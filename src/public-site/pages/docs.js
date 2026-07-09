// SCP-179..181 — Docs section.
//
// A left sidebar lists every doc page; the content sits in a readable column.
// Pages: index (overview), getting-started, cli, sync, self-hosting. Content is
// adapted from README.md and docs/deploy.md (reference reading only).

import { page } from '../render.js';

// Sidebar entries. `slug` is the path under /docs ('' = the docs index).
const DOC_NAV = [
  { slug: '', label: 'Overview' },
  { slug: 'getting-started', label: 'Getting started' },
  { slug: 'cli', label: 'CLI reference' },
  { slug: 'sync', label: 'Sync' },
  { slug: 'self-hosting', label: 'Self-hosting' },
];

function sidebar(activeSlug) {
  const links = DOC_NAV.map((d) => {
    const href = d.slug ? `/docs/${d.slug}` : '/docs';
    const active = d.slug === activeSlug ? ' class="active"' : '';
    return `<li><a href="${href}"${active}>${d.label}</a></li>`;
  }).join('\n        ');
  return `
    <aside class="docs-sidebar" aria-label="Docs navigation">
      <p class="docs-sidebar-title">Documentation</p>
      <ul>
        ${links}
      </ul>
    </aside>`;
}

/**
 * Wrap a doc page's inner HTML in the docs two-column layout and the full
 * document shell.
 */
function docPage(ctx, { slug, title, description, html }) {
  const body = `
  <div class="docs-layout">
    ${sidebar(slug)}
    <article class="docs-content prose markdown">
${html}
    </article>
  </div>`;
  return page({
    title,
    description,
    body,
    active: 'docs',
    assetPrefix: ctx.assetPrefix,
    githubLoginPath: ctx.githubLoginPath,
    canonicalPath: slug ? `/docs/${slug}` : '/docs',
  });
}

/* ------------------------------------------------------------------ */
/* Individual doc pages                                                */
/* ------------------------------------------------------------------ */

export function renderDocsIndex(ctx) {
  const html = `
      <h1>Scope documentation</h1>
      <p>Scope is a local-first kanban for epics, stories, and bugs &mdash; built so
        coding agents and humans can plan and track work without leaving the command
        line. It ships as a CLI, a web UI, and a hub daemon that fans changes out to
        every viewer over SSE.</p>
      <h2>Start here</h2>
      <ul>
        <li><a href="/docs/getting-started">Getting started</a> &mdash; install, init a
          workspace, create tickets, and run the hub.</li>
        <li><a href="/docs/cli">CLI reference</a> &mdash; the commands you'll use day to
          day, all with <code>--json</code> for agents.</li>
        <li><a href="/docs/sync">Sync</a> &mdash; how local event storage, Scope Cloud,
          and optional git-events mode fit together.</li>
        <li><a href="/docs/self-hosting">Self-hosting</a> &mdash; deploy the hosted hub to
          Fly with Postgres, secrets, and a volume.</li>
      </ul>
      <h2>Mental model</h2>
      <p>The source of truth is an append-only event log. New workspaces store that
        log and the SQLite cache in machine-local Scope storage by default, while the
        repo carries only a small marker. Scope Cloud and the realtime hub layer on top
        of that log; git-carried events are an explicit advanced mode.</p>`;
  return docPage(ctx, {
    slug: '',
    title: 'Docs',
    description: 'Documentation for Scope: getting started, CLI reference, sync, and self-hosting.',
    html,
  });
}

export function renderGettingStarted(ctx) {
  const html = `
      <h1>Getting started</h1>
      <h2>Install</h2>
      <pre><code>brew install briannadoubt/tap/scope     # macOS / Linuxbrew
npm install -g scope-kanban             # any platform with Node &ge; 20
npx scope-kanban --help                 # one-shot, no install</code></pre>

      <h2>Initialize a workspace</h2>
      <p>From inside your repo, create a <code>.scope/</code> directory. On a TTY,
        <code>scope init</code> prompts for a workspace key and name; pass flags to skip
        the prompts (handy for agents and non-interactive shells).</p>
      <pre><code>cd ~/my-app
scope init                               # prompts for key + name
# or non-interactively:
scope init --key MA --name "My App"</code></pre>
      <p>New workspaces keep event files out of the repo by default. Use
        <code>scope init --git-events</code> only when you intentionally want
        <code>.scope/events/</code> carried through git.</p>

      <h2>Create some tickets</h2>
      <pre><code>scope ticket create "Auth refactor" -t epic -p high
scope ticket create "OAuth login"   -t story --parent MA-1
scope status MA-2 in_progress --by me</code></pre>
      <p>Tickets are epics, stories, or bugs. IDs are <code>&lt;KEY&gt;-&lt;n&gt;</code>
        (e.g. <code>MA-3</code>) and are immutable once created.</p>

      <h2>Run the hub</h2>
      <pre><code>scope serve                              # → https://localhost:4321
scope ca trust                           # one-time: trust the local CA</code></pre>
      <p><code>scope serve</code> serves the web UI, the REST API, and the SSE event
        stream. It listens on HTTPS with a leaf cert signed by a local certificate
        authority generated on first run. Trust the CA once with <code>scope ca trust</code>
        so browsers stop warning.</p>
      <p>Multiple agents and a human in the browser all share the workspace's SQLite
        cache; writes from any source push to every viewer over SSE within ~100ms.</p>

      <h2>Install the agent skill</h2>
      <p>Ship the "how to use Scope" skill into Claude Code, Codex, or Cursor so agents
        know when and how to reach for it:</p>
      <pre><code>scope skills install                     # bundled copy
scope skills install --tool claude       # target one tool</code></pre>

      <p>Next: the <a href="/docs/cli">CLI reference</a>.</p>`;
  return docPage(ctx, {
    slug: 'getting-started',
    title: 'Getting started',
    description: 'Install Scope, initialize a workspace, create tickets, and run the hub.',
    html,
  });
}

export function renderCliReference(ctx) {
  // Distilled from the README command table. Every command accepts --json.
  const rows = [
    ['scope init [--key KEY --name NAME] [--git-events]', 'Create <code>.scope/</code> in the current directory. Defaults to machine-local event storage; <code>--git-events</code> opts into <code>.scope/events</code>.'],
    ['scope workspace show', 'Print the current workspace (key, name, description, overview).'],
    ['scope workspace set [--key] [--name] [--description] [--overview]', 'Edit workspace metadata. <code>--key</code> only affects future tickets.'],
    ['scope workspace rekey &lt;KEY&gt;', 'Change the key and reprefix every existing ticket (<code>MA-1</code> → <code>APP-1</code>).'],
    ['scope ticket create &lt;title&gt; -t &lt;type&gt; [--parent &lt;epic&gt;]', 'New ticket in the current workspace.'],
    ['scope ticket list / show / edit / delete', 'Manage tickets. <code>edit</code> accepts a comma-separated id list (atomic).'],
    ['scope status &lt;ids&gt; &lt;status&gt; [--by &lt;name&gt;]', 'Move a ticket to any status id configured in the workspace columns. <code>ids</code> may be comma-separated.'],
    ['scope batch [-f ops.json]', 'Apply many ops as one atomic transaction. Supports <code>$ref</code> to reference a ticket created earlier in the batch.'],
    ['scope branch &lt;id&gt; [&lt;name&gt;] [--in-progress]', 'Get/set branch, optionally flip status.'],
    ['scope pr &lt;id&gt; [&lt;url&gt;] [--in-review | --merged]', 'Get/set PR, optionally flip status.'],
    ['scope link add &lt;from&gt; &lt;type&gt; &lt;to&gt;', 'Relate two tickets (inverse auto-created).'],
    ['scope epic list / children &lt;id&gt;', 'Epic-focused views.'],
    ['scope comment &lt;id&gt; &lt;body&gt; [--by &lt;name&gt;]', 'Add a comment.'],
    ['scope history &lt;id&gt;', 'Change log for a ticket.'],
    ['scope board [--epic &lt;id&gt;]', 'Terminal kanban view.'],
    ['scope serve [-p &lt;port&gt;]', 'Run the hub (auto-attaches to a running hub if one exists).'],
    ['scope ca fingerprint / trust / untrust / path', 'Manage the local certificate authority.'],
    ['scope pair', 'Pair a new native client (prints a one-time 6-digit code).'],
    ['scope skills install [--tool] [--project]', 'Install the agent skill.'],
  ].map(([cmd, desc]) => `<tr><td><code>${cmd}</code></td><td>${desc}</td></tr>`).join('\n        ');

  const html = `
      <h1>CLI reference</h1>
      <p>Every command accepts <code>--json</code> for machine-readable output, which is
        how agents consume Scope. The table below covers the commands you'll reach for
        most; run <code>scope &lt;command&gt; --help</code> for full flags.</p>
      <div class="table-wrap">
        <table class="docs-table">
          <thead><tr><th>Command</th><th>What it does</th></tr></thead>
          <tbody>
        ${rows}
          </tbody>
        </table>
      </div>

      <h2>Data model</h2>
      <ul>
        <li><strong>Workspace</strong> &mdash; a <code>.scope/</code> directory; owns the
          key prefix (e.g. <code>MA</code>), name, description, and overview. One SQLite
          database per workspace.</li>
        <li><strong>Ticket</strong> &mdash; an epic, story, or bug. IDs are
          <code>&lt;KEY&gt;-&lt;n&gt;</code> and immutable.</li>
        <li><strong>Status</strong> &mdash; <code>backlog → todo → in_progress → in_review →
          done</code> (plus <code>cancelled</code>).</li>
        <li><strong>Priority</strong> &mdash; <code>low / medium / high / urgent</code>.</li>
        <li><strong>Relation</strong> &mdash; <code>blocks</code>, <code>blocked_by</code>,
          <code>relates_to</code>, <code>duplicates</code>, <code>duplicate_of</code>
          (inverse auto-created).</li>
      </ul>

      <h2>Agent usage</h2>
      <pre><code>scope --json ticket list --status todo
scope --json ticket create "Fix CSRF on /signup" -t bug --priority high
scope --json status MA-7 in_progress --by claude</code></pre>
      <p>Read state before writing it when multiple agents share a board.</p>`;
  return docPage(ctx, {
    slug: 'cli',
    title: 'CLI reference',
    description: 'Key Scope CLI commands — ticket create, status, board, branch, pr, link, batch — all with --json.',
    html,
  });
}

export function renderSync(ctx) {
  const html = `
      <h1>Sync</h1>
      <p>Scope is event-sourced. The source of truth is an append-only log &mdash; one
        JSON file per change, named by a time-sortable ULID. New workspaces store the
        log and rebuildable <code>scope.db</code> cache under
        <code>~/.scope/workspaces/&lt;id&gt;/</code> so the repo stays quiet. The repo
        carries a small <code>.scope/workspace.json</code> marker and, when connected,
        a safe <code>.scope/remote.json</code> pointer.</p>

      <h2>Scope Cloud</h2>
      <p>The normal sharing path is Scope Cloud. <code>scope connect</code> defaults to
        the deployed cloud endpoint, writes the safe remote pointer, and runs the first
        push/pull sync.</p>
      <pre><code>scope auth login
scope connect
scope remote show</code></pre>

      <h2>Git-events mode</h2>
      <p>Because the log is append-only and every filename is globally unique, two
        people or agents working in parallel never write the same file. Merging is just
        the union of each side's event files &mdash; exactly what <code>git pull</code>
        does for a directory of new files. There is no binary SQLite merge, so there is
        nothing to corrupt.</p>
      <pre><code># commit the log (NOT the cache)
scope init --git-events
git add .scope/events && git commit -m "scope: plan auth work"
git pull          # brings in teammates' event files
# next \`scope\` command rebuilds scope.db from the merged log — automatically
scope board</code></pre>

      <h2>Conflict resolution</h2>
      <p>Conflicts resolve deterministically without coordination:</p>
      <ul>
        <li><strong>Concurrent field edits</strong> &mdash; last-writer-wins by timestamp
          (ULID breaks ties).</li>
        <li><strong>New tickets / comments / relations</strong> &mdash; grow-only union;
          both survive.</li>
        <li><strong>Ticket numbers</strong> (<code>SCP-42</code>) are display values
          de-collided at replay &mdash; the earliest creator keeps the number; a colliding
          offline create is bumped.</li>
      </ul>
      <p>This advanced mode works over any dumb file sync &mdash; git, iCloud Drive,
        Dropbox, Syncthing &mdash; because all any of them has to do is deliver new
        files. Move between modes with <code>scope events move-to-local</code> and
        <code>scope events move-to-git</code>.</p>

      <h2>Syncing to a remote hub</h2>
      <p><code>scope sync</code> remains the low-level one-shot command. It walks a sync
        cursor over the append-only stream: it pushes local events the remote hasn't
        acknowledged and pulls remote events past your last-seen cursor.</p>
      <pre><code>scope sync   # after scope connect has written .scope/remote.json</code></pre>
      <p>Because reconciliation is an idempotent union of immutable files, an interrupted
        sync resumes from the last acknowledged cursor &mdash; replaying twice is a no-op.
        Going offline and syncing later loses nothing; the log remains the source of truth
        and the hub is an optimization on top of it.</p>`;
  return docPage(ctx, {
    slug: 'sync',
    title: 'Sync',
    description: 'How Scope syncs local event storage through Scope Cloud, with optional git-events mode.',
    html,
  });
}

export function renderSelfHosting(ctx) {
  // Adapted from docs/deploy.md (Fly deploy, secrets, volume).
  const html = `
      <h1>Self-hosting</h1>
      <p>You can run your own hosted Scope hub. The reference deploy is a single cloud
        instance on Fly.io behind public TLS, with the canonical event log in Postgres
        and a disposable SQLite cache on a volume. The hub's realtime fan-out is an
        in-process event bus, so phase 1 is deliberately one machine &mdash; do not scale
        <code>min_machines_running</code> past 1.</p>

      <h2>Prerequisites</h2>
      <ul>
        <li><code>flyctl</code> installed and authenticated (<code>fly auth login</code>).</li>
        <li>A Postgres database for the canonical log (Fly Postgres, Neon, Supabase, RDS).</li>
        <li>A domain you control for the custom TLS hostname.</li>
      </ul>

      <h2>Create the app and volume</h2>
      <pre><code>fly apps create &lt;your-app&gt;
fly volumes create scope_data --size 1 --region &lt;region&gt;</code></pre>

      <h2>Set secrets</h2>
      <pre><code>fly secrets set \\
  SCOPE_PG_URL="postgres://user:pass@host:5432/scope?sslmode=require" \\
  SCOPE_TOKEN="$(openssl rand -hex 32)"</code></pre>
      <p>Save the <code>SCOPE_TOKEN</code> value &mdash; clients use it as the bearer token
        (the interim credential alongside GitHub login).</p>

      <h2>Deploy and attach TLS</h2>
      <pre><code>fly deploy --remote-only
fly certs add scope.example.com
fly certs show scope.example.com   # wait for "Status: Ready"</code></pre>
      <p>Fly issues and renews the certificate. Add the DNS records it prints.</p>

      <h2>Smoke test</h2>
      <pre><code>curl -fsS https://scope.example.com/healthz
curl -fsS -H "Authorization: Bearer $SCOPE_TOKEN" \\
     https://scope.example.com/api/meta | jq .version
# SSE survives the proxy (stays open past 60s):
curl -N -H "Authorization: Bearer $SCOPE_TOKEN" https://scope.example.com/events</code></pre>

      <h2>Required secrets &amp; env</h2>
      <div class="table-wrap">
        <table class="docs-table">
          <thead><tr><th>Name</th><th>Purpose</th></tr></thead>
          <tbody>
            <tr><td><code>SCOPE_PG_URL</code></td><td>Canonical Postgres event log + cache. Required; <code>/healthz</code> readiness probes it.</td></tr>
            <tr><td><code>SCOPE_TOKEN</code></td><td>Bearer token clients use (interim until GitHub OAuth).</td></tr>
            <tr><td><code>FLY_API_TOKEN</code></td><td>GitHub Actions secret that lets the deploy workflow run <code>fly deploy</code>.</td></tr>
            <tr><td><code>SCOPE_DIR</code></td><td>Path for the disposable SQLite cache on the volume (<code>/data/.scope</code>).</td></tr>
            <tr><td><code>SCOPE_CLOUD</code></td><td>Flags the cloud build to disable Bonjour / mTLS / loopback-bypass.</td></tr>
            <tr><td><code>LOG_LEVEL</code></td><td><code>debug</code>/<code>info</code>/<code>warn</code>/<code>error</code>; default <code>info</code>.</td></tr>
          </tbody>
        </table>
      </div>

      <h2>Backup &amp; recovery</h2>
      <p>Only the canonical <code>events</code> table in Postgres is backed up &mdash; the
        SQLite cache and Postgres cache tables are disposable and rebuilt by replaying the
        log. A nightly <code>pg_dump --data-only --table=events</code> to a versioned bucket
        is the disaster-recovery guarantee: deterministic replay reconstructs the board from
        the log alone, with zero reliance on any cache.</p>`;
  return docPage(ctx, {
    slug: 'self-hosting',
    title: 'Self-hosting',
    description: 'Deploy your own hosted Scope hub to Fly.io with Postgres, secrets, a volume, and public TLS.',
    html,
  });
}

export { DOC_NAV };
