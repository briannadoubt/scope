// SCP-178 — Features page.
//
// Single page with anchored sections covering the five core capabilities.
// Copy is concrete and technical for a dev audience, not fluffy marketing.

import { page } from '../render.js';

const SECTIONS = [
  {
    id: 'offline',
    kicker: 'Offline-first',
    title: 'Offline-first with a sync-cursor protocol',
    paras: [
      `Every <code>scope</code> command reads and writes a local SQLite cache, so the
       board is instant and fully functional with no network. You can create epics,
       move tickets, and comment on a plane; the work is durable the moment it lands
       in the local event log.`,
      `When you reconnect, a sync-cursor protocol reconciles the local log with a
       remote: each side tracks a cursor over the append-only event stream and pulls
       only what it hasn't seen. Because event files are immutable and globally named,
       reconciliation is an idempotent union &mdash; replaying twice is a no-op &mdash;
       so an interrupted sync simply resumes from the last acknowledged cursor.`,
    ],
  },
  {
    id: 'realtime',
    kicker: 'Realtime',
    title: 'Realtime updates over Server-Sent Events',
    paras: [
      `Run <code>scope serve</code> and the hub fans every mutation out to all connected
       viewers over SSE within roughly 100ms. An in-process event bus emits on each
       write; an <code>fs.watch</code> on <code>.scope/</code> plus a
       <code>PRAGMA data_version</code> check also catches writes from <em>other</em>
       processes (a sibling CLI, another serve), so the browser updates even when the
       change didn't originate in the hub.`,
      `Clients subscribe with a plain <code>EventSource</code>, debounce refreshes, and
       diff by hash to skip no-op renders. The live indicator in the web UI reflects
       connection state &mdash; connected, applying, paused, or disconnected &mdash; and
       a watchdog re-probes and rebuilds the stream if the hub moves.`,
    ],
  },
  {
    id: 'clients',
    kicker: 'Multi-client',
    title: 'CLI, web, and iOS &mdash; one board',
    paras: [
      `The CLI is the agent surface: <code>workspace</code>, <code>ticket</code>,
       <code>epic</code>, <code>link</code>, <code>status</code>, <code>branch</code>,
       <code>pr</code>, and <code>board</code>, each with <code>--json</code> output for
       machine consumption. Agents read state before writing it; humans use the same
       commands interactively.`,
      `The web UI is a GitHub-Projects-style kanban: drag-and-drop columns, a ticket
       drawer with inline edit, a workspace overview, an epic filter, and swimlanes
       that group by epic, assignee, priority, or type. The iOS app is a SwiftUI client
       that discovers the hub over Bonjour, pairs via mTLS, and renders the same board
       and ticket detail with the same live updates.`,
    ],
  },
  {
    id: 'storage',
    kicker: 'Storage',
    title: 'Event-sourced storage: local by default',
    paras: [
      `The source of truth is an append-only log &mdash; one JSON file per change,
       named by a time-sortable ULID. New workspaces keep that log and the SQLite
       cache in machine-local Scope storage so your repo stays quiet; git-carried
       events remain an explicit advanced mode.`,
      `Because every filename is globally unique, two people or agents working in
       parallel never write the same file. Merging is the union of each side's event
       files &mdash; exactly what <code>git pull</code> does for a directory of new files.
       Conflicts resolve deterministically: concurrent field edits are last-writer-wins
       by timestamp (ULID breaks ties), and new tickets, comments, and relations are a
       grow-only union so both survive.`,
      `This works over any dumb file sync &mdash; git, iCloud Drive, Dropbox, Syncthing
       &mdash; because all any of them has to do is deliver new files. You deploy nothing
       to collaborate.`,
    ],
  },
  {
    id: 'hosting',
    kicker: 'Hosted hub',
    title: 'Multi-tenant hosted hub',
    paras: [
      `When you want sub-second live updates across the open internet, run the hosted
       hub. It deploys the Express hub behind public TLS with the canonical event log
       in Postgres; the per-instance SQLite cache is disposable and rebuilt by replaying
       the log. The append-only log remains the source of truth, so the hosted hub is an
       optimization layer, not a lock-in.`,
      `The hosted path is multi-tenant and authenticates with GitHub, while keeping the
       same data model and event semantics as the local hub. Backups capture only the
       canonical <code>events</code> table &mdash; deterministic replay reconstructs the
       board from the log alone, which is also the disaster-recovery guarantee. Prefer to
       run it yourself? The whole thing is self-hostable.`,
    ],
  },
];

/**
 * @param {{ assetPrefix: string, githubLoginPath: string }} ctx
 */
export function renderFeatures(ctx) {
  const nav = SECTIONS.map(
    (s) => `<a href="#${s.id}">${s.kicker}</a>`
  ).join('\n        ');

  const sections = SECTIONS.map((s) => `
    <section class="feature-section" id="${s.id}">
      <p class="kicker">${s.kicker}</p>
      <h2>${s.title}</h2>
      ${s.paras.map((p) => `<p>${p}</p>`).join('\n      ')}
    </section>`).join('\n');

  const body = `
  <div class="page-head">
    <div class="page-head-inner">
      <h1>Features</h1>
      <p>A concrete tour of what Scope does and why it's built the way it is.</p>
      <nav class="anchor-nav" aria-label="Features sections">
        ${nav}
      </nav>
    </div>
  </div>
  <div class="prose-wrap">
    <div class="prose">
${sections}
      <div class="cta-band">
        <h2>See it on your own board</h2>
        <p>Sign in and start tracking, or read how it works first.</p>
        <div class="hero-cta">
          <a class="btn-cta lg" href="${ctx.githubLoginPath}">Sign in with GitHub</a>
          <a class="btn-secondary lg" href="/docs">Read the docs</a>
        </div>
      </div>
    </div>
  </div>`;

  return page({
    title: 'Features',
    description:
      'Offline-first sync, realtime SSE updates, multi-client CLI/web/iOS, event-sourced ' +
      'git-mergeable storage, and a multi-tenant hosted hub.',
    body,
    active: 'features',
    assetPrefix: ctx.assetPrefix,
    githubLoginPath: ctx.githubLoginPath,
    canonicalPath: '/features',
  });
}
