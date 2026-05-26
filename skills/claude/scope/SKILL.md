---
name: scope
description: Plan, track, and report on multi-step work using the Scope kanban (local CLI + web UI). Use when the user asks you to scope/plan a project, list open work, mark a ticket done, link a branch/PR, or coordinate with other agents on shared state. Don't use for one-off questions or trivial single-edit requests.
---

# Using Scope

Scope is a local-first kanban for projects, epics, stories, and bugs. It ships
as a CLI and a GitHub-Projects-style web UI. Use it to plan, track, and report
on multi-step work without leaving the terminal.

## When to use

Reach for Scope when:

- The user describes a multi-step task ("rebuild auth", "ship feature X") that
  spans more than a single tool call. Create an **epic** plus child **stories**
  and walk through them.
- The user starts a session and wants context. List open tickets in the project
  before diving in.
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
scope --json ticket list -p MA           # always pass --json for parsing
scope --json ticket show MA-3
scope --json get_meta                    # legal enums (statuses/priorities/types)
```

If the CLI isn't installed:

```bash
brew install briannadoubt/tap/scope
```

## Data model

- **Project** — top-level container. Has a slug (`my-app`) and a 2-10 letter
  key (`MA`) that prefixes all ticket IDs.
- **Epic** — high-level body of work. Holds stories and bugs as children.
- **Story** — a unit of work toward an epic.
- **Bug** — a defect; can also live under an epic.
- **Relation** — `blocks`, `blocked_by`, `relates_to`, `duplicates`,
  `duplicate_of`. The inverse is created automatically.
- **Status** — `backlog` → `todo` → `in_progress` → `in_review` → `done`
  (+ `cancelled`). The board has one column per status.
- **Priority** — `low` / `medium` / `high` / `urgent`.

Ticket IDs look like `MA-3`. Branches and PR URLs can be attached to any ticket
and are surfaced in the UI.

## Common operations

```bash
# one-time setup in a repo
scope init
scope project create my-app MA "My App" -d "Short description"

# plan
scope ticket create MA "Auth refactor" -t epic -p high
scope ticket create MA "OAuth login"  -t story --parent MA-1
scope ticket create MA "Password reset broken on Safari" -t bug --parent MA-1 -p high

# start work
scope branch MA-2 feat/oauth --in-progress

# open PR
scope pr MA-2 https://github.com/owner/repo/pull/42 --in-review

# close
scope status MA-2 done

# see the board (terminal kanban view)
scope board -p MA

# see one ticket with relations, comments, history
scope --json ticket show MA-2

# add context as you go
scope comment MA-2 "Token expiry was 5min; bumped to 1h" --by you
scope link add MA-2 blocked_by MA-7
```

## Guardrails

- **Don't create projects without an explicit human request.** Projects are
  durable. Adding tickets, comments, and statuses to an existing project is
  always fine.
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
`http://localhost:4321` and every `scope` CLI call (yours, the user's, another
agent's) pushes to all viewers via SSE within ~100ms. **Never pass `--port`**
unless you're explicitly told to — concurrent `scope serve` invocations
auto-discover the running hub and register their workspace with it.

If multiple agents are working in parallel, **always read state before writing
state** — there is no merge logic for conflicting `ticket edit` calls, last
write wins.

## Useful follow-ups

- `scope --json epic list` to see epic progress at a glance.
- `scope --json ticket list -p MA --status todo` to find the next thing to do.
- `scope --json get_board project=MA` returns columns + buckets for rendering.
- `scope history MA-2` is the change log for a single ticket.

## Repo

- Source: https://github.com/briannadoubt/scope
- Install: `brew install briannadoubt/tap/scope`
