// SCP-176..181 — Public marketing + docs site router tests.
//
// The public site is CLOUD-ONLY and ships as a mountable router. These tests
// mount it on a BARE express app (no auth, no server.js wiring) and assert:
//   - the public pages render (200 + expected content),
//   - the stylesheet serves with the right content-type,
//   - and crucially that the router does NOT define a catch-all: /app and
//     /api/* must 404 from the bare app, proving the router didn't grab them.
//
// Self-contained: starts the app on an ephemeral port (listen(0)), fetches,
// and closes — following the repo's node:test + node:assert/strict convention.

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { createPublicSiteRouter, PUBLIC_PREFIXES } from '../src/public-site/index.js';

/** Mount the router on a bare app, listen on an ephemeral port, return helpers. */
async function startApp() {
  const app = express();
  app.use(createPublicSiteRouter());

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    async close() {
      await new Promise((r) => server.close(() => r()));
    },
  };
}

test('GET / returns the landing page with the hero headline', async () => {
  const app = await startApp();
  try {
    const res = await fetch(`${app.base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/html/);
    const body = await res.text();
    // Hero headline / positioning line.
    assert.match(body, /The local-first kanban for engineers and their agents\./);
    // Primary + secondary CTAs are present.
    assert.match(body, /Sign in with GitHub/);
    assert.match(body, /Read the docs/);
  } finally {
    await app.close();
  }
});

test('GET /features returns 200 with feature content', async () => {
  const app = await startApp();
  try {
    const res = await fetch(`${app.base}/features`);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /Realtime updates over Server-Sent Events/);
    assert.match(body, /Event-sourced storage/i);
  } finally {
    await app.close();
  }
});

test('GET /docs and doc sub-pages return 200', async () => {
  const app = await startApp();
  try {
    for (const path of [
      '/docs',
      '/docs/getting-started',
      '/docs/cli',
      '/docs/sync',
      '/docs/self-hosting',
    ]) {
      const res = await fetch(`${app.base}${path}`);
      assert.equal(res.status, 200, `expected 200 for ${path}`);
      const body = await res.text();
      assert.match(body, /<aside class="docs-sidebar"/, `sidebar missing on ${path}`);
    }
  } finally {
    await app.close();
  }
});

test('the CSS asset serves with content-type text/css', async () => {
  const app = await startApp();
  try {
    const res = await fetch(`${app.base}/site-assets/site.css`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/css/);
    const body = await res.text();
    // Sanity: the theme custom properties are present (matches the app theme).
    assert.match(body, /--accent:/);
  } finally {
    await app.close();
  }
});

test('router does NOT swallow /app or /api/* (no catch-all)', async () => {
  const app = await startApp();
  try {
    // Bare app has no handler for these — if the router defined a catch-all,
    // they'd return 200 instead of Express's default 404.
    const appRes = await fetch(`${app.base}/app`);
    assert.equal(appRes.status, 404);

    const apiRes = await fetch(`${app.base}/api/anything`);
    assert.equal(apiRes.status, 404);

    // An unknown asset under the static prefix also falls through to 404
    // (fallthrough: true) rather than being served.
    const missingAsset = await fetch(`${app.base}/site-assets/nope.css`);
    assert.equal(missingAsset.status, 404);
  } finally {
    await app.close();
  }
});

test('PUBLIC_PREFIXES advertises the owned path prefixes', async () => {
  assert.ok(Array.isArray(PUBLIC_PREFIXES));
  for (const p of ['/', '/features', '/docs', '/site-assets']) {
    assert.ok(PUBLIC_PREFIXES.includes(p), `PUBLIC_PREFIXES should include ${p}`);
  }
});
