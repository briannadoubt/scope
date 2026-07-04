---
name: plan-work
description: Break a user request into Scope epics, stories, and bugs before implementation. Use for feature work, refactors, investigations, and broad tasks that need visible progress.
metadata:
  short-description: Plan work into Scope tickets
---

# Plan Work

Use this workflow to turn ambiguous or multi-step work into a Scope plan.

Read `../../references/guardrails.md` and `../../references/cli-recipes.md`.

## Workflow

1. Run `scope --json board` to understand active work.
2. Create a human-readable epic for the goal.
3. Create child stories for independently completable slices.
4. Create bugs only for defects with reproducible or actionable detail.
5. Move the epic and first active story to `in_progress`.

Prefer an atomic batch:

```bash
cat plan.json | scope batch --by codex
```

Keep titles short enough to scan on the board. Put implementation notes in
descriptions or comments.
