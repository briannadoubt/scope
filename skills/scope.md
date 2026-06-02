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

## Guardrails

- **Don't change a workspace's key without an explicit human request.**
  Ticket IDs are immutable — once tickets exist with a prefix, changing the
  key leaves them stranded under the old one. Adding tickets, comments, and
  statuses to an existing workspace is always fine.
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

## Collaboration (deploy-free)

Scope is event-sourced: the source of truth is the append-only log in
`.scope/events/` (one ULID-named JSON file per change). `scope.db` is a
gitignored cache rebuilt from the log automatically. To collaborate, **commit
and `git pull` the `.scope/events/` directory** — merges are a pure union of new
files, so there's nothing to conflict on and no server to deploy. The next
`scope` command rebuilds the cache from the merged log. Concurrent edits resolve
last-writer-wins by timestamp; new tickets/comments/relations union; ticket
numbers are de-collided deterministically at replay. Any file sync works (git,
iCloud, Dropbox, Syncthing). Run `scope serve` only when you want sub-second
live updates on a machine/LAN — it's an optimization over the same log.

## Useful follow-ups

- `scope --json epic list` to see epic progress at a glance.
- `scope --json ticket list --status todo` to find the next thing to do.
- `scope --json board` returns columns + buckets for rendering.
- `scope history MA-2` is the change log for a single ticket.

## Repo

- Source: https://github.com/briannadoubt/scope
- Install: `brew install briannadoubt/tap/scope`
