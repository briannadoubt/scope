# Scope kanban guidance for Codex

This file teaches the agent to use Scope, a local-first kanban with a CLI and
a web UI. Drop it at `~/.codex/AGENTS.md` to apply globally, or at the root of
a repo to scope it to that repo.

---

## When to use Scope

Reach for Scope when:

- The user describes a multi-step task ("rebuild auth", "ship feature X").
  Create an **epic** plus child **stories**, then walk through them.
- The user starts a session and wants context. List open tickets first.
- You finish a discrete piece of work. Mark the relevant ticket **done**
  and attach the branch / PR.
- You discover a real bug worth tracking. Create a **bug** ticket with
  enough description that someone else could reproduce it.

Skip Scope for one-off questions or trivial single-edit requests.

## How to access

Shell out to the `scope` CLI. Every command supports `--json` for parseable
output:

```bash
scope --json ticket list
scope --json ticket show MA-3
```

Install if needed:

```bash
brew install briannadoubt/tap/scope
```

## Data model

- **Workspace** — a `.scope/` directory. Owns the 2-10 letter key (`MA`) that
  prefixes ticket IDs, plus name, description, and overview. One per repo.
- **Epic** holds stories and bugs as children.
- **Story** is a unit of work; **Bug** is a defect.
- **Status:** `backlog` → `todo` → `in_progress` → `in_review` → `done`
  (+ `cancelled`).
- **Priority:** `low` / `medium` / `high` / `urgent`.
- **Relations:** `blocks`, `blocked_by`, `relates_to`, `duplicates`,
  `duplicate_of` (inverse auto-created).

## Common operations

```bash
scope init --key MA --name "My App"
scope workspace set --description "Short description"
scope auth login
scope connect

scope ticket create "Auth refactor" -t epic -p high
scope ticket create "OAuth login"  -t story --parent MA-1

scope branch  MA-2 feat/oauth --in-progress
scope pr      MA-2 https://github.com/owner/repo/pull/42 --in-review
scope status  MA-2 done --by codex

scope board
scope --json ticket show MA-2
scope comment MA-2 "Token expiry was 5min; bumped to 1h" --by codex
scope link add MA-2 blocked_by MA-7
```

## Version control

Scope is event-sourced. New workspaces default to quiet machine-local storage:
the append-only event log and `scope.db` cache live under
`~/.scope/workspaces/<id>/`, while the repo carries a small
`.scope/workspace.json` marker and optional `.scope/remote.json` pointer.
Commit those marker/config files, never credentials.

Git-carried events are an advanced opt-in mode (`scope init --git-events` or
`scope events move-to-git`). Only in that mode should `.scope/events/` be
committed; `scope.db*` is always a rebuildable cache and must never be committed.
Use `scope events status` and `scope remote show` when storage or cloud sync is
unclear.

## Guardrails

- Don't change a workspace's key without an explicit human request — ticket
  IDs are immutable and old tickets keep the old prefix.
- Don't delete tickets — set status to `cancelled` so history is preserved.
- Keep titles human-readable. Implementation details go in the description.
- Update status as work happens, not all at once at the end.
- Use `--by <name>` on edits so the history shows who touched what.

## Realtime + multi-agent

If the user runs `scope serve` somewhere, the web UI comes up at
`https://localhost:4321` and every `scope` CLI call (yours, the user's,
another agent's) pushes to all viewers via SSE within ~100ms. **Never pass
`--port`** — concurrent `scope serve` invocations auto-discover the running
hub and register their workspace with it. If multiple agents are working in
parallel, **read state before writing it** — there is no merge logic for
conflicting updates, last write wins.

If the user previews scope from Claude Code, the project's
`.claude/launch.json` must use `scope preview --port <unique>` (not
`scope serve`). `preview_start` enforces one tracked server per port — two
projects both registering `port: 4321` stop each other when their previews
open in different panes. `scope preview` is a per-pane reverse proxy that
forwards a unique port (4322, 4323, ...) to the shared hub on 4321.

## Source

https://github.com/briannadoubt/scope
