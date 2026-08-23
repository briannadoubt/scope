---
name: board-context
description: Summarize the current Scope board, identify active work, and choose the next ticket. Use when starting a session, resuming work, or giving status.
metadata:
  short-description: Read the Scope board
---

# Board Context

Use this when the user asks for context, status, a standup-style summary, or the
next Scope item.

Start with:

```bash
scope --json capabilities
scope --json ready --capabilities <agent-capabilities>
scope --json metrics
```

Summarize:

- ready and capability-eligible work
- active or expired leases and repeated failed attempts
- dependency blockers and explicit causal conflicts
- typed discoveries and the latest plan revision from `scope context <ticket>`

If the user asks for a visual surface, use the Scope MCP render tools when
available: `scope_render_board` for inline UI or `scope_render_sidebar` for a
sidebar-style view.
