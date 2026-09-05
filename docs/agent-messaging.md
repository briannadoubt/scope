# Agent messaging and live session delivery

Scope provides a durable, addressed mailbox plus a machine-local session bridge
for direct collaboration between running Codex and Claude sessions. Scope stores
identity, heartbeat presence, messages, threads, expiry, and acknowledgements in
the workspace. The bridge stores provider session bindings privately on the
machine and resumes the addressed runtime when a message arrives.

This boundary keeps provider credentials and session identifiers out of synced
Scope events while giving every host the same delivery semantics. Other model
runtimes can continue to use the provider-neutral listener or SSE contract.

## Delivery contract

1. A supported lifecycle hook automatically registers a private random agent
   identity and renews presence before the heartbeat TTL. Manual registration
   remains available for hosts without lifecycle hooks.
2. The hook binds the current Codex or Claude Code session using provider data
   that remains machine-private.
3. Scope emits every pending message addressed to that agent.
4. The local bridge resumes the runtime with the message id and workspace.
5. The runtime reads the message through CLI, REST, MCP, or the Node facade.
6. The bridge checkpoints provider acceptance, then acknowledges the message.
7. A result or question is sent as a reply in the same thread.

Delivery is **at least once**. Pending messages are replayed after listener or
SSE reconnection until acknowledged. Consumers must deduplicate by `messageId`.
Acknowledgement is idempotent and may safely be retried. The bridge persists an
`accepted` checkpoint before acknowledgement, so a bridge restart normally
finishes the acknowledgement without injecting the wakeup a second time. The
provider boundary remains at least once if a provider accepts a turn but exits
before reporting success.

## Built-in Codex and Claude bridge

`scope serve` runs one session bridge in the process that owns the local hub.
Every other `scope serve` process attaches to that hub and does not start a
second bridge. A watchdog-promoted hub starts the bridge when it takes ownership.

Registration binds the current session by default:

```bash
scope --json agent register codex:sol --provider openai --ttl 2m
scope --json agent register claude:opus --provider anthropic --ttl 2m
```

For automatic start, resume, presence renewal, and end handling, install the
supported user-level host hooks:

```bash
scope bridge hooks install
scope --json bridge hooks status
```

See [session-lifecycle.md](session-lifecycle.md) for the host capability matrix,
privacy boundary, and truthful mailbox-only fallbacks.

For an isolated session or an environment that does not expose its session id,
bind explicitly on that machine:

```bash
scope --json bridge bind codex:sol --provider codex --session SESSION_ID
scope --json bridge bind claude:opus --provider claude --session SESSION_ID
scope --json bridge list
scope --json bridge status
```

Bindings live in `~/.scope/bridge.json` with mode `0600`; retry/checkpoint state
lives in `~/.scope/bridge-state.json` with the same permissions. These files are
machine-local. CLI and UI projections expose only a one-way session reference,
provider, connection health, timestamps, and safe error codes—not session ids,
message bodies, provider output, credentials, or raw filesystem paths.

## Provider-neutral CLI adapter

```bash
scope --json agent register codex:sol \
  --provider openai --capabilities code,test,review --ttl 2m

scope --json agent heartbeat codex:sol --status busy --ttl 2m

# Long-running JSONL wakeup source. Each line is a Scope protocol envelope.
scope message listen codex:sol
```

The listener emits the current pending inbox on startup, then follows the
workspace event log. Restarting it replays unacknowledged messages. Use it for
providers without a built-in bridge or for a custom host supervisor.

## HTTP/SSE adapter

Register and heartbeat through the REST API, then keep this stream open:

```text
GET /api/agent/agents/codex%3Asol/events
Accept: text/event-stream
```

The stream emits:

- `hello` — adapter contract and agent identity.
- `message` — a pending addressed message; `id` is the message id.
- `acknowledgement` — confirmation that a message sent by this agent was
  acknowledged by its recipient.

Reconnect using the normal EventSource retry behavior. Scope emits pending
messages again; the adapter's message-id deduplication makes this safe.

## Conversation example

```bash
scope --json message send \
  --from codex:sol --to claude:opus \
  --ticket SCP-42 --kind review_request \
  --body "Review commit abc123 and try to falsify the concurrency invariant."

scope --json message inbox claude:opus

scope --json message reply MSG_ID \
  --from claude:opus --body "Found one replay edge case; see the attached evidence."

scope --json message ack MSG_ID --agent claude:opus
```

Replies inherit the original thread, ticket, and correlation id. Durable
project conclusions should still be promoted to ticket discoveries or comments;
the mailbox is operational communication, not the canonical project record.

## Visual inspection and intervention

Run `scope serve` and use the connected-agents button in the topbar to open the
Agent coordination center. The browser view exposes:

- registered agents, heartbeat presence, and pending delivery counts;
- sent and received conversations for the selected agent, newest first;
- ticket filters and links between a thread and its work item;
- message kind, expiry/delivery state, acknowledgements, replies, and new
  messages; and
- workspace-wide connected-session, active lease, attempt, and unresolved
  conflict metrics.

Each agent is labeled `session connected`, `session bridge offline`, or
`mailbox only`. The new-message dialog warns when a recipient has no connected
session: the message remains durable but cannot wake a model until it is bound.

Ticket cards also identify the active execution phase and agent. The ticket
drawer expands that state with lease expiry, attempt and verification status,
evidence, observed repository intent, recent handoffs, and conflicts, and can
open the coordination center already filtered to that ticket.

The UI uses the same durable REST/SQLite projections as the CLI; it is an
operator surface, not a second mailbox implementation. Browser acknowledgements
have the same idempotent semantics as `scope message ack`.

## Host wakeup payload

Adapters should resume a runtime with a bounded prompt such as:

```text
Scope message <messageId> is pending for <agentId> in <workspace>.
Read it from Scope, inspect the linked ticket context, process it once, and
reply in the same thread when useful. The bridge acknowledges after acceptance.
```

The adapter should not inject the entire conversation or artifact contents.
The agent can load those from Scope and Git using the durable identifiers.

## Safety

- Before connecting multiple hosts, compare `scope --json capabilities` and
  require support for the workspace's `eventFormat.minimumReaderVersion`.
  Once format-2 messages are written, a format-1-only Scope binary must not
  open or sync that workspace.
- Treat `fromAgent` as workspace identity, not as an authenticated human.
  Event attribution separately records the authenticated actor where available.
- Do not place credentials or secrets in message bodies or artifact references.
- Use message expiry for time-sensitive requests.
- Keep provider-specific launch tokens and session identifiers in the private
  local bridge files, never in synced Scope events.
- Apply external-action approvals in the host exactly as for user-issued work.
