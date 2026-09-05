#!/usr/bin/env bash
# scope release — bump version, tag, push. CI does the rest.
#
# Usage:
#   ./scripts/release.sh [patch|minor|major|<explicit-version>]   (default: patch)
#
# What this does locally:
#   1. Sanity checks (release-clean tree, on main).
#   2. Bumps package.json/package-lock.json, refreshes generated docs, commits,
#      and creates v<x.y.z>.
#   3. Pushes the commit and tag.
#
# What the GitHub Actions workflow then does (.github/workflows/release.yml):
#   1. Runs the Node matrix and live Postgres integration suite.
#   2. Stages npm with OIDC and waits for maintainer 2FA approval.
#   3. Updates Homebrew and creates the GitHub release.
#   4. Deploys the hosted hub only after the release succeeds.
#
# Required GitHub repo secret (set once):
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
if ! node ./scripts/check-release-tree.mjs; then
  red "Working tree has release-blocking changes. Commit or stash them first."
  yellow "Untracked generated .scope/events and .scope/receipts are allowed; tracked changes and every other untracked path are not."
  exit 1
fi
BRANCH="$(git symbolic-ref --short HEAD)"
if [[ "$BRANCH" != "main" ]]; then
  yellow "Warning: on branch '$BRANCH', not 'main'. Releases usually ship from main."
  read -r -p "Continue anyway? [y/N] " ans
  [[ "$ans" =~ ^[Yy]$ ]] || exit 1
fi

step "Bumping version ($BUMP) and tagging"
# Our precise release-tree check above permits only generated, untracked Scope
# runtime records. npm's generic cleanliness guard cannot distinguish those
# from source files, so perform the version edit without its Git integration
# and then stage exactly the release-owned files ourselves.
NEW_VERSION="$(npm version "$BUMP" --no-git-tag-version --force)"
npm run docs:agent
git add package.json package-lock.json docs/agent-protocol.md
git commit -m "Release $NEW_VERSION"
git tag "$NEW_VERSION"
green "Version is now $NEW_VERSION"

step "Pushing commit and tag to origin"
# `git tag` above creates a lightweight tag. `--follow-tags` only includes
# annotated tags, so name the release tag explicitly or the workflow will not
# receive the tag push that triggers publication.
git push origin "$BRANCH" "$NEW_VERSION"

green ""
green "✓ Pushed $NEW_VERSION. GitHub Actions will now:"
echo "    • run the full Node matrix and live Postgres integration suite"
echo "    • stage npm with OIDC and wait for maintainer 2FA approval"
echo "    • fetch the source tarball and compute its sha256"
echo "    • update Formula/scope.rb in briannadoubt/homebrew-tap"
echo "    • create a GitHub release"
echo "    • deploy the hosted hub only after release succeeds"
echo ""
yellow "Follow progress:"
echo "    gh run watch --repo briannadoubt/scope"
echo ""
yellow "Once it's done, users install with:"
echo "    brew install briannadoubt/tap/scope"
echo "    brew upgrade scope"
