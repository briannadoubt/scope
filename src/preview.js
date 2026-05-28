import http from 'node:http';

/**
 * Tiny loopback reverse-proxy for the scope hub.
 *
 * Why this exists: Claude Code's `preview_start` keys its server registry by
 * **port**, not by name. If two preview panes both register a server on port
 * 4321 (the scope hub default), opening the preview in the second pane
 * forcibly stops the first pane's tracked server — even though the actual
 * scope hub coexists fine across many `scope serve` siblings. To dodge that,
 * each pane runs its own `scope preview --port <unique>`, and this proxy
 * forwards every request through to the shared hub on loopback.
 *
 * Scope only speaks plain HTTP on loopback (no WebSockets — realtime is
 * Server-Sent Events on `/events`), so a vanilla `req.pipe(upstream)` /
 * `upRes.pipe(res)` pair handles every endpoint, SSE included. The proxy
 * strips `accept-encoding` so SSE chunks aren't re-buffered through a
 * compression layer, and reads the upstream port through a getter so a hub
 * fail-over (handled by the watchdog in hub.js) re-targets transparently.
 *
 * @param {object} opts
 * @param {number} opts.port            - port to listen on (loopback only).
 * @param {() => number} opts.getUpstreamPort - live read of the hub's port.
 * @returns {Promise<http.Server>} the listening proxy server.
 */
export function startPreviewProxy({ port, getUpstreamPort }) {
  const proxy = http.createServer((req, res) => {
    const upstreamPort = getUpstreamPort();
    if (!upstreamPort) {
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('scope hub not running\n');
      return;
    }

    const headers = { ...req.headers };
    // Re-compressing SSE through the proxy can buffer chunks; keep it raw.
    delete headers['accept-encoding'];
    headers.host = `localhost:${upstreamPort}`;

    const upstream = http.request(
      {
        hostname: '127.0.0.1',
        port: upstreamPort,
        path: req.url,
        method: req.method,
        headers,
      },
      (upRes) => {
        res.writeHead(upRes.statusCode || 502, upRes.headers);
        upRes.pipe(res);
      }
    );

    upstream.on('error', (e) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain' });
        res.end(`upstream error: ${e.message}\n`);
      } else {
        try { res.end(); } catch {}
      }
    });

    // Make sure half-closed sockets don't leak — if the client hangs up
    // mid-SSE we need to tear down the upstream request too. `req.complete`
    // distinguishes a clean end (don't touch upstream — it's still mid-
    // response) from a client abort (do destroy).
    req.on('close', () => {
      if (!req.complete) { try { upstream.destroy(); } catch {} }
    });

    req.pipe(upstream);
  });

  return new Promise((resolve, reject) => {
    const onErr = (e) => { proxy.off('listening', onListening); reject(e); };
    const onListening = () => { proxy.off('error', onErr); resolve(proxy); };
    proxy.once('error', onErr);
    proxy.once('listening', onListening);
    proxy.listen(port, '127.0.0.1');
  });
}
