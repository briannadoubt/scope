// SCP-177 — Landing page content.
//
// Positions Scope as "the local-first kanban for engineers and their agents."
// Copy is concrete and technical (dev audience). Primary CTA → GitHub login,
// secondary CTA → /docs. Followed by a short "how it works" highlights grid.

import { page, SITE_NAME, SITE_TAGLINE } from '../render.js';

/**
 * @param {{ assetPrefix: string, githubLoginPath: string, appPath: string }} ctx
 */
export function renderLanding(ctx) {
  const body = `
  <section class="hero">
    <div class="hero-inner">
      <p class="eyebrow">CLI &middot; Web &middot; iOS &middot; Hosted hub</p>
      <h1 class="hero-title">${SITE_TAGLINE}</h1>
      <p class="hero-sub">
        Scope is a local-first kanban for epics, stories, and bugs. It works offline,
        syncs through git or any dumb file sync, and streams realtime updates over SSE
        the moment you bring a hub online. Plan and track work from the terminal, the
        browser, or your phone &mdash; alongside the agents doing the work.
      </p>
      <div class="hero-cta">
        <a class="btn-cta lg" href="${ctx.githubLoginPath}">Sign in with GitHub</a>
        <a class="btn-secondary lg" href="/docs">Read the docs</a>
      </div>
      <pre class="hero-code"><code>$ brew install briannadoubt/tap/scope
$ scope init
$ scope ticket create "Auth refactor" -t epic -p high
$ scope serve            <span class="cmt"># → realtime board over SSE</span></code></pre>
    </div>
  </section>

  <section class="value-props">
    <div class="section-head">
      <h2>Built for how engineers and agents actually work</h2>
      <p>No external service required. The source of truth is an append-only event
        log in your repo &mdash; everything else is a cache you can throw away.</p>
    </div>
    <div class="card-grid">
      <article class="feature-card">
        <h3>Offline-first, then it syncs</h3>
        <p>Every command runs against a local SQLite cache, so the board is instant
          and works on a plane. A sync-cursor protocol reconciles with a remote when
          you reconnect &mdash; nothing is lost going offline.</p>
      </article>
      <article class="feature-card">
        <h3>Event-sourced &amp; git-mergeable</h3>
        <p>Changes are append-only JSON events named by time-sortable ULIDs. Two
          people never write the same file, so merging is just a <code>git pull</code>.
          Deploy nothing to collaborate.</p>
      </article>
      <article class="feature-card">
        <h3>Realtime over SSE</h3>
        <p>Run <code>scope serve</code> and every viewer &mdash; CLI, browser, iOS &mdash;
          gets writes pushed over Server-Sent Events within ~100ms. The log stays the
          source of truth; realtime is an optimization on top.</p>
      </article>
      <article class="feature-card">
        <h3>CLI, web, and iOS clients</h3>
        <p>A <code>--json</code> CLI for agents, a GitHub-Projects-style web UI with
          drag-and-drop and swimlanes, and a SwiftUI app that discovers the hub and
          renders the same live board.</p>
      </article>
      <article class="feature-card">
        <h3>Self-hostable hosted hub</h3>
        <p>Want sub-second updates across the internet? Run the multi-tenant hosted
          hub. It deploys to Fly behind public TLS with the canonical event log in
          Postgres &mdash; or self-host the whole thing.</p>
      </article>
      <article class="feature-card">
        <h3>Agent-native</h3>
        <p>Every command speaks <code>--json</code>. A bundled skill teaches Claude
          Code, Codex, and Cursor when to reach for Scope and how to read state
          before writing it when multiple agents share a board.</p>
      </article>
    </div>
  </section>

  <section class="how-it-works">
    <div class="section-head">
      <h2>How it works</h2>
      <p>Three moving parts, one source of truth.</p>
    </div>
    <ol class="steps">
      <li>
        <span class="step-n">1</span>
        <div>
          <h3>Write events locally</h3>
          <p>Each mutation appends one immutable JSON file under
            <code>.scope/events/</code>. The SQLite cache (<code>scope.db</code>) is
            rebuilt from the log on demand and is gitignored.</p>
        </div>
      </li>
      <li>
        <span class="step-n">2</span>
        <div>
          <h3>Sync the log however you like</h3>
          <p>Commit the events and <code>git pull</code> &mdash; or let iCloud, Dropbox,
            or Syncthing deliver the files. Conflicts resolve deterministically:
            last-writer-wins per field, grow-only union for new records.</p>
        </div>
      </li>
      <li>
        <span class="step-n">3</span>
        <div>
          <h3>Go live when you want</h3>
          <p>Bring up a hub for realtime fan-out across a LAN or the hosted cloud.
            Drop offline and resync later &mdash; the append-only log loses nothing.</p>
        </div>
      </li>
    </ol>
    <div class="cta-band">
      <h2>Start tracking work in two commands</h2>
      <p>Free, open-source, and MIT-licensed. Bring your own GitHub account.</p>
      <div class="hero-cta">
        <a class="btn-cta lg" href="${ctx.githubLoginPath}">Sign in with GitHub</a>
        <a class="btn-secondary lg" href="/docs/getting-started">Getting started</a>
      </div>
    </div>
  </section>`;

  return page({
    title: SITE_NAME,
    description:
      'Scope is the local-first kanban for engineers and their agents — offline-first, ' +
      'event-sourced and git-mergeable, with realtime SSE updates across CLI, web, and iOS.',
    body,
    active: '',
    assetPrefix: ctx.assetPrefix,
    githubLoginPath: ctx.githubLoginPath,
    canonicalPath: '/',
  });
}
