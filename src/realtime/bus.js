/**
 * Pluggable fan-out bus (SCP-146).
 *
 * The hosted relay runs many stateless Node nodes behind a load balancer; an
 * SSE client may be connected to any of them. When a write lands (uploadEvents,
 * src/pg/store.js returns the NEWLY-APPLIED events), every node that holds SSE
 * subscribers for that tenant must learn about it — not just the node that
 * accepted the write. That cross-node fan-out is what this bus provides.
 *
 * Interface (intentionally thin, so a NATS / Redis backend can swap in later):
 *
 *     const bus = makeBus();                 // pick a backend from env
 *     await bus.publish(topic, payload);     // notify all nodes on `topic`
 *     const off = await bus.subscribe(topic, cb);  // cb(payload) per message
 *     await off();                           // unsubscribe one callback
 *     await bus.close();                     // tear the backend down
 *
 * `topic` is an opaque string the caller derives (see topics.js for the
 * tenant/project scheme). `payload` is any JSON-serializable value; the
 * Postgres backend ships it as the NOTIFY payload. The canonical payload for
 * Scope is a pointer — `{ tenant, cursor }` — NOT the event body: the receiving
 * node reads the missed rows by cursor (pullEvents) so we never push large
 * bodies through NOTIFY's 8 KB limit and never trust a body that crossed a
 * channel the receiver didn't write.
 *
 * --- Postgres LISTEN/NOTIFY backend ---------------------------------------
 *
 * One dedicated long-lived pg client per node holds every LISTEN (a pooled
 * client can't — LISTEN is connection-scoped and the pool would hand the
 * connection to someone else). publish() borrows a pool client briefly to issue
 * NOTIFY. Postgres channel identifiers are restricted (and case-folded unless
 * quoted), so we hash the topic to a stable, safe channel name and keep the
 * real topic inside the JSON payload for the receiver to match on.
 */

import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

/**
 * Postgres limits a NOTIFY channel name to NAMEDATALEN-1 (63) bytes and folds
 * unquoted identifiers to lower case. Rather than fight quoting rules we map an
 * arbitrary topic to a deterministic safe channel: a fixed prefix + a short
 * hash. Collisions are astronomically unlikely and harmless anyway because the
 * receiver re-checks the exact topic carried in the payload.
 */
export function channelFor(topic) {
  const h = crypto.createHash('sha1').update(String(topic)).digest('hex').slice(0, 24);
  return `scope_rt_${h}`;
}

/**
 * Postgres LISTEN/NOTIFY bus.
 *
 * @param {object} opts
 * @param {import('pg').Pool} opts.pool - pool used for NOTIFY (publish).
 * @param {() => Promise<import('pg').Client> | import('pg').Client} opts.connect
 *        - factory for the dedicated LISTEN client. Defaults to a new pg.Client
 *          on the pool's connection string. Injectable for tests.
 */
export function makePgBus({ pool, connect } = {}) {
  if (!pool) throw new Error('makePgBus requires a pg Pool');

  // Local in-process dispatch: many SSE handlers on this node subscribe to the
  // same channel; we LISTEN once per channel and fan out locally.
  const local = new EventEmitter();
  local.setMaxListeners(0); // unbounded; SSE connections come and go

  let listenClient = null;
  let connecting = null;
  let closed = false;
  // channel -> ref count of active subscriptions, so we UNLISTEN when the last
  // subscriber for a channel goes away.
  const channelRefs = new Map();

  async function getListenClient() {
    if (listenClient) return listenClient;
    if (connecting) return connecting;
    connecting = (async () => {
      let client;
      if (connect) {
        client = await connect();
      } else {
        const pg = (await import('pg')).default;
        // Reuse the pool's connection string; the dedicated client lives outside
        // the pool because LISTEN is connection-scoped.
        client = new pg.Client({ connectionString: pool.options?.connectionString });
        await client.connect();
      }
      client.on('notification', (msg) => {
        // msg.channel is the hashed channel; msg.payload is our JSON envelope.
        let env;
        try { env = JSON.parse(msg.payload); }
        catch { env = { topic: null, payload: msg.payload }; }
        local.emit(msg.channel, env);
      });
      // If the dedicated connection drops, surface it: a dead LISTEN means this
      // node is silently missing fan-out. healthz.js polls liveness; here we
      // just reset so the next subscribe reconnects and re-LISTENs.
      client.on('error', () => { listenClient = null; });
      listenClient = client;
      connecting = null;
      return client;
    })();
    return connecting;
  }

  return {
    /**
     * NOTIFY all nodes subscribed to `topic`. Payload is JSON-wrapped with the
     * exact topic so receivers can disambiguate hash collisions.
     */
    async publish(topic, payload) {
      if (closed) throw new Error('bus is closed');
      const channel = channelFor(topic);
      const envelope = JSON.stringify({ topic, payload });
      // pg_notify() takes the payload as a bind parameter — safer than
      // interpolating into a NOTIFY statement, and the channel is a hash of our
      // own making so it can be interpolated safely.
      await pool.query('SELECT pg_notify($1, $2)', [channel, envelope]);
    },

    /**
     * Subscribe `cb` to `topic` on this node. Returns an async unsubscribe.
     * `cb` receives the original `payload` (unwrapped) for matching topics.
     */
    async subscribe(topic, cb) {
      if (closed) throw new Error('bus is closed');
      const channel = channelFor(topic);
      const handler = (env) => {
        // Guard against hash collisions: only deliver when the exact topic
        // matches. This is the in-process echo of the tenant isolation guard.
        if (env.topic !== topic) return;
        cb(env.payload);
      };
      local.on(channel, handler);

      const refs = channelRefs.get(channel) || 0;
      if (refs === 0) {
        const client = await getListenClient();
        // Channel name is a hash of our own making (safe chars); quote defensively.
        await client.query(`LISTEN "${channel}"`);
      }
      channelRefs.set(channel, refs + 1);

      return async function unsubscribe() {
        local.off(channel, handler);
        const n = (channelRefs.get(channel) || 1) - 1;
        if (n <= 0) {
          channelRefs.delete(channel);
          if (listenClient) {
            try { await listenClient.query(`UNLISTEN "${channel}"`); } catch { /* dropped */ }
          }
        } else {
          channelRefs.set(channel, n);
        }
      };
    },

    /** True if the dedicated LISTEN connection is currently live. (healthz) */
    listening() {
      return !!listenClient;
    },

    async close() {
      closed = true;
      local.removeAllListeners();
      channelRefs.clear();
      const c = listenClient;
      listenClient = null;
      if (c) { try { await c.end(); } catch { /* already gone */ } }
    },
  };
}

/**
 * Construct the bus backend selected by SCOPE_RT_BACKEND (default "pg").
 * Kept as the single seam server.js wires to, so swapping in NATS is a one-line
 * change here, not in the SSE path.
 *
 * @param {object} deps - { pool } for the pg backend.
 */
export function makeBus(deps = {}) {
  const backend = process.env.SCOPE_RT_BACKEND || 'pg';
  switch (backend) {
    case 'pg':
      return makePgBus(deps);
    default:
      throw new Error(`unknown SCOPE_RT_BACKEND: ${backend}`);
  }
}
