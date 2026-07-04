---
name: scope
description: Plan, track, and report multi-step work using Scope. Use when the user wants Codex to manage project state, open tickets, progress, bugs, branches, PRs, or agent coordination.
metadata:
  short-description: Use Scope kanban while coding
---

# Scope

Use Scope when work is more than a trivial one-off. Scope is a local-first
kanban with epics, stories, bugs, relations, comments, branches, PR links, a web
UI, and realtime updates.

Read `../../references/guardrails.md` before mutating tickets.

## Default Flow

1. Inspect state with `scope --json board` or `scope --json ticket list`.
2. For new multi-step work, create one epic and focused child stories.
3. Move the active ticket to `in_progress` when work starts.
4. Add comments when a discovery matters to another agent or future you.
5. Attach branch or PR links when they exist.
6. Mark tickets done as each discrete piece finishes.

Use `scope batch --by codex` for related multi-record changes.
