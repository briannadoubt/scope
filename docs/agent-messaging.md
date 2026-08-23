# Agent messaging and wakeup adapters

Scope provides a durable, addressed mailbox for direct collaboration between
agent runtimes. Scope stores identity, heartbeat presence, messages, threads,
expiry, and acknowledgements. A host adapter remains responsible for starting
or resuming Codex, Claude, or another model runtime.

This boundary keeps provider credentials, process control, sandboxes, and model
session APIs out of Scope while giving every host the same delivery semantics.

## Delivery contract

1. The host registers its agent and renews presence before the heartbeat TTL.
2. The host subscribes to an addressed wakeup stream.
3. Scope emits every pending message addressed to that agent.
4. The host resumes the runtime with the message id, workspace, and ticket id.
5. The runtime reads the message through CLI, REST, MCP, or the Node facade.
6. The recipient acknowledges only after the host has durably accepted the
   message for processing.
7. A result or question is sent as a reply in the same thread.

Delivery is **at least once**. Pending messages are replayed after listener or
SSE reconnection until acknowledged. Consumers must deduplicate by `messageId`.
Acknowledgement is idempotent and may safely be retried.

## CLI adapter

```bash
scope --json agent register codex:sol \
  --provider openai --capabilities code,test,review --ttl 2m

scope --json agent heartbeat codex:sol --status busy --ttl 2m

# Long-running JSONL wakeup source. Each line is a Scope protocol envelope.
scope message listen codex:sol
```

The listener emits the current pending inbox on startup, then follows the
workspace event log. Restarting it replays unacknowledged messages.

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

## Host wakeup payload

Adapters should resume a runtime with a bounded prompt such as:

```text
Scope message <messageId> is pending for <agentId> in <workspace>.
Read it from Scope, inspect the linked ticket context, process it once,
reply in the same thread when useful, then acknowledge the original message.
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
- Keep provider-specific launch tokens and session identifiers in the host
  adapter, never in synced Scope events.
- Apply external-action approvals in the host exactly as for user-issued work.
