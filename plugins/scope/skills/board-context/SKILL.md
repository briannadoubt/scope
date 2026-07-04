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
scope --json board
scope --json ticket list
```

Summarize:

- work in progress
- blocked or related tickets
- urgent and high-priority todo items
- recently completed work if it affects what to do next

If the user asks for a visual surface, use the Scope MCP render tools when
available: `scope_render_board` for inline UI or `scope_render_sidebar` for a
sidebar-style view.
