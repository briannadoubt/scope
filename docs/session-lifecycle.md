# Automatic session lifecycle integration

Scope can register a private, stable random agent identity when a supported
model host starts a session, keep that identity online while the local bridge
runs, reuse it when the provider session resumes, and mark it offline when the
session ends. Install the user-level hooks with:

```bash
scope bridge hooks install
scope --json bridge hooks status
```

The installer merges its handlers into `~/.codex/hooks.json` and
`~/.claude/settings.json`; it preserves unrelated hooks and settings and is
idempotent. A malformed existing JSON file is reported and never overwritten.
Codex requires a one-time review of new or changed non-managed hooks: open
`/hooks` in Codex and trust the two Scope lifecycle definitions. This host
review is intentionally not bypassed by the installer.

## Host capability matrix

| Host | Lifecycle signal | Automatic connection | End behavior | Fallback |
| --- | --- | --- | --- | --- |
| Codex CLI and Codex desktop sessions with hooks enabled | Native `SessionStart` (`startup`, `resume`, `clear`, `compact`) and synchronous `SessionEnd` command hooks | Supported | Offline, release active Scope leases, remove the live binding | Mailbox-only if hooks are disabled, untrusted, or unavailable |
| Claude Code CLI, IDE, or a Claude Code surface that fires Claude Code hooks | Native `SessionStart` (`startup`, `resume`, `clear`, `fork`) and `SessionEnd` command hooks | Supported | Offline, release active Scope leases, remove the live binding | Mailbox-only when Claude Code is started with hooks disabled (for example, bare mode) |
| Standalone Claude Desktop/Cowork chat without a Claude Code hook payload | No supported local provider-session lifecycle signal | Not supported | Presence expires by TTL; there is no fabricated live binding | Mailbox-only |
| Codex cloud or another remote host without access to this machine's hook and bridge process | No supported local hook-to-session bridge | Not supported locally | Presence expires by TTL | Mailbox-only or the provider-neutral listener/SSE adapter |

The supported Codex path is the native hook interface, not transcript scanning
or filesystem polling. Codex documents `session_id`, `cwd`, and
`hook_event_name` as common command-hook input and explicitly supports
[`SessionStart` and `SessionEnd`](https://learn.chatgpt.com/docs/hooks). Claude
Code likewise documents lifecycle command hooks across its supported Claude
Code surfaces and the same start/resume/end payload contract in its
[`Hooks reference`](https://code.claude.com/docs/en/hooks).

## Identity and privacy boundary

The provider's opaque session id is accepted only from the hook's stdin. Scope
stores it in the machine-private `~/.scope/bridge.json` file (mode `0600`) and
uses it to resume the provider session. Shared Scope events contain only a
random identity such as `codex:session:8f…` or `claude:session:31…`; the random
value is not derived from the provider session id.

Ending a session removes the active binding but retains the private
session-to-random-identity record. Resuming that provider session therefore
reuses the same Scope identity without putting the provider id or a hash of it
into the event log. CLI and UI bridge projections may show a short one-way
`sessionRef` for local diagnosis, but that value is not emitted in shared
agent-registration or heartbeat events.

## Presence and wake-up behavior

The `SessionStart` handler registers (or renews) the random identity, writes the
private binding, and ensures one machine-local bridge runner exists. The runner
renews lifecycle-managed presence once per minute with a two-minute TTL and
delivers pending addressed messages by resuming the bound provider session. It
checks Scope's private binding state; it does not inspect provider transcript or
session directories. A runner started automatically by a lifecycle hook exits
after the last private session binding is removed and clears its heartbeat, so a
later session can start a fresh runner immediately.

Provider executables are resolved from an explicit `SCOPE_CODEX_BIN` or
`SCOPE_CLAUDE_BIN` override, the bridge daemon's `PATH`, and standard
user-local locations such as `~/.local/bin`. This keeps wake-up delivery working
when `scope serve` was launched by a GUI with a smaller environment than an
interactive shell.

Bridge status describes the most recent delivery attempt for each binding. A
failed attempt remains in the private bridge state for diagnosis, but it does
not leave the agent marked as retrying after a newer message is acknowledged.

`SessionEnd` is intentionally fast: it removes the live binding, marks the
identity offline, and releases active Scope leases owned by that identity. A
later resume reactivates the private identity and creates a new live binding.
