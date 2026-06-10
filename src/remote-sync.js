/**
 * RemoteSyncAgent (SCP-220 + SCP-223) — a long-running agent that keeps a local
 * .scope continuously converged with one hosted project, so a laptop's board is
 * a LIVE bidirectional mirror (~realtime) with no manual `scope sync` call.
 *
 * It's the gossip engine (src/gossip.js) generalized from a LAN peer to a hosted
 * hub, with the pull half driven by the hub's SSE stream instead of an interval:
 *
 *   PUSH  — subscribe to the local change bus; on every local mutation, debounce
 *           briefly then run a sync round (push new events up, pull deltas down).
 *   PULL  — hold an open /events?project=<tenant> SSE connection; on each change
 *           notification (or reconnect) run a sync round, which pulls since the
 *           persisted ULID cursor and folds the deltas in incrementally (SCP-219).
 *   CATCH-UP — a slow interval tick is the backstop if a bus/SSE signal is missed.
 *
 * Everything routes through the existing idempotent syncWithRemote primitive, so
 * the agent is conflict-free by construction (ULID union, last-writer-wins per
 * field): a missed event, a duplicate delivery, or pulling our own just-pushed
 * events back are all no-ops. The one-shot `scope sync` stays the offline/CI
 * fallback; this just stops a human from calling it.
 *
 * Resilience (SCP-223): one round at a time (in-flight guard coalesces a burst of
 * triggers into a single round + one trailing round), every round is try/caught
 * so a transient failure never kills the loop, the SSE client reconnects with
 * backoff on its own, and the interval tick guarantees eventual convergence even
 * if every push signal is dropped. Fully offline → rounds fail quietly and the
 * local writes keep flowing; on reconnect the SSE onOpen fires a catch-up round.
 */
import { bus } from './events.js';
import { connectSse } from './sse-client.js';
import { syncWithRemote } from './sync-client.js';

/**
 * Start a continuous bidirectional sync agent.
 *
 * @param {import('better-sqlite3').Database} db - open local workspace db
 * @param {string} scopeDir - the local .scope dir
 * @param {object} opts
 * @param {string} opts.remote - hosted hub base URL (e.g. https://scope-hub.fly.dev)
 * @param {string} opts.project - the remote project/tenant id to mirror
 * @param {string} [opts.token] - API key / session for the hub
 * @param {string} [opts.model] - acting-model attribution for pushes
 * @param {number} [opts.debounceMs=80] - coalesce a burst of local changes
 * @param {number} [opts.intervalMs=30000] - catch-up backstop tick
 * @param {Function} [opts.fetchImpl] - injectable fetch (tests)
 * @param {Function} [opts.connectImpl] - injectable SSE connector (tests)
 * @param {(s:object)=>void} [opts.onStatus] - status change callback
 * @returns {{ stop: () => void, status: () => object, syncNow: () => Promise<void> }}
 */
export function startRemoteSync(db, scopeDir, {
  remote, project, token = '', model = '',
  debounceMs = 80, intervalMs = 30000,
  fetchImpl, connectImpl = connectSse, onStatus,
} = {}) {
  if (!remote) throw new Error('startRemoteSync: remote is required');
  if (!project) throw new Error('startRemoteSync: project is required');

  const state = {
    connected: false, running: false, stopped: false,
    lastSyncAt: null, lastError: null, pushed: 0, pulled: 0, rounds: 0,
  };
  const emit = () => { if (onStatus) { try { onStatus(status()); } catch { /* ignore */ } } };
  function status() {
    return {
      connected: state.connected, running: state.running, stopped: state.stopped,
      lastSyncAt: state.lastSyncAt, lastError: state.lastError,
      pushed: state.pushed, pulled: state.pulled, rounds: state.rounds,
    };
  }

  // --- round runner: one at a time, with a trailing round if asked while busy ---
  let inFlight = false;
  let pendingAgain = false;
  let debounceTimer = null;

  async function runRound() {
    if (state.stopped) return;
    if (inFlight) { pendingAgain = true; return; } // coalesce; run once more after
    inFlight = true;
    state.running = true; emit();
    try {
      const r = await syncWithRemote(db, scopeDir, {
        remote, remoteWorkspace: project, token, model, fetchImpl,
      });
      state.pushed += r.pushed || 0;
      state.pulled += r.pulled || 0;
      state.rounds += 1;
      state.lastSyncAt = Date.now();
      state.lastError = null;
    } catch (e) {
      // Transient (offline, 5xx, race) — never kill the loop; the interval tick
      // and the next change/SSE signal will retry. Local writes keep flowing.
      state.lastError = e.message || String(e);
    } finally {
      inFlight = false;
      state.running = false; emit();
      if (pendingAgain && !state.stopped) { pendingAgain = false; runRound(); }
    }
  }

  // Debounce a burst of local changes into a single trailing round.
  function scheduleRound() {
    if (state.stopped) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => { debounceTimer = null; runRound(); }, debounceMs);
    if (debounceTimer.unref) debounceTimer.unref();
  }

  // --- PUSH trigger: local mutations on this workspace ---
  const onChange = () => scheduleRound();
  bus.on('change', onChange);

  // --- PULL trigger: the hub's SSE stream for this project ---
  const sse = connectImpl(`${remote.replace(/\/$/, '')}/events`, {
    token,
    query: { project },
    fetchImpl,
    onOpen: () => {
      state.connected = true; emit();
      runRound(); // catch up on (re)connect — covers anything missed while down
    },
    onEvent: ({ event, data }) => {
      // Any change touching our project => pull the delta. Ignore hello/keepalive.
      if (event === 'change') {
        if (!data || !data.workspace || data.workspace === project) scheduleRound();
      }
    },
    onError: (err) => {
      state.connected = false;
      state.lastError = (err && err.message) || String(err);
      emit();
    },
  });

  // --- CATCH-UP backstop: converge even if every push/SSE signal is missed ---
  const interval = setInterval(() => runRound(), intervalMs);
  if (interval.unref) interval.unref();

  // Prime once at startup (initial reconcile; onOpen will also fire one).
  runRound();

  function stop() {
    if (state.stopped) return;
    state.stopped = true;
    bus.off('change', onChange);
    if (debounceTimer) clearTimeout(debounceTimer);
    clearInterval(interval);
    try { sse.close(); } catch { /* ignore */ }
    state.connected = false; emit();
  }

  return { stop, status, syncNow: runRound };
}
