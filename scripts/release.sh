#!/usr/bin/env bash
# scope release script — npm publish → fetch sha256 → update Formula/scope.rb
#
# Usage:
#   ./scripts/release.sh [patch|minor|major|<explicit-version>]   (default: patch)
#
# What it does:
#   1. Sanity checks (clean git tree, on main, logged into npm).
#   2. Bumps package.json version (npm version <bump>) — creates a v<x.y.z> git tag.
#   3. Publishes to npm.
#   4. Downloads the published tarball, computes sha256.
#   5. Patches Formula/scope.rb (url version + sha256) and commits it.
#   6. Prints the tap-push instructions.
#
# Requirements:
#   - npm logged in: `npm whoami`
#   - clean working tree
#   - origin remote set: github.com/briannadoubt/scope
#
# This script does NOT push to git or to the tap repo — those are the last
# manual steps so you stay in control.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

BUMP="${1:-patch}"
NPM_NAME="$(node -p "require('./package.json').name")"
FORMULA="Formula/scope.rb"

red()    { printf '\033[31m%s\033[0m\n' "$*"; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
step()   { printf '\033[1;34m▸\033[0m %s\n' "$*"; }

# 1. sanity checks
step "Sanity checks"
if [[ -n "$(git status --porcelain)" ]]; then
  red "Working tree is dirty. Commit or stash first."; git status --short; exit 1
fi
BRANCH="$(git symbolic-ref --short HEAD)"
if [[ "$BRANCH" != "main" ]]; then
  yellow "Warning: you're on branch '$BRANCH', not 'main'."
fi
if ! npm whoami >/dev/null 2>&1; then
  red "Not logged in to npm. Run \`npm login\` first."; exit 1
fi
green "npm user: $(npm whoami)"

# 2. version bump
step "Bumping version ($BUMP)"
NEW_VERSION="$(npm version "$BUMP" --no-git-tag-version)"   # e.g. "v0.1.1"
NEW_VERSION="${NEW_VERSION#v}"
git add package.json package-lock.json 2>/dev/null || git add package.json
git commit -m "Release v$NEW_VERSION"
git tag -a "v$NEW_VERSION" -m "v$NEW_VERSION"
green "Version is now v$NEW_VERSION"

# 3. publish
step "Publishing to npm"
npm publish

# 4. sha256 of the published tarball
step "Fetching sha256 of published tarball"
TARBALL_URL="https://registry.npmjs.org/$NPM_NAME/-/$NPM_NAME-$NEW_VERSION.tgz"
TARBALL_TMP="$(mktemp -t scope-release.XXXXXX.tgz)"
trap 'rm -f "$TARBALL_TMP"' EXIT

# Allow a couple of retries — npm registry CDN can take a moment to propagate.
for attempt in 1 2 3 4 5; do
  if curl -fsSL "$TARBALL_URL" -o "$TARBALL_TMP"; then break; fi
  yellow "Tarball not available yet (attempt $attempt) — retrying in 4s..."
  sleep 4
done
if [[ ! -s "$TARBALL_TMP" ]]; then
  red "Could not fetch $TARBALL_URL"; exit 1
fi
SHA256="$(shasum -a 256 "$TARBALL_TMP" | cut -d' ' -f1)"
green "sha256: $SHA256"

# 5. patch Formula/scope.rb
step "Updating $FORMULA"
# url line
/usr/bin/sed -i '' -E "s|^( *url +).*|\\1\"$TARBALL_URL\"|" "$FORMULA"
# sha256 line
/usr/bin/sed -i '' -E "s|^( *sha256 +).*|\\1\"$SHA256\"|" "$FORMULA"
git add "$FORMULA"
git commit -m "Formula: bump to v$NEW_VERSION ($SHA256)"

green ""
green "✓ Released v$NEW_VERSION to npm"
green ""
yellow "Next steps (manual):"
echo "  1. Push the source repo:"
echo "       git push origin main --follow-tags"
echo ""
echo "  2. Update the tap repo (github.com/briannadoubt/homebrew-scope):"
echo "       cp $FORMULA /path/to/homebrew-scope/Formula/scope.rb"
echo "       cd /path/to/homebrew-scope"
echo "       git add Formula/scope.rb"
echo "       git commit -m 'scope v$NEW_VERSION'"
echo "       git push"
echo ""
echo "  3. Users install with:"
echo "       brew tap briannadoubt/scope"
echo "       brew install scope"
echo ""
echo "     Or upgrade with:"
echo "       brew upgrade scope"
