# Changelog

## Unreleased

### Breaking changes

- **Data model: `project` removed.** Each workspace now owns the ticket key
  prefix, name, description, and overview directly. The `projects` table has
  been merged into `workspace` (a singleton row per `.scope/scope.db`).
  Existing databases auto-migrate on first open (`scope serve` or any CLI
  command).
- **CLI:** `scope project create | edit | delete` deprecated. Use
  `scope workspace set` (and the new `scope workspace show`) instead.
  `scope project delete` errors out; the others print a yellow deprecation
  warning and route to the workspace command.
- **CLI:** `scope ticket create` no longer requires `--project`. The flag is
  accepted with a deprecation warning. `scope board` no longer requires
  `--project` either.
- **HTTP API:** `POST /api/projects` removed. `GET /api/projects` kept as a
  back-compat shim that synthesizes one project per workspace for older
  clients (notably pre-flat-model iOS builds). `POST /api/tickets` no longer
  accepts a `project` field. `PATCH /api/workspaces/:id` is the new way to
  edit workspace metadata.

### Added

- **`scope workspace show | set` commands.** Canonical way to read or edit
  workspace metadata (key, name, description, overview).
- **`scope init` prompts for key + name** on a TTY, or accepts
  `--key MA --name "My App"` for non-interactive setup.

## 0.5.1

### Added

- **iOS app.** SwiftUI client with Bonjour discovery, mTLS pairing, kanban
  board, ticket detail, new-ticket creation, project overview (now
  workspace overview), history view, and live SSE updates. Lives under
  `App/` in this repo.
- **Dual-stack hub.** `scope serve` exposes HTTP on loopback and HTTPS
  (mTLS) on the LAN. Bonjour TXT publishes host, port, scheme, supported
  auth methods, and the CA fingerprint so native clients can verify the hub
  before sending credentials.

### Fixed

- **Bonjour discovery on iOS.** TXT record now includes the resolved host
  and port — `NWBrowser` doesn't expose the SRV target without starting a
  full connection, and clients were timing out trying to resolve.

## 0.5.0

- Initial public release: CLI, web UI, hub auto-discovery, terminal board,
  swimlanes, SSE live updates. No changelog kept before this point.
