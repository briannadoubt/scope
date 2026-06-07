---
name: scope
description: Plan, track, and report on multi-step work using the Scope kanban (local CLI + web UI). Use when the user asks you to scope/plan a project, list open work, mark a ticket done, link a branch/PR, or coordinate with other agents on shared state. Don't use for one-off questions or trivial single-edit requests.
---

# Using Scope

Scope is a local-first kanban for epics, stories, and bugs. It ships as a
CLI, a GitHub-Projects-style web UI, and a `scope serve` hub daemon. Use it
to plan, track, and report on multi-step work without leaving the terminal.

## When to use

Reach for Scope when:

- The user describes a multi-step task ("rebuild auth", "ship feature X") that
  spans more than a single tool call. Create an **epic** plus child **stories**
  and walk through them.
- The user starts a session and wants context. List open tickets in the
  current workspace before diving in.
- You finish a discrete piece of work. Mark the relevant ticket **done** and
  attach the branch / PR if there was one.
- You discover a real bug worth tracking (not a fix you just made). Create a
  **bug** ticket with enough description that someone else could reproduce it.

Don't use Scope for one-off questions or trivial single-edit requests — the
overhead isn't worth it.

## How to access

Shell out to the `scope` CLI. Every command supports `--json` for parseable
output:

```bash
scope --json ticket list                 # current workspace, all tickets
scope --json ticket show MA-3
scope --json meta                        # legal enums (statuses/priorities/types)
```

If the CLI isn't installed:

```bash
brew install briannadoubt/tap/scope
```

## Data model

- **Hub** — the `scope serve` daemon. Brokers traffic across workspaces.
- **Workspace** — a `.scope/` directory. Owns the key prefix (`MA`), name,
  description, overview, and all tickets in that repo. One SQLite DB per
  workspace.
- **Epic** — high-level body of work. Holds stories and bugs as children.
- **Story** — a unit of work toward an epic.
- **Bug** — a defect; can also live under an epic.
- **Relation** — `blocks`, `blocked_by`, `relates_to`, `duplicates`,
  `duplicate_of`. The inverse is created automatically.
- **Status** — `backlog` → `todo` → `in_progress` → `in_review` → `done`
  (+ `cancelled`). The board has one column per status.
- **Priority** — `low` / `medium` / `high` / `urgent`.

Ticket IDs look like `MA-3` (workspace key + number) and are immutable.
Branches and PR URLs can be attached to any ticket and are surfaced in the UI.

## Common operations

```bash
# one-time setup in a repo
scope init --key MA --name "My App"
scope workspace set --description "Short description"

# inspect
scope workspace show

# plan
scope ticket create "Auth refactor" -t epic -p high
scope ticket create "OAuth login"  -t story --parent MA-1
scope ticket create "Password reset broken on Safari" -t bug --parent MA-1 -p high

# start work
scope branch MA-2 feat/oauth --in-progress

# open PR
scope pr MA-2 https://github.com/owner/repo/pull/42 --in-review

# close
scope status MA-2 done --by you

# see the board (terminal kanban view)
scope board

# see one ticket with relations, comments, history
scope --json ticket show MA-2

# add context as you go
scope comment MA-2 "Token expiry was 5min; bumped to 1h" --by you
scope link add MA-2 blocked_by MA-7
```

## Bulk & structural changes — never edit scope.db directly

`scope.db` is a **rebuildable cache** of the event log. Editing it with `sqlite3`
writes no event, so the change is silently lost on the next cache rebuild (and
corrupts merges). Every mutation has a command — use them:

```bash
scope workspace set --name "New Name"        # rename / edit metadata
scope workspace rekey APP                     # change key + reprefix ALL tickets (MA-1 → APP-1)
scope ticket edit MA-7 --parent MA-1          # reparent (or "none" to clear)
scope status MA-2,MA-3 done --by you          # bulk, atomic
scope ticket edit MA-2,MA-3 --priority high   # bulk, atomic

# many heterogeneous ops as ONE atomic transaction (all-or-nothing).
# "$ref" references a ticket created earlier in the same batch.
echo '[
  {"op":"create","ref":"e","type":"epic","title":"Billing"},
  {"op":"create","type":"story","title":"Invoices","parent":"$e"},
  {"op":"status","id":"MA-9","status":"done"}
]' | scope batch --by you
```

Batch ops: `create` (optional `ref`), `update {id,fields}`, `status {id,status}`,
`delete {id}`, `comment {id,body}`, `link`/`unlink {from,type,to}`, `workspace
{fields}`. If a command for what you need seems missing, ask for it to be added —
never fall back to SQL.

## Version control — commit the event log, never the cache

A `.scope/` workspace has two kinds of files:

- **`.scope/events/`** — the append-only event log (one JSON file per event).
  This is the **source of truth** and **must be committed**. It's what
  hydrates the local database, merges cleanly across branches/agents, and lets
  any clone rebuild state.
- **`.scope/scope.db`, `scope.db-wal`, `scope.db-shm`** — a rebuildable
  **SQLite cache** of the event log. **Never commit these.** They're
  machine-local, churn constantly, and corrupt merges.

`scope init` writes a `.scope/.gitignore` that already excludes the SQLite
cache while keeping `events/`. Leave it in place and commit it.

**Watch for a parent `.gitignore` that ignores all of `.scope/`.** A blanket
`.scope/` rule in the repo-root `.gitignore` silently excludes the event log
too — the nested `.scope/.gitignore` never runs, and the workspace's history
never gets committed. The root rule should ignore only the cache:

```gitignore
# Scope: commit the event log (.scope/events/), never the SQLite cache.
.scope/scope.db
.scope/scope.db-wal
.scope/scope.db-shm
```

Verify with `git check-ignore -v .scope/events/ .scope/scope.db` — `events/`
should be NOT ignored, `scope.db` should be ignored.

## Guardrails

- **Don't change a workspace's key without an explicit human request.** When
  asked, use `scope workspace rekey <KEY>` (reprefixes every ticket atomically
  via the log); avoid `set --key`, which strands existing tickets under the old
  prefix. Adding tickets, comments, and statuses is always fine.
- **Don't delete tickets** to "clean up." Set status to `cancelled` so history
  is preserved and the audit log makes sense.
- **Keep titles human-readable.** A title is what shows up on the kanban card
  and in stand-ups. Implementation details go in the description.
- **Update status as work happens, not all at once at the end.** The point of
  this thing is for the user (and other agents) to see live progress.
- **Use `--by <name>`** on status changes / edits so the history shows who
  touched what. For agents, your own name or "agent" is fine.

## Realtime + multi-agent

If the user runs `scope serve` somewhere, the web UI comes up at
`https://localhost:4321` and every `scope` CLI call (yours, the user's,
another agent's) pushes to all viewers via SSE within ~100ms. **Never pass
`--port`** unless you're explicitly told to — concurrent `scope serve`
invocations auto-discover the running hub and register their workspace with
it.

If multiple agents are working in parallel, **always read state before writing
state** — there is no merge logic for conflicting `ticket edit` calls, last
write wins.

### Claude Code preview pane setup

For Claude Code's preview pane, `.claude/launch.json` must use
`scope preview --port <unique>`, **not** `scope serve`. `preview_start`
enforces one tracked server per port — if two projects both register
`port: 4321` (the hub), opening the preview in the second pane stops the
first pane's tracked process and the iframe shows "The preview server
stopped." `scope preview` is a tiny per-pane reverse proxy: each project
picks its own port (4322, 4323, ...) and forwards to the shared hub on 4321.

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

## Useful follow-ups

- `scope --json epic list` to see epic progress at a glance.
- `scope --json ticket list --status todo` to find the next thing to do.
- `scope --json board` returns columns + buckets for rendering.
- `scope history MA-2` is the change log for a single ticket.

## Repo

- Source: https://github.com/briannadoubt/scope
- Install: `brew install briannadoubt/tap/scope`
