# scope

Local-first kanban for projects, epics, stories, and bugs — built so coding
agents and humans can plan and track work without leaving the command line.

Ships as a **CLI** and a **GitHub-Projects-style web UI**. Everything lives in
a `.scope/` directory in your repo (SQLite, WAL mode), so it works offline,
syncs through git if you want, and needs no server.

```
brew install briannadoubt/tap/scope     # macOS / Linuxbrew
npm install -g scope-kanban             # any platform with Node ≥20
npx scope-kanban --help                 # one-shot, no install
```

## Quick start

```bash
cd ~/my-app
scope init
scope project create my-app MA "My App"
scope ticket create MA "Auth refactor" -t epic -p high
scope ticket create MA "OAuth login"   -t story --parent MA-1
scope serve                              # → https://localhost:4321 (also https://scope.local:4321)
scope ca trust                           # one-time: trust the local CA so browsers stop warning
```

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

## What you get

- **CLI** — `project / ticket / epic / link / status / branch / pr / board`
  with `--json` output on every command for agent consumption.
- **Web UI** — kanban columns, drag-and-drop, ticket drawer with inline edit,
  project overview, epic filter, **swimlanes** (group by epic / assignee /
  priority / type), live updates via SSE.
- **`scope serve`** — one long-lived process that serves the UI, the REST
  API, and the SSE event stream on `http://localhost:4321`. Multiple agents
  and a human in the browser all share one SQLite DB; writes from any source
  push to every viewer over Server-Sent Events within ~100ms.
- **Self-healing federated hub** — every `scope serve` invocation
  auto-discovers a running hub (default port `4321`, walks forward to `4330`
  if taken by a non-scope process) and registers its local `.scope/` with it.
  First one to start binds the port; the rest idle with a watchdog that
  promotes a survivor if the hub-owning process dies. Concurrent Claude Code
  sessions / previews / repos all converge on the same UI, no port flags
  required. Each repo keeps its own `.db` file (so it travels with `git clone`).

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
scope --json ticket list -p MA --status todo
scope --json ticket create MA "Fix CSRF on /signup" -t bug --priority high
scope --json status MA-7 in_progress --by claude
```

Ship the "how to use scope" skill into Claude Code, Codex, or Cursor:

```bash
scope skills install                      # uses bundled copy from your install
curl -fsSL https://raw.githubusercontent.com/briannadoubt/scope/main/skills/install.sh | bash   # remote
```

Force a subset or target a specific Cursor project:

```bash
scope skills install --tool claude
scope skills install --tool cursor --project /path/to/repo
```

The skill teaches the agent **when** to reach for Scope (multi-step work,
status updates, bug tracking), **how** to invoke it (CLI with `--json`), the
data model, and a handful of guardrails (e.g. *read state before writing
state* when multiple agents share a board).

## Data model

| | |
|---|---|
| **Project** | Top-level container. Slug + 2–10 letter key (e.g. `MA`). |
| **Epic** | High-level work. Parents stories and bugs. |
| **Story** | Unit of work toward an epic. |
| **Bug** | Defect. Can live under an epic. |
| **Status** | `backlog` → `todo` → `in_progress` → `in_review` → `done` (+ `cancelled`) |
| **Priority** | `low` / `medium` / `high` / `urgent` |
| **Relation** | `blocks`, `blocked_by`, `relates_to`, `duplicates`, `duplicate_of` (inverse auto-created) |

Ticket IDs look like `MA-3` (project key + number).

## Command reference

| Command | What it does |
|---|---|
| `scope init` | Create `.scope/` in the current directory |
| `scope project create <id> <KEY> <name>` | New project |
| `scope project list / show / edit / delete` | Manage projects |
| `scope ticket create <KEY> <title> -t <type> [--parent <epic>]` | New ticket |
| `scope ticket list / show / edit / delete` | Manage tickets |
| `scope status <id> <status>` | Move a ticket |
| `scope branch <id> [<name>] [--in-progress]` | Get/set branch, optionally flip status |
| `scope pr <id> [<url>] [--in-review\|--merged]` | Get/set PR, optionally flip status |
| `scope link add <from> <type> <to>` | Relate two tickets |
| `scope epic list / children <id>` | Epic-focused views |
| `scope comment <id> <body> [--by <name>]` | Add a comment |
| `scope history <id>` | Change log for a ticket |
| `scope board [-p <key>] [--epic <id>]` | Terminal kanban view |
| `scope serve [-p <port>]` | Run the web UI (auto-attaches to a running hub) |
| `scope workspace add / list / remove` | Manage workspaces on the running hub |
| `scope ca fingerprint / trust / untrust / path` | Manage the local certificate authority |
| `scope pair` | Pair a new native client (prints a one-time 6-digit code) |
| `scope devices list / rename` | Inspect or rename paired native clients |
| `scope skills install [--tool ...] [--project ...]` | Install agent skill |

Every command accepts `--json` for machine-readable output.

## Architecture

- **Storage** — SQLite via `better-sqlite3`, in `.scope/scope.db`. WAL mode
  for safe multi-process writes; serialization happens at the SQLite layer.
- **CLI** — Node 20+ ES modules, `commander` for parsing.
- **Server** — Express. Mounts the REST API and an SSE `/events` channel.
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
├── skills/                   # agent skills (Claude / Codex / Cursor)
├── Formula/scope.rb          # Homebrew formula
├── .github/workflows/        # tag-driven release
└── scripts/release.sh        # local bump + tag + push wrapper
```

## License

MIT — see [LICENSE](LICENSE).
