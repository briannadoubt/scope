#!/usr/bin/env bash
# Install the Scope skill into Claude Code, Codex, and/or Cursor.
#
# Usage (remote, no clone required):
#   curl -fsSL https://raw.githubusercontent.com/briannadoubt/scope/main/skills/install.sh | bash
#
# By default this auto-detects which agents you have installed and installs
# the matching skill for each. You can force a subset with --tool:
#
#   curl -fsSL .../install.sh | bash -s -- --tool claude
#   curl -fsSL .../install.sh | bash -s -- --tool claude,codex
#
# Or install for a specific Cursor project:
#
#   curl -fsSL .../install.sh | bash -s -- --tool cursor --project /path/to/repo

set -euo pipefail

RAW="https://raw.githubusercontent.com/briannadoubt/scope/main/skills"
TOOLS=""
PROJECT_DIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tool)    TOOLS="${2:-}"; shift 2 ;;
    --project) PROJECT_DIR="${2:-}"; shift 2 ;;
    -h|--help)
      sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

green()  { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
red()    { printf '\033[31m%s\033[0m\n' "$*"; }
step()   { printf '\033[1;34m▸\033[0m %s\n' "$*"; }

want() {
  [[ -z "$TOOLS" ]] && return 0
  case ",${TOOLS}," in *",$1,"*) return 0 ;; *) return 1 ;; esac
}

install_claude() {
  if ! want claude; then return 0; fi
  local dest="$HOME/.claude/skills/scope"
  if [[ -z "$TOOLS" && ! -d "$HOME/.claude" ]]; then
    yellow "  skip claude (no ~/.claude directory)"; return 0
  fi
  step "Installing Claude skill → $dest"
  mkdir -p "$dest"
  curl -fsSL "$RAW/claude/scope/SKILL.md" -o "$dest/SKILL.md"
  green "  ✓ Claude skill installed. Restart Claude Code to pick it up."
}

install_codex() {
  if ! want codex; then return 0; fi
  local dest="$HOME/.codex/AGENTS.md"
  if [[ -z "$TOOLS" && ! -d "$HOME/.codex" ]]; then
    yellow "  skip codex (no ~/.codex directory)"; return 0
  fi
  mkdir -p "$(dirname "$dest")"
  if [[ -f "$dest" ]]; then
    step "Appending Scope guidance → $dest (backed up to $dest.bak)"
    cp "$dest" "$dest.bak"
    {
      printf '\n\n<!-- BEGIN scope kanban guidance -->\n'
      curl -fsSL "$RAW/codex/AGENTS.md"
      printf '\n<!-- END scope kanban guidance -->\n'
    } >> "$dest"
  else
    step "Installing Codex guidance → $dest"
    curl -fsSL "$RAW/codex/AGENTS.md" -o "$dest"
  fi
  green "  ✓ Codex guidance installed."
}

install_cursor() {
  if ! want cursor; then return 0; fi
  local target_root="${PROJECT_DIR:-$PWD}"
  if [[ -z "$TOOLS" && ! -d "$target_root/.cursor" && ! -d "$HOME/Library/Application Support/Cursor" ]]; then
    yellow "  skip cursor (no .cursor/ in CWD and no Cursor app dir)"; return 0
  fi
  local dest="$target_root/.cursor/rules/scope.mdc"
  step "Installing Cursor rule → $dest"
  mkdir -p "$(dirname "$dest")"
  curl -fsSL "$RAW/cursor/scope.mdc" -o "$dest"
  green "  ✓ Cursor rule installed. (Per-project; pass --project for another repo.)"
}

if ! command -v curl >/dev/null 2>&1; then
  red "curl is required."; exit 1
fi

install_claude
install_codex
install_cursor

echo ""
green "Done. The skill teaches the agent when and how to use scope:"
echo "  brew install briannadoubt/tap/scope    # if you haven't already"
echo "  scope init && scope project create my-app MA \"My App\""
