# Changelog

## Unreleased

### Fixed

- **Web UI topbar no longer collapses labels before they actually collide.**
  The width-based `@media (max-width: 600px)` rule hid the Auto-scroll
  toggle label and the "New ticket" button label in one jump, even when the
  topbar's flex spacer still had ~190px of slack between the left and right
  clusters. Replaced with a `ResizeObserver`-driven compactor that measures
  the spacer in real time and escalates through three classes only when the
  cluster would otherwise be forced off the row (`compact-1` → lose toggle
  + new-ticket text; `compact-2` → lose view trigger label; `compact-3` →
  lose breadcrumb workspace name).

### iOS app

(The iOS app is not on npm; these are reference notes for users tracking the
in-repo `App/` target.)

- **SCP-91 — Markdown + Mermaid rendering** in ticket descriptions.
  `MarkdownView` splits prose from ```` ```mermaid ```` fences; prose
  renders via `AttributedString(.full)`, diagrams via a `WKWebView` loading
  the same pinned `mermaid@11` build the web UI uses.
- **SCP-92 — Swipe gestures on board cards.** Left-swipe advances a card's
  status, right-swipe regresses. Reveal labels in green / orange. PATCH on
  release past the 80pt threshold; SSE move-into-column animates for free.
- **SCP-93 — Offline state + reconnection.** `NWPathMonitor`-driven
  `isOnline` flag with a slim banner overlay; writes fail fast with
  `HubClientError.offline` instead of timing out; tickets re-sync on the
  online edge.
- **Pairing → Board transition fix.** `PairingView` used to drive its
  transition off `.onChange(of: manager.isPaired)`, which silently no-ops
  when `isPaired` was already `true` on appear (Keychain seeds it from the
  prior pair). Replaced with explicit calls after `pair()` returns plus a
  `.task` modifier that catches the already-paired case. Also: tapping a
  previously-paired hub from `ConnectionView` now skips the pair sheet
  entirely (Keychain check → direct `store.connect()`).

## 0.6.0

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
- **`scope preview --port <N>` command.** Per-pane reverse proxy to the
  scope hub, intended for Claude Code's `.claude/launch.json`. Claude Code's
  `preview_start` enforces one tracked server per port, so two projects both
  registering `port: 4321` (the hub) stop each other when their previews
  open in different panes — `scope preview` gives each pane its own
  unique-port slot while every proxy still forwards to the shared hub on
  4321. README, skills (`scope.md`, claude/codex/cursor variants), and the
  skills README document the new pattern.

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
