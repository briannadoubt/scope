// SCP-176..181 — Public marketing + documentation site (CLOUD-ONLY).
//
// This module exports a *mountable* Express router for the public-facing site
// (landing, features, docs) plus the list of path prefixes it owns. The hosted
// server mounts this router ONLY in cloud mode and lets PUBLIC_PREFIXES bypass
// auth; nothing here assumes it is always mounted, and the router defines only
// EXPLICIT public paths — never a catch-all `*` — so it cannot swallow /app or
// /api routes the parallel auth/app work owns.

import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { renderLanding } from './pages/landing.js';
import { renderFeatures } from './pages/features.js';
import {
  renderDocsIndex,
  renderGettingStarted,
  renderCliReference,
  renderSync,
  renderSelfHosting,
} from './pages/docs.js';

// ESM __dirname (no global in modules) — points static serving at the local
// assets directory regardless of the process CWD.
const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = join(__dirname, 'assets');

// URL prefix under which the stylesheet and any future static assets are served.
const ASSET_PREFIX = '/site-assets';

/**
 * Path prefixes this router owns. The caller (server.js, cloud mode) uses these
 * to let public traffic bypass authentication. They are intentionally a small,
 * explicit set — NOT a wildcard — so /app and /api remain owned by other code.
 *
 * @type {string[]}
 */
export const PUBLIC_PREFIXES = ['/', '/features', '/docs', ASSET_PREFIX];

/**
 * Build the public-site router.
 *
 * @param {object} [opts]
 * @param {string} [opts.appPath='/app']            - where the authenticated app lives (for nav/CTAs that link into the app).
 * @param {string} [opts.githubLoginPath='/auth/login'] - where the "Sign in with GitHub" button points.
 * @returns {import('express').Router}
 */
export function createPublicSiteRouter(opts = {}) {
  const appPath = opts.appPath || '/app';
  const githubLoginPath = opts.githubLoginPath || '/auth/login';

  // Shared context handed to every page renderer.
  const ctx = { assetPrefix: ASSET_PREFIX, githubLoginPath, appPath };

  const router = express.Router();

  // Small helper to send a rendered HTML document.
  const html = (res, doc) =>
    res.type('html').set('Cache-Control', 'public, max-age=300').send(doc);

  // Static assets (CSS, etc.). express.static only matches files that exist, so
  // a miss falls through to the next handler instead of swallowing the path.
  router.use(
    ASSET_PREFIX,
    express.static(ASSETS_DIR, {
      maxAge: '1h',
      fallthrough: true,
      index: false,
    }),
  );

  // Landing — SCP-177.
  router.get('/', (_req, res) => html(res, renderLanding(ctx)));

  // Features — SCP-178 (single page with anchored sections).
  router.get('/features', (_req, res) => html(res, renderFeatures(ctx)));

  // Docs — SCP-179..181. Explicit routes only; no catch-all.
  router.get('/docs', (_req, res) => html(res, renderDocsIndex(ctx)));
  router.get('/docs/getting-started', (_req, res) => html(res, renderGettingStarted(ctx)));
  router.get('/docs/cli', (_req, res) => html(res, renderCliReference(ctx)));
  router.get('/docs/sync', (_req, res) => html(res, renderSync(ctx)));
  router.get('/docs/self-hosting', (_req, res) => html(res, renderSelfHosting(ctx)));

  return router;
}

export default createPublicSiteRouter;
