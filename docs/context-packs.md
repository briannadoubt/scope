# Bounded context packs

`scope --json context SCP-339 --budget 2000` limits the **minified response data**
to 8,000 UTF-8 bytes. Budgets are integers from 256 through 262144. This is a
deterministic size limit, not a model tokenizer: `approximateTokens` reports
the returned JSON's JavaScript string length divided by four, rounded up.
`outputBytes` measures the returned data, including its accounting fields.
The CLI emits compact JSON; its protocol envelope and newline are outside the
data budget. HTTP and the library use the same data bound.

Small packs retain their existing fields (`ticket`, `contract`, `readiness`,
`execution`, `discoveries`, etc.) with `truncated: false`. Check `view` before
reading large packs: when the full pack cannot fit, `view: "context-v2"` returns
an index of `{section, id?, value}` or `{section, id?, detail: {ref, bytes}}`
records. Execution links to lease, attempt, and discovery IDs instead of
repeating their bodies. Changes carry event metadata and a referenced payload.
Large evidence, descriptions, contracts, and handoffs remain available on demand.

```sh
scope --json context SCP-339 --budget 2000
scope --json context SCP-339 --cursor NEXT_CURSOR --budget 2000
scope --json context SCP-339 --detail REF --budget 2000
```

Follow `nextCursor` until it is null. The final index page publishes `cursor`
for the next `--since` request; earlier pages return `cursor: null`. Save the
previous completed `--since` cursor until pagination finishes. Index pages
are bound to the ticket, starting cursor, and snapshot. A mutation or lease
expiry can return `STALE_CURSOR`; restart from that previous completed cursor
and deduplicate event IDs. `--cursor` is self-contained and cannot be combined
with `--since` or `--detail`. A page budget can change between requests.

Index `complete` means all index records have been delivered, **not** that
referenced detail has been read. `truncated: true` explicitly signals that the
response is a projection. Retrieve relevant contracts, blockers, and evidence
before acting; a small index is not acceptance verification. Retain the index's
references if advancing `--since`. No historical change entries are silently
dropped to fit the budget.

Detail responses have `view: "context-detail-v1"`, `encoding: "json"`, `text`,
`offset`, `totalChars`, `complete`, and `nextCursor`. Concatenate the decoded
`text` strings in offset order, then JSON-parse the result. Offsets count UTF-16
code units; chunks can split an escaped character or surrogate pair. Do not
parse individual chunks. Every chunk obeys the same data budget, including JSON
escaping and UTF-8 overhead. Detail `truncated` is false only on the last chunk.

References are SHA-256 hashes of the exact JSON record and are looked up in the
requested ticket's context sources. They are not persisted blobs. Durable
discoveries, plans, comments, and event payloads remain retrievable while
present and unchanged; a mutable ticket/contract/attempt/execution record may change. In that
case `CONTEXT_DETAIL_NOT_FOUND` instructs the caller to refresh the index rather
than substituting different content under the old hash.

HTTP uses `GET /api/agent/tickets/:id/context` with `budget`, `since`, `cursor`,
and `detail` query parameters. The library exposes the same options through
`contextPack(db, ticketId, options)`. The `boundedContextPacks` capability
advertises this contract. There is no event-format or database migration.

This bounds output, not database work: source context is still assembled before
projection. A cached/indexed context reader is a separate performance change.
