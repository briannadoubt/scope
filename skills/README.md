# Scope skills

This directory ships the Scope kanban as an **agent skill** for Claude Code,
Codex, and Cursor. Each tool gets a wrapper in its native format that points
at the same canonical content (`scope.md`).

| Tool | File | Installed to |
|---|---|---|
| Claude Code | `claude/scope/SKILL.md` | `~/.claude/skills/scope/SKILL.md` |
| Codex | `codex/AGENTS.md` | `~/.codex/AGENTS.md` (appended if it exists) |
| Cursor | `cursor/scope.mdc` | `<project>/.cursor/rules/scope.mdc` |

## Remote install (recommended)

One command. Auto-detects which tools you have and installs only those:

```bash
curl -fsSL https://raw.githubusercontent.com/briannadoubt/scope/main/skills/install.sh | bash
```

Force a specific tool (or comma-separated set):

```bash
curl -fsSL https://raw.githubusercontent.com/briannadoubt/scope/main/skills/install.sh | bash -s -- --tool claude
curl -fsSL https://raw.githubusercontent.com/briannadoubt/scope/main/skills/install.sh | bash -s -- --tool claude,codex
```

Install the Cursor rule into a specific project:

```bash
curl -fsSL https://raw.githubusercontent.com/briannadoubt/scope/main/skills/install.sh | bash -s -- --tool cursor --project /path/to/my-repo
```

## Per-tool one-liners

If you'd rather skip the installer:

```bash
# Claude Code
mkdir -p ~/.claude/skills/scope && \
  curl -fsSL https://raw.githubusercontent.com/briannadoubt/scope/main/skills/claude/scope/SKILL.md \
       -o ~/.claude/skills/scope/SKILL.md

# Codex (creates ~/.codex/AGENTS.md or appends to it)
mkdir -p ~/.codex && \
  curl -fsSL https://raw.githubusercontent.com/briannadoubt/scope/main/skills/codex/AGENTS.md \
       >> ~/.codex/AGENTS.md

# Cursor (per-project — run from the project root)
mkdir -p .cursor/rules && \
  curl -fsSL https://raw.githubusercontent.com/briannadoubt/scope/main/skills/cursor/scope.mdc \
       -o .cursor/rules/scope.mdc
```

## What the skill teaches

In short: when to reach for Scope (multi-step work, planning, status updates,
bug tracking), how to invoke it (the CLI, with `--json` for parseable output),
the data model (workspace / epic / story / bug / relations / statuses /
priorities), and a handful of common commands. See [`scope.md`](./scope.md)
for the canonical text — the per-tool files are mostly the same content with
different frontmatter.

## No extra setup required

Scope is **CLI-first**. Agents shell out to `scope` directly (every command
supports `--json`). There is nothing to wire up in `~/.claude.json` or
`~/.codex/config.toml` — if `scope` is on `$PATH` the skill works.

To watch the board live while an agent works, run `scope serve` once and open
http://localhost:4321. Every agent that touches `scope` in any repo registers
its `.scope/` with that running hub automatically; the workspace switcher in
the topbar lets you pick which board to look at. If the hub-owning process
dies, a watchdog in any sibling `scope serve` instance promotes itself within
~30s — no manual intervention.

### Claude Code preview pane

For Claude Code's preview pane, use `scope preview --port <unique>` in
`.claude/launch.json` — **not** `scope serve`. `preview_start` enforces one
tracked server per port; if two projects both register `port: 4321` (the
hub), opening the preview in a second pane stops the first pane's tracked
process and the iframe shows "The preview server stopped." `scope preview`
is a tiny per-pane reverse proxy: each project picks its own port (4322,
4323, ...) and forwards to the shared hub on 4321 — so every pane gets its
own preview slot while still showing the same federated kanban.

```json
{
  "version": "0.0.1",
  "configurations": [
    {
      "name": "scope-myproject",
      "runtimeExecutable": "scope",
      "runtimeArgs": ["preview", "--port", "4322"],
      "port": 4322,
      "autoPort": false
    }
  ]
}
```
