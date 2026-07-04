---
name: git-handoff
description: Attach branches and PRs to Scope tickets and prepare handoff comments. Use when creating branches, opening PRs, finishing work, or handing work to another agent.
metadata:
  short-description: Link Scope with git work
---

# Git Handoff

Use Scope as the durable handoff record for branch and PR state.

Commands:

```bash
scope branch SCP-123 codex/feature-name --in-progress
scope pr SCP-123 https://github.com/owner/repo/pull/42 --in-review
scope comment SCP-123 "Ready for review. Tests: npm test." --by codex
scope status SCP-123 done --by codex
```

If no PR exists, comment with the branch name, verification run, and any known
risks. Do not mark a ticket done until the requested work is actually complete.
