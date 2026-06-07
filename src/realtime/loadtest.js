/**
 * Connection-scale + bus-throughput load test (SCP-150).
 *
 * Runnable script (NOT part of the test suite). Benchmarks the two ceilings that
 * decide a hosted node's capacity and the PG-NOTIFY → NATS graduation point:
 *
 *   1. Fan-out latency + throughput: how fast a NOTIFY reaches N concurrent
 *      subscribers on a separate connection, at a sustained publish rate.
 *   2. Subscriber scale: memory / fan-out cost as the local subscriber count
 *      grows (the per-node SSE-connection analogue — each SSE client is one
 *      local subscribe()).
 *
 * It drives the real Postgres LISTEN/NOTIFY backend (bus.js) so the numbers
 * reflect the actual backbone, then prints a per-node ceiling estimate and a
 * suggested NATS-graduation threshold.
 *
 * Usage:
 *   SCOPE_PG_URL=postgres://scope:scope@localhost:5433/scope_test \
 *     node src/realtime/loadtest.js [--subs=500] [--msgs=2000] [--rate=500]
 *
 *   --subs  concurrent subscribers on one LISTEN connection (default 500)
 *   --msgs  total NOTIFY messages to publish           (default 2000)
 *   --rate  target publishes/sec                       (default 1000)
 *
 * Skips cleanly (exit 0) if no Postgres is reachable.
 */

import pg from 'pg';
import { makePgBus } from './bus.js';
import { topicForTenant } from './topics.js';

function arg(name, def) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : def;
}

const PG_URL =
  process.env.SCOPE_PG_URL ||
  process.env.DATABASE_URL ||
  'postgres://scope:scope@localhost:5433/scope_test';

const SUBS = arg('subs', 500);
const MSGS = arg('msgs', 2000);
const RATE = arg('rate', 1000);
const TENANT = `fan_load_${Date.now()}`;
const TOPIC = topicForTenant(TENANT);

function pct(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}

async function reachable() {
  const c = new pg.Client({ connectionString: PG_URL, connectionTimeoutMillis: 1500 });
  try { await c.connect(); await c.end(); return true; } catch { return false; }
}

async function main() {
  if (!(await reachable())) {
    console.log(`[loadtest] no Postgres reachable at ${PG_URL} — skipping (run: docker compose up -d)`);
    process.exit(0);
  }

  const pool = new pg.Pool({ connectionString: PG_URL, max: 4 });
  const bus = makePgBus({ pool });

  console.log(`[loadtest] tenant=${TENANT} subs=${SUBS} msgs=${MSGS} target=${RATE}/s`);

  // --- 1. attach SUBS local subscribers to one LISTEN connection -----------
  const memBefore = process.memoryUsage().rss;
  const tSubStart = performance.now();

  // Each message carries its publish timestamp; we measure delivery latency at
  // a single "probe" subscriber (measuring all SUBS*MSGS would dominate the GC).
  const latencies = [];
  let delivered = 0;
  const expectedProbe = MSGS;
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });

  const offs = [];
  for (let i = 0; i < SUBS; i++) {
    const isProbe = i === 0;
    const off = await bus.subscribe(TOPIC, (payload) => {
      if (isProbe) {
        latencies.push(performance.now() - payload.t0);
        if (++delivered >= expectedProbe) resolveDone();
      }
    });
    offs.push(off);
  }
  const subSetupMs = performance.now() - tSubStart;
  const memAfter = process.memoryUsage().rss;
  const memPerSubKb = (memAfter - memBefore) / SUBS / 1024;

  // --- 2. publish MSGS at the target rate ----------------------------------
  const gapMs = 1000 / RATE;
  const tPubStart = performance.now();
  for (let n = 0; n < MSGS; n++) {
    // Pointer payload, exactly as the real fan-out ships it.
    bus.publish(TOPIC, { tenant: TENANT, cursor: `seq-${n}`, t0: performance.now() });
    if (gapMs >= 1) await sleep(gapMs);
  }
  const publishWallMs = performance.now() - tPubStart;

  // Wait for the probe subscriber to drain (bounded).
  await Promise.race([done, sleep(15000)]);
  const totalMs = performance.now() - tPubStart;

  latencies.sort((a, b) => a - b);
  const achievedRate = (MSGS / publishWallMs) * 1000;
  const deliveredRate = (delivered / totalMs) * 1000;

  console.log('\n=== fan-out results ===');
  console.log(`subscribers attached : ${SUBS}  (setup ${subSetupMs.toFixed(0)}ms, ~${memPerSubKb.toFixed(1)} KB rss/sub)`);
  console.log(`published            : ${MSGS} in ${publishWallMs.toFixed(0)}ms → ${achievedRate.toFixed(0)} NOTIFY/s`);
  console.log(`probe delivered      : ${delivered}/${expectedProbe}`);
  console.log(`delivery latency p50 : ${pct(latencies, 50).toFixed(2)} ms`);
  console.log(`             p95     : ${pct(latencies, 95).toFixed(2)} ms`);
  console.log(`             p99     : ${pct(latencies, 99).toFixed(2)} ms`);
  console.log(`             max     : ${(latencies[latencies.length - 1] || 0).toFixed(2)} ms`);

  // --- per-node ceiling estimate -------------------------------------------
  // Each delivered NOTIFY fans to every local subscriber, so effective per-node
  // delivery work = deliveredRate * SUBS messages/s. We report it as the
  // headline ceiling input.
  const fanoutWorkPerSec = deliveredRate * SUBS;
  console.log('\n=== per-node ceiling estimate ===');
  console.log(`sustained NOTIFY ingest (1 LISTEN conn): ~${deliveredRate.toFixed(0)} msg/s`);
  console.log(`local fan-out work at ${SUBS} subs       : ~${fanoutWorkPerSec.toFixed(0)} deliveries/s`);
  console.log(`mem per subscriber                       : ~${memPerSubKb.toFixed(1)} KB rss`);
  console.log(`→ est. subs/node at 512MB rss budget     : ~${Math.floor((512 * 1024) / Math.max(memPerSubKb, 0.1))}`);
  console.log(
    `→ NATS graduation: consider when sustained NOTIFY ingest approaches\n` +
    `  ~${deliveredRate.toFixed(0)} msg/s per node OR p99 delivery latency exceeds ~50ms\n` +
    `  under target fleet write rate (PG NOTIFY is single-LISTEN-connection bound).`
  );

  // cleanup
  for (const off of offs) await off();
  await bus.close();
  await pool.end();
  process.exit(0);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

main().catch((e) => { console.error('[loadtest] error', e); process.exit(1); });
