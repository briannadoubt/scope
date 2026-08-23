# Scope Guardrails

- Use Scope for multi-step work, session context, discrete completion updates, and real bugs worth tracking.
- Do not use Scope for trivial one-off questions.
- Discover `scope --json capabilities`; do not hard-code workspace statuses.
- Before mixed-agent work, verify every host supports
  `data.eventFormat.minimumReaderVersion`. Never open or sync a format-2
  workspace with a format-1-only Scope binary.
- Claim work before editing and renew/release the lease honestly.
- Use host-native subagents for spawning and same-harness live communication.
  Use Scope messages for cross-host or restart-safe delivery. Claim one
  independent Scope ticket per child; do not build or start a Scope runner.
- Deduplicate delivered messages by id and acknowledge only after durable host
  acceptance. Never put credentials or provider session tokens in messages.
- Treat a child final message as advisory. Re-read its Scope attempt and
  completion evidence before reporting success.
- Use `--if-revision` or batch assertions for state-dependent mutations.
- Treat file overlap warnings and unresolved conflicts as coordination signals.
- Never edit `.scope/scope.db` directly. It is a rebuildable cache.
- New workspaces keep events in machine-local storage by default. Commit
  `.scope/workspace.json` and `.scope/remote.json` when present; commit
  `.scope/events/` only in explicit git-events mode.
- Do not delete tickets to clean up; move them to `cancelled`.
- Do not rekey a workspace unless the user explicitly asks.
- Use `--by codex` or a more specific agent name for mutations.
