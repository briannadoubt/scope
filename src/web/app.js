/* scope — local web UI */

const state = {
  meta: null,
  workspaces: [],
  currentWorkspace: localStorage.getItem('scope.workspace') || null,
  projects: [],
  currentProject: null,
  epicFilter: '',
  view: 'board', // 'board' | 'overview'
  board: null,
  drawerTicketId: null,
  groupBy: localStorage.getItem('scope.groupBy') || 'none',
  showDoneEpics: localStorage.getItem('scope.showDoneEpics') === 'true',
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
    renderEmpty('No workspaces attached. Start a `scope mcp` somewhere or attach via the API.');
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
  await loadBoard();
  renderBoard();
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

/* ------------- topbar ------------- */

function bindTopbar() {
  document.getElementById('new-ticket').addEventListener('click', () => openTicketModal());
  document.getElementById('breadcrumb-trigger').addEventListener('click', openBreadcrumbPopover);
  document.getElementById('view-trigger').addEventListener('click', openViewPopover);
  document.getElementById('overflow-trigger').addEventListener('click', openOverflowMenu);
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
    <div class="menu-sep"></div>
    <button type="button" class="menu-item" data-act="new-project"><span class="mi-icon">＋</span> New project</button>
  `;
  pop.querySelectorAll('.menu-item').forEach((b) => {
    b.addEventListener('click', async () => {
      const act = b.dataset.act;
      closePopover();
      if (act === 'refresh') { flashIndicator('tick'); await refresh(); }
      else if (act === 'overview') {
        state.view = state.view === 'overview' ? 'board' : 'overview';
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

function startEventStream() {
  if (eventSource) eventSource.close();
  const params = new URLSearchParams();
  if (state.currentWorkspace) params.set('workspace', state.currentWorkspace);
  const url = '/events' + (params.toString() ? `?${params}` : '');
  eventSource = new EventSource(url);
  eventSource.addEventListener('open', () => setIndicator(null));
  eventSource.addEventListener('error', () => setIndicator('disconnected'));
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
    scheduleRefresh(detail);
  });
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
        lastBoardHash = hash;
        state.board = board;
        renderBoard();
        flashIndicator('tick');
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

/* ------------- board ------------- */

function renderEmpty(msg) {
  document.getElementById('board').innerHTML =
    '<div class="empty">' +
    (msg || 'No projects yet. Click <b>+ Project</b> to create one.') +
    '</div>';
}

function renderBoard() {
  const root = document.getElementById('board');
  root.style.display = '';
  root.innerHTML = '';
  if (!state.board) return;

  if (state.groupBy === 'none') {
    root.classList.remove('swim');
    renderColumnRow(root, state.board.buckets, { showHeader: true });
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
    `;
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
      alert(err.message);
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

    <div class="section">
      <h3>Description</h3>
      <textarea data-field="description" placeholder="Markdown supported">${escapeHtml(t.description ?? '')}</textarea>
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
      alert(err.message);
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
    alert(err.message);
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
  if (!state.currentProject) return alert('Create a project first.');
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
    </div>
  `;
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
