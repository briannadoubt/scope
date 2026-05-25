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
bug tracking), how to access it (MCP first, then CLI), the data model
(project / epic / story / bug / relations / statuses / priorities), and a
handful of common commands. See [`scope.md`](./scope.md) for the canonical
text — the per-tool files are mostly the same content with different
frontmatter.

## Don't forget the actual tool

Skills tell an agent *how* to use Scope; the agent still needs Scope
installed:

```bash
brew install briannadoubt/tap/scope
```

For MCP, add this to the agent's MCP config (`~/.claude.json`, Cursor MCP
settings, or `~/.codex/config.toml`):

```json
{
  "mcpServers": {
    "scope": {
      "command": "scope",
      "args": ["mcp"]
    }
  }
}
```

Or, for a shared HTTP MCP endpoint (run `scope serve` somewhere first):

```json
{
  "mcpServers": {
    "scope": {
      "type": "http",
      "url": "http://localhost:4321/mcp"
    }
  }
}
```
