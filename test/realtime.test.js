import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import { getPool, closePool, pgUrl } from '../src/pg/pool.js';
import { makePgBus, channelFor } from '../src/realtime/bus.js';
import {
  topicForPrincipal,
  topicForTenant,
  tenantOfTopic,
  isolationGuard,
  guardedDelivery,
} from '../src/realtime/topics.js';
import { makeHealthz } from '../src/realtime/healthz.js';

/**
 * SCP-146/148/149 — realtime fan-out bus, topic isolation, healthz.
 * Bus tests need Postgres (LISTEN/NOTIFY); topic/guard tests are pure units.
 */
process.env.SCOPE_PG_URL =
  process.env.SCOPE_PG_URL || 'postgres://scope:scope@localhost:5433/scope_test';

let available = false;
try {
  const c = new pg.Client({ connectionString: pgUrl(), connectionTimeoutMillis: 1500 });
  await c.connect(); await c.end(); available = true;
} catch { /* skip */ }
const skip = available ? false : 'no Postgres reachable (run: docker compose up -d)';

function waitFor(predicate, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const i = setInterval(() => {
      if (predicate()) { clearInterval(i); resolve(); }
      else if (Date.now() - start > timeoutMs) { clearInterval(i); reject(new Error('timeout')); }
    }, 10);
  });
}

/* ---------- SCP-148: topic routing + isolation (pure units) ---------- */

test('topicForPrincipal derives tenant topic and ignores client-supplied scope', () => {
  assert.equal(topicForPrincipal({ tenant: 'fan_acme' }), 'scope.fan_acme');
  assert.equal(
    topicForPrincipal({ tenant: 'fan_acme', projects: ['p1'] }, { project: 'p1' }),
    'scope.fan_acme.p1'
  );
});

test('topicForPrincipal refuses a project outside the principal membership', () => {
  assert.throws(
    () => topicForPrincipal({ tenant: 'fan_acme', projects: ['p1'] }, { project: 'p2' }),
    /not a member/
  );
});

test('topicForPrincipal rejects missing/invalid tenant', () => {
  assert.throws(() => topicForPrincipal(null), /authenticated principal/);
  assert.throws(() => topicForPrincipal({ tenant: 'bad tenant!' }), /invalid tenant/);
});

test('tenantOfTopic / topicForTenant round-trip', () => {
  assert.equal(tenantOfTopic(topicForTenant('fan_acme')), 'fan_acme');
  assert.equal(tenantOfTopic('scope.fan_acme.p1'), 'fan_acme');
  assert.equal(tenantOfTopic('garbage'), null);
});

test('isolationGuard only passes in-tenant payloads', () => {
  const allow = isolationGuard({ tenant: 'fan_acme' });
  assert.equal(allow({ tenant: 'fan_acme', cursor: 'x' }), true);
  assert.equal(allow({ tenant: 'fan_evil', cursor: 'x' }), false);
  assert.equal(allow({ cursor: 'x' }), false); // un-attributed → reject
});

test('guardedDelivery drops cross-tenant messages before the callback', () => {
  const seen = [];
  const deliver = guardedDelivery({ tenant: 'fan_acme' }, (p) => seen.push(p.cursor));
  deliver({ tenant: 'fan_acme', cursor: 'a' });
  deliver({ tenant: 'fan_evil', cursor: 'b' });
  assert.deepEqual(seen, ['a']);
});

test('channelFor is deterministic and within Postgres identifier limits', () => {
  const ch = channelFor('scope.fan_acme');
  assert.equal(ch, channelFor('scope.fan_acme'));
  assert.notEqual(ch, channelFor('scope.fan_other'));
  assert.ok(ch.length <= 63 && /^scope_rt_[0-9a-f]+$/.test(ch));
});

/* ---------- SCP-146: Postgres LISTEN/NOTIFY fan-out ---------- */

test('publish on one connection reaches a subscriber on another', { skip }, async () => {
  const pool = getPool();
  const tenant = `fan_${Date.now()}_a`;
  const topic = topicForTenant(tenant);

  // Two independent buses → two independent LISTEN connections, mimicking two
  // nodes behind the LB.
  const subBus = makePgBus({ pool });
  const pubBus = makePgBus({ pool });

  const got = [];
  const off = await subBus.subscribe(topic, (payload) => got.push(payload));

  await pubBus.publish(topic, { tenant, cursor: 'seq-1' });
  await waitFor(() => got.length >= 1);

  assert.equal(got.length, 1);
  assert.deepEqual(got[0], { tenant, cursor: 'seq-1' });
  assert.equal(subBus.listening(), true, 'LISTEN connection is live');

  await off();
  await subBus.close();
  await pubBus.close();
});

test('a subscriber only gets its own topic, never another tenant\'s', { skip }, async () => {
  const pool = getPool();
  const tA = `fan_${Date.now()}_iso_a`;
  const tB = `fan_${Date.now()}_iso_b`;
  const bus = makePgBus({ pool });

  const gotA = [];
  const off = await bus.subscribe(topicForTenant(tA), (p) => gotA.push(p));

  await bus.publish(topicForTenant(tB), { tenant: tB, cursor: 'x' }); // other tenant
  await bus.publish(topicForTenant(tA), { tenant: tA, cursor: 'y' }); // mine
  await waitFor(() => gotA.length >= 1);

  // Give any stray cross-tenant delivery a beat to (not) arrive.
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(gotA.length, 1, 'only the subscribed tenant delivered');
  assert.equal(gotA[0].tenant, tA);

  await off();
  await bus.close();
});

test('unsubscribe stops delivery (UNLISTEN when last subscriber leaves)', { skip }, async () => {
  const pool = getPool();
  const tenant = `fan_${Date.now()}_unsub`;
  const topic = topicForTenant(tenant);
  const bus = makePgBus({ pool });

  const got = [];
  const off = await bus.subscribe(topic, (p) => got.push(p));
  await bus.publish(topic, { tenant, cursor: '1' });
  await waitFor(() => got.length >= 1);
  await off();

  await bus.publish(topic, { tenant, cursor: '2' });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(got.length, 1, 'no delivery after unsubscribe');

  await bus.close();
});

/* ---------- SCP-149: healthz ---------- */

test('healthz reports ok when DB reachable and LISTEN live', { skip }, async () => {
  const pool = getPool();
  const bus = makePgBus({ pool });
  // Force the LISTEN connection live by subscribing once.
  const off = await bus.subscribe(topicForTenant(`fan_${Date.now()}_hz`), () => {});

  const handler = makeHealthz({ pool, bus });
  const res = fakeRes();
  await handler({}, res);
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).status, 'ok');
  assert.deepEqual(JSON.parse(res.body).checks, { db: true, listen: true });

  await off();
  await bus.close();
});

test('healthz reports 503 when LISTEN connection is not live', { skip }, async () => {
  const pool = getPool();
  const bus = makePgBus({ pool }); // never subscribed → no LISTEN conn
  const handler = makeHealthz({ pool, bus });
  const res = fakeRes();
  await handler({}, res);
  assert.equal(res.statusCode, 503);
  assert.equal(JSON.parse(res.body).status, 'unhealthy');
  assert.equal(JSON.parse(res.body).checks.listen, false);
  await bus.close();
});

function fakeRes() {
  return {
    statusCode: 200,
    body: '',
    headers: null,
    writeHead(code, h) { this.statusCode = code; this.headers = h; },
    end(b) { this.body = b; },
  };
}

test.after(async () => {
  if (available) await closePool();
});
