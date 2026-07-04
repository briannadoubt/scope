---
name: multi-agent
description: Coordinate multiple Codex agents working in one Scope workspace. Use when tasks are parallelized, handed off, blocked, or updated by several agents.
metadata:
  short-description: Coordinate agents with Scope
---

# Multi-Agent Coordination

Scope is last-write-wins at the ticket-field level, so read state immediately
before writing.

Workflow:

1. Inspect `scope --json board`.
2. Claim a ticket by moving it to `in_progress` and adding a comment.
3. Link dependencies with `blocked_by` or `blocks`.
4. Leave comments for discoveries that affect another agent.
5. Do not rewrite another agent's current ticket unless the user asks.

If `scope serve` is running, CLI updates appear in the web UI via SSE. Never
pass `--port` to `scope serve`; the hub auto-discovers the running instance.
