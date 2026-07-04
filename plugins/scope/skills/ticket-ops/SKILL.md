---
name: ticket-ops
description: Create, edit, comment, link, prioritize, and close Scope tickets from Codex. Use when the user asks for ticket changes or when work progress should be recorded.
metadata:
  short-description: Operate Scope tickets
---

# Ticket Operations

Read state before writing:

```bash
scope --json ticket show SCP-123
```

Use CLI commands rather than editing `.scope/scope.db`.

Common operations:

```bash
scope status SCP-123 in_progress --by codex
scope ticket edit SCP-123 --priority high
scope comment SCP-123 "Useful implementation note." --by codex
scope link add SCP-123 blocked_by SCP-130
scope status SCP-123 done --by codex
```

For several changes, use `scope batch --by codex` so readers see one coherent
history entry sequence.
