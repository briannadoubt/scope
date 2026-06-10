/**
 * CLI SSE client (SCP-221) — a minimal Server-Sent Events client for Node.
 *
 * Node has no native `EventSource`, so the CLI can't subscribe to the hub's
 * realtime stream out of the box. This module gives us a focused, dependency-free
 * client built on `node:http`/`node:https` `request` that speaks the exact wire
 * format the hub emits from `app.get('/events')` in src/server.js:
 *
 *   retry: 2000\n
 *   event: hello\ndata: {"workspaces":[...]}\n\n
 *   event: change\ndata: {"type":"sync.applied","workspace":"<tenant>",...}\n\n
 *   : keepalive\n\n               (comment line — proves liveness, never an event)
 *
 * The future RemoteSyncAgent (SCP-220) uses this to drive an incremental pull:
 * fire a catch-up `/api/sync/pull` from `onOpen` (every connect, to bridge any
 * gap), and react to each `onEvent` `change` to pull just-applied deltas.
 *
 * Design notes:
 * - Pure SSE line grammar, no `EventSource` polyfill semantics beyond what the
 *   hub needs: `event:`, `data:` (repeatable, joined by `\n`), `retry:`, and
 *   `:`-prefixed comments. A blank line dispatches the accumulated frame.
 * - Reconnect with exponential backoff (retryMs → maxRetryMs, reset on a clean
 *   connect). A `retry:` line from the server overrides the current delay.
 * - `close()` is idempotent: it aborts the in-flight request, clears timers, and
 *   stops all reconnection so the process can exit with no leaked sockets/timers.
 *   After `close()`, no further callbacks fire.
 */

import http from 'node:http';
import https from 'node:https';

/**
 * Subscribe to a hub SSE stream.
 *
 * @param {string} url - the stream URL (e.g. https://hub.scope.dev/events).
 * @param {object} [opts]
 * @param {string} [opts.token] - bearer token (API key `sk_…` or session JWT);
 *   when present, sent as `Authorization: Bearer <token>`.
 * @param {Record<string,string>} [opts.headers={}] - extra request headers,
 *   merged over the defaults (Accept + Authorization).
 * @param {Record<string,string|number>} [opts.query={}] - query params appended
 *   to the URL (e.g. `{ project: tenantId }` / `{ workspace: id }`).
 * @param {(evt: {event: string, data: any}) => void} [opts.onEvent] - called once
 *   per dispatched frame. `event` is the `event:` type (or `'message'` when the
 *   frame had no `event:` line). `data` is parsed JSON when it parses, else the
 *   raw string. Comment lines (`:`) never produce an event.
 * @param {() => void} [opts.onOpen] - called on every successful (re)connect.
 *   Consumers use this to run a catch-up pull and bridge any missed window.
 * @param {(err: Error) => void} [opts.onError] - called on transport errors and
 *   non-2xx responses. See auth handling below.
 * @param {number} [opts.retryMs=2000] - initial reconnect delay.
 * @param {number} [opts.maxRetryMs=30000] - backoff ceiling.
 * @param {(options: object, cb: Function) => import('node:http').ClientRequest}
 *   [opts.fetchImpl] - injectable request fn (defaults to http/https `request`
 *   chosen by URL protocol); takes Node request options + a response callback.
 * @returns {{ close(): void }} handle whose `close()` stops the stream for good.
 *
 * Auth handling: a non-2xx response surfaces via `onError` and, by default, the
 * client still backs off and retries — transient 5xx and proxy hiccups are
 * common and self-heal. The two hard auth failures, 401 (unauthorized) and 403
 * (forbidden), are treated as terminal: `onError` fires once and the client
 * stops (no reconnect), because retrying a rejected credential just hammers the
 * hub. Callers that rotate a token should create a fresh `connectSse`.
 */
export function connectSse(url, opts = {}) {
  const {
    token,
    headers = {},
    query = {},
    onEvent,
    onOpen,
    onError,
    retryMs = 2000,
    maxRetryMs = 30000,
    fetchImpl,
  } = opts;

  // Build the full URL with merged query params. URL parsing also picks the
  // transport (http vs https) below.
  const target = new URL(url);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null) target.searchParams.set(k, String(v));
  }

  const transport =
    fetchImpl || (target.protocol === 'https:' ? https.request : http.request);

  let closed = false; // hard stop — set by close(), never unset
  let req = null; // in-flight ClientRequest, if any
  let res = null; // in-flight IncomingMessage, if any
  let reconnectTimer = null;
  let delay = retryMs; // current backoff delay; server `retry:` can override

  /** Schedule the next connect with the current backoff, then double it. */
  const scheduleReconnect = () => {
    if (closed) return;
    clearTimer();
    const wait = delay;
    delay = Math.min(delay * 2, maxRetryMs);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, wait);
    // Don't let a pending reconnect keep the process alive on its own.
    reconnectTimer.unref?.();
  };

  const clearTimer = () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  /** Surface an error; treat 401/403 as terminal (no reconnect). */
  const fail = (err, { terminal = false } = {}) => {
    if (closed) return;
    onError?.(err);
    if (terminal) {
      // Hard auth failure — stop for good so we don't hammer the hub.
      closed = true;
      destroyRequest();
      clearTimer();
      return;
    }
    scheduleReconnect();
  };

  /** Tear down the active request/response without flipping `closed`. */
  const destroyRequest = () => {
    if (res) {
      try {
        res.removeAllListeners();
        res.destroy();
      } catch {
        /* already gone */
      }
      res = null;
    }
    if (req) {
      try {
        req.removeAllListeners();
        // `abort()`/`destroy()` cancel an in-flight request; either works.
        req.destroy();
      } catch {
        /* already gone */
      }
      req = null;
    }
  };

  const connect = () => {
    if (closed) return;

    const requestHeaders = {
      Accept: 'text/event-stream',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    };

    const options = {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      path: `${target.pathname}${target.search}`,
      method: 'GET',
      headers: requestHeaders,
    };

    req = transport(options, (response) => {
      res = response;

      // Non-2xx → error path. 401/403 are hard auth failures (terminal).
      if (response.statusCode < 200 || response.statusCode >= 300) {
        const status = response.statusCode;
        // Drain so the socket can be freed.
        response.resume();
        const terminal = status === 401 || status === 403;
        destroyRequest();
        fail(new Error(`SSE HTTP ${status}`), { terminal });
        return;
      }

      // Clean connect — reset backoff and notify the caller (catch-up hook).
      delay = retryMs;
      if (!closed) onOpen?.();

      response.setEncoding('utf8');

      // SSE frame accumulator. We buffer raw text and split on newlines so a
      // chunk that lands mid-line is handled correctly.
      let buffer = '';
      let eventType = '';
      const dataLines = [];

      const dispatch = () => {
        if (dataLines.length === 0 && eventType === '') return; // empty frame
        const raw = dataLines.join('\n');
        let data = raw;
        // Per the ticket: parse JSON when it parses, else hand back the raw
        // string. Empty-data frames stay as ''.
        if (raw !== '') {
          try {
            data = JSON.parse(raw);
          } catch {
            data = raw;
          }
        }
        const type = eventType || 'message';
        eventType = '';
        dataLines.length = 0;
        if (!closed) onEvent?.({ event: type, data });
      };

      const handleLine = (line) => {
        // Strip a single trailing CR (servers may send CRLF).
        if (line.endsWith('\r')) line = line.slice(0, -1);

        if (line === '') {
          dispatch(); // blank line ends a frame
          return;
        }
        if (line.startsWith(':')) {
          // Comment line (e.g. `: keepalive`). Proves liveness; not an event.
          return;
        }

        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        // SSE: one optional space after the colon is stripped.
        let value = colon === -1 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);

        switch (field) {
          case 'event':
            eventType = value;
            break;
          case 'data':
            dataLines.push(value);
            break;
          case 'retry': {
            const ms = Number(value);
            if (Number.isFinite(ms) && ms >= 0) delay = ms;
            break;
          }
          // `id` and unknown fields are ignored — the hub doesn't use them.
          default:
            break;
        }
      };

      response.on('data', (chunk) => {
        if (closed) return;
        buffer += chunk;
        let idx;
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          handleLine(line);
        }
      });

      response.on('end', () => {
        // Connection closed by the server — reconnect with backoff.
        destroyRequest();
        if (!closed) scheduleReconnect();
      });

      response.on('error', (err) => {
        destroyRequest();
        if (!closed) fail(err);
      });
    });

    req.on('error', (err) => {
      // Transport-level failure (DNS, refused, reset). Back off and retry.
      destroyRequest();
      if (!closed) fail(err);
    });

    req.end();
  };

  // Kick off the first connection.
  connect();

  return {
    /**
     * Stop the stream permanently. Idempotent: aborts the in-flight request,
     * clears timers, and prevents any further reconnect or callback.
     */
    close() {
      if (closed) return;
      closed = true;
      clearTimer();
      destroyRequest();
    },
  };
}
