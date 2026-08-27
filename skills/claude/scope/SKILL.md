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
scope --json capabilities                # executable protocol + workspace vocabulary
```

JSON output is a versioned envelope. Consume `.data` on success; failures use
stable `.error.code`, `.error.retryable`, and `.error.details` fields.
Before sharing a workspace across hosts, verify each host supports
`.data.eventFormat.minimumReaderVersion` from `scope --json capabilities`.

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
scope auth login
scope connect

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
{fields}`, `assert {id,fields}`. If a command for what you need seems missing, ask for it to be added —
never fall back to SQL.

## Version control and storage

Scope is event-sourced. New workspaces default to quiet machine-local storage:
the append-only event log and `scope.db` cache live under
`~/.scope/workspaces/<id>/`, while the repo carries `.scope/workspace.json` and
optional `.scope/remote.json`. Commit those marker/config files; credentials
stay machine-local.

Git-carried events are an explicit advanced mode (`scope init --git-events` or
`scope events move-to-git`). Only in that mode should `.scope/events/` be
committed. `scope.db*` is always a rebuildable cache and must never be
committed. Use `scope events status`, `scope events move-to-local`, and
`scope remote show` when storage or cloud sync is unclear.

In git-events mode, verify with
`git check-ignore -v .scope/events/ .scope/scope.db` — `events/` should be NOT
ignored and `scope.db` should be ignored. In quiet local mode, `events/` is
intentionally ignored because the authoritative log is under `~/.scope/`.

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

Use Scope's execution primitives when agents share work:

```bash
scope --json ready --capabilities node,postgres
scope --json claim MA-2 --agent claude --files src/auth.js,test/auth.test.js
scope --json context MA-2 --budget 3000
scope --json lease renew LEASE_ID --agent claude
scope --json discover MA-2 fact "Expiry is enforced in middleware" --by claude
scope --json complete MA-2 --attempt <attempt-id> --agent claude \
  --verification '[{"command":"npm test","ok":true}]'
```

Claims atomically create renewable, expiring leases and execution attempts.
Dependencies determine readiness; contracts can require capabilities,
verification/evidence, or exclusive file intent. Use global `--request-id` for
exactly-once retries and `--if-revision` for state-dependent writes. Consume
incremental context with `context --since`, follow events with `watch --since`,
and inspect/resolve concurrent sibling intent via `conflicts`.

Save `data.lease.leaseId` and `data.attempt.attemptId` from `claim`; ticket,
lease, and attempt ids are not interchangeable. `lease renew` takes the lease
id, while `complete` takes the attempt id. `discover` takes the ticket id,
then exactly one of `decision`, `fact`, `risk`, `blocker`, `question`,
`handoff`, or `evidence`, followed by the body. After `complete`,
`handoff create`, or `lease release`, stop renewing. On `NOT_FOUND` or
`LEASE_EXPIRED`, re-read execution state instead of retrying the stale id. On
`INVALID_ARGUMENT`, inspect `--help` or `capabilities` and correct the request
before retrying.

For communication that must cross hosts or survive a restart, use stable agent
ids and the addressed mailbox:

```bash
scope --json agent register claude:opus --provider anthropic --ttl 2m
scope --json message inbox claude:opus
scope --json message reply MESSAGE_ID --from claude:opus --body "Review complete"
scope --json bridge status
```

Registration inside Claude binds the current session locally by default. The
single bridge owned by `scope serve` resumes the addressed Claude session,
retries transient failures, and acknowledges after provider acceptance. Use
`scope --json bridge bind AGENT_ID --provider claude --session UUID` when the
session id must be supplied explicitly, and `bridge status` to inspect safe
connection state. Use native Claude messaging for siblings already running in
one harness.

Humans can inspect and operate the same coordination state from the
connected-agents button in the `scope serve` web UI. It shows presence, pending
delivery, truthful session-connected/mailbox-only state, ticket-linked
conversations, acknowledgements/replies, leases, attempts, and conflicts.
Ticket cards and drawers show the active agent and execution details. Keep
messages free of credentials because bodies are durable workspace data.

### Native Claude subagents

Claude Code owns spawning, prompting, model-session wakeup, waiting,
cancellation, sandboxing, and worktrees. Scope supplies durable shared state
and cross-host message delivery:

1. Run `scope --json ready --plan --capabilities <csv>`. Spawn children only
   for tickets in a safe parallel group; unresolved intent stays sequential.
2. Give each child one ticket. The child runs `claim --agent <unique-id>
   --files <anticipated-files>`, then reads `context`; it claims no other work.
3. During long work, renew the lease. Renewal observes changed Git files when
   `--files` is omitted, improving later overlap decisions.
4. Use native Claude communication for live coordination. Persist facts and
   decisions with `discover`; use `handoff create` when unfinished work changes
   owners; use `complete` with verification/evidence only when actually done.
5. Re-read the ticket's `execution` state after the child returns. Treat chat
   output as advisory and durable attempt/evidence state as authoritative.

Claims move conventional workflows to `in_progress`; successful attempts move
to `in_review`, failures and handoffs to `todo`, and completion to `done`.
`scope serve` is optional.

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
