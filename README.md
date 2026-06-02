# scope

Local-first kanban for epics, stories, and bugs — built so coding
agents and humans can plan and track work without leaving the command line.

Ships as a **CLI**, a **GitHub-Projects-style web UI**, and a **hub daemon**
(`scope serve`) that fans changes out to every viewer over SSE. Everything
lives in a `.scope/` directory in your repo (SQLite, WAL mode), so it works
offline, syncs through git if you want, and needs no external service.

```
brew install briannadoubt/tap/scope     # macOS / Linuxbrew
npm install -g scope-kanban             # any platform with Node ≥20
npx scope-kanban --help                 # one-shot, no install
```

## Quick start

```bash
cd ~/my-app
scope init                               # prompts for workspace key + name on a TTY
scope workspace set --key MA --name "My App" --description "Short blurb"
scope ticket create "Auth refactor" -t epic -p high
scope ticket create "OAuth login"   -t story --parent MA-1
scope serve                              # → https://localhost:4321 (also https://scope.local:4321)
scope ca trust                           # one-time: trust the local CA so browsers stop warning
```

`scope init` accepts `--key MA --name "My App"` if you want to skip the prompts
(e.g. from another agent or a non-interactive shell).

## LAN security

`scope serve` listens on **HTTPS** with a leaf cert signed by a local
certificate authority (generated on first run, persisted to
`~/.scope-hub/ca/`). Authentication is layered:

- **Browser path** — a bearer token stored in a cookie. Bookmark
  `https://scope.local:4321/?token=…` once (printed at startup) and the
  cookie does the rest. Loopback connections from the same machine bypass
  the token check entirely so `scope` CLI commands work without
  configuration.
- **Native path (SwiftUI app, etc.)** — clients pair with `scope pair` and
  get a client certificate signed by the local CA. mTLS replaces the
  bearer token for those connections; see `scope devices list`.

To clear the browser cert warning, trust the local CA once:

```bash
scope ca trust            # System keychain, sudo (recommended)
scope ca trust --user     # login keychain, no sudo (per-user only)
scope ca fingerprint      # print SHA-256 for out-of-band verification
scope ca untrust          # reverses `scope ca trust`
```

The CA's private key lives at `~/.scope-hub/ca/ca.key` (mode `0600`) and
never leaves the machine. The cert at `~/.scope-hub/ca/ca.crt` is what gets
trusted by the keychain.

## What ships today

- **CLI** — `workspace / ticket / epic / link / status / branch / pr / board`
  with `--json` output on every command for agent consumption.
- **Web UI** — kanban columns, drag-and-drop, ticket drawer with inline edit,
  workspace overview, epic filter, **swimlanes** (group by epic / assignee /
  priority / type), live updates via SSE.
- **`scope serve` hub** — one long-lived process that serves the UI, the REST
  API, and the SSE event stream on `https://localhost:4321` (loopback HTTP
  also bound for CLI traffic). Multiple agents and a human in the browser all
  share the workspace's SQLite DB; writes from any source push to every viewer
  over Server-Sent Events within ~100ms.
- **Self-healing federated hub** — every `scope serve` invocation
  auto-discovers a running hub (default port `4321`, walks forward to `4330`
  if taken by a non-scope process) and registers its local `.scope/` workspace
  with it. First one to start binds the port; the rest idle with a watchdog
  that promotes a survivor if the hub-owning process dies. Concurrent Claude
  Code sessions / previews / repos all converge on the same UI, no port flags
  required. Each repo keeps its own `.scope/scope.db` (so it travels with
  `git clone`).
- **iOS app** — SwiftUI client that discovers the hub over Bonjour, pairs via
  mTLS, and renders the same board + ticket detail + live updates. Lives in
  `App/` in this repo.

## The web UI

```bash
scope serve
```

The **Group by** picker in the topbar turns the board into swimlanes — one
horizontal row per epic, assignee, priority, or type, each with its own
status columns. State (group choice, collapsed lanes) persists in
`localStorage`.

The little dot next to the refresh button is your live indicator:
**green** = SSE connected, **blue flash** = just applied a change,
**gray** = paused (drawer/modal/input/drag), **red** = disconnected.
Clicking refresh during a red indicator triggers an active hub re-probe
and rebuilds the SSE connection.

## Agent integration

Agents call scope via the CLI — every command supports `--json` for
machine-readable output. No MCP server, no extra config; if `scope` is on
`$PATH` it works.

```jsonc
// example tool use from an agent
scope --json ticket list --status todo
scope --json ticket create "Fix CSRF on /signup" -t bug --priority high
scope --json status MA-7 in_progress --by claude
```

Ship the "how to use scope" skill into Claude Code, Codex, or Cursor:

```bash
scope skills install                      # uses bundled copy from your install
curl -fsSL https://raw.githubusercontent.com/briannadoubt/scope/main/skills/install.sh | bash   # remote
```

Force a subset or target a specific repo:

```bash
scope skills install --tool claude
scope skills install --tool cursor --project /path/to/repo
```

The skill teaches the agent **when** to reach for Scope (multi-step work,
status updates, bug tracking), **how** to invoke it (CLI with `--json`), the
data model, and a handful of guardrails (e.g. *read state before writing
state* when multiple agents share a board).

### Previewing in Claude Code

If you want the kanban available in Claude Code's preview pane, use
`scope preview --port <unique>` in `.claude/launch.json` — **never** plain
`scope serve` for previews:

```json
{
  "version": "0.0.1",
  "configurations": [
    {
      "name": "scope-myproject",
      "runtimeExecutable": "scope",
      "runtimeArgs": ["preview", "--port", "4322"],
      "port": 4322,
      "autoPort": false
    }
  ]
}
```

**Why:** Claude Code's `preview_start` enforces one tracked server per port.
If two projects both register `port: 4321` (the hub), opening the preview in
the second pane forcibly stops the first pane's tracked process — the iframe
goes blank with "The preview server stopped." Even with unique server names
this happens, because the collision is on `port`.

`scope preview --port <N>` works around this with a tiny per-pane reverse
proxy: each project picks its own port (e.g. 4322, 4323, ...), and every
proxy forwards to the single shared hub on 4321. Each pane gets its own
preview-tracked server (no collision), all viewers see the same federated
kanban. The first `scope preview` to run lazily starts the hub via the
usual `ensureHub()` path; subsequent ones just proxy.

Pick a different port for every project (suggested range: 4322–4399).

## Data model

| | |
|---|---|
| **Hub** | The `scope serve` daemon. Discovers and brokers traffic across one or more workspaces on a machine / LAN. |
| **Workspace** | A `.scope/` directory: owns the key prefix (e.g. `MA`), name, description, and overview. Each workspace is one SQLite database. |
| **Ticket** | Epic, story, or bug. Belongs to one workspace. IDs are `<KEY>-<n>` (e.g. `MA-3`). |
| **Epic** | High-level work. Parents stories and bugs. |
| **Story** | Unit of work toward an epic. |
| **Bug** | Defect. Can live under an epic. |
| **Status** | `backlog` → `todo` → `in_progress` → `in_review` → `done` (+ `cancelled`) |
| **Priority** | `low` / `medium` / `high` / `urgent` |
| **Relation** | `blocks`, `blocked_by`, `relates_to`, `duplicates`, `duplicate_of` (inverse auto-created) |

Ticket IDs are immutable — once a ticket is created, its prefix is baked into
its ID. Changing the workspace key after the fact leaves old tickets with the
old prefix.

## Collaboration — deploy nothing, just `git pull`

Scope is event-sourced. The source of truth is an **append-only log** under
`.scope/events/` — one JSON file per change, named by a time-sortable ULID.
`scope.db` is a **cache** rebuilt from that log on demand; it is gitignored (via
`.scope/.gitignore`, written by `scope init`) and must never be committed.

Because the log is append-only and every file name is globally unique, two
people (or agents) working in parallel **never write the same file**. Merging is
just the *union* of each side's event files — exactly what `git pull` does for a
directory of new files. There is no binary SQLite merge, so there is nothing to
corrupt:

```bash
# commit the log (NOT the cache)
git add .scope/events && git commit -m "scope: plan auth work"
git pull          # brings in teammates' event files
# next `scope` command rebuilds scope.db from the merged log — automatically
scope board
```

Conflicts resolve deterministically without coordination:

- **Concurrent field edits** → last-writer-wins by timestamp (ULID breaks ties).
- **New tickets / comments / relations** → grow-only union; both survive.
- **Ticket numbers** (`SCP-42`) are display values de-collided at replay — the
  earliest creator keeps the number; a colliding offline create is bumped.

This works over **any** dumb file sync — git, iCloud Drive, Dropbox, Syncthing —
because all any of them has to do is deliver new files. No server to deploy.

When you *do* want sub-second live updates, run `scope serve`: the hub brokers
changes over SSE/mTLS on a machine or LAN. That's an optimization on top of the
same log — the log remains the source of truth, so going offline and syncing
later loses nothing. (Real-time across the open internet with zero
infrastructure is the one thing that's out of scope — that always needs a
meeting point.)

See [docs/event-log-format.md](docs/event-log-format.md) and
[docs/adr/0001-decentralized-ticket-identity.md](docs/adr/0001-decentralized-ticket-identity.md)
for the format and conflict semantics.

## Command reference

| Command | What it does |
|---|---|
| `scope init [--key KEY --name NAME]` | Create `.scope/` in the current directory. Prompts on a TTY if flags are omitted. |
| `scope workspace show` | Print the current workspace (key, name, description, overview). |
| `scope workspace set [--key KEY] [--name NAME] [--description ...] [--overview ...]` | Edit workspace metadata. `--key` only affects future tickets. |
| `scope workspace rekey <KEY>` | Change the key **and reprefix every existing ticket** (`MA-1` → `APP-1`). The correct way to rename a key. |
| `scope workspace add / list / remove` | Manage which workspaces the running hub knows about. |
| `scope ticket create <title> -t <type> [--parent <epic>]` | New ticket in the current workspace. |
| `scope ticket list / show / edit / delete` | Manage tickets. `edit` accepts a comma-separated id list (atomic). |
| `scope status <ids> <status> [--by <name>]` | Move a ticket. `ids` may be comma-separated to move several atomically. |
| `scope batch [-f ops.json]` | Apply many ops as one atomic transaction (or pipe the JSON array on stdin). Supports `$ref` to reference a ticket created earlier in the batch. The supported path for bulk/compound edits — never edit `scope.db` directly. |
| `scope branch <id> [<name>] [--in-progress]` | Get/set branch, optionally flip status. |
| `scope pr <id> [<url>] [--in-review\|--merged]` | Get/set PR, optionally flip status. |
| `scope link add <from> <type> <to>` | Relate two tickets. |
| `scope epic list / children <id>` | Epic-focused views. |
| `scope comment <id> <body> [--by <name>]` | Add a comment. |
| `scope history <id>` | Change log for a ticket. |
| `scope board [--epic <id>]` | Terminal kanban view. |
| `scope serve [-p <port>]` | Run the hub (auto-attaches to a running hub if one exists). |
| `scope preview --port <N>` | Run a per-pane proxy to the hub. For Claude Code's `.claude/launch.json` — each pane uses a unique port so `preview_start` doesn't make panes stop each other. |
| `scope ca fingerprint / trust / untrust / path` | Manage the local certificate authority. |
| `scope pair` | Pair a new native client (prints a one-time 6-digit code). |
| `scope devices list / rename` | Inspect or rename paired native clients. |
| `scope skills install [--tool ...] [--project ...]` | Install agent skill. |

> **Deprecated.** `scope project create / show / list / edit` are kept as
> aliases that route to the `scope workspace` commands and print a yellow
> warning. `scope project delete` errors out — there's nothing to delete now
> that each workspace owns exactly one project. `scope ticket create` still
> accepts `--project <KEY>` but ignores it with a deprecation warning.

Every command accepts `--json` for machine-readable output.

## Architecture

- **Storage** — SQLite via `better-sqlite3`, in `.scope/scope.db`. WAL mode
  for safe multi-process writes; serialization happens at the SQLite layer.
  Each DB has a singleton `workspace` row (key, name, description, overview)
  and a `tickets` table — the old `projects` table has been folded into
  `workspace`. Existing DBs migrate on first open.
- **CLI** — Node 20+ ES modules, `commander` for parsing.
- **Server** — Express. Mounts the REST API and an SSE `/events` channel.
  `GET /api/workspaces` returns `{id, scope_dir, label, key, name,
  description, overview}`; `GET /api/projects` is kept as a back-compat shim
  that synthesizes one project per workspace for older clients.
- **Realtime** — in-process `EventEmitter` bus emits on every mutation;
  `fs.watch` on `.scope/` plus a `PRAGMA data_version` check catches writes
  from *other* processes (CLI, sibling serve processes) and feeds them into
  the same bus. UI subscribes via `EventSource`, debounces refresh, and
  diffs by hash to skip no-op renders.
- **Hub coordination** — discovery file at `~/.scope-hub/hub.json`,
  workspace registry at `~/.scope-hub/workspaces.json`. The watchdog in
  every long-lived process polls `/api/meta` and re-runs `ensureHub()` if
  the current hub stops answering, so the UI never goes blank for surviving
  workspaces.

## Releasing

`npm run release` bumps the patch version, tags, and pushes. From there,
[`.github/workflows/release.yml`](.github/workflows/release.yml) takes over:

1. Verifies tag matches `package.json`.
2. `npm publish --provenance --access public` to the npm registry.
3. Fetches the GitHub source tarball and computes its sha256.
4. Patches [`Formula/scope.rb`](Formula/scope.rb) and pushes it into
   [`briannadoubt/homebrew-tap`](https://github.com/briannadoubt/homebrew-tap)
   via an SSH deploy key.
5. Creates a GitHub release with auto-generated notes.

Bump types:

```bash
npm run release            # patch
npm run release minor
npm run release major
npm run release 1.0.0      # explicit
```

## Repo layout

```
.
├── bin/scope.js              # CLI entrypoint
├── src/
│   ├── cli.js                # commander wiring
│   ├── db.js                 # SQLite schema, migrations, id generation
│   ├── repo.js               # data layer (emits change events)
│   ├── events.js             # in-process bus
│   ├── server.js             # Express: REST + SSE + UI
│   ├── hub.js                # auto-discovery + watchdog
│   ├── workspaces.js         # workspace registry
│   ├── format.js             # terminal table / board renderers
│   └── web/                  # vanilla-JS SPA (no build step)
├── App/                      # SwiftUI iOS client
├── skills/                   # agent skills (Claude / Codex / Cursor)
├── Formula/scope.rb          # Homebrew formula
├── .github/workflows/        # tag-driven release
└── scripts/release.sh        # local bump + tag + push wrapper
```

## License

MIT — see [LICENSE](LICENSE).
