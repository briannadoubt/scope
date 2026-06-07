# Changelog

## 0.8.0

### Added

- **Nestable epics.** An epic can now have a parent epic, so work can be
  organized into multiple levels (e.g. _Platform → Auth subsystem → OAuth
  providers_). Reparenting is cycle-safe — an epic can't be nested under one of
  its own descendants. An epic's progress now rolls up recursively across the
  whole subtree (stories/bugs under nested epics included), not just its direct
  children. Create one with `scope ticket create -t epic "…" --parent <epic>`.
- **Nested swimlanes (web).** Grouping the board by epic now renders the epic
  hierarchy: sub-epics appear indented beneath their parent in tree order, with
  a `SUB-EPIC` badge and subtree-aware progress bars.

### Changed

- **Custom swimlane scroll indicator (web).** Each lane's column strip now
  scrolls edge-to-edge across the window while a custom indicator stays inset
  from the window edges — aligned to the column gutter and each lane's nesting
  indent — instead of the native scrollbar. The first column rests at the
  gutter and the last column stops one gutter in when fully scrolled, lining up
  with the indicator on both ends.

## 0.7.1

### Fixed

- **Relationship graph now updates live as relations change (iOS).** The event
  stream parses `relation.added` / `relation.removed` into a new
  `.relationsChanged` SSE event (previously dropped), and `FlowGraphView`
  carries its own stream so it stays connected after the Board tab disconnects
  on disappear. Added/removed connectors used to draw stale until an unrelated
  ticket change forced a reload; they now refresh immediately.
- **Per-workspace graph relation cache (iOS).** `FlowGraphView` resets its
  relation cache on workspace change, so two workspaces with overlapping ticket
  ids can no longer reuse each other's edges.

## 0.7.0

### Added

- **Event-sourced storage (SCP-106).** The source of truth is now an
  append-only log under `.scope/events/` — one ULID-named JSON file per change.
  `scope.db` is a rebuildable cache projected from the log. Delete it any time;
  the next command replays the log and rebuilds it.
- **Deploy-free collaboration.** Because the log is append-only with globally
  unique file names, merging is a pure union of files — `git pull` (or iCloud /
  Dropbox / Syncthing) reconciles two divergent boards with no server and no
  binary-SQLite merge. Conflicts resolve deterministically: scalar fields are
  last-writer-wins by timestamp; tickets/comments/relations union; ticket
  numbers are de-collided at replay (earliest creator keeps the number). See
  `docs/event-log-format.md` and `docs/adr/0001-decentralized-ticket-identity.md`.
- **`scope batch`** — apply many operations as one atomic transaction (JSON ops
  via `--file` or stdin; all-or-nothing across both the cache and the log).
  Supports `$ref` to reference a ticket created earlier in the same batch.
- **`scope workspace rekey <KEY>`** — change the workspace key *and* reprefix
  every existing ticket (`MA-1` → `APP-1`). `set --key` remains future-only.
- **Comma-separated ids** on `scope status A,B,C <status>` and
  `scope ticket edit A,B …`, applied atomically.
- **`.scope/.gitignore`** written on `init` (and first open): commit the event
  log, never the `scope.db` cache.
- **Relationship graph view (web).** A new scrollable node-link diagram
  (overflow menu → "Relationship graph") that lays epics out as tinted
  umbrella clusters over their child tickets, with cross-ticket relations
  (blocks / relates-to / duplicates) overlaid as colour-coded dashed edges
  with arrowheads. Each epic fans its children into a responsive 1–3 column
  grid, and the clusters pack into a masonry that fills the viewport width
  (wide screen → grid, narrow → a single vertical column). Hovering a node
  spotlights it and its direct connections; epics collapse/expand (persisted
  in `localStorage`); zoom controls and the legend live together in one
  pinned floating control panel. Clicking a node opens the ticket drawer.
  Relations are fetched per-ticket and deduped from the hub's bidirectional
  storage.

- **Full-text ticket search.** A new `GET /api/tickets/search?q=…` endpoint
  backed by a SQLite **FTS5** index that spans every searchable field —
  ticket key (`SCP-12`), number, title, description, assignee, labels,
  branch, PR URL — **and comment bodies**, ranked by relevance (bm25). The
  index is maintained by triggers so it stays in lockstep with every write
  (CLI, hub, direct SQL) and is rebuilt automatically when missing. In the
  **web UI** a command palette opens from the new ⌕ topbar button or the `/`
  and ⌘/Ctrl-K shortcuts: debounced live results with type/priority/status
  plus assignee · label · branch chips, keyboard navigation (↑/↓/↵), and
  click-to-open into the ticket drawer. Also on the CLI as
  `scope ticket search <query>` (alias `find`).

### Changed

- Schema v4: every ticket gets a stable ULID identity (`uid`) backfilled on
  upgrade; existing boards auto-migrate and a complete event log is synthesized
  from current rows + history on first open (no data loss).

### Fixed

- **Cache rebuilds only from an *authoritative* log.** A log counts as the
  source of truth only once it contains a `workspace.init` event, so a partial
  or stray set of events can never trigger a rebuild that would wipe a populated
  database.
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

- **Relationship graph tab.** SwiftUI port of the web relationship graph: a
  new "Graph" tab rendering the same masonry of tinted epic clusters with
  curved hierarchy + relation edges drawn in a `Canvas`, responsive
  multi-column child fan-out (viewport width via `GeometryReader`),
  tap-to-spotlight a node's connections, collapse/expand epics
  (`@AppStorage`), pinch + button zoom, and a single floating zoom-plus-legend
  control panel pinned to the scroll frame. Tapping a node opens
  `TicketDetailView`; relations are fetched per-ticket
  (`GET /api/tickets/:id/relations`) and deduped. A DEBUG-only `UITEST_*`
  launch-environment hook (`ScopeApp`) lets headless tooling open the graph
  directly for verification.
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
- **Ticket search.** A `.searchable` board search wired to the new
  `/api/tickets/search` endpoint: debounced full-text queries across all
  fields and comments, ranked results in a list with type/priority/status
  badges and assignee/label chips, tap-to-open into `TicketDetailView`.

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
