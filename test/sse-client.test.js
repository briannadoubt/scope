import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { connectSse } from '../src/sse-client.js';

/**
 * SCP-221 — CLI SSE client. We spin a real http server (listen(0)) that emits
 * the hub's exact wire format and drive `connectSse` against it over real
 * sockets, so the line-buffering, frame grammar, reconnect/backoff, auth header,
 * and teardown are all exercised end-to-end. If any handle leaks, `node --test`
 * hangs — that hang IS the failure for the close() test.
 */

/** Start a server whose request handler is provided per-test. */
function startServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, url: `http://127.0.0.1:${port}/events` });
    });
  });
}

/** Tear down a server, dropping any lingering keep-alive/SSE sockets. */
function closeServer(server) {
  return new Promise((resolve) => {
    if (!server) return resolve();
    try { server.closeAllConnections?.(); } catch { /* noop */ }
    server.close(() => resolve());
  });
}

/** Poll until `predicate()` is truthy or we time out. */
function waitFor(predicate, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const i = setInterval(() => {
      if (predicate()) { clearInterval(i); resolve(); }
      else if (Date.now() - start > timeoutMs) {
        clearInterval(i);
        reject(new Error('waitFor timeout'));
      }
    }, 10);
  });
}

test('parses retry, hello, a JSON change, and ignores keepalive comments', async () => {
  const { server, url } = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('retry: 2000\n');
    res.write(`event: hello\ndata: ${JSON.stringify({ workspaces: ['w1'] })}\n\n`);
    res.write(': keepalive\n\n');
    res.write(
      `event: change\ndata: ${JSON.stringify({ type: 'sync.applied', workspace: 't1' })}\n\n`
    );
  });

  const events = [];
  let opens = 0;
  const client = connectSse(url, {
    retryMs: 50,
    onOpen: () => { opens += 1; },
    onEvent: (e) => events.push(e),
  });

  try {
    await waitFor(() => events.length >= 2);
    // Give a keepalive a beat to (wrongly) arrive as an event.
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(opens, 1, 'onOpen fires exactly once for one connection');
    assert.equal(events.length, 2, 'keepalive comment is NOT delivered as an event');

    const [hello, change] = events;
    assert.equal(hello.event, 'hello');
    assert.deepEqual(hello.data, { workspaces: ['w1'] }, 'hello data parsed as object');

    assert.equal(change.event, 'change');
    assert.equal(typeof change.data, 'object', 'change data parsed as object');
    assert.deepEqual(change.data, { type: 'sync.applied', workspace: 't1' });
  } finally {
    client.close();
    await closeServer(server);
  }
});

test('multi-line data: two data: lines dispatch once joined by \\n', async () => {
  const { server, url } = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    // Two data lines, no `event:` → event name defaults to 'message'. Use a
    // non-JSON body so we assert the raw string passthrough.
    res.write('data: line one\ndata: line two\n\n');
  });

  const events = [];
  const client = connectSse(url, { retryMs: 50, onEvent: (e) => events.push(e) });

  try {
    await waitFor(() => events.length >= 1);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(events.length, 1, 'two data lines dispatch a single event');
    assert.equal(events[0].event, 'message', "no event: line → 'message'");
    assert.equal(events[0].data, 'line one\nline two', 'data lines joined by \\n');
  } finally {
    client.close();
    await closeServer(server);
  }
});

test('reconnects with backoff after the server drops the socket', async () => {
  let conns = 0;
  const { server, url } = await startServer((req, res) => {
    conns += 1;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (conns === 1) {
      // First connection: emit one event, then close to force a reconnect.
      res.write(`event: change\ndata: ${JSON.stringify({ n: 1 })}\n\n`);
      res.end();
    } else {
      // Second connection: emit a subsequent event and hold open.
      res.write(`event: change\ndata: ${JSON.stringify({ n: 2 })}\n\n`);
    }
  });

  const events = [];
  let opens = 0;
  const client = connectSse(url, {
    retryMs: 25,
    onOpen: () => { opens += 1; },
    onEvent: (e) => events.push(e),
  });

  try {
    await waitFor(() => opens >= 2 && events.length >= 2);
    assert.ok(opens >= 2, 'onOpen fired again on reconnect');
    assert.deepEqual(events.map((e) => e.data.n), [1, 2], 'received pre- and post-reconnect events');
  } finally {
    client.close();
    await closeServer(server);
  }
});

test('idle watchdog force-cycles a silently-stalled (half-open) connection', async () => {
  // A half-open socket emits no 'end'/'error', so without the watchdog the
  // client would wait forever. First connection writes nothing and holds open
  // (the stall); the watchdog must fire, surface an error, and reconnect.
  let conns = 0;
  const { server, url } = await startServer((req, res) => {
    conns += 1;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    // Flush headers immediately (the real hub writes `retry:` up front) so the
    // client's response callback fires and the watchdog arms.
    res.write('retry: 2000\n');
    if (conns >= 2) res.write(`event: change\ndata: ${JSON.stringify({ n: 2 })}\n\n`);
    // conns === 1: nothing more — established but silent, then never ends. The
    // watchdog must notice the stall and force a reconnect.
  });

  const events = [];
  const errors = [];
  let opens = 0;
  const client = connectSse(url, {
    retryMs: 25,
    idleTimeoutMs: 80, // fire fast for the test
    onOpen: () => { opens += 1; },
    onEvent: (e) => events.push(e),
    onError: (e) => errors.push(e),
  });

  try {
    await waitFor(() => opens >= 2 && events.length >= 1);
    assert.ok(opens >= 2, 'watchdog tripped a reconnect on the stalled connection');
    assert.ok(errors.some((e) => /idle timeout/i.test(e.message)), 'idle timeout surfaced via onError');
    assert.equal(events[0].data.n, 2, 'received the event from the recovered connection');
  } finally {
    client.close();
    await closeServer(server);
  }
});

test('keepalive comments reset the watchdog — a healthy stream is not cycled', async () => {
  // The hub proves liveness with `: keepalive` comments. Each is bytes on the
  // wire, so it must reset the idle timer and keep a quiet-but-live stream up.
  let conns = 0;
  const timers = [];
  const { server, url } = await startServer((req, res) => {
    conns += 1;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(': keepalive\n\n');
    const t = setInterval(() => res.write(': keepalive\n\n'), 30);
    timers.push(t);
    res.on('close', () => clearInterval(t));
  });

  let opens = 0;
  const client = connectSse(url, {
    retryMs: 25,
    idleTimeoutMs: 80, // keepalives at 30ms must keep resetting this
    onOpen: () => { opens += 1; },
  });

  try {
    // Over a window several idle-timeouts long, no reconnect should occur.
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(opens, 1, 'single stable connection — keepalives kept the watchdog from firing');
    assert.equal(conns, 1, 'server saw exactly one connection');
  } finally {
    client.close();
    for (const t of timers) clearInterval(t);
    await closeServer(server);
  }
});

test('sends Authorization: Bearer <token>', async () => {
  let seenAuth = null;
  const { server, url } = await startServer((req, res) => {
    seenAuth = req.headers.authorization;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`event: hello\ndata: {}\n\n`);
  });

  const events = [];
  const client = connectSse(url, {
    token: 'sk_test_abc123',
    retryMs: 50,
    onEvent: (e) => events.push(e),
  });

  try {
    await waitFor(() => events.length >= 1);
    assert.equal(seenAuth, 'Bearer sk_test_abc123', 'server saw the bearer token');
  } finally {
    client.close();
    await closeServer(server);
  }
});

test('close() stops all callbacks and lets the process exit cleanly', async () => {
  // The server holds the connection open and keeps emitting. After close() we
  // assert no further callbacks fire; the implicit assertion is that the test
  // process can exit — a leaked socket/timer would hang `node --test`.
  let timer = null;
  const { server, url } = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`event: change\ndata: ${JSON.stringify({ n: 0 })}\n\n`);
    let n = 1;
    timer = setInterval(() => {
      try { res.write(`event: change\ndata: ${JSON.stringify({ n: n++ })}\n\n`); }
      catch { /* socket gone */ }
    }, 20);
  });

  let events = 0;
  let opens = 0;
  const client = connectSse(url, {
    retryMs: 25,
    onOpen: () => { opens += 1; },
    onEvent: () => { events += 1; },
  });

  try {
    await waitFor(() => events >= 1);
    client.close();
    const eventsAtClose = events;
    const opensAtClose = opens;

    // Let the server keep emitting; none of it should reach our callbacks.
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(events, eventsAtClose, 'no onEvent after close()');
    assert.equal(opens, opensAtClose, 'no onOpen after close()');

    // close() is idempotent.
    client.close();
  } finally {
    if (timer) clearInterval(timer);
    await closeServer(server);
  }
});
