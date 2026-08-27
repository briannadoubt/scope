# UI Surfaces

The Scope MCP server exposes two UI render tools:

- `scope_render_board`: an inline board summary for the current repository.
- `scope_render_sidebar`: a sidebar-style workspace view for open work,
  in-progress tickets, blocked items, and recent completion context.

Both tools advertise `ui://scope/board.html` with `_meta.ui.resourceUri` and the
ChatGPT compatibility alias `_meta["openai/outputTemplate"]`. The widget HTML is
served with `text/html;profile=mcp-app`.

The widget treats Scope as the source of truth. It renders from
`structuredContent`, keeps local UI state cosmetic, and uses `window.openai`
only when available for optional host conveniences.

The local `scope serve` web UI also includes a first-party Agent coordination
center, opened from the connected-agents button in the topbar. It renders agent
presence, pending delivery, durable ticket-linked conversations,
acknowledgements and replies, truthful session-connected/mailbox-only state,
active leases, attempt metrics, and conflicts. The message composer warns when
a durable recipient cannot currently be woken by the local session bridge.
Board cards identify the active execution phase and agent; ticket drawers show
lease expiry, verification, evidence, observed repository intent, handoffs, and
conflicts and can jump into a ticket-filtered conversation view.
