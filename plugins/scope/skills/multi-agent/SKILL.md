---
name: multi-agent
description: Coordinate multiple Codex agents working in one Scope workspace. Use when tasks are parallelized, handed off, blocked, or updated by several agents.
metadata:
  short-description: Coordinate agents with Scope
---

# Multi-Agent Coordination

Workflow:

1. Run `scope --json capabilities` and verify every host supports
   `data.eventFormat.minimumReaderVersion`, then advertise work capabilities
   with `scope --json ready --capabilities <csv>`.
2. For a self-directed worker, atomically reserve work with
   `scope --json claim [ticket] --agent <id>`.
3. Include `--files`, `--worktree`, `--branch`, and `--base` when known so
   overlap is visible before agents edit the same repository surface.
4. Renew long-running work with `lease renew`; release or finish failed and
   handed-off attempts explicitly.
5. Publish facts, risks, blockers, questions, and handoffs with `discover`.
6. Use `context --since <cursor>` for compact incremental handoff state.
7. Inspect `conflicts list`; resolve sibling field intent explicitly.
8. Register stable agent identities and use `message send` / `message reply`
   for targeted cross-host communication. Acknowledge each received message
   only after it is durably accepted for processing.

Dependencies drive readiness automatically. A lease is ownership with an
expiry, not a permanent lock; abandoned work becomes reclaimable. Contracts
may turn file overlap into a hard block and require completion evidence.

## Native host subagents

When Codex, Claude, or another host already provides subagents, do not create a
runner. The host owns spawning, prompting, model-session wakeup, waiting,
cancellation, sandboxing, and worktrees. Scope owns durable scheduling,
execution state, addressed delivery, and acknowledgements.

```bash
scope --json ready --plan --capabilities <csv>
scope --json claim SCP-123 --agent <unique-child-id> \
  --files <anticipated-files>
scope --json context SCP-123
scope --json message inbox <unique-child-id>
```

Spawn children only for tickets in a safe parallel group. Unknown repository
intent stays sequential; overlap with an active lease is deferred. Each child
owns exactly one ticket and must not claim another. During long work, renew its
lease; when `--files` is omitted, renewal observes changed Git files. Use Scope
for durable discoveries, leases, attempts, verification, and outcomes.

Use the native host channel for already-running siblings; use Scope messages
when communication must cross hosts or survive a restart. A host adapter can
consume `scope message listen <agent>` or the addressed SSE stream.

After a child returns, re-read the ticket and attempt rather than trusting its
final message. If ownership changes before completion, run `handoff create` to
persist decisions, files, verification, remaining work, and blockers. Claims
derive `in_progress`; success derives `in_review`; failure or handoff derives
`todo`; `complete` derives `done`. `scope serve` is optional.

If `scope serve` is running, CLI updates appear in the web UI via SSE. Never
pass `--port` to `scope serve`; the hub auto-discovers the running instance.
