# Scope Guardrails

- Use Scope for multi-step work, session context, discrete completion updates, and real bugs worth tracking.
- Do not use Scope for trivial one-off questions.
- Read state before writing state when multiple agents may be active.
- Never edit `.scope/scope.db` directly. It is a rebuildable cache.
- Commit `.scope/events/` when the workspace is part of the repository history.
- Do not delete tickets to clean up; move them to `cancelled`.
- Do not rekey a workspace unless the user explicitly asks.
- Use `--by codex` or a more specific agent name for mutations.
