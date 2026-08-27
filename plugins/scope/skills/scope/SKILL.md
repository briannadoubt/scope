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

## Machine Protocol

1. Run `scope --json capabilities`; parse the versioned envelope's `data`.
   For shared workspaces, verify each host supports
   `data.eventFormat.minimumReaderVersion` before it reads or writes events.
2. Inspect `scope --json ready` and atomically `claim --agent <identity>`.
3. Read `scope --json context <ticket>`, then renew the lease during long work.
4. Record durable facts with `discover`, not untyped prose comments.
5. Finish with `complete`, including verification/evidence required by contract.

Keep execution identifiers distinct. `claim` returns
`data.lease.leaseId` and `data.attempt.attemptId`; renew only the lease id and
complete only the attempt id, always with the same agent identity:

```bash
scope --json lease renew LEASE_ID --agent AGENT_ID
scope --json discover TICKET_ID fact "Observed behavior" --by AGENT_ID
scope --json complete TICKET_ID --attempt ATTEMPT_ID --agent AGENT_ID \
  --verification '[{"command":"npm test","ok":true}]'
```

`discover` accepts only `decision`, `fact`, `risk`, `blocker`, `question`,
`handoff`, or `evidence` as its second positional argument. After `complete`,
`handoff create`, or `lease release`, stop renewing that lease. On
`NOT_FOUND` or `LEASE_EXPIRED`, re-read the ticket's execution state and do not
retry the stale id. On `INVALID_ARGUMENT`, inspect `--help` or `capabilities`
and correct the request instead of replaying it unchanged.

When the host has native subagents, run `scope --json ready --plan` and use a
safe parallel group. Give each child one ticket; that child runs `claim`, reads
`context`, renews its lease, and either `complete`s with evidence or creates a
structured `handoff`. Keep spawning, prompting, live messaging, waiting,
cancellation, sandboxing, and worktrees in the host harness. Re-read the
ticket's `execution` state after a child returns; do not infer success from chat.

For communication that must cross hosts or survive a restart, register stable
agent ids and use `message send`, `message inbox`, `message reply`, and
`message ack`. Host adapters consume `scope message listen <agent>` or the
addressed SSE stream. Delivery is at least once until acknowledgement, so
deduplicate by message id.

When `scope serve` is running, the connected-agents button opens the visual
coordination center. Humans can inspect presence, pending delivery,
ticket-linked conversations, acknowledgements/replies, leases, attempts, and
conflicts there. Ticket cards and drawers show the active agent and execution
details. Message bodies are durable workspace data, so never include secrets.

Use global `--request-id` when retrying mutations and `--if-revision` when a
write depends on previously read state. Never unwrap JSON by guessing: success
is in `data`; failures are in `error` with stable codes and retryability.

Use `scope batch --by codex` for related multi-record changes. Include an
`assert` op or `--if-revision` when correctness depends on current values.
