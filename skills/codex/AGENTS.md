# Scope kanban guidance for Codex

This file teaches the agent to use Scope, a local-first kanban with a CLI,
a web UI, and a Model Context Protocol server. Drop it at `~/.codex/AGENTS.md`
to apply globally, or at the root of a project to scope it to that repo.

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

If a `scope` MCP server is configured in `~/.codex/config.toml`, use those
tools. Otherwise shell out to the CLI:

```bash
scope --json ticket list -p MA
scope --json ticket show MA-3
```

Install if needed:

```bash
brew install briannadoubt/tap/scope
```

## Data model

- **Project** has a 2-10 letter key (`MA`) that prefixes ticket IDs.
- **Epic** holds stories and bugs as children.
- **Story** is a unit of work; **Bug** is a defect.
- **Status:** `backlog` → `todo` → `in_progress` → `in_review` → `done`
  (+ `cancelled`).
- **Priority:** `low` / `medium` / `high` / `urgent`.
- **Relations:** `blocks`, `blocked_by`, `relates_to`, `duplicates`,
  `duplicate_of` (inverse auto-created).

## Common operations

```bash
scope init
scope project create my-app MA "My App"

scope ticket create MA "Auth refactor" -t epic -p high
scope ticket create MA "OAuth login"  -t story --parent MA-1

scope branch  MA-2 feat/oauth --in-progress
scope pr      MA-2 https://github.com/owner/repo/pull/42 --in-review
scope status  MA-2 done

scope board -p MA
scope --json ticket show MA-2
scope comment MA-2 "Token expiry was 5min; bumped to 1h" --by codex
scope link add MA-2 blocked_by MA-7
```

## Guardrails

- Don't create projects without an explicit human request.
- Don't delete tickets — set status to `cancelled` so history is preserved.
- Keep titles human-readable. Implementation details go in the description.
- Update status as work happens, not all at once at the end.
- Use `--by <name>` on edits so the history shows who touched what.

## Realtime + multi-agent

`scope serve`, `scope ui`, and `scope mcp` all auto-discover a running hub
and attach to it; the first started becomes the hub. **Never pass `--port`**
— concurrent agents converge on the shared hub at `http://localhost:4321`
(walks forward to `4330` if a non-scope process holds `4321`). Writes from
any source push to all viewers via SSE within ~100ms. If multiple agents
are working in parallel, **read state before writing it** — there is no
merge logic for conflicting updates, last write wins.

## Source

https://github.com/briannadoubt/scope
