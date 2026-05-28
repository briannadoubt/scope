import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { startPreviewProxy } from '../src/preview.js';

/* Spin up a tiny upstream HTTP server for the proxy to forward to. The
 * handler is provided per-test so individual tests can assert on what the
 * upstream received and decide what to return. */
function startUpstream(handler) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { body += c; });
    req.on('end', () => handler(req, res, body));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function get(port, path = '/', { headers } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'GET', headers },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function post(port, path, body, { headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1', port, path, method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
      },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { buf += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: buf }));
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

test('GET round-trips through the proxy', async () => {
  const up = await startUpstream((req, res, body) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ path: req.url, method: req.method }));
  });
  const proxy = await startPreviewProxy({ port: 0, getUpstreamPort: () => up.port });
  try {
    const r = await get(proxy.address().port, '/api/meta');
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body), { path: '/api/meta', method: 'GET' });
  } finally {
    proxy.close();
    up.server.close();
  }
});

test('POST body forwards through the proxy', async () => {
  const up = await startUpstream((req, res, body) => {
    res.writeHead(201, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ got: body, contentType: req.headers['content-type'] }));
  });
  const proxy = await startPreviewProxy({ port: 0, getUpstreamPort: () => up.port });
  try {
    const r = await post(proxy.address().port, '/api/tickets', JSON.stringify({ title: 'hi' }));
    assert.equal(r.status, 201);
    const parsed = JSON.parse(r.body);
    assert.equal(parsed.got, '{"title":"hi"}');
    assert.equal(parsed.contentType, 'application/json');
  } finally {
    proxy.close();
    up.server.close();
  }
});

test('SSE responses stream without being buffered to EOF', async () => {
  // The upstream writes three frames spaced out over ~80ms without ever
  // calling res.end(). If the proxy were buffering the upstream response
  // until completion, this client would receive 0 frames before its timeout.
  const up = await startUpstream(async (req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    });
    res.write('event: hello\ndata: {"n":0}\n\n');
    setTimeout(() => res.write('event: tick\ndata: {"n":1}\n\n'), 30);
    setTimeout(() => res.write('event: tick\ndata: {"n":2}\n\n'), 60);
  });
  const proxy = await startPreviewProxy({ port: 0, getUpstreamPort: () => up.port });

  /* Read raw chunks from the proxy and bail out as soon as we've seen all
   * three frames or 1 second elapses. */
  const frames = await new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port: proxy.address().port, path: '/events', method: 'GET' },
      (res) => {
        let buf = '';
        const seen = [];
        const finish = () => { try { req.destroy(); } catch {} resolve(seen); };
        res.setEncoding('utf8');
        res.on('data', (c) => {
          buf += c;
          let idx;
          while ((idx = buf.indexOf('\n\n')) !== -1) {
            seen.push(buf.slice(0, idx));
            buf = buf.slice(idx + 2);
            if (seen.length >= 3) finish();
          }
        });
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.end();
    setTimeout(() => reject(new Error('timed out waiting for SSE frames')), 1000);
  });

  try {
    assert.equal(frames.length, 3);
    assert.match(frames[0], /event: hello/);
    assert.match(frames[1], /"n":1/);
    assert.match(frames[2], /"n":2/);
  } finally {
    proxy.close();
    up.server.close();
  }
});

test('upstream connection refused surfaces as 502', async () => {
  // Point the proxy at a port nothing is listening on. http.request fails
  // with ECONNREFUSED, which the proxy translates to a 502.
  const proxy = await startPreviewProxy({ port: 0, getUpstreamPort: () => 1 });
  try {
    const r = await get(proxy.address().port, '/api/meta');
    assert.equal(r.status, 502);
    assert.match(r.body, /upstream error/);
  } finally {
    proxy.close();
  }
});

test('getUpstreamPort is re-read per request (handles hub fail-over)', async () => {
  // Two upstreams; the getter flips between them between requests, simulating
  // the watchdog promoting a new hub. Both requests should hit the right one.
  const up1 = await startUpstream((req, res) => { res.writeHead(200); res.end('one'); });
  const up2 = await startUpstream((req, res) => { res.writeHead(200); res.end('two'); });
  let current = up1.port;
  const proxy = await startPreviewProxy({ port: 0, getUpstreamPort: () => current });
  try {
    const r1 = await get(proxy.address().port, '/');
    assert.equal(r1.body, 'one');
    current = up2.port;
    const r2 = await get(proxy.address().port, '/');
    assert.equal(r2.body, 'two');
  } finally {
    proxy.close();
    up1.server.close();
    up2.server.close();
  }
});

test('startPreviewProxy rejects when the chosen port is already in use', async () => {
  // Squat the port with another listener, then try to bring the proxy up on
  // the same port. The promise should reject with EADDRINUSE, matching the
  // error code the CLI's preview command branches on.
  const squat = http.createServer(() => {});
  await new Promise((res) => squat.listen(0, '127.0.0.1', res));
  const taken = squat.address().port;
  try {
    await assert.rejects(
      () => startPreviewProxy({ port: taken, getUpstreamPort: () => 4321 }),
      (e) => e.code === 'EADDRINUSE'
    );
  } finally {
    squat.close();
  }
});
