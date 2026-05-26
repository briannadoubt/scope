/* scope — local web UI */

const state = {
  meta: null,
  workspaces: [],
  currentWorkspace: localStorage.getItem('scope.workspace') || null,
  projects: [],
  currentProject: null,
  epicFilter: '',
  view: 'board', // 'board' | 'overview' | 'history'
  history: null, // { entries: [...] } for the history view
  board: null,
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
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

/* ------------- init ------------- */

async function init() {
  state.meta = await api('/api/meta');
  await reloadWorkspaces();
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
    renderEmpty('No workspaces attached. Run `scope serve` in a repo with a .scope/ directory.');
    return;
  }
  await reloadProjects();
  if (state.projects.length === 0) {
    updateBreadcrumb();
    openProjectModal();
  } else {
    state.currentProject = state.projects[0].id;
    updateBreadcrumb();
    await refresh();
  }
}

async function reloadWorkspaces() {
  state.workspaces = await api('/api/workspaces');
  updateBreadcrumb();
}

async function reloadProjects() {
  state.projects = await api('/api/projects');
  updateBreadcrumb();
}

function updateBreadcrumb() {
  const w = state.workspaces.find((x) => x.id === state.currentWorkspace);
  const p = state.projects.find((x) => x.id === state.currentProject);
  const wsEl = document.getElementById('bc-workspace');
  const pjEl = document.getElementById('bc-project');
  if (!wsEl || !pjEl) return;
  wsEl.textContent = w ? w.label : (state.workspaces.length ? 'Select workspace' : 'No workspaces');
  pjEl.textContent = p ? `${p.key} · ${p.name}` : (state.projects.length ? 'Select project' : 'No project');
  pjEl.classList.toggle('muted', !p);
  updateViewTrigger();
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
  if (!state.currentProject) return renderEmpty();
  await loadEpicsForFilter();
  if (state.view === 'overview') return renderOverview();
  if (state.view === 'history') return renderHistory();
  const oldPositions = captureCardPositions();
  const oldBoard = state.board;
  await loadBoard();
  renderBoard();
  animateCardMoves(oldPositions);
  burstConfettiForNewDone(oldBoard, state.board);
  if (state.autoScroll) scrollToMovedCards(findMovedTicketIds(oldBoard, state.board), 380);
}

async function loadEpicsForFilter() {
  const tickets = await api(
    `/api/tickets?project=${encodeURIComponent(state.currentProject)}&type=epic`
  );
  state.allEpics = tickets;
  // If the filter points at an epic that no longer exists, clear it.
  if (state.epicFilter && !tickets.some((t) => t.id === state.epicFilter)) {
    state.epicFilter = '';
  }
  updateViewTrigger();
}

async function loadBoard() {
  const params = new URLSearchParams({ project: state.currentProject });
  if (state.epicFilter) params.set('epic', state.epicFilter);
  state.board = await api(`/api/board?${params}`);
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
  const pop = openPopover(anchor, {align: 'left', width: 520});
  pop.classList.add('popover-breadcrumb');
  pop.innerHTML = `
    <div class="pane pane-workspaces">
      <div class="pane-head">Workspaces</div>
      <div class="pane-list" id="bc-ws-list"></div>
      <button type="button" class="pane-foot" id="bc-attach">＋ Attach workspace…</button>
    </div>
    <div class="pane pane-projects">
      <div class="pane-head">Projects</div>
      <div class="pane-list" id="bc-pj-list"></div>
    </div>
  `;
  const wsList = pop.querySelector('#bc-ws-list');
  const pjList = pop.querySelector('#bc-pj-list');
  let hoverWorkspace = state.currentWorkspace;

  const renderWsList = () => {
    wsList.innerHTML = '';
    for (const w of state.workspaces) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'pane-item';
      if (w.id === state.currentWorkspace) item.classList.add('active');
      if (w.id === hoverWorkspace) item.classList.add('hover');
      item.innerHTML = `
        <span class="pane-item-label">${escapeHtml(w.label)}</span>
        <span class="pane-item-sub">${escapeHtml(w.scope_dir)}</span>
      `;
      item.addEventListener('mouseenter', () => {
        hoverWorkspace = w.id;
        renderWsList();
        renderPjList();
      });
      item.addEventListener('click', async () => {
        if (w.id !== state.currentWorkspace) {
          state.currentWorkspace = w.id;
          localStorage.setItem('scope.workspace', w.id);
          state.epicFilter = '';
          state.currentProject = null;
          state.view = 'board';
          await reloadProjects();
          if (state.projects.length) state.currentProject = state.projects[0].id;
          updateBreadcrumb();
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

  const renderPjList = async () => {
    let projects = state.projects;
    if (hoverWorkspace && hoverWorkspace !== state.currentWorkspace) {
      try {
        projects = await api(`/api/projects?workspace=${encodeURIComponent(hoverWorkspace)}`);
      } catch { projects = []; }
    }
    pjList.innerHTML = '';
    if (projects.length === 0) {
      pjList.innerHTML = '<div class="pane-empty">No projects in this workspace.</div>';
      return;
    }
    for (const p of projects) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'pane-item';
      if (p.id === state.currentProject && hoverWorkspace === state.currentWorkspace) {
        item.classList.add('active');
      }
      item.innerHTML = `
        <span class="pane-item-label"><span class="pkey">${escapeHtml(p.key)}</span> ${escapeHtml(p.name)}</span>
        ${p.description ? `<span class="pane-item-sub">${escapeHtml(p.description)}</span>` : ''}
      `;
      item.addEventListener('click', async () => {
        if (hoverWorkspace !== state.currentWorkspace) {
          state.currentWorkspace = hoverWorkspace;
          localStorage.setItem('scope.workspace', hoverWorkspace);
          await reloadProjects();
        }
        state.currentProject = p.id;
        state.epicFilter = '';
        state.view = 'board';
        updateBreadcrumb();
        closePopover();
        await refresh();
      });
      pjList.appendChild(item);
    }
  };

  pop.querySelector('#bc-attach').addEventListener('click', () => {
    closePopover();
    openAddWorkspaceModal();
  });

  renderWsList();
  renderPjList();
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
  pop.innerHTML = `
    <button type="button" class="menu-item" data-act="refresh"><span class="mi-icon">↻</span> Refresh</button>
    <button type="button" class="menu-item" data-act="overview"><span class="mi-icon">☰</span> ${state.view === 'overview' ? 'Back to board' : 'Project overview'}</button>
    <button type="button" class="menu-item" data-act="history"><span class="mi-icon">⏱</span> ${state.view === 'history' ? 'Back to board' : 'History'}</button>
    <div class="menu-sep"></div>
    <button type="button" class="menu-item" data-act="new-project"><span class="mi-icon">＋</span> New project</button>
  `;
  pop.querySelectorAll('.menu-item').forEach((b) => {
    b.addEventListener('click', async () => {
      const act = b.dataset.act;
      closePopover();
      if (act === 'refresh') { flashIndicator('tick'); await repairHubConnection(); }
      else if (act === 'overview') {
        state.view = state.view === 'overview' ? 'board' : 'overview';
        await refresh();
      }
      else if (act === 'history') {
        state.view = state.view === 'history' ? 'board' : 'history';
        await refresh();
      }
      else if (act === 'new-project') openProjectModal();
    });
  });
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
  try {
    const r = await fetch('/api/meta', { cache: 'no-store' });
    alive = r.ok;
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
  // Hub is healthy — make sure SSE is connected (it may have silently
  // dropped) and refresh the visible state.
  if (!eventSource || eventSource.readyState !== 1) {
    if (eventSource) { try { eventSource.close(); } catch {} }
    eventSource = null;
    startEventStream();
  }
  await refresh();
}

function startEventStream() {
  if (eventSource) eventSource.close();
  const params = new URLSearchParams();
  if (state.currentWorkspace) params.set('workspace', state.currentWorkspace);
  const url = '/events' + (params.toString() ? `?${params}` : '');
  eventSource = new EventSource(url);
  eventSource.addEventListener('open', () => setIndicator(null));
  eventSource.addEventListener('error', () => {
    setIndicator('disconnected');
    // EventSource will keep retrying internally, but if the hub died and
    // a new process needs to be promoted, the server-side watchdog runs on
    // its own timer (~10s). Do an active repair check shortly after the
    // first error so the UI converges faster than EventSource's default
    // exponential backoff would.
    scheduleAutoRepair();
  });
  eventSource.addEventListener('hello', () => setIndicator(null));
  eventSource.addEventListener('change', async (e) => {
    const detail = safeParse(e.data);
    if (
      detail?.type === 'workspace.attached' ||
      detail?.type === 'workspace.detached'
    ) {
      // Refresh the breadcrumb without dropping the user's selection.
      await reloadWorkspaces();
      if (state.currentWorkspace && state.workspaces.find((w) => w.id === state.currentWorkspace)) {
        updateBreadcrumb();
      } else if (state.workspaces.length) {
        // Our workspace went away — fall back to the first one.
        state.currentWorkspace = state.workspaces[0].id;
        localStorage.setItem('scope.workspace', state.currentWorkspace);
        await reloadProjects();
        if (state.projects.length) state.currentProject = state.projects[0].id;
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
    if (applyPaused()) {
      setIndicator('paused');
      return;
    }
    if (!state.currentProject) return;
    try {
      const params = new URLSearchParams({ project: state.currentProject });
      if (state.epicFilter) params.set('epic', state.epicFilter);
      const board = await api(`/api/board?${params}`);
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
  root.innerHTML = '';
  const restoreScroll = () => {
    if (savedWindowY) window.scrollTo({ top: savedWindowY, behavior: 'instant' });
    for (const lane of document.querySelectorAll('.lane-columns')) {
      const key = lane.closest('.lane')?.dataset.group;
      if (key != null && savedLaneScroll.has(key)) lane.scrollLeft = savedLaneScroll.get(key);
    }
  };
  if (!state.board) { restoreScroll(); return; }

  if (state.groupBy === 'none') {
    root.classList.remove('swim');
    renderColumnRow(root, state.board.buckets, { showHeader: true });
    restoreScroll();
    return;
  }

  root.classList.add('swim');
  const lanes = buildLanes(state.board, state.groupBy);
  for (const lane of lanes) {
    const section = document.createElement('section');
    section.className = 'lane';
    section.dataset.group = lane.key;
    if (lane.status) section.dataset.status = lane.status;
    if (state.collapsedLanes.has(lane.key)) section.classList.add('collapsed');

    const head = document.createElement('header');
    head.className = 'lane-head';
    const isEpic = lane.kind === 'epic';
    head.innerHTML = `
      <span class="lane-chevron">▾</span>
      ${isEpic ? '<span class="lane-epic-badge">EPIC</span>' : ''}
      <span class="lane-title">${escapeHtml(lane.label)}</span>
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
    root.appendChild(section);
  }
  restoreScroll();
}

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
  // Exception: when the user explicitly filtered to one epic, don't hide it
  // — otherwise jumping to a done epic from the overview shows nothing.
  const hideDone =
    groupBy === 'epic' && !state.showDoneEpics && !state.epicFilter;
  const isHiddenEpicId = (id) => hideDone && epicById[id]?.status === 'done';

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
    const g = ensure(key, label, extras);
    if (g.buckets[t.status]) {
      g.buckets[t.status].push(t);
      g.count++;
    }
  }

  // Always include a lane for every epic, even if it has no children, so
  // empty epics still appear as planning rows. Skip done ones when filtered.
  if (groupBy === 'epic') {
    for (const e of Object.values(epicById)) {
      if (hideDone && e.status === 'done') continue;
      ensure(e.id, `${e.id} · ${e.title}`, {
        kind: 'epic',
        epicId: e.id,
        status: e.status,
        meta: e.status,
        progress: epicProgressFromTickets(e.id, allTickets),
      });
    }
  }

  return [...groups.values()].sort(laneSorter(groupBy));
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
      return {
        key: e.id,
        label: `${e.id} · ${e.title}`,
        extras: {
          kind: 'epic',
          epicId: e.id,
          status: e.status,
          meta: e.status,
          progress: epicProgressFromTickets(e.id, Object.values(epicById).concat()),
        },
      };
    }
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

function epicProgressFromTickets(epicId, allTickets) {
  let total = 0, done = 0;
  for (const t of allTickets) {
    if (t.parent_id === epicId) {
      total++;
      if (t.status === 'done') done++;
    }
  }
  return { total, done, percent: total ? Math.round((done / total) * 100) : 0 };
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
  // epic / assignee / default: '__none' sinks to the bottom, others alpha
  return (a, b) => {
    if (a.key === '__none' && b.key !== '__none') return 1;
    if (b.key === '__none' && a.key !== '__none') return -1;
    return String(a.label).localeCompare(String(b.label));
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
    p.href = t.pr_url;
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
      await api(`/api/tickets/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: { status, __by: 'ui' },
      });
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
                   value="${t.parent_id ?? ''}" />
          </div>`
        : ''
    }
    <div class="row">
      <span class="label">Branch</span>
      <input type="text" data-field="branch" value="${t.branch ?? ''}" placeholder="feat/foo" />
    </div>
    <div class="row">
      <span class="label">PR URL</span>
      <input type="url" data-field="pr_url" value="${t.pr_url ?? ''}" placeholder="https://github.com/..." />
    </div>
    <div class="row">
      <span class="label">Assignee</span>
      <input type="text" data-field="assignee" value="${t.assignee ?? ''}" placeholder="handle" />
    </div>
    <div class="row">
      <span class="label">Labels</span>
      <input type="text" data-field="labels" value="${(t.labels || []).join(', ')}" placeholder="frontend, infra" />
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
  const root = document.getElementById('modal-root');
  root.innerHTML = `<div class="modal-backdrop"><div class="modal">${html}</div></div>`;
  root.querySelector('.modal-backdrop').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeModal();
  });
  return root.querySelector('.modal');
}
function closeModal() {
  document.getElementById('modal-root').innerHTML = '';
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
      await reloadProjects();
      state.currentProject = state.projects[0]?.id || null;
      updateBreadcrumb();
      await refresh();
    } catch (e) {
      modal.querySelector('#w-err').textContent = e.message;
    }
  });
}

function openProjectModal() {
  const modal = openModal(`
    <h3>New project</h3>
    <label>ID (lowercase, kebab) <input id="p-id" placeholder="my-app" /></label>
    <label>Key (2-10 uppercase) <input id="p-key" placeholder="APP" /></label>
    <label>Name <input id="p-name" placeholder="My App" /></label>
    <label>Description <input id="p-desc" placeholder="optional" /></label>
    <label>Overview (goals, architecture)
      <textarea id="p-overview" placeholder="Markdown supported"></textarea>
    </label>
    <div class="error" id="p-err"></div>
    <div class="modal-actions">
      <button class="btn ghost" id="p-cancel">Cancel</button>
      <button class="btn primary" id="p-create">Create</button>
    </div>
  `);
  modal.querySelector('#p-cancel').addEventListener('click', closeModal);
  modal.querySelector('#p-create').addEventListener('click', async () => {
    const body = {
      id: modal.querySelector('#p-id').value.trim(),
      key: modal.querySelector('#p-key').value.trim().toUpperCase(),
      name: modal.querySelector('#p-name').value.trim(),
      description: modal.querySelector('#p-desc').value.trim(),
      overview: modal.querySelector('#p-overview').value,
    };
    try {
      const p = await api('/api/projects', { method: 'POST', body });
      closeModal();
      await reloadProjects();
      state.currentProject = p.id;
      updateBreadcrumb();
      await refresh();
    } catch (e) {
      modal.querySelector('#p-err').textContent = e.message;
    }
  });
}

async function openTicketModal({ status = 'backlog', parent = '' } = {}) {
  if (!state.currentProject) return toast('Create a project first.', { variant: 'info' });
  const epics = await api(
    `/api/tickets?project=${encodeURIComponent(state.currentProject)}&type=epic`
  );
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
      projectIdOrKey: state.currentProject,
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
  const p = await api(`/api/projects/${encodeURIComponent(state.currentProject)}`);
  const root = document.getElementById('board');
  root.style.display = 'block';
  root.innerHTML = `
    <div class="overview">
      <div><span class="key">${p.key}</span></div>
      <h1>${escapeHtml(p.name)}</h1>
      ${p.description ? `<div class="description">${escapeHtml(p.description)}</div>` : ''}
      ${
        p.overview && p.overview.trim()
          ? `<div class="overview-body markdown">${renderMarkdown(p.overview)}</div>`
          : '<div class="overview-body" style="color: var(--text-dim)">No overview yet. Use <code>scope project edit ' +
            p.key +
            ' --edit</code> to add one.</div>'
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

/* ------------- history view ------------- */

const HISTORY_PAGE_SIZE = 100;

async function renderHistory() {
  if (!state.currentProject) return renderEmpty();
  const root = document.getElementById('board');
  root.style.display = 'block';
  // Render shell first so the empty/loading state shows immediately.
  root.innerHTML = `
    <div class="history">
      <div class="history-head">
        <h1>History</h1>
        <button type="button" class="btn ghost" id="history-back">← Back to board</button>
      </div>
      <p class="history-sub">Every change to every ticket in this project, newest first.</p>
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
    const data = await api(
      `/api/history?project=${encodeURIComponent(state.currentProject)}&limit=${HISTORY_PAGE_SIZE}`
    );
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
          `/api/history?project=${encodeURIComponent(state.currentProject)}&limit=${HISTORY_PAGE_SIZE}&before=${encodeURIComponent(last.changed_at)}&beforeId=${encodeURIComponent(last.id)}`
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

const LIVE_FEED_MIN_WIDTH = 1280;
const LIVE_FEED_MAX = 6;
const LIVE_FEED_TTL_MS = 6000;

function isLiveFeedEnabled() {
  return window.innerWidth >= LIVE_FEED_MIN_WIDTH;
}

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

function pushLiveFeed(detail) {
  if (!detail || !detail.type) return;
  if (!isLiveFeedEnabled()) return;
  // Drop workspace lifecycle events — they aren't ticket activity.
  if (detail.type.startsWith('workspace.')) return;
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
  el.innerHTML = `
    <span class="live-icon" aria-hidden="true">${icon}</span>
    <div class="live-body">
      ${tid ? `<div class="live-id">${escapeHtml(tid)}</div>` : ''}
      <div class="live-desc">${escapeHtml(desc)}</div>
    </div>
    <span class="live-when">now</span>
    ${tid && /^[A-Z][A-Z0-9]*-\d+$/.test(tid) ? `<button type="button" class="live-open" title="Open ${escapeHtml(tid)}" aria-label="Open ${escapeHtml(tid)}">↗</button>` : ''}
  `;
  const openBtn = el.querySelector('.live-open');
  if (openBtn) {
    openBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openDrawer(tid);
    });
  }
  root.appendChild(el);
  // Cap stacked toasts.
  while (root.children.length > LIVE_FEED_MAX) {
    root.firstElementChild.remove();
  }
  // Enter transition.
  requestAnimationFrame(() => el.classList.add('show'));
  // Auto-dismiss.
  const dismiss = () => {
    if (!el.isConnected) return;
    el.classList.remove('show');
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 240);
  };
  const timer = setTimeout(dismiss, LIVE_FEED_TTL_MS);
  el.addEventListener('mouseenter', () => clearTimeout(timer), { once: true });
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
// just below it even when the topbar wraps onto multiple rows.
(() => {
  const topbar = document.querySelector('.topbar');
  if (!topbar) return;
  const setH = () => {
    document.documentElement.style.setProperty(
      '--topbar-h', topbar.offsetHeight + 'px'
    );
  };
  setH();
  new ResizeObserver(setH).observe(topbar);
})();

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refresh().catch(() => {});
});

init().catch((e) => {
  document.body.innerHTML = `<pre style="padding:24px;color:#f85149">${escapeHtml(e.stack || e.message)}</pre>`;
});
