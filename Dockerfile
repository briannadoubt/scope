# syntax=docker/dockerfile:1
#
# Hosted Scope hub image (SCP-151).
#
# better-sqlite3 is a native addon: it needs a C++ toolchain + Python to build
# its prebuilt-or-compiled binary against the exact Node ABI. The slim Debian
# images don't ship those, so we use a multi-stage build:
#
#   build stage  — full toolchain, `npm ci` compiles better-sqlite3.
#   runtime stage — node:22-slim, copies only node_modules + app (no toolchain),
#                   keeping the final image small and the attack surface low.
#
# We pin node:22 (current LTS; satisfies package.json engines ">=20"). The ABI
# of the build stage and the runtime stage MUST match — both are node:22-* — or
# the compiled better-sqlite3 .node won't load at runtime.

# ---------- build ----------
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Toolchain for native modules (better-sqlite3). python3 + make + g++ are what
# node-gyp shells out to. Removed implicitly by not carrying this stage forward.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Install deps first (layer cache: only re-runs when manifests change).
COPY package.json package-lock.json ./
# Production deps only — devDeps aren't needed to run the hub. `npm ci` compiles
# better-sqlite3 here against Node 22.
RUN npm ci --omit=dev --no-audit --no-fund

# App source.
COPY . .

# ---------- runtime ----------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Run as the unprivileged user that the node image already provides.
# The persistent volume (/data) is chowned at deploy time via fly.toml; the app
# writes its disposable SQLite cache there (SCOPE_DIR=/data/.scope).
COPY --from=build --chown=node:node /app /app

USER node

# Documents the port; fly.toml maps the public 443 -> this internal port.
EXPOSE 8080

# bin/scope.js serve starts the Express hub. PORT is read by fly.toml's
# internal_port wiring; the serve command takes --port. We pass it explicitly
# from the env so the platform controls the bind port.
#
# SCOPE_CLOUD=1 (from fly.toml) makes serve bind 0.0.0.0 and require auth on
# every request. On a fresh volume there's no workspace yet, so init one at
# SCOPE_DIR first (idempotent: skipped if it already exists) — otherwise serve
# would exit with "No .scope directory found" (SCP-163).
CMD ["sh", "-c", "[ -d \"${SCOPE_DIR:-/data/.scope}\" ] || node bin/scope.js init --key SCOPE --name Scope; node bin/scope.js serve --port ${PORT:-8080} --no-open"]
