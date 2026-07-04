# CLI Recipes

## Inspect

```bash
scope --json workspace show
scope --json board
scope --json ticket list --status todo
scope --json ticket show SCP-123
scope history SCP-123
```

## Plan

```bash
scope ticket create "Feature name" -t epic -p high
scope ticket create "Implement first slice" -t story --parent SCP-123 -p high
```

Prefer `scope batch --by codex` when creating several related records so the
plan appears atomically.

## Work

```bash
scope status SCP-124 in_progress --by codex
scope branch SCP-124 codex/feature-name --in-progress
scope comment SCP-124 "Found the existing parser boundary." --by codex
scope pr SCP-124 https://github.com/owner/repo/pull/42 --in-review
scope status SCP-124 done --by codex
```

## Coordinate

```bash
scope link add SCP-124 blocked_by SCP-130
scope comment SCP-124 "Blocked on SCP-130 because the API contract is not fixed." --by codex
```
