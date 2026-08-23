# CLI Recipes

## Inspect

```bash
scope --json workspace show
scope --json board
scope --json ticket list --status todo
scope --json ticket show SCP-123
scope --json capabilities
scope --json ready --capabilities node,postgres
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
scope --json claim SCP-124 --agent codex --ttl 20m --files src/parser.js,test/parser.test.js
scope --json context SCP-124 --budget 3000
scope --json discover SCP-124 fact "Found the existing parser boundary." --by codex
scope --json lease renew <lease-id> --agent codex --ttl 20m
scope --json complete SCP-124 --attempt <attempt-id> --agent codex \
  --verification '[{"command":"npm test","ok":true}]'
```

## Coordinate

```bash
scope link add SCP-124 blocked_by SCP-130
scope discover SCP-124 blocker "SCP-130 API contract is not fixed." --by codex
scope conflicts list SCP-124
```

## Coordinate native subagents

```bash
scope --json ready --plan --capabilities node
scope --json claim SCP-124 --agent codex:worker-1 \
  --files src/parser.js,test/parser.test.js
scope --json context SCP-124 --budget 3000
scope --json handoff create SCP-124 --agent codex:worker-1 \
  --summary "Parser implemented; fixture remains" \
  --remaining '["add malformed-input fixture"]'
```

The host launches and communicates with native subagents. Scope plans safe
parallel work, reserves tickets, exposes execution state, and persists results.

## Cross-agent messaging

```bash
scope --json agent register codex:sol --provider openai --ttl 2m
scope --json agent register claude:opus --provider anthropic --ttl 2m
scope --json message send --from codex:sol --to claude:opus \
  --ticket SCP-124 --kind review_request --body "Review commit abc123"
scope --json message inbox claude:opus
scope --json message reply MESSAGE_ID --from claude:opus --body "Review complete"
scope --json message ack MESSAGE_ID --agent claude:opus
scope message listen claude:opus
```

`message listen` is a long-running JSONL wakeup source for host adapters.
Pending messages are replayed after restart until acknowledged.

All `--json` output is a versioned envelope. Consume `.data` on success and
`.error.code` / `.error.retryable` on failure. Retry mutations with the same
global `--request-id`; protect state-dependent writes with `--if-revision`.
