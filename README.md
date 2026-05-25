# scope

Local-first kanban for projects, epics, stories, and bugs — built so coding
agents and humans can plan and track work without leaving the command line.

Ships as a **CLI**, a **GitHub-Projects-style web UI**, and a **Model Context
Protocol server**. Everything lives in a `.scope/` directory in your repo
(SQLite, WAL mode), so it works offline, syncs through git if you want, and
needs no server.

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
scope serve                              # → http://localhost:4321
```

## What you get

- **CLI** — `project / ticket / epic / link / status / branch / pr / board`
  with `--json` output on every command for agent consumption.
- **Web UI** — kanban columns, drag-and-drop, ticket drawer with inline edit,
  project overview, epic filter, **swimlanes** (group by epic / assignee /
  priority / type), live updates via SSE.
- **MCP server** — `scope mcp` (stdio) or HTTP at `/mcp` via `scope serve`.
  23 tools cover the full CLI surface; built on `@modelcontextprotocol/sdk`
  with zod-typed inputs.
- **`scope serve`** — UI + HTTP MCP on one port. Multiple agents over HTTP
  and a human in the browser all share one SQLite DB; writes from any source
  push to every viewer over Server-Sent Events within ~100ms.

## The web UI

```bash
scope ui            # UI only (no MCP)
scope serve         # UI + HTTP MCP on the same port (default)
scope serve --no-ui # MCP-only HTTP server
```

The **Group by** picker in the topbar turns the board into swimlanes — one
horizontal row per epic, assignee, priority, or type, each with its own
status columns. State (group choice, collapsed lanes) persists in
`localStorage`.

The little dot next to the refresh button is your live indicator:
**green** = SSE connected, **blue flash** = just applied a change,
**gray** = paused (drawer/modal/input/drag), **red** = disconnected.

## MCP integration

`scope` exposes itself over MCP so agents can call typed tools instead of
shelling out. Two transports:

### Stdio (zero install — recommended)

`npx` fetches scope on first use and caches it. **The web UI comes up
automatically** on http://localhost:4321 alongside the stdio MCP, so you can
watch tickets move in real time as the agent works. If the port is already in
use (e.g. you have multiple agents registered), the rest silently share the
first one's UI.

```jsonc
// ~/.claude.json, ~/.codex/config.toml (TOML equiv), Cursor MCP, etc.
{
  "mcpServers": {
    "scope": {
      "command": "npx",
      "args": ["-y", "scope-kanban", "mcp"]
    }
  }
}
```

Already have scope installed via brew? Drop the `npx -y` and use `scope` directly:

```jsonc
{ "mcpServers": { "scope": { "command": "scope", "args": ["mcp"] } } }
```

Want no UI from MCP processes? `"args": ["-y", "scope-kanban", "mcp", "--no-ui"]`.

### HTTP (multi-agent + UI in one process)

Run `scope serve` somewhere, then point every agent at `/mcp`.

```jsonc
{
  "mcpServers": {
    "scope": {
      "type": "http",
      "url": "http://localhost:4321/mcp"
    }
  }
}
```

Stateless per request: any number of agents POST simultaneously, coordination
happens at the SQLite layer. The UI watches the same SSE feed and reflects
their writes live.

Available tools: `list_projects`, `get_project`, `create_project`,
`update_project`, `delete_project`, `list_tickets`, `get_ticket`,
`create_ticket`, `update_ticket`, `delete_ticket`, `set_status`, `set_branch`,
`set_pr`, `add_relation`, `remove_relation`, `list_relations`,
`list_epic_children`, `get_epic_progress`, `add_comment`, `list_comments`,
`list_history`, `get_board`, `get_meta`.

## Agent skills

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
status updates, bug tracking), **how** to access it (MCP first, CLI fallback),
the data model, and a handful of guardrails (e.g. *read state before writing
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
| `scope ui [-p <port>]` | Web UI only |
| `scope serve [-p <port>] [--no-ui] [--no-mcp]` | UI + HTTP MCP |
| `scope mcp [--no-ui] [-p <port>] [--open]` | Stdio MCP server. Also auto-starts the web UI on port 4321 (silent skip if taken). |
| `scope skills install [--tool ...] [--project ...]` | Install agent skill |

Every command accepts `--json` for machine-readable output.

## Architecture

- **Storage** — SQLite via `better-sqlite3`, in `.scope/scope.db`. WAL mode
  for safe multi-process writes; serialization happens at the SQLite layer.
- **CLI** — Node 20+ ES modules, `commander` for parsing.
- **Server** — Express. Mounts the REST API, the MCP HTTP endpoint
  (`StreamableHTTPServerTransport`, stateless), and an SSE `/events` channel.
- **Realtime** — in-process `EventEmitter` bus emits on every mutation;
  `fs.watch` on `.scope/` plus a `PRAGMA data_version` check catches writes
  from *other* processes (CLI, stdio MCP subprocesses) and feeds them into
  the same bus. UI subscribes via `EventSource`, debounces refresh, and
  diffs by hash to skip no-op renders.
- **MCP** — `@modelcontextprotocol/sdk` with zod tool schemas. Destructive
  ops require an explicit `confirm: true`.

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
│   ├── server.js             # Express: REST + MCP HTTP + SSE
│   ├── mcp.js                # MCP server + tool registrations
│   ├── format.js             # terminal table / board renderers
│   └── web/                  # vanilla-JS SPA (no build step)
├── skills/                   # agent skills (Claude / Codex / Cursor)
├── Formula/scope.rb          # Homebrew formula
├── .github/workflows/        # tag-driven release
└── scripts/release.sh        # local bump + tag + push wrapper
```

## License

MIT — see [LICENSE](LICENSE).
