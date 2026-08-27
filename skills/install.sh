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

# Fetch a skill file. If $SCOPE_SKILLS_DIR is set (as it is when invoked from
# `scope skills install`), copy from the bundled local directory; otherwise
# download from the GitHub raw URL.
fetch() {
  local rel="$1" out="$2"
  if [[ -n "${SCOPE_SKILLS_DIR:-}" && -f "$SCOPE_SKILLS_DIR/$rel" ]]; then
    cp "$SCOPE_SKILLS_DIR/$rel" "$out"
  else
    curl -fsSL "$RAW/$rel" -o "$out"
  fi
}
# Stream a skill file (for managed-block Codex guidance install).
fetch_cat() {
  local rel="$1"
  if [[ -n "${SCOPE_SKILLS_DIR:-}" && -f "$SCOPE_SKILLS_DIR/$rel" ]]; then
    cat "$SCOPE_SKILLS_DIR/$rel"
  else
    curl -fsSL "$RAW/$rel"
  fi
}

install_claude() {
  if ! want claude; then return 0; fi
  local dest="$HOME/.claude/skills/scope"
  if [[ -z "$TOOLS" && ! -d "$HOME/.claude" ]]; then
    yellow "  skip claude (no ~/.claude directory)"; return 0
  fi
  step "Installing Claude skill → $dest"
  mkdir -p "$dest"
  fetch "claude/scope/SKILL.md" "$dest/SKILL.md"
  green "  ✓ Claude skill installed. Restart Claude Code to pick it up."
}

install_codex() {
  if ! want codex; then return 0; fi
  local skill_dest="$HOME/.agents/skills/scope"
  local guidance_dest="$HOME/.codex/AGENTS.md"
  if [[ -z "$TOOLS" && ! -d "$HOME/.codex" && ! -d "$HOME/.agents" ]]; then
    yellow "  skip codex (no ~/.codex or ~/.agents directory)"; return 0
  fi
  step "Installing Codex user skill → $skill_dest"
  mkdir -p "$skill_dest"
  fetch "scope.md" "$skill_dest/SKILL.md"

  # Keep the legacy global AGENTS.md surface current for existing Codex hosts,
  # but replace our managed block instead of appending duplicates on every run.
  mkdir -p "$(dirname "$guidance_dest")"
  local tmp
  tmp="$(mktemp "${TMPDIR:-/tmp}/scope-agents.XXXXXX")"
  if [[ -f "$guidance_dest" ]]; then
    step "Refreshing managed Scope guidance → $guidance_dest (backup: $guidance_dest.bak)"
    cp "$guidance_dest" "$guidance_dest.bak"
    awk '
      /<!-- BEGIN scope kanban guidance -->/ { skip=1; next }
      /<!-- END scope kanban guidance -->/ { skip=0; next }
      !skip { print }
    ' "$guidance_dest" > "$tmp"
  else
    step "Installing managed Scope guidance → $guidance_dest"
    : > "$tmp"
  fi
  {
    cat "$tmp"
    printf '\n<!-- BEGIN scope kanban guidance -->\n'
    fetch_cat "codex/AGENTS.md"
    printf '\n<!-- END scope kanban guidance -->\n'
  } > "$guidance_dest"
  rm -f "$tmp"
  green "  ✓ Codex skill + global guidance installed. Restart Codex only if the update is not detected."
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
  fetch "cursor/scope.mdc" "$dest"
  green "  ✓ Cursor rule installed. (Per-project; pass --project for another repo.)"
}

if [[ -z "${SCOPE_SKILLS_DIR:-}" ]] && ! command -v curl >/dev/null 2>&1; then
  red "curl is required when SCOPE_SKILLS_DIR is not set."; exit 1
fi

install_claude
install_codex
install_cursor

echo ""
green "Done. The skill teaches the agent when and how to use scope:"
echo "  brew install briannadoubt/tap/scope    # if you haven't already"
echo "  scope init && scope project create my-app MA \"My App\""
