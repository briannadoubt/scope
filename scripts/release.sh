#!/usr/bin/env bash
# scope release — bump version, tag, push. CI does the rest.
#
# Usage:
#   ./scripts/release.sh [patch|minor|major|<explicit-version>]   (default: patch)
#
# What this does locally:
#   1. Sanity checks (clean tree, on main).
#   2. `npm version <bump>` — bumps package.json AND creates the v<x.y.z> tag.
#   3. Pushes the commit and tag.
#
# What the GitHub Actions workflow then does (.github/workflows/release.yml):
#   1. Publishes to npm (with provenance).
#   2. Computes sha256 of the published tarball.
#   3. Patches Formula/scope.rb (url + sha256) and pushes it into
#      briannadoubt/homebrew-tap.
#   4. Creates a GitHub release with auto-generated notes.
#
# Required GitHub repo secrets (set once):
#   NPM_TOKEN                  npm automation token (Publish scope)
#   HOMEBREW_TAP_DEPLOY_KEY    SSH private key; its pubkey is a write-enabled
#                              deploy key on briannadoubt/homebrew-tap

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

BUMP="${1:-patch}"

red()    { printf '\033[31m%s\033[0m\n' "$*"; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
step()   { printf '\033[1;34m▸\033[0m %s\n' "$*"; }

step "Sanity checks"
if [[ -n "$(git status --porcelain)" ]]; then
  red "Working tree is dirty. Commit or stash first."
  git status --short
  exit 1
fi
BRANCH="$(git symbolic-ref --short HEAD)"
if [[ "$BRANCH" != "main" ]]; then
  yellow "Warning: on branch '$BRANCH', not 'main'. Releases usually ship from main."
  read -r -p "Continue anyway? [y/N] " ans
  [[ "$ans" =~ ^[Yy]$ ]] || exit 1
fi

step "Bumping version ($BUMP) and tagging"
# npm version creates a commit AND a tag in one go.
NEW_VERSION="$(npm version "$BUMP" -m "Release v%s")"
green "Version is now $NEW_VERSION"

step "Pushing commit and tag to origin"
git push origin "$BRANCH" --follow-tags

green ""
green "✓ Pushed $NEW_VERSION. GitHub Actions will now:"
echo "    • publish to npm"
echo "    • compute sha256"
echo "    • update Formula/scope.rb in briannadoubt/homebrew-tap"
echo "    • create a GitHub release"
echo ""
yellow "Follow progress:"
echo "    gh run watch -R briannadoubt/scope"
echo ""
yellow "Once it's done, users install with:"
echo "    brew install briannadoubt/tap/scope"
echo "    brew upgrade scope"
