/* scope — local web UI */

const state = {
  meta: null,
  serverVersion: null,
  workspaces: [],
  currentWorkspace: localStorage.getItem('scope.workspace') || null,
  epicFilter: '',
  view: 'board', // 'board' | 'overview' | 'history' | 'graph'
  history: null, // { entries: [...] } for the history view
  board: null,
  graphData: null, // { tickets, edges } cached while the graph view is open
  graphScale: 1,   // zoom factor for the graph view
  graphCollapsed: new Set(
    JSON.parse(localStorage.getItem('scope.graphCollapsed') || '[]')
  ),
  drawerTicketId: null,
  groupBy: localStorage.getItem('scope.groupBy') || 'none',
  showDoneEpics: localStorage.getItem('scope.showDoneEpics') === 'true',
  autoScroll: localStorage.getItem('scope.autoScroll') !== 'false',
  allEpics: [],
  collapsedLanes: new Set(
    JSON.parse(localStorage.getItem('scope.collapsedLanes') || '[]')
  ),
};

const STATUS_LABELS = {
  backlog: 'Backlog',
  todo: 'Todo',
  in_progress: 'In progress',
  in_review: 'In review',
  done: 'Done',
  cancelled: 'Cancelled',
};

const BOARD_COLUMNS = ['backlog', 'todo', 'in_progress', 'in_review', 'done'];

/* ------------- API ------------- */

/**
 * Fetch wrapper. Auto-threads the current workspace into every URL that
 * starts with /api/ (and doesn't already specify one) via the X-Scope-Workspace
 * header. Workspace and event-source URLs are passthrough.
 */
async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (
    state.currentWorkspace &&
    path.startsWith('/api/') &&
    !path.includes('/api/workspaces') &&
    !path.includes('/api/meta') &&
    !/[?&]workspace=/.test(path)
  ) {
    headers['X-Scope-Workspace'] = state.currentWorkspace;
  }
  const res = await fetch(path, {
    ...opts,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    // SCP-191: carry the HTTP status + machine code (e.g. LAST_OWNER,
    // FORBIDDEN_ROLE) so callers can branch without string-matching messages.
    const e = new Error(err.error || `HTTP ${res.status}`);
    e.status = res.status;
    e.code = err.code || null;
    throw e;
  }
  if (res.status === 204) return null;
  return res.json();
}

/* ------------- init ------------- */

async function init() {
  state.meta = await api('/api/meta');
  state.serverVersion = state.meta.version ?? null;
  // SCP-191: invite links land on /app?invite=<code>. Redeem BEFORE the first
  // workspaces fetch so the newly-joined board is already in the list, and
  // prefer it as the active board below.
  const invitedTenant = await maybeAcceptInvite();
  await reloadWorkspaces();
  if (invitedTenant && state.workspaces.find((w) => w.id === invitedTenant)) {
    state.currentWorkspace = invitedTenant;
    localStorage.setItem('scope.workspace', invitedTenant);
  }
  bindTopbar();
  // Pick workspace: previously-selected if still attached, else first.
  if (
    !state.currentWorkspace ||
    !state.workspaces.find((w) => w.id === state.currentWorkspace)
  ) {
    state.currentWorkspace = state.workspaces[0]?.id || null;
  }
  if (!state.currentWorkspace) {
    updateBreadcrumb();
    // SCP-191: a fresh hosted login with zero projects gets a welcome card
    // (create-first-project CTA) instead of the local-path hint.
    if (state.meta?.hosted) renderHostedWelcome();
    else renderEmpty('No workspaces attached. Run `scope serve` in a repo with a .scope/ directory.');
    return;
  }
  updateBreadcrumb();
  await refresh();
}

/**
 * SCP-191: if the URL carries ?invite=<code> on a hosted hub, redeem it and
 * strip the param (codes are single-use — a refresh must not re-redeem).
 * Returns the joined tenant id, or null when there was nothing to accept.
 */
async function maybeAcceptInvite() {
  if (!state.meta?.hosted) return null;
  const params = new URLSearchParams(location.search);
  const code = params.get('invite');
  if (!code) return null;
  params.delete('invite');
  const qs = params.toString();
  history.replaceState(null, '', location.pathname + (qs ? `?${qs}` : '') + location.hash);
  try {
    const res = await api('/api/invites/accept', { method: 'POST', body: { code } });
    toast(`Joined ${res.name} as ${res.role}.`, { variant: 'info' });
    return res.tenantId;
  } catch (e) {
    toast(`Couldn’t accept invite: ${e.message}`);
    return null;
  }
}

async function reloadWorkspaces() {
  state.workspaces = await api('/api/workspaces');
  updateBreadcrumb();
}

function currentWorkspaceObj() {
  return state.workspaces.find((x) => x.id === state.currentWorkspace) || null;
}

function updateBreadcrumb() {
  const w = currentWorkspaceObj();
  const wsEl = document.getElementById('bc-workspace');
  if (!wsEl) return;
  if (w) {
    // Show workspace name plus key chip.
    wsEl.innerHTML = '';
    if (w.key) {
      const chip = document.createElement('span');
      chip.className = 'pkey';
      chip.textContent = w.key;
      wsEl.appendChild(chip);
      wsEl.appendChild(document.createTextNode(' '));
    }
    wsEl.appendChild(document.createTextNode(w.name || w.label));
  } else {
    wsEl.textContent = state.workspaces.length ? 'Select workspace' : 'No workspaces';
  }
  applyRoleChrome();
  updateViewTrigger();
}

/**
 * SCP-191: role-aware chrome. Viewers can't create tickets (the server 403s),
 * so hide the dead controls — body.role-viewer drives display:none rules for
 * the "+ New ticket" button and the per-column "+" buttons. Hosted-only: the
 * local path has no roles, so the class never appears there.
 */
function applyRoleChrome() {
  const viewer = !!(state.meta?.hosted && currentWorkspaceObj()?.role === 'viewer');
  document.body.classList.toggle('role-viewer', viewer);
}

function updateViewTrigger() {
  const label = document.getElementById('view-label');
  if (!label) return;
  const bits = [];
  if (state.groupBy && state.groupBy !== 'none') {
    bits.push(state.groupBy.charAt(0).toUpperCase() + state.groupBy.slice(1));
  }
  if (state.epicFilter) bits.push(state.epicFilter);
  label.textContent = bits.length ? bits.join(' · ') : 'View';
  document.getElementById('view-trigger').classList.toggle('active', bits.length > 0);
}

async function refresh() {
  if (!state.currentWorkspace) return renderEmpty();
  refreshPresence(); // SCP-225: keep the online-roster pill in step with the board
  // The graph view repurposes #board with its own host class; clear it on every
  // refresh so non-graph views aren't constrained by the graph's layout rules.
  document.getElementById('board').classList.remove('graph-host');
  await loadEpicsForFilter();
  if (state.view === 'overview') return renderOverview();
  if (state.view === 'history') return renderHistory();
  if (state.view === 'graph') return renderGraph();
  const oldPositions = captureCardPositions();
  const oldBoard = state.board;
  await loadBoard();
  renderBoard();
  animateCardMoves(oldPositions);
  if (state.autoScroll) scrollToMovedCards(findMovedTicketIds(oldBoard, state.board), 380);
}

async function loadEpicsForFilter() {
  const tickets = await api('/api/tickets?type=epic');
  state.allEpics = tickets;
  // If the filter points at an epic that no longer exists, clear it.
  if (state.epicFilter && !tickets.some((t) => t.id === state.epicFilter)) {
    state.epicFilter = '';
  }
  updateViewTrigger();
}

async function loadBoard() {
  const params = new URLSearchParams();
  if (state.epicFilter) params.set('epic', state.epicFilter);
  const q = params.toString();
  state.board = await api(`/api/board${q ? `?${q}` : ''}`);
  lastBoardHash = hashBoard(state.board);
}

/* ------------- mermaid ------------- */

// Lazy-load mermaid only when a description actually contains a mermaid fence.
// Cached as a Promise so concurrent renders share one network round-trip.
let _mermaidPromise = null;
function loadMermaid() {
  if (_mermaidPromise) return _mermaidPromise;
  _mermaidPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.type = 'module';
    // Pinned version so a CDN change can't break diagrams unannounced.
    script.textContent = `
      import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';
      mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict' });
      window.__mermaid = mermaid;
      window.dispatchEvent(new Event('__mermaid-ready'));
    `;
    const onReady = () => { window.removeEventListener('__mermaid-ready', onReady); resolve(window.__mermaid); };
    window.addEventListener('__mermaid-ready', onReady);
    script.addEventListener('error', () => reject(new Error('Failed to load mermaid')));
    document.head.appendChild(script);
    // Failsafe timeout — if the CDN is unreachable the fences degrade to source.
    setTimeout(() => {
      if (!window.__mermaid) reject(new Error('mermaid load timeout'));
    }, 8000);
  }).catch((err) => { _mermaidPromise = null; throw err; });
  return _mermaidPromise;
}

/**
 * Find any rendered fenced blocks tagged `mermaid` inside `root` and replace
 * each with the rendered SVG. Runs after renderMarkdown has produced
 * `<pre><code class="lang-mermaid">...</code></pre>`. Falls back gracefully
 * when the CDN is unreachable.
 */
async function hydrateMermaid(root) {
  if (!root) return;
  const blocks = root.querySelectorAll('pre > code.lang-mermaid');
  if (!blocks.length) return;
  let mermaid;
  try { mermaid = await loadMermaid(); }
  catch {
    for (const code of blocks) {
      const pre = code.parentElement;
      pre.classList.add('mermaid-offline');
      pre.setAttribute('data-note', 'mermaid (offline — showing source)');
    }
    return;
  }
  let idx = 0;
  for (const code of blocks) {
    const pre = code.parentElement;
    if (!pre || pre.dataset.rendered === '1') continue;
    const src = code.textContent;
    const id = `mmd-${Date.now()}-${idx++}`;
    try {
      const { svg } = await mermaid.render(id, src);
      const wrap = document.createElement('div');
      wrap.className = 'mermaid-diagram';
      wrap.innerHTML = svg;
      pre.replaceWith(wrap);
    } catch (err) {
      pre.classList.add('mermaid-error');
      pre.setAttribute('data-note', `mermaid: ${err.message || 'parse error'}`);
      pre.dataset.rendered = '1';
    }
  }
}

/* ------------- toasts ------------- */

/**
 * Show an inline toast. Replaces window.alert() so transient errors don't
 * block the UI thread (or trap focus). Stacks vertically in the bottom-right.
 * variant: 'error' (default) | 'info'.
 */
function toast(message, { variant = 'error', timeout = 4500 } = {}) {
  const root = document.getElementById('toast-root');
  if (!root) return;
  const el = document.createElement('div');
  el.className = `toast toast-${variant}`;
  el.setAttribute('role', variant === 'error' ? 'alert' : 'status');
  el.textContent = String(message ?? '');
  const close = document.createElement('button');
  close.className = 'toast-close';
  close.setAttribute('aria-label', 'Dismiss');
  close.textContent = '×';
  close.addEventListener('click', () => dismiss());
  el.appendChild(close);
  root.appendChild(el);
  // Force a reflow so the enter transition plays.
  void el.offsetHeight;
  el.classList.add('show');
  let timer = setTimeout(dismiss, timeout);
  function dismiss() {
    if (timer) { clearTimeout(timer); timer = null; }
    el.classList.remove('show');
    el.addEventListener('transitionend', () => el.remove(), { once: true });
    // Belt-and-suspenders for environments where transitionend may not fire.
    setTimeout(() => el.remove(), 600);
  }
}

/* ------------- topbar ------------- */

function bindTopbar() {
  document.getElementById('new-ticket').addEventListener('click', () => openTicketModal());
  document.getElementById('breadcrumb-trigger').addEventListener('click', openBreadcrumbPopover);
  document.getElementById('view-trigger').addEventListener('click', openViewPopover);
  document.getElementById('overflow-trigger').addEventListener('click', openOverflowMenu);
  document.getElementById('search-trigger').addEventListener('click', () => openSearchModal());
  bindSearchShortcuts();
  const autoInput = document.getElementById('autoscroll-toggle');
  autoInput.checked = state.autoScroll;
  autoInput.addEventListener('change', () => {
    state.autoScroll = autoInput.checked;
    localStorage.setItem('scope.autoScroll', state.autoScroll ? 'true' : 'false');
  });
  startEventStream();
}

/* ------------- popovers ------------- */

// One popover at a time. Returns the popover element so callers can populate
// it. Anchors below `anchorEl`, aligned to its `align` edge ('left' | 'right').
let popoverEl = null;
function openPopover(anchorEl, {align = 'left', width} = {}) {
  closePopover();
  const pop = document.createElement('div');
  pop.className = 'popover';
  if (width) pop.style.width = typeof width === 'number' ? `${width}px` : width;
  document.body.appendChild(pop);
  const rect = anchorEl.getBoundingClientRect();
  pop.style.top = `${rect.bottom + 6 + window.scrollY}px`;
  // Defer left-edge math until after content sets width.
  requestAnimationFrame(() => {
    const popRect = pop.getBoundingClientRect();
    let left = align === 'right'
      ? rect.right - popRect.width
      : rect.left;
    left = Math.max(8, Math.min(left, window.innerWidth - popRect.width - 8));
    pop.style.left = `${left + window.scrollX}px`;
  });
  popoverEl = pop;
  anchorEl.classList.add('open');
  const onDocClick = (e) => {
    if (pop.contains(e.target) || anchorEl.contains(e.target)) return;
    closePopover();
  };
  const onKey = (e) => { if (e.key === 'Escape') closePopover(); };
  setTimeout(() => {
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
  }, 0);
  pop._cleanup = () => {
    document.removeEventListener('mousedown', onDocClick);
    document.removeEventListener('keydown', onKey);
    anchorEl.classList.remove('open');
  };
  return pop;
}
function closePopover() {
  if (popoverEl) {
    popoverEl._cleanup?.();
    popoverEl.remove();
    popoverEl = null;
  }
}

function openBreadcrumbPopover() {
  const anchor = document.getElementById('breadcrumb-trigger');
  if (popoverEl) return closePopover();
  const pop = openPopover(anchor, {align: 'left', width: 320});
  pop.classList.add('popover-breadcrumb');
  // SCP-191: hosted boards are project boards — the footer creates a new
  // project instead of attaching a local .scope/ dir (meaningless when hosted).
  const hosted = !!state.meta?.hosted;
  pop.innerHTML = `
    <div class="pane pane-workspaces">
      <div class="pane-head">${hosted ? 'Projects' : 'Workspaces'}</div>
      <div class="pane-list" id="bc-ws-list"></div>
      <button type="button" class="pane-foot" id="bc-attach">${hosted ? '＋ New project…' : '＋ Attach workspace…'}</button>
    </div>
  `;
  const wsList = pop.querySelector('#bc-ws-list');

  const renderWsList = () => {
    wsList.innerHTML = '';
    for (const w of state.workspaces) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'pane-item';
      if (w.id === state.currentWorkspace) item.classList.add('active');
      // Hosted entries have no scope_dir; show the caller's role instead.
      item.innerHTML = `
        <span class="pane-item-label">${w.key ? `<span class="pkey">${escapeHtml(w.key)}</span> ` : ''}${escapeHtml(w.name || w.label)}</span>
        <span class="pane-item-sub">${hosted ? escapeHtml(w.role || '') : escapeHtml(w.scope_dir)}</span>
      `;
      item.addEventListener('click', async () => {
        if (w.id !== state.currentWorkspace) {
          state.currentWorkspace = w.id;
          localStorage.setItem('scope.workspace', w.id);
          state.epicFilter = '';
          state.view = 'board';
          updateBreadcrumb();
          // Restart SSE so the workspace filter is correct.
          if (eventSource) { try { eventSource.close(); } catch {} eventSource = null; }
          startEventStream();
          await refresh();
        }
        closePopover();
      });
      wsList.appendChild(item);
    }
    if (state.workspaces.length === 0) {
      wsList.innerHTML = '<div class="pane-empty">No workspaces attached.</div>';
    }
  };

  pop.querySelector('#bc-attach').addEventListener('click', () => {
    closePopover();
    if (hosted) openCreateProjectModal();
    else openAddWorkspaceModal();
  });

  renderWsList();
}

function openViewPopover() {
  const anchor = document.getElementById('view-trigger');
  if (popoverEl) return closePopover();
  const pop = openPopover(anchor, {align: 'left', width: 280});
  pop.classList.add('popover-view');
  const epicOpts = ['<option value="">All tickets</option>']
    .concat(state.allEpics.map((e) =>
      `<option value="${escapeHtml(e.id)}"${e.id === state.epicFilter ? ' selected' : ''}>${escapeHtml(e.id)} · ${escapeHtml(e.title)}</option>`
    ))
    .join('');
  pop.innerHTML = `
    <div class="popover-section">
      <label class="popover-label">Filter</label>
      <select id="vp-epic" class="popover-select">${epicOpts}</select>
    </div>
    <div class="popover-section">
      <label class="popover-label">Group by</label>
      <div class="popover-segmented" id="vp-group">
        ${['none','epic','assignee','priority','type'].map((v) =>
          `<button type="button" data-v="${v}"${state.groupBy === v ? ' class="active"' : ''}>${v === 'none' ? 'None' : v[0].toUpperCase()+v.slice(1)}</button>`
        ).join('')}
      </div>
    </div>
    <div class="popover-section" id="vp-showdone-wrap"${state.groupBy === 'epic' ? '' : ' hidden'}>
      <label class="check">
        <input id="vp-showdone" type="checkbox"${state.showDoneEpics ? ' checked' : ''} />
        <span>Show done epics</span>
      </label>
    </div>
  `;
  pop.querySelector('#vp-epic').addEventListener('change', async (e) => {
    state.epicFilter = e.target.value;
    state.view = 'board';
    updateViewTrigger();
    await refresh();
  });
  pop.querySelectorAll('#vp-group button').forEach((b) => {
    b.addEventListener('click', () => {
      state.groupBy = b.dataset.v;
      localStorage.setItem('scope.groupBy', state.groupBy);
      pop.querySelectorAll('#vp-group button').forEach((x) => x.classList.toggle('active', x === b));
      pop.querySelector('#vp-showdone-wrap').hidden = state.groupBy !== 'epic';
      updateViewTrigger();
      renderBoard();
    });
  });
  pop.querySelector('#vp-showdone').addEventListener('change', (e) => {
    state.showDoneEpics = e.target.checked;
    localStorage.setItem('scope.showDoneEpics', String(state.showDoneEpics));
    renderBoard();
  });
}

function openOverflowMenu() {
  const anchor = document.getElementById('overflow-trigger');
  if (popoverEl) return closePopover();
  const pop = openPopover(anchor, {align: 'right', width: 200});
  pop.classList.add('popover-menu');
  // Hosted-only items (per-user identity): members panel (SCP-191), API keys +
  // sign out (SCP-174). Shown only when the hub runs hosted auth — never on the
  // local/LAN path.
  const hostedItems = state.meta?.hosted ? `
    <div class="menu-sep"></div>
    <button type="button" class="menu-item" data-act="members"><span class="mi-icon">👥</span> Members &amp; sharing</button>
    <button type="button" class="menu-item" data-act="apikeys"><span class="mi-icon">🔑</span> API keys</button>
    <button type="button" class="menu-item" data-act="signout"><span class="mi-icon">⏏</span> Sign out</button>
  ` : '';
  pop.innerHTML = `
    <button type="button" class="menu-item" data-act="refresh"><span class="mi-icon">↻</span> Refresh</button>
    <button type="button" class="menu-item" data-act="graph"><span class="mi-icon">⛓</span> ${state.view === 'graph' ? 'Back to board' : 'Relationship graph'}</button>
    <button type="button" class="menu-item" data-act="overview"><span class="mi-icon">☰</span> ${state.view === 'overview' ? 'Back to board' : 'Workspace overview'}</button>
    <button type="button" class="menu-item" data-act="history"><span class="mi-icon">⏱</span> ${state.view === 'history' ? 'Back to board' : 'History'}</button>
    ${hostedItems}
  `;
  pop.querySelectorAll('.menu-item').forEach((b) => {
    b.addEventListener('click', async () => {
      const act = b.dataset.act;
      closePopover();
      if (act === 'refresh') { flashIndicator('tick'); await repairHubConnection(); }
      else if (act === 'graph') {
        state.view = state.view === 'graph' ? 'board' : 'graph';
        if (state.view === 'graph') state.graphData = null; // force a fresh fetch
        await refresh();
      }
      else if (act === 'overview') {
        state.view = state.view === 'overview' ? 'board' : 'overview';
        await refresh();
      }
      else if (act === 'history') {
        state.view = state.view === 'history' ? 'board' : 'history';
        await refresh();
      }
      else if (act === 'members') openMembersModal();
      else if (act === 'apikeys') openApiKeysModal();
      else if (act === 'signout') {
        try { await api('/auth/logout', { method: 'POST' }); } catch {}
        window.location.href = '/';
      }
    });
  });
}

/**
 * API-keys manager (SCP-174) — mint, copy, and revoke per-user keys for the CLI
 * and agents. The plaintext secret is shown exactly once, at creation. Hosted
 * mode only (the menu entry that opens this is gated on meta.hosted).
 */
async function openApiKeysModal() {
  const modal = openModal(`
    <div class="modal-head"><h2>API keys</h2></div>
    <p class="modal-sub">Use a key as <code>SCOPE_API_KEY</code> for <code>scope sync</code>. The secret is shown once.</p>
    <form id="apikey-form" class="apikey-form">
      <input id="apikey-name" type="text" placeholder="Key name (e.g. laptop, ci)" autocomplete="off" required />
      <button type="submit" class="btn primary">Create</button>
    </form>
    <div id="apikey-fresh" class="apikey-fresh" hidden></div>
    <div id="apikey-list" class="apikey-list">Loading…</div>
  `);

  const listEl = modal.querySelector('#apikey-list');
  const freshEl = modal.querySelector('#apikey-fresh');

  async function renderList() {
    try {
      const keys = await api('/auth/keys');
      listEl.innerHTML = keys.length
        ? keys.map((k) => `
          <div class="apikey-row${k.revoked_at ? ' revoked' : ''}">
            <span class="apikey-id">${escapeHtml(k.name)} <code>${escapeHtml(k.id)}</code></span>
            ${k.revoked_at
              ? '<span class="apikey-tag">revoked</span>'
              : `<button type="button" class="link-btn" data-revoke="${escapeHtml(k.id)}">Revoke</button>`}
          </div>`).join('')
        : '<div class="pane-empty">No keys yet.</div>';
      listEl.querySelectorAll('[data-revoke]').forEach((b) => {
        b.addEventListener('click', async () => {
          b.disabled = true;
          try { await api(`/auth/keys/${encodeURIComponent(b.dataset.revoke)}`, { method: 'DELETE' }); }
          catch (e) { b.disabled = false; return; }
          await renderList();
        });
      });
    } catch (e) {
      listEl.innerHTML = `<div class="modal-error">${escapeHtml(e.message)}</div>`;
    }
  }

  modal.querySelector('#apikey-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = modal.querySelector('#apikey-name');
    const name = input.value.trim();
    if (!name) return;
    try {
      const created = await api('/auth/keys', { method: 'POST', body: { name } });
      input.value = '';
      freshEl.hidden = false;
      freshEl.innerHTML = `Copy your new key now — it won’t be shown again:
        <code class="apikey-secret">${escapeHtml(created.key)}</code>
        <button type="button" class="link-btn" id="apikey-copy">Copy</button>`;
      freshEl.querySelector('#apikey-copy').addEventListener('click', () => {
        navigator.clipboard?.writeText(created.key);
      });
      await renderList();
    } catch (e) {
      freshEl.hidden = false;
      freshEl.innerHTML = `<span class="modal-error">${escapeHtml(e.message)}</span>`;
    }
  });

  await renderList();
}

/* ------- projects: create / members / invites / lifecycle (SCP-191) -------
 * Everything in this section is hosted-only: the entry points (switcher
 * footer, overflow menu, welcome card, ?invite= boot hook) are all gated on
 * state.meta.hosted, so none of it is reachable on the local `scope serve`
 * path. A hosted "workspace" is a project board; its id is the tenant id and
 * its `role` field is the caller's role on that board. */

const PROJECT_ROLES = ['owner', 'member', 'viewer'];

/**
 * Switch the UI onto a hosted board after the project list changed (created,
 * joined, archived, left). Reloads workspaces first; `tenantId` may be null or
 * stale — then we fall back to the first remaining board, or the welcome card
 * when the caller has none left.
 */
async function switchToBoard(tenantId) {
  await reloadWorkspaces();
  const target =
    state.workspaces.find((x) => x.id === tenantId) || state.workspaces[0] || null;
  state.currentWorkspace = target ? target.id : null;
  if (target) localStorage.setItem('scope.workspace', target.id);
  state.epicFilter = '';
  state.view = 'board';
  updateBreadcrumb();
  // Restart SSE so the workspace filter is correct.
  if (eventSource) { try { eventSource.close(); } catch {} eventSource = null; }
  startEventStream();
  if (!state.currentWorkspace) return renderHostedWelcome();
  await refresh();
}

/**
 * Centered welcome card for a hosted account with zero projects (fresh login,
 * or the last board was just archived/left). Reuses the board-empty layout.
 */
function renderHostedWelcome() {
  const root = document.getElementById('board');
  root.classList.remove('swim', 'graph-host');
  root.style.display = '';
  root.classList.add('board-empty-wrap');
  root.innerHTML = `
    <div class="board-empty proj-welcome">
      <div class="board-empty-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="40" height="40" fill="none"
             stroke="currentColor" stroke-width="1.5"
             stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="4" width="18" height="16" rx="2"/>
          <path d="M9 4v16M15 4v16"/>
        </svg>
      </div>
      <h2 class="board-empty-title">Welcome to Scope</h2>
      <p class="board-empty-desc">You don’t have a project yet. A project is a
        shared kanban board — create one, then invite teammates from
        “Members &amp; sharing”.</p>
      <div class="board-empty-actions">
        <button type="button" class="btn primary" id="proj-welcome-create">
          <span aria-hidden="true">＋</span>
          <span>Create your first project</span>
        </button>
      </div>
    </div>
  `;
  root.querySelector('#proj-welcome-create').addEventListener('click', () => openCreateProjectModal());
}

/** Name-only modal → POST /api/projects → switch to the new board. */
function openCreateProjectModal() {
  const modal = openModal(`
    <h3>New project</h3>
    <p class="modal-sub">A project is a shared board. You become its owner and
      can invite others from “Members &amp; sharing”.</p>
    <label>Name <input id="proj-name" placeholder="e.g. Apollo" autocomplete="off" /></label>
    <div class="error" id="proj-err"></div>
    <div class="modal-actions">
      <button class="btn ghost" id="proj-cancel" type="button">Cancel</button>
      <button class="btn primary" id="proj-create" type="button">Create</button>
    </div>
  `);
  const input = modal.querySelector('#proj-name');
  input.focus();
  const submit = async () => {
    const name = input.value.trim();
    if (!name) {
      modal.querySelector('#proj-err').textContent = 'Name is required.';
      return;
    }
    const btn = modal.querySelector('#proj-create');
    btn.disabled = true;
    try {
      const created = await api('/api/projects', { method: 'POST', body: { name } });
      closeModal();
      toast(`Project ${created.name} created.`, { variant: 'info' });
      await switchToBoard(created.tenantId);
    } catch (e) {
      btn.disabled = false;
      modal.querySelector('#proj-err').textContent = e.message;
    }
  };
  modal.querySelector('#proj-cancel').addEventListener('click', closeModal);
  modal.querySelector('#proj-create').addEventListener('click', submit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
  });
}

/**
 * Leave a project as a non-owner. The hub exposes no whoami endpoint, so the
 * client can't directly know its own account id; DELETE /members/:accountId
 * (which the server only allows on YOURSELF unless you're an owner) is the
 * one self-shaped operation. Strategy, safest first:
 *   1. an id learned from a previous successful leave (localStorage cache),
 *   2. a sequential probe: for a NON-owner every non-self delete is refused
 *      with 403 before any mutation, so trying candidates one by one is
 *      side-effect-free for every row except our own. A sentinel pre-check
 *      aborts if our role drifted to owner server-side (where a real delete
 *      would land on someone else).
 */
async function leaveProject(tid, members, errEl) {
  const tidPath = encodeURIComponent(tid);
  const memberPath = (acct) => `/api/projects/${tidPath}/members/${encodeURIComponent(acct)}`;

  // Sentinel pre-check: an owner deleting a nonexistent member gets an
  // idempotent {ok:true}; a non-owner gets 403 before any lookup. Only a 403
  // proves the probe below cannot remove anyone but ourselves.
  try {
    await api(memberPath('__scope_self_probe__'), { method: 'DELETE' });
    errEl.textContent = 'You are an owner of this project — transfer ownership before leaving.';
    return false;
  } catch (e) {
    if (e.status !== 403) { errEl.textContent = e.message; return false; }
  }

  const cached = localStorage.getItem('scope.accountId');
  const myRole = state.workspaces.find((x) => x.id === tid)?.role || null;
  const sameRole = members.filter((m) => m.role === myRole);
  const candidates = [];
  if (cached && members.some((m) => m.account_id === cached)) candidates.push(cached);
  for (const m of [...sameRole, ...members]) {
    if (!candidates.includes(m.account_id)) candidates.push(m.account_id);
  }

  for (const acct of candidates) {
    try {
      await api(memberPath(acct), { method: 'DELETE' });
      localStorage.setItem('scope.accountId', acct); // learned: this is me
      return true;
    } catch (e) {
      if (e.status === 403) continue; // not me — refused before any change
      errEl.textContent = e.message;
      return false;
    }
  }
  errEl.textContent = 'Couldn’t identify your membership — ask an owner to remove you.';
  return false;
}

/**
 * Members & sharing panel: member list with role management (owner), invites
 * with one-time share links (owner), self leave (non-owner), and project
 * rename/archive (owner). Opened from the overflow menu, hosted only.
 */
async function openMembersModal() {
  const w = currentWorkspaceObj();
  if (!state.meta?.hosted || !w) {
    return toast('Select a project first.', { variant: 'info' });
  }
  const tid = w.id;
  const tidPath = encodeURIComponent(tid);
  const myRole = w.role || 'viewer';
  const isOwner = myRole === 'owner';
  const projName = w.name || w.label || 'this project';

  const modal = openModal(`
    <div class="modal-head"><h2>Members &amp; sharing</h2></div>
    <p class="modal-sub">${w.key ? `<span class="pkey">${escapeHtml(w.key)}</span> ` : ''}${escapeHtml(projName)} — your role: <strong>${escapeHtml(myRole)}</strong></p>
    <div id="member-list" class="member-list">Loading…</div>
    <div id="member-err" class="modal-error" role="alert"></div>
    ${isOwner ? `
      <div class="member-sec-head">Invite someone</div>
      <form id="invite-form" class="proj-invite-form">
        <input id="invite-email" type="email" placeholder="email (optional)" autocomplete="off" />
        <select id="invite-role">
          ${PROJECT_ROLES.map((r) => `<option value="${r}"${r === 'member' ? ' selected' : ''}>${r}</option>`).join('')}
        </select>
        <button type="submit" class="btn primary">Create invite</button>
      </form>
      <div id="invite-fresh" class="apikey-fresh" hidden></div>
      <div id="invite-list" class="apikey-list"></div>
      <div class="member-sec-head">Project</div>
      <form id="proj-rename" class="proj-invite-form">
        <input id="proj-rename-name" value="${escapeHtml(w.name || '')}" autocomplete="off" />
        <button type="submit" class="btn">Rename</button>
      </form>
      <div class="modal-actions">
        <button type="button" class="btn danger" id="proj-archive">Archive project</button>
      </div>
    ` : `
      <div class="modal-actions">
        <button type="button" class="btn danger" id="member-leave">Leave project</button>
      </div>
    `}
  `);

  const listEl = modal.querySelector('#member-list');
  const errEl = modal.querySelector('#member-err');
  let members = [];

  // After a successful membership mutation our own role (or membership) may
  // have changed — re-sync the workspace list and rebuild what's stale.
  async function resync() {
    await reloadWorkspaces();
    const nw = state.workspaces.find((x) => x.id === tid);
    if (!nw) {
      // We no longer belong to this board (removed ourselves) — move on.
      closeModal();
      await switchToBoard(null);
      return;
    }
    if ((nw.role || 'viewer') !== myRole) {
      openMembersModal(); // rebuild with the new role's controls
      return;
    }
    await renderMembers();
  }

  async function renderMembers() {
    try {
      members = await api(`/api/projects/${tidPath}/members`);
    } catch (e) {
      listEl.innerHTML = `<div class="modal-error">${escapeHtml(e.message)}</div>`;
      return;
    }
    listEl.innerHTML = members.length
      ? members.map((m) => `
        <div class="member-row">
          <span class="member-id">${escapeHtml(m.name || m.email || m.account_id)} <code>${escapeHtml(m.email || m.account_id)}</code></span>
          ${isOwner ? `
            <select class="member-role" data-acct="${escapeHtml(m.account_id)}" data-prev="${escapeHtml(m.role)}">
              ${PROJECT_ROLES.map((r) => `<option value="${r}"${r === m.role ? ' selected' : ''}>${r}</option>`).join('')}
            </select>
            <button type="button" class="link-btn" data-remove="${escapeHtml(m.account_id)}">Remove</button>
          ` : `<span class="member-tag">${escapeHtml(m.role)}</span>`}
        </div>`).join('')
      : '<div class="pane-empty">No members.</div>';

    const lastOwnerMsg = 'A project must keep at least one owner — promote someone else first.';
    listEl.querySelectorAll('.member-role').forEach((sel) => {
      sel.addEventListener('change', async () => {
        errEl.textContent = '';
        sel.disabled = true;
        try {
          await api(`/api/projects/${tidPath}/members/${encodeURIComponent(sel.dataset.acct)}`, {
            method: 'PATCH', body: { role: sel.value },
          });
          await resync();
        } catch (e) {
          sel.value = sel.dataset.prev;
          sel.disabled = false;
          errEl.textContent = e.code === 'LAST_OWNER' ? lastOwnerMsg : e.message;
        }
      });
    });
    listEl.querySelectorAll('[data-remove]').forEach((b) => {
      b.addEventListener('click', async () => {
        const m = members.find((x) => x.account_id === b.dataset.remove);
        if (!confirm(`Remove ${m?.email || b.dataset.remove} from this project?`)) return;
        errEl.textContent = '';
        b.disabled = true;
        try {
          await api(`/api/projects/${tidPath}/members/${encodeURIComponent(b.dataset.remove)}`, { method: 'DELETE' });
          await resync();
        } catch (e) {
          b.disabled = false;
          errEl.textContent = e.code === 'LAST_OWNER' ? lastOwnerMsg : e.message;
        }
      });
    });
  }

  /* ---- invites (owner only — the elements exist only in the owner DOM) ---- */

  const inviteList = modal.querySelector('#invite-list');
  const inviteFresh = modal.querySelector('#invite-fresh');

  async function renderInvites() {
    if (!inviteList) return;
    try {
      const invites = await api(`/api/projects/${tidPath}/invites`);
      inviteList.innerHTML = invites.length
        ? invites.map((i) => `
          <div class="apikey-row">
            <span class="apikey-id">${escapeHtml(i.email || 'anyone with the link')}
              <code>${escapeHtml(i.role)} · expires ${escapeHtml(String(i.expires_at).slice(0, 10))}</code></span>
            <button type="button" class="link-btn" data-revoke-invite="${escapeHtml(i.id)}">Revoke</button>
          </div>`).join('')
        : '<div class="pane-empty">No pending invites.</div>';
      inviteList.querySelectorAll('[data-revoke-invite]').forEach((b) => {
        b.addEventListener('click', async () => {
          b.disabled = true;
          try {
            await api(`/api/projects/${tidPath}/invites/${encodeURIComponent(b.dataset.revokeInvite)}`, { method: 'DELETE' });
          } catch (e) {
            b.disabled = false;
            errEl.textContent = e.message;
            return;
          }
          await renderInvites();
        });
      });
    } catch (e) {
      inviteList.innerHTML = `<div class="modal-error">${escapeHtml(e.message)}</div>`;
    }
  }

  modal.querySelector('#invite-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    errEl.textContent = '';
    const email = modal.querySelector('#invite-email').value.trim();
    const role = modal.querySelector('#invite-role').value;
    try {
      const inv = await api(`/api/projects/${tidPath}/invites`, {
        method: 'POST', body: { role, ...(email ? { email } : {}) },
      });
      // Mirror of the apikey-fresh pattern: the code is shown exactly once.
      const link = `${location.origin}/invite/${encodeURIComponent(inv.code)}`;
      inviteFresh.hidden = false;
      inviteFresh.innerHTML = `Share this invite link now — it won’t be shown again:
        <code class="apikey-secret">${escapeHtml(link)}</code>
        <button type="button" class="link-btn" id="invite-copy">Copy link</button>`;
      inviteFresh.querySelector('#invite-copy').addEventListener('click', () => {
        navigator.clipboard?.writeText(link);
      });
      modal.querySelector('#invite-email').value = '';
      await renderInvites();
    } catch (e2) {
      inviteFresh.hidden = false;
      inviteFresh.innerHTML = `<span class="modal-error">${escapeHtml(e2.message)}</span>`;
    }
  });

  /* ---- project lifecycle: rename + archive (owner only) ---- */

  modal.querySelector('#proj-rename')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    errEl.textContent = '';
    const name = modal.querySelector('#proj-rename-name').value.trim();
    if (!name) {
      errEl.textContent = 'Project name can’t be empty.';
      return;
    }
    try {
      await api(`/api/projects/${tidPath}`, { method: 'PATCH', body: { name } });
      await reloadWorkspaces(); // refreshes the breadcrumb too
      toast('Project renamed.', { variant: 'info' });
    } catch (e2) {
      errEl.textContent = e2.message;
    }
  });

  const archiveBtn = modal.querySelector('#proj-archive');
  archiveBtn?.addEventListener('click', async () => {
    // Two-step confirm: the first click arms the button, the second fires.
    if (!archiveBtn.classList.contains('armed')) {
      archiveBtn.classList.add('armed');
      archiveBtn.textContent = 'Really archive?';
      setTimeout(() => {
        if (!archiveBtn.isConnected) return;
        archiveBtn.classList.remove('armed');
        archiveBtn.textContent = 'Archive project';
      }, 5000);
      return;
    }
    archiveBtn.disabled = true;
    errEl.textContent = '';
    try {
      await api(`/api/projects/${tidPath}`, { method: 'DELETE' });
      closeModal();
      toast(`Archived ${projName}.`, { variant: 'info' });
      await switchToBoard(null);
    } catch (e) {
      archiveBtn.disabled = false;
      errEl.textContent = e.message;
    }
  });

  modal.querySelector('#member-leave')?.addEventListener('click', async () => {
    if (!confirm(`Leave ${projName}? You’ll need a new invite to come back.`)) return;
    errEl.textContent = '';
    const ok = await leaveProject(tid, members, errEl);
    if (ok) {
      closeModal();
      toast(`Left ${projName}.`, { variant: 'info' });
      await switchToBoard(null);
    }
  });

  await renderMembers();
  if (isOwner) await renderInvites();
}

/* ------------- realtime: server-sent events ------------- */

let eventSource = null;
let pendingRefresh = false;
let lastBoardHash = '';

function applyPaused() {
  if (state.view === 'history') return false;     // history view handles its own SSE refresh
  if (state.view !== 'board') return true;       // overview / other view — re-renders on its own
  if (state.drawerTicketId) return true;          // user is editing
  if (document.querySelector('.modal-backdrop')) return true;
  if (dragState) return true;
  if (document.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName))
    return true;
  return false;
}

function setIndicator(klass) {
  const el = document.getElementById('live-indicator');
  if (!el) return;
  el.classList.remove('paused', 'tick', 'disconnected');
  if (klass) el.classList.add(klass);
}
function flashIndicator(klass = 'tick') {
  setIndicator(klass);
  setTimeout(() => setIndicator(eventSource?.readyState === 1 ? null : 'disconnected'), 250);
}

/**
 * Presence pill (SCP-225): "● N" of accounts currently connected to the active
 * board, with their names on hover. Hosted-only; a no-op (and hidden) locally.
 * Refreshed on board load + on 'presence' SSE ticks.
 */
async function refreshPresence() {
  let pill = document.getElementById('presence-indicator');
  if (!state.meta?.hosted || !state.currentWorkspace) { if (pill) pill.hidden = true; return; }
  let people;
  try {
    people = await api(`/api/projects/${encodeURIComponent(state.currentWorkspace)}/presence`);
  } catch { return; }
  if (!pill) {
    pill = document.createElement('span');
    pill.id = 'presence-indicator';
    pill.className = 'presence-pill';
    const dot = document.getElementById('live-indicator');
    dot?.parentNode?.insertBefore(pill, dot);
  }
  const names = people.map((p) => p.name || p.email || p.account_id);
  pill.hidden = people.length === 0;
  pill.textContent = `● ${people.length}`;
  pill.title = names.length ? `Online: ${names.join(', ')}` : 'No one else online';
}

/**
 * "Runtime repair" from the UI side. The refresh button calls this — and it
 * also runs automatically when we notice the SSE stream has dropped.
 *
 * The server-side watchdog in each long-lived scope process promotes a new
 * hub if the previous one died. From the browser's perspective, the hub URL
 * (default `http://localhost:4321`) stays the same — we just have to wait
 * for SSE to reconnect once a new process binds the port. This function
 * forces that retry instead of waiting for the next EventSource backoff.
 */
let autoRepairTimer = null;
function scheduleAutoRepair() {
  if (autoRepairTimer) return;
  autoRepairTimer = setTimeout(async () => {
    autoRepairTimer = null;
    if (eventSource?.readyState === 1) return; // recovered on its own
    await repairHubConnection();
  }, 3000);
}

async function repairHubConnection() {
  setIndicator(null);
  let alive = false;
  let freshMeta = null;
  try {
    const r = await fetch('/api/meta', { cache: 'no-store' });
    alive = r.ok;
    if (alive) freshMeta = await r.json().catch(() => null);
  } catch { alive = false; }
  if (!alive) {
    setIndicator('disconnected');
    // The hub is gone; the server-side watchdog should promote a new one
    // within a few seconds. Rebuild the SSE stream so we reconnect the
    // instant a fresh hub appears.
    if (eventSource) {
      try { eventSource.close(); } catch {}
      eventSource = null;
    }
    startEventStream();
    return;
  }
  // Detect server version change (e.g. after `npm link` or restart).
  const freshVersion = freshMeta?.version ?? null;
  if (freshVersion && state.serverVersion && freshVersion !== state.serverVersion) {
    showReloadBanner();
    return;
  }

  // Hub is healthy — make sure SSE is connected (it may have silently
  // dropped) and refresh the visible state.
  if (!eventSource || eventSource.readyState !== 1) {
    if (eventSource) { try { eventSource.close(); } catch {} }
    eventSource = null;
    startEventStream();
  }
  await refresh();
}

function showReloadBanner() {
  if (document.getElementById('version-banner')) return;
  const banner = document.createElement('div');
  banner.id = 'version-banner';
  banner.className = 'version-banner';
  banner.setAttribute('role', 'status');
  const msg = document.createElement('span');
  msg.textContent = 'Scope was updated. Reload to get the latest version.';
  const btn = document.createElement('button');
  btn.className = 'btn primary';
  btn.textContent = 'Reload';
  btn.addEventListener('click', () => location.reload());
  banner.appendChild(msg);
  banner.appendChild(btn);
  document.body.appendChild(banner);
}

function startEventStream() {
  if (eventSource) eventSource.close();
  const params = new URLSearchParams();
  if (state.currentWorkspace) params.set('workspace', state.currentWorkspace);
  const url = '/events' + (params.toString() ? `?${params}` : '');
  eventSource = new EventSource(url);
  // Reconcile on every (re)connect (SCP-147): SSE has no Last-Event-ID replay,
  // so a reconnect can miss changes emitted during the gap. Resume by pulling
  // current state rather than replaying the stream — scheduleRefresh is
  // debounced and board-hash-guarded, so the initial connect is a no-op and a
  // reconnect catches up immediately instead of waiting for the next change.
  const resumeOnConnect = () => {
    setIndicator(null);
    scheduleRefresh();
    // This connection just registered us in the board's presence roster (SCP-225),
    // and the initial board-load fetch ran before that — re-fetch now so the pill
    // reflects our own (and anyone else's) connection without waiting for a tick.
    refreshPresence();
  };
  eventSource.addEventListener('open', resumeOnConnect);
  eventSource.addEventListener('error', () => {
    setIndicator('disconnected');
    // EventSource will keep retrying internally, but if the hub died and
    // a new process needs to be promoted, the server-side watchdog runs on
    // its own timer (~10s). Do an active repair check shortly after the
    // first error so the UI converges faster than EventSource's default
    // exponential backoff would.
    scheduleAutoRepair();
  });
  eventSource.addEventListener('hello', resumeOnConnect);
  eventSource.addEventListener('change', async (e) => {
    const detail = safeParse(e.data);
    // Presence (SCP-225): a peer joined/left the board — refresh the roster pill,
    // don't trigger a board refresh.
    if (detail?.type === 'presence') {
      if (!detail.workspace || detail.workspace === state.currentWorkspace) refreshPresence();
      return;
    }
    if (
      detail?.type === 'workspace.attached' ||
      detail?.type === 'workspace.detached' ||
      detail?.type === 'workspace.updated'
    ) {
      // Refresh the breadcrumb without dropping the user's selection.
      await reloadWorkspaces();
      if (state.currentWorkspace && state.workspaces.find((w) => w.id === state.currentWorkspace)) {
        updateBreadcrumb();
      } else if (state.workspaces.length) {
        // Our workspace went away — fall back to the first one.
        state.currentWorkspace = state.workspaces[0].id;
        localStorage.setItem('scope.workspace', state.currentWorkspace);
        updateBreadcrumb();
        await refresh();
      }
      return;
    }
    pushLiveFeed(detail);
    if (state.view === 'history') {
      scheduleHistoryRefresh();
    } else {
      scheduleRefresh(detail);
    }
  });
}

let pendingHistoryRefresh = false;
function scheduleHistoryRefresh() {
  if (pendingHistoryRefresh) return;
  pendingHistoryRefresh = true;
  setTimeout(async () => {
    pendingHistoryRefresh = false;
    if (state.view !== 'history') return;
    try { await renderHistory(); } catch { /* swallow; next event retries */ }
  }, 120);
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return {}; }
}

/**
 * Coalesce a burst of change events into one refresh. Honors the
 * pause-while-editing rule and uses the board-hash to skip no-op re-renders.
 */
function scheduleRefresh(_detail) {
  if (pendingRefresh) return;
  pendingRefresh = true;
  setTimeout(async () => {
    pendingRefresh = false;
    // Keep an open search palette live: re-run its current query so remote
    // create/edit/delete is reflected in the results (and a since-deleted hit
    // drops out). The board itself stays paused while a modal is open.
    if (activeSearchRerun) activeSearchRerun();
    if (applyPaused()) {
      setIndicator('paused');
      return;
    }
    if (!state.currentWorkspace) return;
    try {
      const params = new URLSearchParams();
      if (state.epicFilter) params.set('epic', state.epicFilter);
      const q = params.toString();
      const board = await api(`/api/board${q ? `?${q}` : ''}`);
      const hash = hashBoard(board);
      if (hash !== lastBoardHash) {
        const oldPositions = captureCardPositions();
        const oldBoard = state.board;
        lastBoardHash = hash;
        state.board = board;
        renderBoard();
        flashIndicator('tick');
        animateCardMoves(oldPositions);
        burstConfettiForNewDone(oldBoard, state.board);
        const moved = findMovedTicketIds(oldBoard, state.board);
        if (state.autoScroll) scrollToMovedCards(moved, 380);
        highlightMovedCards(moved);
      }
    } catch {
      /* next event will retry */
    }
  }, 80);
}

function hashBoard(board) {
  if (!board) return '';
  const parts = [];
  for (const status of Object.keys(board.buckets).sort()) {
    for (const t of board.buckets[status]) {
      parts.push(`${t.id}:${t.status}:${t.updated_at}:${t.title}:${t.branch ?? ''}:${t.pr_url ?? ''}:${t.priority}:${t.parent_id ?? ''}:${t.assignee ?? ''}`);
    }
  }
  return parts.join('|');
}

/* ------------- animations ------------- */

function captureCardPositions() {
  const positions = new Map();
  for (const card of document.querySelectorAll('.card')) {
    positions.set(card.dataset.id, card.getBoundingClientRect());
  }
  return positions;
}

function animateCardMoves(oldPositions) {
  if (!oldPositions || !oldPositions.size) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  for (const card of document.querySelectorAll('.card')) {
    const id = card.dataset.id;
    const oldRect = oldPositions.get(id);
    if (!oldRect) continue;
    const newRect = card.getBoundingClientRect();
    const dx = oldRect.left - newRect.left;
    const dy = oldRect.top - newRect.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
    card.style.transform = `translate(${dx}px, ${dy}px)`;
    card.style.transition = 'none';
    card.getBoundingClientRect(); // force layout
    requestAnimationFrame(() => {
      card.style.transition = 'transform 350ms cubic-bezier(0.25, 0.46, 0.45, 0.94)';
      card.style.transform = '';
      card.addEventListener('transitionend', () => {
        card.style.transition = '';
      }, { once: true });
    });
  }
}

function findMovedTicketIds(oldBoard, newBoard) {
  if (!oldBoard || !newBoard) return [];
  const oldStatus = new Map();
  for (const [status, tickets] of Object.entries(oldBoard.buckets || {})) {
    for (const t of tickets) oldStatus.set(t.id, status);
  }
  const moved = [];
  for (const [status, tickets] of Object.entries(newBoard.buckets || {})) {
    for (const t of tickets) {
      if (oldStatus.has(t.id) && oldStatus.get(t.id) !== status) moved.push(t.id);
    }
  }
  return moved;
}

// Tickets whose SSE-driven move should still show the highlight. Tracked at
// module scope so subsequent re-renders (triggered by unrelated SSE updates
// like comment timestamps) re-apply the class instead of dropping it.
const recentlyMovedIds = new Set();
function highlightMovedCards(ids) {
  if (!ids.length) return;
  for (const id of ids) {
    recentlyMovedIds.add(id);
    setTimeout(() => {
      recentlyMovedIds.delete(id);
      const card = document.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
      if (card) card.classList.remove('just-moved');
    }, 2400);
  }
  // Apply on the current DOM too (renderCard reads the set on subsequent renders).
  setTimeout(() => {
    for (const id of ids) {
      const card = document.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
      if (!card) continue;
      card.classList.remove('just-moved');
      void card.offsetWidth;
      card.classList.add('just-moved');
    }
  }, 360);
}

function scrollToMovedCards(ids, delay) {
  if (!ids.length) return;
  setTimeout(() => {
    for (const id of ids) {
      const card = document.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
      if (!card) continue;
      // Clear any FLIP transform so getBoundingClientRect reads the final layout.
      card.style.transform = '';
      card.style.transition = '';
      const rect = card.getBoundingClientRect();
      // Vertical: scroll the window so the card sits in the viewport's middle.
      const targetY = window.scrollY + rect.top - window.innerHeight / 2 + rect.height / 2;
      window.scrollTo({ top: targetY, behavior: 'smooth' });
      // Horizontal: scrollIntoView doesn't propagate reliably into containers
      // with overflow-x:auto + overflow-y:visible, so walk up and scroll the
      // first horizontal-overflow ancestor ourselves.
      let h = card.parentElement;
      while (h && h !== document.body) {
        const cs = getComputedStyle(h);
        const scrollsX = (cs.overflowX === 'auto' || cs.overflowX === 'scroll') && h.scrollWidth > h.clientWidth;
        if (scrollsX) {
          const hRect = h.getBoundingClientRect();
          const targetX = h.scrollLeft + rect.left - hRect.left - h.clientWidth / 2 + rect.width / 2;
          h.scrollTo({ left: targetX, behavior: 'smooth' });
          break;
        }
        h = h.parentElement;
      }
      break;
    }
  }, delay);
}

function burstConfettiForNewDone(oldBoard, newBoard) {
  if (!oldBoard || !newBoard) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const oldDone = new Set((oldBoard.buckets?.done || []).map((t) => t.id));
  const hasNew = (newBoard.buckets?.done || []).some((t) => !oldDone.has(t.id));
  if (hasNew) burstConfetti();
}

function burstConfetti() {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:9999;';
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  const COLORS = ['#7c6af7', '#54d0a0', '#f5a623', '#e05c5c', '#4aa8d8', '#f7d154'];
  const particles = Array.from({ length: 28 }, (_, i) => ({
    x: (i / 27) * canvas.width * 1.1 - canvas.width * 0.05 + (Math.random() - 0.5) * (canvas.width / 28) * 1.4,
    y: -10 - Math.random() * 60,
    vx: (Math.random() - 0.5) * 0.7,
    vy: 0.5 + Math.random() * 0.7,
    w: 7 + Math.random() * 6,
    h: 3 + Math.random() * 3,
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
    rot: Math.random() * Math.PI * 2,
    rotV: (Math.random() - 0.5) * 0.04,
    life: 1,
    decay: 0.002 + Math.random() * 0.002,
  }));

  function tick() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    let alive = 0;
    for (const p of particles) {
      p.vy += 0.018; // very gentle gravity
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.rotV;
      if (p.y > canvas.height + 20) { p.life = 0; }
      p.life -= p.decay;
      if (p.life <= 0) continue;
      alive++;
      ctx.save();
      ctx.globalAlpha = Math.min(1, p.life * 3); // fade out only in last third
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    if (alive > 0) requestAnimationFrame(tick);
    else canvas.remove();
  }
  requestAnimationFrame(tick);
}

/* ------------- board ------------- */

function renderEmpty(msg) {
  document.getElementById('board').innerHTML =
    '<div class="empty">' +
    (msg || 'No projects yet. Click <b>+ Project</b> to create one.') +
    '</div>';
}

function isBoardEmpty(board) {
  if (!board || !board.buckets) return false;
  for (const status of BOARD_COLUMNS) {
    if ((board.buckets[status] || []).length > 0) return false;
  }
  return true;
}

/**
 * Hero empty state for the board. `variant` controls copy + CTAs:
 *   - 'empty'     — workspace has zero tickets (the default)
 *   - 'all-done'  — swimlanes by epic, but every epic is done and the
 *                   "Show completed epics" toggle is off; primary CTA
 *                   flips that toggle so the user's work reappears.
 *   - 'filtered'  — buildLanes returned no lanes for another reason
 *                   (e.g. every ticket is in a non-board status). Same
 *                   shape, generic copy, no toggle CTA.
 */
function renderBoardEmptyState(root, { variant = 'empty' } = {}) {
  const w = currentWorkspaceObj();
  const name = (w && (w.name || w.label)) || 'this workspace';
  const keyHint = w && w.key ? ` (workspace key <code>${escapeHtml(w.key)}</code>)` : '';

  let title, desc, showToggleCta = false;
  if (variant === 'all-done') {
    title = 'All epics complete';
    desc = `Every epic in ${escapeHtml(name)} is marked done, and
            “Show completed epics” is off. Plan a new epic — or bring the
            finished ones back into view.`;
    showToggleCta = true;
  } else if (variant === 'filtered') {
    title = 'Nothing to show';
    desc = `Your current view has no lanes. Adjust the view options,
            plan a new epic, or add a ticket directly.`;
  } else {
    title = 'Plan your first epic';
    desc = `${escapeHtml(name)} doesn't have any tickets yet. Ask your
            coding agent to scope an epic${keyHint} — or add one yourself.`;
  }

  root.classList.add('board-empty-wrap');
  root.innerHTML = `
    <div class="board-empty">
      <div class="board-empty-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="40" height="40" fill="none"
             stroke="currentColor" stroke-width="1.5"
             stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>
          <circle cx="12" cy="12" r="3.2"/>
        </svg>
      </div>
      <h2 class="board-empty-title">${title}</h2>
      <p class="board-empty-desc">${desc}</p>
      <div class="board-empty-actions">
        ${showToggleCta ? `
          <button type="button" class="btn primary" id="board-empty-showdone">
            <span aria-hidden="true">👁</span>
            <span>Show completed epics</span>
          </button>
          <button type="button" class="btn" id="board-empty-agent">
            <span aria-hidden="true">✨</span>
            <span class="be-label">Plan with your agent</span>
          </button>
        ` : `
          <button type="button" class="btn primary" id="board-empty-agent">
            <span aria-hidden="true">✨</span>
            <span class="be-label">Plan with your agent</span>
          </button>
        `}
        <button type="button" class="btn" id="board-empty-manual">
          <span aria-hidden="true">＋</span>
          <span>Add a ticket manually</span>
        </button>
      </div>
      <p class="board-empty-hint">
        “Plan with your agent” copies a starter prompt to your clipboard.
      </p>
    </div>
  `;

  const agentBtn = document.getElementById('board-empty-agent');
  if (agentBtn) {
    agentBtn.addEventListener('click', (e) => {
      copyAgentStarterPrompt(w, e.currentTarget);
    });
  }
  document.getElementById('board-empty-manual').addEventListener('click', () => {
    openTicketModal();
  });
  const showDoneBtn = document.getElementById('board-empty-showdone');
  if (showDoneBtn) {
    showDoneBtn.addEventListener('click', () => {
      state.showDoneEpics = true;
      localStorage.setItem('scope.showDoneEpics', 'true');
      // Re-sync the view popover's checkbox if it's currently open, so the
      // toggle there reflects the new value the next time the user looks.
      const cb = document.getElementById('vp-showdone');
      if (cb) cb.checked = true;
      renderBoard();
    });
  }
}

function copyAgentStarterPrompt(workspace, buttonEl) {
  const name = (workspace && (workspace.name || workspace.label)) || 'this project';
  const keyHint = workspace && workspace.key ? ` (workspace key \`${workspace.key}\`)` : '';
  const prompt = [
    `Plan an epic for ${name}${keyHint} using the Scope CLI.`,
    '',
    '- Create an epic that captures the next meaningful body of work.',
    '- Break it down into stories (and bugs, where relevant) underneath it.',
    '- Use `scope ticket create … -t epic|story|bug --parent <epic>` and link related tickets with `scope link add`.',
    "- When you're done, show me the resulting board with `scope --json ticket list`.",
  ].join('\n');

  const onCopied = () => {
    if (buttonEl) {
      const label = buttonEl.querySelector('.be-label');
      const prev = label ? label.textContent : null;
      if (label) label.textContent = 'Prompt copied';
      buttonEl.classList.add('copied');
      setTimeout(() => {
        if (label && prev != null) label.textContent = prev;
        buttonEl.classList.remove('copied');
      }, 2000);
    }
    toast('Starter prompt copied to clipboard. Paste it to your agent.', { variant: 'info', timeout: 3500 });
  };

  // navigator.clipboard requires a secure context — the hub serves HTTPS, but
  // fall back to the legacy execCommand path for the unlikely HTTP case so the
  // button still does something instead of silently failing.
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(prompt).then(onCopied).catch(() => fallbackCopy(prompt, onCopied));
  } else {
    fallbackCopy(prompt, onCopied);
  }
}

function fallbackCopy(text, onDone) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'absolute';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  document.body.removeChild(ta);
  if (ok) { onDone && onDone(); }
  else { toast('Could not copy prompt — your browser blocked clipboard access.'); }
}

function renderBoard() {
  const root = document.getElementById('board');
  // Capture scroll state before wiping. Without this the browser clamps
  // window.scrollY to 0 the instant `root.innerHTML = ''` collapses the page,
  // and any subsequent re-render leaves the user scrolled to the top.
  const savedWindowY = window.scrollY;
  const savedLaneScroll = new Map();
  for (const lane of document.querySelectorAll('.lane-columns')) {
    const key = lane.closest('.lane')?.dataset.group;
    if (key != null) savedLaneScroll.set(key, lane.scrollLeft);
  }
  root.style.display = '';
  // Always clear the empty-state wrapper class so transitioning out of the
  // empty state restores normal board flex/grid behavior.
  root.classList.remove('board-empty-wrap');
  root.innerHTML = '';
  // Old lane strips are gone now — drop their observations so the observer only
  // ever tracks the lanes built below (no leak across re-renders).
  if (typeof laneScrollbarRO !== 'undefined' && laneScrollbarRO) laneScrollbarRO.disconnect();
  const restoreScroll = () => {
    if (savedWindowY) window.scrollTo({ top: savedWindowY, behavior: 'instant' });
    for (const lane of document.querySelectorAll('.lane-columns')) {
      const key = lane.closest('.lane')?.dataset.group;
      if (key != null && savedLaneScroll.has(key)) lane.scrollLeft = savedLaneScroll.get(key);
    }
  };
  if (!state.board) { restoreScroll(); return; }

  // No tickets yet in this workspace — replace the (otherwise empty)
  // columns with a tasteful empty state that nudges the user toward
  // planning an epic with their agent. Skipped when an epic filter is
  // active (zero results there is a real filter outcome, not "the
  // workspace has no tickets").
  const trulyEmpty = !state.epicFilter && isBoardEmpty(state.board);
  if (trulyEmpty && state.groupBy === 'none') {
    root.classList.remove('swim');
    renderBoardEmptyState(root, { variant: 'empty' });
    restoreScroll();
    return;
  }

  if (state.groupBy === 'none') {
    root.classList.remove('swim');
    renderColumnRow(root, state.board.buckets, { showHeader: true });
    restoreScroll();
    return;
  }

  const lanes = buildLanes(state.board, state.groupBy);
  // Swimlane path: lanes can end up empty even when board.buckets isn't —
  // e.g. all epics are done and the "Show completed epics" toggle is off,
  // or every ticket is in a non-board status. Without this, the user sees
  // a blank page with no explanation.
  if (lanes.length === 0) {
    root.classList.remove('swim');
    let variant = 'empty';
    if (!trulyEmpty) {
      variant = (state.groupBy === 'epic' && !state.showDoneEpics)
        ? 'all-done'
        : 'filtered';
    }
    renderBoardEmptyState(root, { variant });
    restoreScroll();
    return;
  }

  root.classList.add('swim');
  for (const lane of lanes) {
    const section = document.createElement('section');
    section.className = 'lane';
    section.dataset.group = lane.key;
    if (lane.status) section.dataset.status = lane.status;
    if (state.collapsedLanes.has(lane.key)) section.classList.add('collapsed');
    // Nested epics indent under their parent so the hierarchy reads top-down.
    if (lane.depth) {
      section.classList.add('lane-nested');
      section.style.setProperty('--lane-depth', lane.depth);
    }

    const head = document.createElement('header');
    head.className = 'lane-head';
    const isEpic = lane.kind === 'epic';
    const isSubEpic = isEpic && lane.depth > 0;
    // .lane-break is a zero-width flex item that forces a wrap onto the
    // next row at narrow viewports (via CSS @media). At wide widths it's
    // display:none, so the head stays a single line.
    head.innerHTML = `
      <span class="lane-chevron">▼</span>
      ${isSubEpic ? '<span class="lane-nest-arrow" aria-hidden="true">↳</span>' : ''}
      ${isEpic ? `<span class="lane-epic-badge">${isSubEpic ? 'SUB-EPIC' : 'EPIC'}</span>` : ''}
      <span class="lane-title">${escapeHtml(lane.label)}</span>
      <span class="lane-break" aria-hidden="true"></span>
      ${isEpic && lane.status
        ? `<span class="lane-status ${lane.status}">
             <span class="dot ${lane.status}"></span>${escapeHtml(lane.status.replace('_', ' '))}
           </span>`
        : lane.meta
          ? `<span class="lane-meta">${escapeHtml(lane.meta)}</span>`
          : ''}
      ${lane.progress
        ? `<div class="lane-progress" title="${lane.progress.done}/${lane.progress.total} done">
             <div class="fill" style="width:${lane.progress.percent}%"></div>
           </div>`
        : ''}
      <span class="lane-count">${lane.count}</span>
      ${isEpic ? '<button class="lane-open-btn" title="Open epic">↗</button>' : ''}
    `;
    if (isEpic) {
      head.querySelector('.lane-open-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        openDrawer(lane.epicId);
      });
    }
    head.addEventListener('click', (e) => {
      // Don't toggle when clicking inside the progress bar — leave a noop affordance
      if (e.target.closest('.lane-progress')) return;
      toggleLane(lane.key);
      section.classList.toggle('collapsed');
    });
    section.appendChild(head);

    const cols = document.createElement('div');
    cols.className = 'lane-columns';
    renderColumnRow(cols, lane.buckets, { showHeader: false, lane: lane.key });
    section.appendChild(cols);
    // Append to the live DOM *before* wiring the scrollbar so attach can measure
    // overflow synchronously (a detached strip reports 0 size).
    root.appendChild(section);
    attachLaneScrollbar(section, cols);
  }
  restoreScroll();
  // The native scrollbar is hidden (so the columns can bleed to the window
  // edges); our custom indicator sits inset from the edges instead. Refresh
  // every lane's thumb once layout + restored scroll positions have settled.
  requestAnimationFrame(updateAllLaneScrollbars);
}

/* ---------------- custom lane scroll indicator ----------------
 * The column strips scroll full-bleed (out to both window edges), but the
 * native scrollbar can't be inset from the edge — macOS overlay scrollbars
 * ignore CSS offsets entirely. So we hide it and drive our own thin indicator
 * that lives in the lane's content box, padded from the window edges (and the
 * nesting indent), while staying in sync with the real scroll position. */
function updateLaneScrollbar(section) {
  const cols = section.querySelector('.lane-columns');
  const bar = section.querySelector(':scope > .lane-scrollbar');
  const thumb = bar && bar.querySelector('.lane-scrollbar-thumb');
  if (!cols || !bar || !thumb) return;
  const { scrollWidth, clientWidth, scrollLeft } = cols;
  // Nothing to scroll → hide the indicator (and reclaim its row).
  if (scrollWidth <= clientWidth + 1) {
    bar.classList.remove('scrollable');
    return;
  }
  bar.classList.add('scrollable');
  const trackW = bar.clientWidth;
  const thumbW = Math.max(24, Math.round((trackW * clientWidth) / scrollWidth));
  const maxScroll = scrollWidth - clientWidth;
  const maxThumbX = Math.max(0, trackW - thumbW);
  const x = maxScroll > 0 ? Math.round((scrollLeft / maxScroll) * maxThumbX) : 0;
  thumb.style.width = thumbW + 'px';
  thumb.style.transform = `translateX(${x}px)`;
}

function updateAllLaneScrollbars() {
  for (const section of document.querySelectorAll('#board .lane')) updateLaneScrollbar(section);
}

function attachLaneScrollbar(section, cols) {
  const bar = document.createElement('div');
  bar.className = 'lane-scrollbar';
  const thumb = document.createElement('div');
  thumb.className = 'lane-scrollbar-thumb';
  bar.appendChild(thumb);
  section.appendChild(bar);

  cols.addEventListener('scroll', () => updateLaneScrollbar(section), { passive: true });
  // Fires once the strip first gets its real layout size (and again on
  // window/content resize) — more reliable than a post-render rAF, since grid
  // column widths aren't always settled by the time that fires.
  if (laneScrollbarRO) laneScrollbarRO.observe(cols);

  // Drag the thumb to scroll. Pointer capture keeps tracking even if the
  // cursor leaves the thin thumb mid-drag.
  let startX = 0, startScroll = 0, maxScroll = 0, maxThumbX = 0, dragging = false;
  thumb.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    dragging = true;
    thumb.classList.add('dragging');
    try { thumb.setPointerCapture(e.pointerId); } catch {}
    startX = e.clientX;
    startScroll = cols.scrollLeft;
    maxScroll = cols.scrollWidth - cols.clientWidth;
    maxThumbX = Math.max(0, bar.clientWidth - thumb.offsetWidth);
  });
  thumb.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    cols.scrollLeft = startScroll + (maxThumbX > 0 ? (dx / maxThumbX) * maxScroll : 0);
  });
  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    thumb.classList.remove('dragging');
    try { thumb.releasePointerCapture(e.pointerId); } catch {}
  };
  thumb.addEventListener('pointerup', end);
  thumb.addEventListener('pointercancel', end);

  // Measure now (the strip is already live, so scrollWidth/clientWidth are real)
  // so the indicator is correct immediately — no dependency on a frame firing,
  // which matters for background/throttled tabs. The rAF is a follow-up after
  // restoreScroll() repositions the strip.
  updateLaneScrollbar(section);
  requestAnimationFrame(() => updateLaneScrollbar(section));
}

// Single shared observer for all lane strips. Each render disconnects it (see
// renderBoard) and the freshly-built lanes re-observe, so it never accumulates
// stale detached elements. The initial observation callback is what reliably
// reveals the indicator on load. Covers window resize too — full-bleed strips
// resize with the window.
const laneScrollbarRO = typeof ResizeObserver !== 'undefined'
  ? new ResizeObserver((entries) => {
      for (const e of entries) {
        const section = e.target.closest && e.target.closest('.lane');
        if (section) updateLaneScrollbar(section);
      }
    })
  : null;

function renderColumnRow(parent, buckets, { showHeader, lane = null }) {
  for (const status of BOARD_COLUMNS) {
    const tickets = buckets[status] || [];
    const col = document.createElement('section');
    col.className = 'column';
    col.dataset.status = status;
    if (lane) col.dataset.lane = lane;
    col.innerHTML = `
      ${showHeader
        ? `<div class="column-head">
             <div class="column-title">
               <span class="dot ${status}"></span>
               ${STATUS_LABELS[status]}
               <span class="column-count">${tickets.length}</span>
             </div>
             <button class="column-add" title="New ticket in ${STATUS_LABELS[status]}">+</button>
           </div>`
        : `<div class="column-head" style="padding:4px 6px;">
             <div class="column-title" style="font-size:10px;opacity:0.6;">
               <span class="dot ${status}"></span>
               ${STATUS_LABELS[status]}
               <span class="column-count">${tickets.length}</span>
             </div>
             <button class="column-add" title="New ticket in ${STATUS_LABELS[status]}">+</button>
           </div>`}
      <div class="column-body"></div>
    `;
    const body = col.querySelector('.column-body');
    for (const t of tickets) body.appendChild(renderCard(t));
    col.querySelector('.column-add').addEventListener('click', () =>
      openTicketModal({ status })
    );
    bindColumnDnD(col);
    parent.appendChild(col);
  }
}

function toggleLane(key) {
  if (state.collapsedLanes.has(key)) state.collapsedLanes.delete(key);
  else state.collapsedLanes.add(key);
  localStorage.setItem(
    'scope.collapsedLanes',
    JSON.stringify([...state.collapsedLanes])
  );
}

/**
 * Partition the board into lanes for the given group-by dimension.
 * Returns [{key, label, meta?, progress?, count, buckets: {status: tickets[]}}].
 */
function buildLanes(board, groupBy) {
  const allTickets = Object.values(board.buckets).flat();
  const epicById = {};
  for (const t of allTickets) if (t.type === 'epic') epicById[t.id] = t;
  // When the board is filtered to a single epic, the API response doesn't
  // include the epic-typed card itself — but we still need its title/status
  // to label the lane. Fall back to the cached epic list.
  if (groupBy === 'epic') {
    const wanted = state.epicFilter
      ? state.allEpics.filter((e) => e.id === state.epicFilter)
      : state.allEpics;
    for (const e of wanted) if (!epicById[e.id]) epicById[e.id] = e;
  }

  // Honor the "Show done" toggle: when grouped by epic and toggle is off,
  // hide lanes whose epic is done (their children get hidden too — usually
  // they're done as well, and "Show done" lets you see them when you want).
  // Cancelled epics are abandoned work — hide their lanes unconditionally,
  // independent of the Show-done toggle.
  // Exception: when the user explicitly filtered to one epic, don't hide it
  // — otherwise jumping to a done/cancelled epic from the overview shows nothing.
  const filteredToOne = groupBy === 'epic' && !!state.epicFilter;
  const hideDone = groupBy === 'epic' && !state.showDoneEpics && !filteredToOne;
  const hideCancelled = groupBy === 'epic' && !filteredToOne;
  const isHiddenEpic = (e) =>
    (hideDone && e?.status === 'done') ||
    (hideCancelled && e?.status === 'cancelled');
  const isHiddenEpicId = (id) => isHiddenEpic(epicById[id]);

  const groups = new Map();
  const ensure = (key, label, extras = {}) => {
    if (!groups.has(key)) {
      groups.set(key, {
        key, label, count: 0,
        buckets: Object.fromEntries(BOARD_COLUMNS.map((s) => [s, []])),
        ...extras,
      });
    }
    return groups.get(key);
  };

  for (const t of allTickets) {
    const {key, label, extras, skip} = groupKey(t, groupBy, epicById);
    if (skip) continue;
    if (isHiddenEpicId(key)) continue;
    // Orphan catch-all lanes (Random Bugs / no epic) hide their done items —
    // for ticket-less drive-bys, 'done' usually means 'closed for good' and
    // keeping them around is noise. Real epic lanes are still controlled by
    // the Show-Done-Epics toggle.
    if ((key === '__bugs' || key === '__none') && t.status === 'done') continue;
    // Statuses outside the board's columns (cancelled, etc.) shouldn't
    // create a lane on their own — there's no bucket for them to land in,
    // so a lane built just to host them stays empty (SCP-70).
    if (!BOARD_COLUMNS.includes(t.status)) continue;
    const g = ensure(key, label, extras);
    g.buckets[t.status].push(t);
    g.count++;
  }

  // Always include a lane for every epic, even if it has no children, so
  // empty epics still appear as planning rows. Skip done ones when filtered.
  if (groupBy === 'epic') {
    for (const e of Object.values(epicById)) {
      if (isHiddenEpic(e)) continue;
      ensure(e.id, `${e.id} · ${e.title}`, {
        kind: 'epic',
        epicId: e.id,
        status: e.status,
        meta: e.status,
      });
    }
  }

  const lanes = [...groups.values()];
  // Attach hierarchy info to epic lanes: subtree-aware progress, nesting depth
  // (for indentation), and a tree-order sort path so sub-epics sit under their
  // parent. Done in one pass here since it needs the full epic + ticket sets.
  if (groupBy === 'epic') {
    for (const lane of lanes) {
      if (lane.kind !== 'epic') continue;
      lane.progress = epicProgressFromTickets(lane.epicId, allTickets, epicById);
      lane.depth = epicDepth(lane.epicId, epicById);
      lane.sortPath = epicSortPath(lane.epicId, epicById);
    }
  }

  return lanes.sort(laneSorter(groupBy));
}

function groupKey(t, groupBy, epicById) {
  if (groupBy === 'epic') {
    if (t.type === 'epic') {
      // Skip the epic-typed card itself when grouped by epic — its title
      // already shows in the lane header.
      return { skip: true };
    }
    if (t.parent_id && epicById[t.parent_id]) {
      const e = epicById[t.parent_id];
      // progress/depth/sortPath are attached in buildLanes' post-process pass
      // (they need the full ticket + epic sets), so we don't compute them here.
      return {
        key: e.id,
        label: `${e.id} · ${e.title}`,
        extras: { kind: 'epic', epicId: e.id, status: e.status, meta: e.status },
      };
    }
    // Orphan bugs get their own catch-all lane so they don't drown in the
    // (no epic) bucket alongside unrelated stories. Drive-by reports without
    // a home are easier to triage when they're visually grouped.
    if (t.type === 'bug') return { key: '__bugs', label: 'Random Bugs' };
    return { key: '__none', label: '(no epic)' };
  }
  if (groupBy === 'assignee') {
    return t.assignee
      ? { key: t.assignee, label: `@${t.assignee}` }
      : { key: '__none', label: '(unassigned)' };
  }
  if (groupBy === 'priority') {
    return { key: t.priority, label: `Priority: ${t.priority}` };
  }
  if (groupBy === 'type') {
    return { key: t.type, label: t.type.toUpperCase() };
  }
  return { key: '__none', label: '(none)' };
}

// Ids of an epic plus every epic nested beneath it. Mirrors epicSubtreeIds()
// on the server so the swimlane progress bars fold in work under sub-epics.
function epicSubtreeIds(epicId, epicById) {
  const ids = [];
  const seen = new Set();
  const walk = (id) => {
    if (seen.has(id)) return;
    seen.add(id);
    ids.push(id);
    for (const e of Object.values(epicById)) {
      if (e.parent_id === id && e.type === 'epic') walk(e.id);
    }
  };
  walk(epicId);
  return new Set(ids);
}

function epicProgressFromTickets(epicId, allTickets, epicById = {}) {
  const subtree = epicSubtreeIds(epicId, epicById);
  let total = 0, done = 0;
  for (const t of allTickets) {
    // Sub-epics are containers, not work — count only the stories/bugs nested
    // anywhere beneath this epic, matching the server's epicProgress().
    if (t.type === 'epic') continue;
    if (subtree.has(t.parent_id)) {
      total++;
      if (t.status === 'done') done++;
    }
  }
  return { total, done, percent: total ? Math.round((done / total) * 100) : 0 };
}

// Depth of an epic in the epic tree (0 = top-level). Used to indent nested
// lanes. Guards against cycles defensively even though the server rejects them.
function epicDepth(epicId, epicById) {
  let depth = 0;
  let cur = epicById[epicId];
  const seen = new Set();
  while (cur && cur.parent_id && epicById[cur.parent_id] && !seen.has(cur.id)) {
    seen.add(cur.id);
    depth++;
    cur = epicById[cur.parent_id];
  }
  return depth;
}

// A NUL-joined label chain from the root epic down to this one. Lexically
// sorting on it lays the lanes out in tree order — each parent immediately
// followed by its descendants.
function epicSortPath(epicId, epicById) {
  const parts = [];
  let cur = epicById[epicId];
  const seen = new Set();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    parts.unshift(`${cur.id} · ${cur.title}`);
    cur = cur.parent_id ? epicById[cur.parent_id] : null;
  }
  return parts.join(' ');
}

function laneSorter(groupBy) {
  if (groupBy === 'priority') {
    const order = { urgent: 0, high: 1, medium: 2, low: 3, __none: 99 };
    return (a, b) => (order[a.key] ?? 50) - (order[b.key] ?? 50);
  }
  if (groupBy === 'type') {
    const order = { epic: 0, story: 1, bug: 2, __none: 99 };
    return (a, b) => (order[a.key] ?? 50) - (order[b.key] ?? 50);
  }
  // epic / assignee / default: catch-all lanes sink to the bottom — __bugs
  // (orphan bugs) just above __none (everything else without a parent), so
  // real epic lanes stay sorted alphabetically up top.
  const sinkOrder = (k) => (k === '__none' ? 2 : k === '__bugs' ? 1 : 0);
  return (a, b) => {
    const sa = sinkOrder(a.key);
    const sb = sinkOrder(b.key);
    if (sa !== sb) return sa - sb;
    // Epic lanes carry a root-to-self label chain; sorting on it keeps each
    // nested epic directly beneath its parent (tree/DFS order). Other lanes
    // fall back to their own label.
    return String(a.sortPath ?? a.label).localeCompare(String(b.sortPath ?? b.label));
  };
}

function renderCard(t) {
  const tpl = document.getElementById('card-template');
  const node = tpl.content.cloneNode(true);
  const card = node.querySelector('.card');
  card.dataset.id = t.id;
  if (recentlyMovedIds.has(t.id)) card.classList.add('just-moved');
  card.querySelector('.badge').classList.add(t.type);
  card.querySelector('.badge').textContent = t.type;
  card.querySelector('.card-id').textContent = t.id;
  const pri = card.querySelector('.card-pri');
  pri.textContent = t.priority !== 'medium' ? t.priority : '';
  pri.classList.add(t.priority);
  card.querySelector('.card-title').textContent = t.title;

  const meta = card.querySelector('.card-meta');
  if (t.parent_id) {
    const epic = document.createElement('span');
    epic.className = 'chip epic';
    epic.textContent = `↑ ${t.parent_id}`;
    epic.title = 'Filter to this epic';
    epic.addEventListener('click', async (e) => {
      e.stopPropagation();
      state.epicFilter = t.parent_id;
      updateViewTrigger();
      await refresh();
    });
    meta.appendChild(epic);
  }
  if (t.branch) {
    const b = document.createElement('span');
    b.className = 'chip branch';
    b.textContent = `⎇ ${t.branch}`;
    meta.appendChild(b);
  }
  if (t.pr_url) {
    const p = document.createElement('a');
    p.className = 'chip pr';
    // Only follow http(s) PR links — a pr_url of javascript:… would execute on
    // click otherwise (SCP-217). Non-http schemes render inert.
    p.href = /^https?:\/\//i.test(t.pr_url) ? t.pr_url : '#';
    p.target = '_blank';
    p.rel = 'noreferrer';
    p.textContent = '⇄ PR';
    p.addEventListener('click', (e) => e.stopPropagation());
    meta.appendChild(p);
  }
  if (t.assignee) {
    const a = document.createElement('span');
    a.className = 'chip';
    a.textContent = `@${t.assignee}`;
    meta.appendChild(a);
  }
  if (!meta.children.length) meta.remove();

  card.addEventListener('click', () => openDrawer(t.id));
  bindCardDnD(card);
  return card;
}

/* ------------- drag and drop ------------- */

let dragState = null;
function bindCardDnD(card) {
  card.addEventListener('dragstart', (e) => {
    dragState = { id: card.dataset.id, from: card.parentElement };
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', card.dataset.id);
  });
  card.addEventListener('dragend', () => {
    card.classList.remove('dragging');
    dragState = null;
  });
}
function bindColumnDnD(col) {
  col.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    col.classList.add('drop-target');
  });
  col.addEventListener('dragleave', () => col.classList.remove('drop-target'));
  col.addEventListener('drop', async (e) => {
    e.preventDefault();
    col.classList.remove('drop-target');
    const id = e.dataTransfer.getData('text/plain');
    const status = col.dataset.status;
    if (!id || !status) return;
    try {
      const fromStatus = dragState?.from?.parentElement?.dataset?.status;
      await api(`/api/tickets/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: { status, __by: 'ui' },
      });
      if (status === 'done' && fromStatus !== 'done') burstConfetti();
      await refresh();
    } catch (err) {
      toast(err.message);
    }
  });
}

/* ------------- drawer ------------- */

async function openDrawer(id) {
  const drawer = document.getElementById('drawer');
  drawer.hidden = false;
  state.drawerTicketId = id;
  const data = await api(`/api/tickets/${encodeURIComponent(id)}`);
  renderDrawer(data);
}
function closeDrawer() {
  document.getElementById('drawer').hidden = true;
  state.drawerTicketId = null;
}

function renderDrawer(t) {
  const el = document.getElementById('drawer-content');
  const epicProgress = t.progress
    ? `<div class="row">
         <span class="label">Progress</span>
         <span class="value">${t.progress.done}/${t.progress.total} (${t.progress.percent}%)</span>
       </div>
       <div class="progress-bar"><div class="fill" style="width:${t.progress.percent}%"></div></div>`
    : '';
  el.innerHTML = `
    <button class="close" title="Close">×</button>
    <div class="drawer-head">
      <span class="badge ${t.type}">${t.type}</span>
      <span style="color: var(--text-muted); font-family: ui-monospace, monospace;">${t.id}</span>
    </div>
    <h2 contenteditable="true" data-field="title">${escapeHtml(t.title)}</h2>

    <div class="row">
      <span class="label">Status</span>
      <select data-field="status">
        ${state.meta.statuses
          .map(
            (s) =>
              `<option value="${s}" ${s === t.status ? 'selected' : ''}>${STATUS_LABELS[s] || s}</option>`
          )
          .join('')}
      </select>
    </div>
    <div class="row">
      <span class="label">Priority</span>
      <select data-field="priority">
        ${state.meta.priorities
          .map(
            (p) =>
              `<option value="${p}" ${p === t.priority ? 'selected' : ''}>${p}</option>`
          )
          .join('')}
      </select>
    </div>
    ${
      t.type !== 'epic'
        ? `<div class="row">
            <span class="label">Epic</span>
            <input type="text" data-field="parent_id" placeholder="EPIC-1 (or empty)"
                   value="${escapeHtml(t.parent_id ?? '')}" />
          </div>`
        : ''
    }
    <div class="row">
      <span class="label">Branch</span>
      <input type="text" data-field="branch" value="${escapeHtml(t.branch ?? '')}" placeholder="feat/foo" />
    </div>
    <div class="row">
      <span class="label">PR URL</span>
      <input type="url" data-field="pr_url" value="${escapeHtml(t.pr_url ?? '')}" placeholder="https://github.com/..." />
    </div>
    <div class="row">
      <span class="label">Assignee</span>
      <input type="text" data-field="assignee" value="${escapeHtml(t.assignee ?? '')}" placeholder="handle" />
    </div>
    <div class="row">
      <span class="label">Labels</span>
      <input type="text" data-field="labels" value="${escapeHtml((t.labels || []).join(', '))}" placeholder="frontend, infra" />
    </div>
    ${epicProgress}

    <div class="section description-section">
      <div class="description-head">
        <h3>Description</h3>
        <button type="button" class="description-toggle" data-mode="view" title="Toggle edit/preview">Edit</button>
      </div>
      <div class="description-preview" data-empty="${!t.description}">${
        t.description ? renderMarkdown(t.description) : '<p class="muted">No description yet.</p>'
      }</div>
      <textarea class="description-edit" data-field="description" hidden placeholder="Markdown supported (#, **bold**, *italic*, \`code\`, lists, [links](https://...))">${escapeHtml(t.description ?? '')}</textarea>
    </div>

    <div class="actions">
      <button class="btn primary" id="save-ticket">Save</button>
      <button class="btn danger" id="delete-ticket">Delete</button>
    </div>

    ${
      t.children && t.children.length
        ? `<div class="section">
            <h3>Children (${t.children.length})</h3>
            <div class="children-list">
              ${t.children
                .map(
                  (c) => `
                <div class="child" data-id="${c.id}">
                  <span class="badge ${c.type}">${c.type}</span>
                  <span style="font-family: ui-monospace, monospace; color: var(--text-muted)">${c.id}</span>
                  <span class="child-title">${escapeHtml(c.title)}</span>
                  <span class="dot ${c.status}" title="${c.status}"></span>
                </div>`
                )
                .join('')}
            </div>
          </div>`
        : ''
    }

    <div class="section">
      <h3>Relations</h3>
      <div class="relations-list">
        ${
          (t.relations || []).length
            ? t.relations
                .map(
                  (r) => `
              <div class="relation" data-id="${r.to_ticket_id}">
                <span class="rel-type">${r.type}</span>
                <span style="font-family: ui-monospace, monospace; color: var(--text-muted)">${r.to_ticket_id}</span>
                <span style="flex:1">${escapeHtml(r.title || '')}</span>
                ${r.status ? `<span class="dot ${r.status}" title="${r.status}"></span>` : ''}
                <button class="btn ghost" data-remove="${r.to_ticket_id}|${r.type}" title="Remove">×</button>
              </div>`
                )
                .join('')
            : '<div style="color: var(--text-dim); font-size: 12px;">(none)</div>'
        }
      </div>
      <div class="row" style="margin-top: 8px;">
        <select id="rel-type">
          ${state.meta.relation_types.map((r) => `<option value="${r}">${r}</option>`).join('')}
        </select>
        <input type="text" id="rel-to" placeholder="ticket id (e.g. SCP-3)" />
        <button class="btn" id="rel-add">Add</button>
      </div>
    </div>

    <div class="section">
      <h3>Comments</h3>
      <div class="comments-list">
        ${
          (t.comments || []).length
            ? t.comments
                .map(
                  (c) => `
              <div class="comment">
                <div style="flex:1">
                  <div class="meta">${escapeHtml(c.author || 'anon')} · ${c.created_at}</div>
                  <div class="body">${escapeHtml(c.body)}</div>
                </div>
              </div>`
                )
                .join('')
            : '<div style="color: var(--text-dim); font-size: 12px;">(none)</div>'
        }
      </div>
      <div class="row" style="margin-top: 8px;">
        <input type="text" id="comment-author" placeholder="author (optional)" style="width:140px" />
        <input type="text" id="comment-body" placeholder="add a comment…" style="flex:1" />
        <button class="btn" id="comment-add">Comment</button>
      </div>
    </div>
  `;

  el.querySelector('.close').addEventListener('click', closeDrawer);
  el.querySelector('#save-ticket').addEventListener('click', () => saveDrawer(t));
  el.querySelector('#delete-ticket').addEventListener('click', () => deleteDrawer(t));

  // Description: click preview or "Edit" toggles to textarea; "Preview" goes back.
  const preview = el.querySelector('.description-preview');
  const editor = el.querySelector('.description-edit');
  const toggle = el.querySelector('.description-toggle');
  const showEdit = () => {
    preview.hidden = true;
    editor.hidden = false;
    toggle.textContent = 'Preview';
    toggle.dataset.mode = 'edit';
    editor.focus();
  };
  const showPreview = () => {
    preview.innerHTML = editor.value
      ? renderMarkdown(editor.value)
      : '<p class="muted">No description yet.</p>';
    preview.dataset.empty = String(!editor.value);
    editor.hidden = true;
    preview.hidden = false;
    toggle.textContent = 'Edit';
    toggle.dataset.mode = 'view';
    hydrateMermaid(preview);
  };
  toggle.addEventListener('click', () => {
    if (toggle.dataset.mode === 'view') showEdit(); else showPreview();
  });
  preview.addEventListener('click', (e) => {
    if (e.target.closest('a')) return; // let links work
    showEdit();
  });
  hydrateMermaid(preview);

  el.querySelectorAll('.child').forEach((c) =>
    c.addEventListener('click', () => openDrawer(c.dataset.id))
  );
  el.querySelectorAll('.relation').forEach((r) => {
    r.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      openDrawer(r.dataset.id);
    });
  });
  el.querySelectorAll('[data-remove]').forEach((btn) =>
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const [to, type] = btn.dataset.remove.split('|');
      await api(`/api/tickets/${encodeURIComponent(t.id)}/relations`, {
        method: 'DELETE',
        body: { to, type },
      });
      openDrawer(t.id);
    })
  );
  el.querySelector('#rel-add').addEventListener('click', async () => {
    const to = el.querySelector('#rel-to').value.trim();
    const type = el.querySelector('#rel-type').value;
    if (!to) return;
    try {
      await api(`/api/tickets/${encodeURIComponent(t.id)}/relations`, {
        method: 'POST',
        body: { to, type },
      });
      openDrawer(t.id);
      await refresh();
    } catch (err) {
      toast(err.message);
    }
  });
  el.querySelector('#comment-add').addEventListener('click', async () => {
    const body = el.querySelector('#comment-body').value.trim();
    const author = el.querySelector('#comment-author').value.trim() || null;
    if (!body) return;
    await api(`/api/tickets/${encodeURIComponent(t.id)}/comments`, {
      method: 'POST',
      body: { body, author },
    });
    openDrawer(t.id);
  });
}

async function saveDrawer(t) {
  const el = document.getElementById('drawer-content');
  const fields = {};
  el.querySelectorAll('[data-field]').forEach((node) => {
    const field = node.dataset.field;
    let v = node.tagName === 'H2' ? node.textContent.trim() : node.value;
    if (field === 'parent_id') v = v.trim() || null;
    if (field === 'branch' || field === 'pr_url' || field === 'assignee')
      v = v.trim() || null;
    if (field === 'labels')
      v = v.split(',').map((x) => x.trim()).filter(Boolean);
    fields[field] = v;
  });
  fields.__by = 'ui';
  try {
    await api(`/api/tickets/${encodeURIComponent(t.id)}`, {
      method: 'PATCH',
      body: fields,
    });
    if (fields.status === 'done' && t.status !== 'done') burstConfetti();
    await refresh();
    openDrawer(t.id);
  } catch (err) {
    toast(err.message);
  }
}

async function deleteDrawer(t) {
  if (!confirm(`Delete ${t.id}? This cannot be undone.`)) return;
  await api(`/api/tickets/${encodeURIComponent(t.id)}`, { method: 'DELETE' });
  closeDrawer();
  await refresh();
}

/* ------------- modals ------------- */

function openModal(html) {
  // Opening any modal tears down whatever was in modal-root, including a search
  // palette — drop its live-refresh hook so a stale closure can't keep firing.
  activeSearchRerun = null;
  const root = document.getElementById('modal-root');
  root.innerHTML = `<div class="modal-backdrop"><div class="modal">${html}</div></div>`;
  root.querySelector('.modal-backdrop').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeModal();
  });
  return root.querySelector('.modal');
}
function closeModal() {
  activeSearchRerun = null;
  document.getElementById('modal-root').innerHTML = '';
}

/* ------------- search ------------- */

// `/` opens search from anywhere on the board; Cmd/Ctrl-K works even while a
// field is focused. We never hijack the keys while the user is typing in a
// field (so `/` in a title still types a slash) or when another modal is up.
function bindSearchShortcuts() {
  document.addEventListener('keydown', (e) => {
    // Any modal (including an already-open palette) blocks both shortcuts:
    // ⌘K/Ctrl-K must NOT openModal() over a half-filled New-ticket/Attach form
    // and wipe it. The search palette is itself a .modal-backdrop, so this also
    // no-ops the shortcut while the palette is open.
    const modalOpen = !!document.querySelector('.modal-backdrop');
    const t = e.target;
    const typing =
      t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (!modalOpen) openSearchModal();
      return;
    }
    if (e.key === '/' && !typing && !modalOpen) {
      e.preventDefault();
      openSearchModal();
    }
  });
}

// Set by openSearchModal to a closure that re-runs the palette's current
// query; called from scheduleRefresh so live SSE changes update open results.
// Cleared by openModal/closeModal. Null when no palette is open.
let activeSearchRerun = null;
// Clients don't request a custom page size, so results cap at the server
// default; we surface that cap in a footer when we hit it.
const SEARCH_PAGE_SIZE = 50;

function openSearchModal(initial = '') {
  if (!state.currentWorkspace) {
    toast('Select a workspace to search.');
    return;
  }
  // Per-palette state — kept local so a second palette can't collide with a
  // stale debounce/sequence from a previous one.
  let searchSeq = 0;
  let searchDebounce = null;
  const modal = openModal(`
    <div class="search-head">
      <span class="search-icon" aria-hidden="true"><svg class="icon-svg" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg></span>
      <input id="search-q" class="search-input" type="text" autocomplete="off"
             spellcheck="false" enterkeyhint="search"
             placeholder="Search tickets — title, SCP-12, @assignee, label, comment…" />
    </div>
    <div id="search-results" class="search-results"></div>
    <div class="search-foot">
      <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
      <span><kbd>↵</kbd> open</span>
      <span><kbd>esc</kbd> close</span>
    </div>
  `);
  modal.classList.add('search-palette');
  const input = modal.querySelector('#search-q');
  const resultsEl = modal.querySelector('#search-results');
  let results = [];
  let active = -1;

  const highlight = () => {
    const rows = resultsEl.querySelectorAll('.search-row');
    rows.forEach((row, i) => row.classList.toggle('active', i === active));
    rows[active]?.scrollIntoView({ block: 'nearest' });
  };

  const choose = async (i) => {
    const t = results[i];
    if (!t) return;
    closeModal();
    // Await + catch: the result list can outlive the ticket (it may be deleted
    // remotely between render and click), and openDrawer fetches by id — a 404
    // would otherwise be an unhandled rejection over a half-open drawer.
    try {
      await openDrawer(t.id);
    } catch (e) {
      closeDrawer();
      toast(`Couldn’t open ${t.id}: ${e.message}`);
    }
  };

  const render = (items, q) => {
    results = items;
    active = items.length ? 0 : -1;
    if (!q.trim()) {
      resultsEl.innerHTML =
        `<div class="search-empty">Search every field — id, title, description, assignee, labels, branch, PR, and comments.</div>`;
      return;
    }
    if (!items.length) {
      resultsEl.innerHTML = `<div class="search-empty">No tickets match “${escapeHtml(q)}”.</div>`;
      return;
    }
    // Surface the server-side cap so a >50-match query doesn't look complete.
    const footer =
      items.length >= SEARCH_PAGE_SIZE
        ? `<div class="search-note">Showing the first ${SEARCH_PAGE_SIZE} matches — refine your search to narrow.</div>`
        : '';
    resultsEl.innerHTML = items.map(searchRowHtml).join('') + footer;
    highlight();
    resultsEl.querySelectorAll('.search-row').forEach((row) => {
      const i = Number(row.dataset.i);
      row.addEventListener('click', () => choose(i));
      row.addEventListener('mousemove', () => {
        if (active !== i) { active = i; highlight(); }
      });
    });
  };

  const run = async (q) => {
    const seq = ++searchSeq;
    if (!q.trim()) return render([], q);
    try {
      const items = await api(`/api/tickets/search?q=${encodeURIComponent(q)}`);
      if (seq === searchSeq) render(items, q);
    } catch (e) {
      if (seq === searchSeq) {
        resultsEl.innerHTML = `<div class="search-empty">${escapeHtml(e.message)}</div>`;
      }
    }
  };

  input.addEventListener('input', () => {
    clearTimeout(searchDebounce);
    const q = input.value;
    searchDebounce = setTimeout(() => run(q), 140);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeModal(); return; }
    if (!results.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      active = (active + 1) % results.length;
      highlight();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      active = (active - 1 + results.length) % results.length;
      highlight();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (active >= 0) choose(active);
    }
  });

  render([], '');
  input.value = initial;
  input.focus();
  if (initial) run(initial);

  // Live-refresh hook: scheduleRefresh() calls this on every SSE change so the
  // open palette re-runs its current query. Re-uses the seq guard in run().
  activeSearchRerun = () => run(input.value);
}

function searchRowHtml(t, i) {
  const pri =
    t.priority && t.priority !== 'medium'
      ? `<span class="search-pri ${escapeHtml(t.priority)}">${escapeHtml(t.priority)}</span>`
      : '';
  const meta = [];
  if (t.parent_id) meta.push(`<span class="chip epic">↑ ${escapeHtml(t.parent_id)}</span>`);
  if (t.assignee) meta.push(`<span class="chip">@${escapeHtml(t.assignee)}</span>`);
  if (t.branch) meta.push(`<span class="chip branch">⎇ ${escapeHtml(t.branch)}</span>`);
  // Match the board card, which shows a PR chip (renderCard); search omitted it.
  if (t.pr_url) meta.push(`<span class="chip pr">⇄ PR</span>`);
  if (Array.isArray(t.labels)) {
    for (const l of t.labels) meta.push(`<span class="chip">${escapeHtml(l)}</span>`);
  }
  return `
    <div class="search-row" data-i="${i}">
      <div class="search-row-main">
        <span class="badge ${escapeHtml(t.type)}">${escapeHtml(t.type)}</span>
        <span class="search-id">${escapeHtml(t.id)}</span>
        <span class="search-title">${escapeHtml(t.title)}</span>
        <span class="search-grow"></span>
        ${pri}
        <span class="search-status">${escapeHtml(STATUS_LABELS[t.status] || t.status)}</span>
      </div>
      ${meta.length ? `<div class="search-row-meta">${meta.join('')}</div>` : ''}
    </div>`;
}

function openAddWorkspaceModal() {
  const modal = openModal(`
    <h3>Attach a workspace</h3>
    <p style="font-size:12px;color:var(--text-muted);margin:0 0 12px;">
      Point at an existing <code>.scope/</code> directory. The hub will open
      it, watch it for changes, and show its projects in the workspace picker.
    </p>
    <label>Path to .scope/ <input id="w-path" placeholder="/path/to/repo/.scope" /></label>
    <label>Label (optional) <input id="w-label" placeholder="defaults to the repo dir name" /></label>
    <div class="error" id="w-err"></div>
    <div class="modal-actions">
      <button class="btn ghost" id="w-cancel">Cancel</button>
      <button class="btn primary" id="w-attach">Attach</button>
    </div>
  `);
  const pathInput = modal.querySelector('#w-path');
  pathInput.focus();
  modal.querySelector('#w-cancel').addEventListener('click', closeModal);
  modal.querySelector('#w-attach').addEventListener('click', async () => {
    const scope_dir = pathInput.value.trim();
    const label = modal.querySelector('#w-label').value.trim() || undefined;
    if (!scope_dir) {
      modal.querySelector('#w-err').textContent = 'Path is required.';
      return;
    }
    try {
      const w = await api('/api/workspaces', {
        method: 'POST',
        body: { scope_dir, label },
      });
      closeModal();
      // SSE will refresh the picker, but make the new workspace active immediately.
      await reloadWorkspaces();
      state.currentWorkspace = w.id;
      localStorage.setItem('scope.workspace', w.id);
      updateBreadcrumb();
      if (eventSource) { try { eventSource.close(); } catch {} eventSource = null; }
      startEventStream();
      await refresh();
    } catch (e) {
      modal.querySelector('#w-err').textContent = e.message;
    }
  });
}

async function openTicketModal({ status = 'backlog', parent = '' } = {}) {
  if (!state.currentWorkspace) return toast('Attach a workspace first.', { variant: 'info' });
  const epics = await api('/api/tickets?type=epic');
  const modal = openModal(`
    <h3>New ticket</h3>
    <label>Type
      <select id="t-type">
        <option value="story">story</option>
        <option value="bug">bug</option>
        <option value="epic">epic</option>
      </select>
    </label>
    <label>Title <input id="t-title" placeholder="Brief summary" /></label>
    <label>Parent epic
      <select id="t-parent">
        <option value="">(none)</option>
        ${epics.map((e) => `<option value="${e.id}" ${e.id === parent ? 'selected' : ''}>${e.id} — ${escapeHtml(e.title)}</option>`).join('')}
      </select>
    </label>
    <label>Status
      <select id="t-status">
        ${state.meta.statuses.map((s) => `<option value="${s}" ${s === status ? 'selected' : ''}>${STATUS_LABELS[s] || s}</option>`).join('')}
      </select>
    </label>
    <label>Priority
      <select id="t-priority">
        ${state.meta.priorities.map((p) => `<option value="${p}" ${p === 'medium' ? 'selected' : ''}>${p}</option>`).join('')}
      </select>
    </label>
    <label>Description <textarea id="t-desc" placeholder="Markdown supported"></textarea></label>
    <label>Branch <input id="t-branch" placeholder="feat/foo (optional)" /></label>
    <label>PR URL <input id="t-pr" placeholder="https://github.com/... (optional)" /></label>
    <div class="error" id="t-err"></div>
    <div class="modal-actions">
      <button class="btn ghost" id="t-cancel">Cancel</button>
      <button class="btn primary" id="t-create">Create</button>
    </div>
  `);
  const typeSel = modal.querySelector('#t-type');
  const parentSel = modal.querySelector('#t-parent');
  typeSel.addEventListener('change', () => {
    parentSel.disabled = typeSel.value === 'epic';
    if (parentSel.disabled) parentSel.value = '';
  });
  modal.querySelector('#t-cancel').addEventListener('click', closeModal);
  modal.querySelector('#t-create').addEventListener('click', async () => {
    const body = {
      type: typeSel.value,
      title: modal.querySelector('#t-title').value.trim(),
      description: modal.querySelector('#t-desc').value,
      status: modal.querySelector('#t-status').value,
      priority: modal.querySelector('#t-priority').value,
      parent: parentSel.value || undefined,
      branch: modal.querySelector('#t-branch').value.trim() || undefined,
      prUrl: modal.querySelector('#t-pr').value.trim() || undefined,
    };
    try {
      await api('/api/tickets', { method: 'POST', body });
      closeModal();
      await refresh();
    } catch (e) {
      modal.querySelector('#t-err').textContent = e.message;
    }
  });
}

/* ------------- overview ------------- */

async function renderOverview() {
  // The workspace IS the project in v2. Fetch via the back-compat /api/projects
  // endpoint using the workspace's key (the synthesized id is key.toLowerCase()).
  const w = currentWorkspaceObj();
  if (!w || !w.key) return renderEmpty();
  const p = await api(`/api/projects/${encodeURIComponent(w.key)}`);
  const root = document.getElementById('board');
  root.style.display = 'block';
  root.innerHTML = `
    <div class="overview">
      <div><span class="key">${escapeHtml(p.key)}</span></div>
      <h1>${escapeHtml(p.name)}</h1>
      ${p.description ? `<div class="description">${escapeHtml(p.description)}</div>` : ''}
      ${
        p.overview && p.overview.trim()
          ? `<div class="overview-body markdown">${renderMarkdown(p.overview)}</div>`
          : '<div class="overview-body" style="color: var(--text-dim)">No overview yet. Use <code>scope workspace set --edit</code> to add one.</div>'
      }
      <h3 style="margin-top: 28px;">Epics</h3>
      <div class="epics-grid">
        ${
          p.epics.length
            ? p.epics
                .map(
                  (e) => `
              <div class="epic-card" data-id="${e.id}">
                <div><span class="badge epic">EPIC</span>
                  <span style="font-family: ui-monospace, monospace; color: var(--text-muted)">${e.id}</span>
                </div>
                <div class="epic-title">${escapeHtml(e.title)}</div>
                <div class="epic-stats">
                  <span class="dot ${e.status}"></span> ${e.status} ·
                  ${e.progress.done}/${e.progress.total} done (${e.progress.percent}%)
                </div>
                <div class="progress-bar" style="margin-top: 8px;">
                  <div class="fill" style="width:${e.progress.percent}%"></div>
                </div>
              </div>`
                )
                .join('')
            : '<div style="color: var(--text-dim)">No epics yet.</div>'
        }
      </div>
      <div class="overview-foot">
        <button type="button" class="link-btn" id="overview-history-link">View history →</button>
      </div>
    </div>
  `;
  root.querySelector('#overview-history-link')?.addEventListener('click', async () => {
    state.view = 'history';
    await refresh();
  });
  root.querySelectorAll('.epic-card').forEach((el) =>
    el.addEventListener('click', async () => {
      state.view = 'board';
      state.epicFilter = el.dataset.id;
      updateViewTrigger();
      // restore board layout
      root.style.display = '';
      await refresh();
    })
  );
  hydrateMermaid(root);
}

/* ------------- relationship graph view ------------- */
//
// A scrollable node-link diagram of the workspace: epics sit at the top as
// "umbrella" nodes with their child tickets flowing beneath (the parent_id
// hierarchy), and cross-ticket relations (blocks / relates_to / duplicates)
// overlay as dashed, colour-coded connectors. Clicking any node opens the same
// drawer the board uses. Mirrors the iOS FlowGraphView.

const GRAPH = {
  NODE_W: 200,
  NODE_H: 76,
  PARENT_GAP: 30,   // vertical gap from a node to its children area
  CHILD_V_GAP: 14,  // vertical gap between stacked child blocks in a column
  INNER_GAP: 18,    // horizontal gap between child columns within a cluster
  CLUSTER_PAD: 16,  // padding inside a cluster's tinted box
  CLUSTER_GAP: 22,  // gap between clusters in a row
  ROW_GAP: 26,      // gap between rows of clusters
  PAD: 24,
  MIN_SCALE: 0.4,
  MAX_SCALE: 2.2,
};

const RELATION_STYLE = {
  blocks:       { color: 'var(--red)',     dashed: true, directional: true,  label: 'Blocks' },
  relates_to:   { color: 'var(--blue)',    dashed: true, directional: false, label: 'Relates to' },
  duplicates:   { color: 'var(--magenta)', dashed: true, directional: true,  label: 'Duplicates' },
};

async function renderGraph() {
  if (!state.currentWorkspace) return renderEmpty();
  const root = document.getElementById('board');
  root.classList.remove('swim', 'board-empty-wrap');
  root.classList.add('graph-host');
  root.style.display = 'block';

  // Fetch tickets + their relations once per graph open; zooming reuses this.
  if (!state.graphData) {
    root.innerHTML = '<div class="graph-loading">Loading graph…</div>';
    try {
      const tickets = await api('/api/tickets');
      const edges = await loadGraphRelations(tickets);
      state.graphData = { tickets, edges };
    } catch (err) {
      toast(err.message);
      state.graphData = { tickets: [], edges: [] };
    }
  }
  drawGraph();
}

async function loadGraphRelations(tickets) {
  // No bulk endpoint — fan out one request per ticket (browsers cap real
  // concurrency per origin) and dedupe the hub's bidirectional storage.
  const relByTicket = new Map();
  await Promise.all(
    tickets.map(async (t) => {
      try {
        const rels = await api(`/api/tickets/${encodeURIComponent(t.id)}/relations`);
        if (rels && rels.length) relByTicket.set(t.id, rels);
      } catch { /* best-effort: a failed ticket just contributes no edges */ }
    })
  );
  return dedupeRelationEdges(relByTicket);
}

function dedupeRelationEdges(relByTicket) {
  const seen = new Set();
  const edges = [];
  for (const [from, rels] of relByTicket) {
    for (const r of rels) {
      const to = r.to_ticket_id;
      if (!to || from === to) continue;
      if (r.type === 'blocked_by' || r.type === 'duplicate_of') continue; // inverse half
      if (r.type === 'relates_to') {
        const key = 'rel|' + [from, to].sort().join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({ from, to, type: 'relates_to' });
      } else if (r.type === 'blocks' || r.type === 'duplicates') {
        const key = `${from}|${to}|${r.type}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({ from, to, type: r.type });
      }
    }
  }
  return edges;
}

/**
 * Layout of epic clusters — ports iOS FlowGraphLayout.
 *
 * Each root (epic or parentless ticket) plus its descendants becomes a compact
 * cluster laid out recursively: a node sits on top with its children fanned in a
 * grid of 1–3 columns beneath it (more columns on wider screens / bigger epics),
 * each child a sub-block of the same shape. Collapsed nodes hide their children.
 * Clusters then flow left-to-right and wrap into rows to fit `availableWidth`.
 */
function computeGraphLayout(tickets, availableWidth, collapsed) {
  const { NODE_W, NODE_H, PARENT_GAP, CHILD_V_GAP, INNER_GAP, CLUSTER_PAD, CLUSTER_GAP, ROW_GAP, PAD } = GRAPH;
  const avail = Math.max((availableWidth || 0) - PAD * 2, NODE_W);
  const byId = new Map(tickets.map((t) => [t.id, t]));

  const childrenOf = new Map();
  for (const t of tickets) {
    if (t.parent_id && byId.has(t.parent_id)) {
      if (!childrenOf.has(t.parent_id)) childrenOf.set(t.parent_id, []);
      childrenOf.get(t.parent_id).push(t);
    }
  }
  const rank = (t) => (t.type === 'epic' ? 0 : t.type === 'story' ? 1 : 2);
  const order = (a, b) =>
    rank(a) - rank(b) ||
    String(a.created_at).localeCompare(String(b.created_at)) ||
    a.id.localeCompare(b.id);
  for (const arr of childrenOf.values()) arr.sort(order);

  // How many columns to fan a node's children into.
  const childCols = (n) => {
    const byWidth = avail >= 1100 ? 3 : avail >= 680 ? 2 : 1;
    const byCount = n > 12 ? 3 : n > 6 ? 2 : 1;
    return Math.max(1, Math.min(byWidth, byCount));
  };

  // Recursively lay a node + its (visible) descendants out in block-local
  // coordinates. `lx/ly` are node centres relative to the block's top-left.
  const visited = new Set();
  const swallow = (node) => {
    visited.add(node.id);
    for (const k of childrenOf.get(node.id) || []) swallow(k);
  };
  function layoutBlock(node) {
    visited.add(node.id);
    const kids = (childrenOf.get(node.id) || []).filter((k) => byId.has(k.id));
    if (!kids.length || collapsed.has(node.id)) {
      // Collapsed: mark the hidden descendants visited so the cycle-recovery
      // pass below doesn't resurrect them as their own root clusters.
      for (const k of kids) swallow(k);
      return {
        nodes: [{ ticket: node, lx: NODE_W / 2, ly: NODE_H / 2, childCount: kids.length }],
        w: NODE_W,
        h: NODE_H,
      };
    }
    const blocks = kids.map(layoutBlock);
    const cols = childCols(blocks.length);
    const colW = Math.max(NODE_W, ...blocks.map((b) => b.w));
    const colH = new Array(cols).fill(0);
    const placed = [];
    for (const b of blocks) {
      let j = 0;
      for (let k = 1; k < cols; k++) if (colH[k] < colH[j]) j = k;
      placed.push({ b, col: j, yoff: colH[j] });
      colH[j] += b.h + CHILD_V_GAP;
    }
    const childrenW = cols * colW + (cols - 1) * INNER_GAP;
    const childrenH = Math.max(...colH) - CHILD_V_GAP;
    const blockW = Math.max(NODE_W, childrenW);
    const childrenX0 = (blockW - childrenW) / 2;
    const childrenY0 = NODE_H + PARENT_GAP;
    const nodes = [{ ticket: node, lx: blockW / 2, ly: NODE_H / 2, childCount: kids.length }];
    for (const p of placed) {
      const bx = childrenX0 + p.col * (colW + INNER_GAP) + (colW - p.b.w) / 2;
      const by = childrenY0 + p.yoff;
      for (const cn of p.b.nodes) nodes.push({ ...cn, lx: bx + cn.lx, ly: by + cn.ly });
    }
    return { nodes, w: blockW, h: childrenY0 + childrenH };
  }

  const roots = tickets
    .filter((t) => !t.parent_id || !byId.has(t.parent_id))
    .sort(order);
  const clusters = roots.map(layoutBlock);
  // Pathological parent-id cycles: anything still unplaced becomes its own root.
  for (const t of tickets) if (!visited.has(t.id)) clusters.push(layoutBlock(t));

  // Flow clusters left-to-right, wrapping into rows that fit the viewport.
  const positions = new Map();
  const nodes = [];
  const clusterRects = [];
  let curX = PAD;
  let rowY = PAD;
  let rowMaxH = 0;
  let maxRight = PAD;
  for (const c of clusters) {
    const boxW = c.w + CLUSTER_PAD * 2;
    const boxH = c.h + CLUSTER_PAD * 2;
    if (curX > PAD && curX + boxW > PAD + avail) {
      rowY += rowMaxH + ROW_GAP;
      curX = PAD;
      rowMaxH = 0;
    }
    const ox = curX + CLUSTER_PAD;
    const oy = rowY + CLUSTER_PAD;
    clusterRects.push({ x: curX, y: rowY, w: boxW, h: boxH, ticket: c.nodes[0].ticket });
    for (const n of c.nodes) {
      const x = ox + n.lx;
      const y = oy + n.ly;
      positions.set(n.ticket.id, { x, y });
      nodes.push({ ticket: n.ticket, x, y, childCount: n.childCount });
    }
    curX += boxW + CLUSTER_GAP;
    rowMaxH = Math.max(rowMaxH, boxH);
    maxRight = Math.max(maxRight, curX - CLUSTER_GAP);
  }

  const parentEdges = [];
  for (const n of nodes) {
    for (const k of childrenOf.get(n.ticket.id) || []) {
      if (positions.has(k.id)) parentEdges.push({ from: n.ticket.id, to: k.id });
    }
  }

  return {
    positions,
    nodes,
    parentEdges,
    clusterRects,
    width: maxRight + PAD,
    height: rowY + rowMaxH + PAD,
  };
}

function drawGraph() {
  const root = document.getElementById('board');
  const { tickets, edges } = state.graphData;

  if (!tickets.length) {
    root.innerHTML = '';
    renderBoardEmptyState(root, { variant: 'empty' });
    return;
  }

  const availW = root.clientWidth || window.innerWidth || 1200;
  const layout = computeGraphLayout(tickets, availW, state.graphCollapsed);
  const relEdges = edges.filter(
    (e) => layout.positions.has(e.from) && layout.positions.has(e.to)
  );
  const s = state.graphScale;

  const wrap = document.createElement('div');
  wrap.className = 'graph-wrap';

  const sizer = document.createElement('div');
  sizer.className = 'graph-sizer';
  sizer.style.width = `${layout.width * s}px`;
  sizer.style.height = `${layout.height * s}px`;

  const canvas = document.createElement('div');
  canvas.className = 'graph-canvas';
  canvas.style.width = `${layout.width}px`;
  canvas.style.height = `${layout.height}px`;
  canvas.style.transform = `scale(${s})`;

  // Painted back-to-front: cluster tints, then edges, then node cards.
  canvas.insertAdjacentHTML('afterbegin', buildGraphEdgesSVG(layout, relEdges));
  canvas.insertAdjacentHTML('afterbegin', layout.clusterRects.map(buildClusterBg).join(''));
  for (const node of layout.nodes) canvas.appendChild(buildGraphNode(node));

  sizer.appendChild(canvas);
  wrap.appendChild(sizer);

  root.innerHTML = '';
  root.appendChild(wrap);
  // Controls live OUTSIDE the scroll container so they stay pinned as a single
  // floating overlay instead of drifting with the diagram.
  root.appendChild(buildGraphControls(layout, relEdges));

  wireGraphHighlight(wrap, layout, relEdges);
}

function buildGraphControls(layout, relEdges) {
  const overlay = document.createElement('div');
  overlay.className = 'graph-overlay';
  overlay.appendChild(buildGraphZoom());
  overlay.appendChild(buildGraphLegend(layout, relEdges));
  return overlay;
}

/** Deterministic 0–359 hue from a ticket id, so each epic keeps its tint. */
function graphHue(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % 360;
}

function buildClusterBg(rect) {
  const t = rect.ticket;
  if (t.type !== 'epic') return ''; // only epic umbrellas get a tint
  const hue = graphHue(t.id);
  return (
    `<div class="graph-cluster" style="left:${rect.x}px;top:${rect.y}px;` +
    `width:${rect.w}px;height:${rect.h}px;` +
    `background:hsla(${hue},60%,55%,0.07);border-color:hsla(${hue},60%,62%,0.32)"></div>`
  );
}

function buildGraphEdgesSVG(layout, relEdges) {
  const { NODE_H } = GRAPH;
  const pos = layout.positions;
  let paths = '';

  // Epic → ticket hierarchy: smooth vertical S-curves fanning to each child.
  for (const e of layout.parentEdges) {
    const p = pos.get(e.from);
    const c = pos.get(e.to);
    if (!p || !c) continue;
    const sx = p.x, sy = p.y + NODE_H / 2;
    const ex = c.x, ey = c.y - NODE_H / 2;
    const my = (sy + ey) / 2;
    paths += `<path d="M ${sx} ${sy} C ${sx} ${my} ${ex} ${my} ${ex} ${ey}" class="graph-edge graph-edge-parent" fill="none" data-a="${e.from}" data-b="${e.to}"/>`;
  }

  // Cross-ticket relations: curved, dashed, colour-coded; grouped with their
  // arrowhead so highlighting toggles both together.
  for (const e of relEdges) {
    const a = pos.get(e.from);
    const b = pos.get(e.to);
    if (!a || !b) continue;
    const st = RELATION_STYLE[e.type] || RELATION_STYLE.relates_to;
    const { cx, cy } = graphArc(a, b);
    let g = `<path d="M ${a.x} ${a.y} Q ${cx} ${cy} ${b.x} ${b.y}" fill="none" stroke="${st.color}" stroke-width="1.6" stroke-dasharray="6 4"/>`;
    if (st.directional) g += graphArrowHead(cx, cy, b, st.color);
    paths += `<g class="graph-edge graph-edge-rel" data-a="${e.from}" data-b="${e.to}">${g}</g>`;
  }

  return `<svg class="graph-edges" width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}">${paths}</svg>`;
}

/** Control point for a gently bowed quadratic between two node centres. */
function graphArc(a, b) {
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.max(Math.hypot(dx, dy), 1);
  const bow = Math.min(Math.max(len * 0.12, 18), 70);
  return { cx: mx + (-dy / len) * bow, cy: my + (dx / len) * bow };
}

/** Arrowhead pointing at `b`, oriented along the curve's exit tangent. */
function graphArrowHead(cx, cy, b, color) {
  const dx = b.x - cx, dy = b.y - cy;
  const len = Math.max(Math.hypot(dx, dy), 0.0001);
  const ux = dx / len, uy = dy / len;
  const inset = GRAPH.NODE_H / 2 + 4;
  const tx = b.x - ux * inset, ty = b.y - uy * inset;
  const ang = Math.atan2(uy, ux);
  const wing = 8, spread = Math.PI / 7;
  const lx = tx - Math.cos(ang - spread) * wing, ly = ty - Math.sin(ang - spread) * wing;
  const rx = tx - Math.cos(ang + spread) * wing, ry = ty - Math.sin(ang + spread) * wing;
  return `<polyline points="${lx},${ly} ${tx},${ty} ${rx},${ry}" fill="none" stroke="${color}" stroke-width="1.8"/>`;
}

function buildGraphNode(node) {
  const { NODE_W, NODE_H } = GRAPH;
  const t = node.ticket;
  const el = document.createElement('div');
  el.className = `graph-node${t.type === 'epic' ? ' epic' : ''}`;
  el.dataset.id = t.id;
  el.style.left = `${node.x - NODE_W / 2}px`;
  el.style.top = `${node.y - NODE_H / 2}px`;
  el.style.width = `${NODE_W}px`;
  el.style.height = `${NODE_H}px`;
  if (t.type === 'epic') el.style.setProperty('--gh', graphHue(t.id));

  const collapsible = node.childCount > 0;
  const collapsed = state.graphCollapsed.has(t.id);
  const chevron = collapsible
    ? `<button class="gn-collapse" title="${collapsed ? 'Expand' : 'Collapse'} children">${collapsed ? '▶' : '▼'}</button>`
    : '';
  const count = collapsible && t.type === 'epic'
    ? `<span class="gn-count">${node.childCount}</span>`
    : '';
  el.innerHTML = `
    <div class="gn-head">
      ${chevron}
      <span class="badge ${t.type}">${t.type}</span>
      <span class="gn-id">${escapeHtml(t.id)}</span>
      ${count}
      <span class="dot ${t.status}" title="${escapeHtml(t.status)}"></span>
    </div>
    <div class="gn-title">${escapeHtml(t.title)}</div>
  `;
  el.querySelector('.gn-collapse')?.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleGraphCollapse(t.id);
  });
  el.addEventListener('click', () => openDrawer(t.id));
  return el;
}

function toggleGraphCollapse(id) {
  if (state.graphCollapsed.has(id)) state.graphCollapsed.delete(id);
  else state.graphCollapsed.add(id);
  localStorage.setItem('scope.graphCollapsed', JSON.stringify([...state.graphCollapsed]));
  drawGraph();
}

/** Dim everything except a hovered node and its direct connections. */
function wireGraphHighlight(wrap, layout, relEdges) {
  const adj = new Map();
  const link = (a, b) => {
    if (!adj.has(a)) adj.set(a, new Set());
    adj.get(a).add(b);
  };
  for (const e of layout.parentEdges) { link(e.from, e.to); link(e.to, e.from); }
  for (const e of relEdges) { link(e.from, e.to); link(e.to, e.from); }

  const nodeEls = [...wrap.querySelectorAll('.graph-node')];
  const edgeEls = [...wrap.querySelectorAll('.graph-edge')];
  const byId = {};
  for (const el of nodeEls) byId[el.dataset.id] = el;

  const clear = () => {
    wrap.classList.remove('highlighting');
    for (const el of nodeEls) el.classList.remove('hl');
    for (const el of edgeEls) el.classList.remove('hl');
  };

  for (const el of nodeEls) {
    el.addEventListener('mouseenter', () => {
      const id = el.dataset.id;
      wrap.classList.add('highlighting');
      el.classList.add('hl');
      for (const nid of adj.get(id) || []) byId[nid]?.classList.add('hl');
      for (const ed of edgeEls) {
        if (ed.dataset.a === id || ed.dataset.b === id) ed.classList.add('hl');
      }
    });
    el.addEventListener('mouseleave', clear);
  }
}

function buildGraphLegend(layout, relEdges) {
  const present = new Set(relEdges.map((e) => e.type));
  const rows = [];
  if (layout.parentEdges.length) {
    rows.push('<div class="gl-row"><span class="gl-line parent"></span>Epic → ticket</div>');
  }
  for (const type of ['blocks', 'relates_to', 'duplicates']) {
    if (!present.has(type)) continue;
    const st = RELATION_STYLE[type];
    rows.push(
      `<div class="gl-row"><span class="gl-line dashed" style="color:${st.color}"></span>${st.label}</div>`
    );
  }
  const legend = document.createElement('div');
  legend.className = 'graph-legend';
  legend.innerHTML = rows.join('') || '<div class="gl-row">No relationships yet</div>';
  return legend;
}

function buildGraphZoom() {
  const bar = document.createElement('div');
  bar.className = 'graph-zoom';
  bar.innerHTML = `
    <button type="button" data-z="out" title="Zoom out">−</button>
    <button type="button" data-z="reset" title="Reset zoom">⊙</button>
    <button type="button" data-z="in" title="Zoom in">+</button>
  `;
  const setScale = (next) => {
    state.graphScale = Math.min(GRAPH.MAX_SCALE, Math.max(GRAPH.MIN_SCALE, next));
    drawGraph();
  };
  bar.querySelector('[data-z="out"]').addEventListener('click', () => setScale(state.graphScale - 0.2));
  bar.querySelector('[data-z="reset"]').addEventListener('click', () => setScale(1));
  bar.querySelector('[data-z="in"]').addEventListener('click', () => setScale(state.graphScale + 0.2));
  return bar;
}

/* ------------- history view ------------- */

const HISTORY_PAGE_SIZE = 100;

async function renderHistory() {
  if (!state.currentWorkspace) return renderEmpty();
  const root = document.getElementById('board');
  root.style.display = 'block';
  // Render shell first so the empty/loading state shows immediately.
  root.innerHTML = `
    <div class="history">
      <div class="history-head">
        <h1>History</h1>
        <button type="button" class="btn ghost" id="history-back">← Back to board</button>
      </div>
      <p class="history-sub">Every change to every ticket in this workspace, newest first.</p>
      <div class="history-list" id="history-list">
        <div class="history-loading">Loading…</div>
      </div>
      <div class="history-foot">
        <button type="button" class="btn ghost" id="history-more" hidden>Load older</button>
      </div>
    </div>
  `;
  root.querySelector('#history-back').addEventListener('click', async () => {
    state.view = 'board';
    await refresh();
  });
  try {
    const data = await api(`/api/history?limit=${HISTORY_PAGE_SIZE}`);
    state.history = data;
    paintHistoryList(data.entries);
  } catch (e) {
    root.querySelector('#history-list').innerHTML =
      `<div class="history-empty">Couldn't load history: ${escapeHtml(e.message)}</div>`;
  }

  const moreBtn = root.querySelector('#history-more');
  if ((state.history?.entries?.length || 0) >= HISTORY_PAGE_SIZE) {
    moreBtn.hidden = false;
    moreBtn.addEventListener('click', async () => {
      const last = state.history.entries[state.history.entries.length - 1];
      if (!last) return;
      moreBtn.disabled = true;
      try {
        const older = await api(
          `/api/history?limit=${HISTORY_PAGE_SIZE}&before=${encodeURIComponent(last.changed_at)}&beforeId=${encodeURIComponent(last.id)}`
        );
        state.history.entries.push(...older.entries);
        paintHistoryList(state.history.entries);
        if (older.entries.length < HISTORY_PAGE_SIZE) moreBtn.hidden = true;
      } catch (e) {
        toast(e.message);
      } finally {
        moreBtn.disabled = false;
      }
    });
  }
}

function paintHistoryList(entries) {
  const list = document.getElementById('history-list');
  if (!list) return;
  if (!entries.length) {
    list.innerHTML = `<div class="history-empty">No history yet. Make a change to a ticket and it'll show up here.</div>`;
    return;
  }
  list.innerHTML = entries.map(historyRowHtml).join('');
  list.querySelectorAll('.history-row').forEach((row) => {
    row.addEventListener('click', () => {
      const id = row.dataset.ticket;
      if (id) openDrawer(id);
    });
  });
}

function historyRowHtml(h) {
  const when = relativeTime(h.changed_at);
  const who = h.changed_by ? escapeHtml(h.changed_by) : 'unknown';
  const ttype = (h.ticket_type || 'story').toLowerCase();
  const field = escapeHtml(h.field);
  const oldV = formatHistoryValue(h.old_value);
  const newV = formatHistoryValue(h.new_value);
  return `
    <div class="history-row" data-ticket="${escapeHtml(h.ticket_id)}" title="${escapeHtml(h.changed_at)}">
      <span class="badge ${ttype}">${ttype}</span>
      <span class="history-tid">${escapeHtml(h.ticket_id)}</span>
      <span class="history-title">${escapeHtml(h.ticket_title || '')}</span>
      <span class="history-change">
        <span class="history-field">${field}</span>
        ${h.old_value != null ? `<span class="history-old">${oldV}</span><span class="history-arrow">→</span>` : ''}
        <span class="history-new">${newV}</span>
      </span>
      <span class="history-who">@${who}</span>
      <span class="history-when">${escapeHtml(when)}</span>
    </div>
  `;
}

function formatHistoryValue(v) {
  if (v == null || v === '') return '<span class="history-empty-val">∅</span>';
  const s = String(v);
  const trimmed = s.length > 80 ? s.slice(0, 77) + '…' : s;
  return `<span class="history-val">${escapeHtml(trimmed)}</span>`;
}

function relativeTime(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return iso;
  const diff = Math.max(0, Date.now() - then);
  const s = Math.floor(diff / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

/* ------------- live action feed (large screens) ------------- */
// SCP-67: floating column of SSE-driven activity toasts. Distinct from the
// alert toast() helper above — this is an ambient feed, not a notification.

const LIVE_FEED_MAX = 4;
const LIVE_FEED_TTL_MS = 5000;

function ensureLiveFeedRoot() {
  let root = document.getElementById('live-feed');
  if (!root) {
    root = document.createElement('div');
    root.id = 'live-feed';
    root.setAttribute('aria-live', 'polite');
    root.setAttribute('aria-label', 'Live activity feed');
    document.body.appendChild(root);
  }
  return root;
}

// Highest ticket_history.id and ticket_comments.id we've already shown a
// toast for. Used to de-dupe rich events that the hub may emit twice (once
// directly from the in-process write, once via the fs-watch replay path).
let lastLiveFeedHistoryId = 0;
let lastLiveFeedCommentId = 0;

function pushLiveFeed(detail) {
  if (!detail || !detail.type) return;
  // Drop workspace lifecycle events — they aren't ticket activity.
  if (detail.type.startsWith('workspace.')) return;
  // 'external' is the catch-all fs-watch envelope for changes the hub can't
  // classify (data_version moved but no new history/comment row). Don't toast
  // — we'd be guessing at what happened.
  if (detail.type === 'external') return;
  // Track historyId/commentId so we can de-dupe rich events that arrive both
  // via direct in-process emit and (rarely) via the fs-watch replay path.
  if (typeof detail.historyId === 'number') {
    if (detail.historyId <= lastLiveFeedHistoryId) return;
    lastLiveFeedHistoryId = Math.max(lastLiveFeedHistoryId, detail.historyId);
  }
  if (typeof detail.commentId === 'number') {
    if (detail.commentId <= lastLiveFeedCommentId) return;
    lastLiveFeedCommentId = Math.max(lastLiveFeedCommentId, detail.commentId);
  }
  // Only render activity that belongs to the current workspace (the server
  // already filters by workspace on subscribe, but be defensive).
  if (
    detail.workspace &&
    state.currentWorkspace &&
    detail.workspace !== state.currentWorkspace
  ) return;

  const root = ensureLiveFeedRoot();
  const el = document.createElement('div');
  el.className = 'live-toast';
  const icon = liveFeedIcon(detail.type);
  const desc = liveFeedDescription(detail);
  const tid = detail.id || detail.ticket || '';
  const clickable = tid && /^[A-Z][A-Z0-9]*-\d+$/.test(tid);
  if (clickable) {
    el.classList.add('clickable');
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
    el.setAttribute('title', `Open ${tid}`);
  }
  // Single-line layout: [icon] [ID] [desc — flexes + truncates].
  // Drop the separate "now" label and the absolute open button; the whole
  // row is the click target for ticket toasts.
  el.innerHTML = `
    <span class="live-icon" aria-hidden="true">${icon}</span>
    ${tid ? `<span class="live-id">${escapeHtml(tid)}</span>` : ''}
    <span class="live-desc">${escapeHtml(desc)}</span>
  `;
  if (clickable) {
    const open = () => openDrawer(tid);
    el.addEventListener('click', open);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
  }
  root.appendChild(el);
  // Cap stacked toasts.
  while (root.children.length > LIVE_FEED_MAX) {
    root.firstElementChild.remove();
  }
  // Enter transition.
  requestAnimationFrame(() => el.classList.add('show'));

  // Auto-dismiss with hover-pause-and-resume. Bug before: mouseenter cleared
  // the timer once and never re-armed, so any accidental hover pinned the
  // toast forever (especially painful on narrow viewports where toasts cover
  // the board).
  let timer = null;
  const dismiss = () => {
    if (!el.isConnected) return;
    el.classList.remove('show');
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 240);
  };
  const arm = (ms) => { clearTimeout(timer); timer = setTimeout(dismiss, ms); };
  arm(LIVE_FEED_TTL_MS);
  el.addEventListener('mouseenter', () => clearTimeout(timer));
  el.addEventListener('mouseleave', () => arm(LIVE_FEED_TTL_MS));
}

function liveFeedIcon(type) {
  if (type.startsWith('ticket.created')) return '✦';
  if (type.startsWith('ticket.deleted')) return '×';
  if (type === 'comment.added' || type.startsWith('comment.')) return '💬';
  if (type.startsWith('relation.')) return '↔';
  if (type.startsWith('project.')) return '◆';
  return '•';
}

function liveFeedDescription(detail) {
  const t = detail.type || 'change';
  switch (t) {
    case 'ticket.created': return 'created';
    case 'ticket.updated': {
      // Rich events (from in-process and from fs-watch replay) carry the
      // field/new_value tuple so we can describe the change concretely.
      if (detail.field) {
        const v = detail.new_value;
        const o = detail.old_value;
        if (detail.field === 'status') return o ? `${o} → ${v}` : `status: ${v}`;
        if (detail.field === 'priority') return o ? `priority ${o} → ${v}` : `priority: ${v}`;
        if (detail.field === 'assignee') return v ? `assigned ${v}` : 'unassigned';
        if (detail.field === 'branch') return v ? `branch ${v}` : 'branch cleared';
        if (detail.field === 'pr_url') return v ? 'PR linked' : 'PR cleared';
        if (detail.field === 'parent_id') return v ? `parent → ${v}` : 'detached from epic';
        if (detail.field === 'title') return 'renamed';
        if (detail.field === 'description') return 'description edited';
        if (detail.field === 'labels') return 'labels changed';
        return `${detail.field} changed`;
      }
      if (detail.fields && Array.isArray(detail.fields) && detail.fields.length) {
        return `updated ${detail.fields.join(', ')}`;
      }
      return 'updated';
    }
    case 'ticket.deleted': return 'deleted';
    case 'comment.added': return 'new comment';
    case 'relation.added': return 'relation added';
    case 'relation.removed': return 'relation removed';
    case 'project.created': return 'project created';
    case 'project.updated': return 'project updated';
    default: return t;
  }
}

/* ------------- utils ------------- */

// Minimal, safe markdown renderer. Escapes HTML first so any raw tags in the
// source become inert text before transforms run — keeping the local-first
// app dependency-free without opening an XSS hole.
function renderMarkdown(src) {
  const codeBlocks = [];
  let s = String(src ?? '').replace(/\r\n?/g, '\n');

  // Pull fenced code blocks out first so their contents aren't transformed.
  s = s.replace(/```([^\n`]*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const i = codeBlocks.push({lang: lang.trim(), code}) - 1;
    return `\n§CB${i}§\n`;
  });

  s = escapeHtml(s);
  // The replacer's literal § survives escapeHtml; this isolates the
  // placeholder on its own line so it becomes its own block, not part of a
  // surrounding paragraph (which would yield <p><pre>…</pre></p>).

  // Inline code (after escape so backticked HTML stays literal).
  s = s.replace(/`([^`\n]+)`/g, (_, c) => `<code>${c}</code>`);

  // Links [text](url) — only http(s)/mailto/relative.
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, href) => {
    const safe = /^(https?:|mailto:|\/|#|\.\/|\.\.\/)/i.test(href);
    if (!safe) return `${text} (${href})`;
    return `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  });

  // Bold / italic.
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');

  // Block parse line-by-line.
  const lines = s.split('\n');
  const out = [];
  let i = 0;
  const flushPara = (buf) => {
    if (!buf.length) return;
    // CommonMark: single newlines fold to a space; only a trailing "  " on a
    // line forces a hard <br>.
    const joined = buf
      .map((l, idx) => (idx < buf.length - 1 && /  $/.test(l) ? l.replace(/ +$/, '') + '<br>' : l))
      .join(' ')
      .replace(/<br> /g, '<br>');
    out.push(`<p>${joined}</p>`);
  };
  const isBlockStart = (l) => {
    const t = l.trim();
    return (
      !t ||
      /^§CB\d+§$/.test(t) ||
      /^(#{1,6})\s+/.test(t) ||
      /^[-*+]\s+/.test(t) ||
      /^\d+\.\s+/.test(t) ||
      /^&gt;\s?/.test(t) ||
      /^(---|\*\*\*|___)\s*$/.test(t)
    );
  };
  // For a list, a continuation line is non-empty, doesn't start a new block,
  // and is indented (matches loose-list convention). We join it onto the
  // previous item with a space so wrapped prose stays a single <li>.
  const collectList = (re) => {
    const items = [];
    while (i < lines.length && re.test(lines[i].trim())) {
      items.push(lines[i].trim().replace(re, ''));
      i++;
      while (i < lines.length && /^\s+\S/.test(lines[i]) && !isBlockStart(lines[i])) {
        items[items.length - 1] += ' ' + lines[i].trim();
        i++;
      }
    }
    return items;
  };
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) { i++; continue; }
    if (/^§CB\d+§$/.test(trimmed)) { out.push(trimmed); i++; continue; }
    const h = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (h) { out.push(`<h${h[1].length}>${h[2]}</h${h[1].length}>`); i++; continue; }
    if (/^(---|\*\*\*|___)\s*$/.test(trimmed)) { out.push('<hr>'); i++; continue; }
    if (/^&gt;\s?/.test(trimmed)) {
      const buf = [];
      while (i < lines.length && /^&gt;\s?/.test(lines[i].trim())) {
        buf.push(lines[i].trim().replace(/^&gt;\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${buf.join('<br>')}</blockquote>`);
      continue;
    }
    if (/^[-*+]\s+/.test(trimmed)) {
      const items = collectList(/^[-*+]\s+/);
      out.push(`<ul>${items.map((x) => `<li>${x}</li>`).join('')}</ul>`);
      continue;
    }
    if (/^\d+\.\s+/.test(trimmed)) {
      const items = collectList(/^\d+\.\s+/);
      out.push(`<ol>${items.map((x) => `<li>${x}</li>`).join('')}</ol>`);
      continue;
    }
    // Paragraph: collect contiguous non-blank, non-block lines.
    const buf = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) {
      buf.push(lines[i]);
      i++;
    }
    flushPara(buf);
  }

  let html = out.join('\n');
  html = html.replace(/§CB(\d+)§/g, (_, idx) => {
    const {lang, code} = codeBlocks[Number(idx)];
    return `<pre><code${lang ? ` class="lang-${escapeHtml(lang)}"` : ''}>${escapeHtml(code)}</code></pre>`;
  });
  return html;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

window.__scope = { state, api };

// Track the topbar's actual rendered height so the sticky lane headers can sit
// just below it even when the topbar wraps onto multiple rows. Also runs a
// collision-based compactor that hides labels only when the spacer would
// otherwise go to zero (vs. the old width-based @media queries, which hid
// labels eagerly and left a wide empty gap between the left and right
// clusters — see git history for the "stop collapsing before colliding" fix).
(() => {
  const topbar = document.querySelector('.topbar');
  if (!topbar) return;

  const spacer = topbar.querySelector('.topbar-spacer');
  // Minimum spacer width before we trigger the next compaction level. A few
  // pixels of slack keeps the right cluster from kissing the left cluster
  // and looking accidentally crowded.
  const MIN_SLACK = 12;

  // Three escalating levels: lose the lowest-value labels first.
  //   1: auto-scroll text + "New ticket" text (small, frequent gestures —
  //      the toggle and "+" icon read fine on their own).
  //   2: view-trigger label + caret (the ≡ icon already says "menu").
  //   3: breadcrumb workspace name (replaced by just the brand mark).
  const LEVELS = ['compact-1', 'compact-2', 'compact-3'];

  const measureSlack = () =>
    spacer ? spacer.getBoundingClientRect().width : Number.POSITIVE_INFINITY;

  const fit = () => {
    for (const cls of LEVELS) topbar.classList.remove(cls);
    // Force a layout read after the resets so the next measurement reflects
    // the uncompacted width.
    void topbar.offsetWidth;

    for (const cls of LEVELS) {
      if (measureSlack() >= MIN_SLACK) break;
      topbar.classList.add(cls);
      void topbar.offsetWidth;
    }
  };

  const setH = () => {
    document.documentElement.style.setProperty(
      '--topbar-h', topbar.offsetHeight + 'px'
    );
    fit();
  };
  setH();
  // Observe both the topbar (catches inner content changes, e.g. workspace
  // name updates) and the viewport (handles window resizes — topbar's own
  // size only changes via flex, not via vw).
  new ResizeObserver(setH).observe(topbar);
  new ResizeObserver(setH).observe(document.documentElement);
})();

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refresh().catch(() => {});
});

init().catch((e) => {
  document.body.innerHTML = `<pre style="padding:24px;color:#f85149">${escapeHtml(e.stack || e.message)}</pre>`;
});
