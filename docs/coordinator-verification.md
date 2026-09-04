# Coordinator fixes: verification and adoption ledger

All changes are local to `/Users/bri/.codex/worktrees/510e/Scope`, branch
`codex/coordinator-readiness`. Baseline:
`6921c276deebf3092d0b612ae44b64bacf238fb5`.

| Commit | Result |
| --- | --- |
| `8a49c70cc445d399c629674a9fc35763c0b19cd2` | Declared ownership, slash-prose regressions, source/interface/output conflicts, compact view with complete pagination and snapshot refresh. |
| `05e9a46dd248ea51adb5f8e3242b1a62db130485` | Generic phase resources on work leases, schema/replay migration and explicit event-format-3 boundary. |
| `4207c2918542f33fc9f9d88baf5e51631f254d49` | Historical attempt completion cannot overwrite current ticket lifecycle (Alder AS-201 regression). |
| `d737af8ec099a06d79459d9aa791dff6070ce122` | Exclusive claim admission checks declared outputs/interfaces and respects exclusivity requested by either participant. |

## Tests actually run

- Full branch at `d737af8`: `npm test` — **452 tests: 382 passed, 70 skipped,
  zero failed**. PostgreSQL was unavailable; those integration tests were skipped.
- Independently assembled format-2-compatible checkout: baseline plus
  `8a49c70`, `4207c29`, `d737af8`, excluding `05e9a46`.
  `npm test` — **445 tests: 375 passed, 70 PostgreSQL skips, zero failed**.
  Cherry-picks applied cleanly. The disposable checkout was removed after testing.
- AS-201 regressions were run before the fix and failed with `cancelled` instead
  of `todo`, and `todo` instead of the newer worker's `in_progress`. Afterward,
  runtime tests passed, including replay, coordinator reclaim, preservation of
  review/done and legitimate cancellation by the current owner.
- Resource fixtures cover two independent processes competing for one slot,
  disjoint host domains, capacity exhaustion/mismatch, all-or-nothing acquisition,
  independent phases/authoring, renewal, completion, expiry, stale handles after
  reclaim, and durable SQLite replay. Migration retains existing lease ownership.
- Compact tests cover deterministic ordering, complete reconstruction of all
  conflicts/blockers/tickets, byte budgets, oversized-record errors, stale cursors,
  lease expiry, conditional refresh, lifecycle references and CLI/HTTP interfaces.
- `npm run docs:agent:check` and `git diff --check` passed.

## Response size

The isolated 12-worker large-handoff fixture in
`scripts/benchmark-coordinator.mjs` produced:

| View | Minified data bytes | Approximate tokens (characters / 4) |
| --- | ---: | ---: |
| Pre-fix baseline full plan | 1,900,175 | 475,044 |
| Current full plan | 1,900,575 | 475,144 |
| Current compact snapshot (one page) | 7,875 | 1,969 |
| Current unchanged refresh | 460 | — |

This measures data serialization/context size, not Alder's live board, CLI
latency, envelope/pretty-print overhead, or a model-specific tokenizer. Full
execution projections are still built internally; server-side projection cost
and caching remain possible follow-up work. Pagination never silently discards
conflicts, blockers or groups; callers must finish a snapshot before dispatch.

## Evidence from the two requested tasks

- **Resume AS-157 with Unreal MCP**
  (`01a064d0-776c-7360-8171-62ee322e19f5`): repeated per-ticket state reads,
  confusion between `ready` and `ready --plan` shapes, and manual separation of
  source/instrument completion from native asset publication and acceptance.
  Later AS-201 evidence from the requesting coordinator demonstrated the
  superseded-attempt lifecycle regression, now reproduced and fixed.
- **Evaluate Opus Sol collaboration**
  (`01a02d74-d3f9-7c63-b75c-fb5a394deea3`): recent lease misuse/expiry and CLI
  p95 around 1.3–1.6 seconds; older turn
  `01a06799-74ff-72c0-bd90-b0334e919c46` recorded an undelivered message after
  six attempts with four pending target messages. A later check reported the
  stale binding removed. **SCP-336**, related to **SCP-330**, tracks verification
  of bridge recovery; this work does not claim that historical incident repaired.

## Safe adoption and remaining limits

For the urgent fixes without an event migration, use **8a49c70 → 4207c29 →
d737af8**. That exact patch combination passed the independent format-2 test
run. Old readers can still parse its events, but claimants must use the updated
admission implementation to enforce structured ownership consistently.

Including **05e9a46** changes the package to `0.10.0-dogfood.2`, cache schema to
10 and new event writes to format 3. Upgrade all shared writers/readers and sync
servers before writing those events. Readers retain support for formats 1/2.
PostgreSQL projection changes are present but require live backend validation
before deployment.

Resource admission requires one shared workspace database/HTTP authority per
physical domain; independently writable offline replicas cannot provide a
mutex. Native wrappers retain process/engine locks and must fence expired work.
Scope neither starts workers nor establishes that an expired process has exited.
Canonical worktree/output paths are required; symlink aliases are not discovered.
Worker success and handoff do not certify integration or production acceptance;
use separate ticket contracts and exact verification evidence for those stages.

Installed Scope was checked as **0.10.0-dogfood.1** and was not replaced.
No pushes, deployments, global installs, Alder workspace/configuration changes,
Alder worker directions or native game-acceptance claims were made. See
[coordinator-workflow.md](coordinator-workflow.md) for interface details.
