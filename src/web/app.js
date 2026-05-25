/* scope — local web UI */

const state = {
  meta: null,
  projects: [],
  currentProject: null,
  epicFilter: '',
  view: 'board', // 'board' | 'overview'
  board: null,
  drawerTicketId: null,
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

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
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
  await reloadProjects();
  bindTopbar();
  if (state.projects.length === 0) {
    openProjectModal();
  } else {
    state.currentProject = state.projects[0].id;
    document.getElementById('project-picker').value = state.currentProject;
    await refresh();
  }
}

async function reloadProjects() {
  state.projects = await api('/api/projects');
  const picker = document.getElementById('project-picker');
  picker.innerHTML = '';
  if (state.projects.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '(no projects)';
    picker.appendChild(opt);
    return;
  }
  for (const p of state.projects) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = `${p.key} · ${p.name}`;
    picker.appendChild(opt);
  }
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
  const sel = document.getElementById('epic-filter');
  const current = sel.value;
  sel.innerHTML = '<option value="">All tickets</option>';
  for (const e of tickets) {
    const o = document.createElement('option');
    o.value = e.id;
    o.textContent = `${e.id} · ${e.title}`;
    sel.appendChild(o);
  }
  if (current && tickets.some((t) => t.id === current)) sel.value = current;
  else state.epicFilter = '';
}

async function loadBoard() {
  const params = new URLSearchParams({ project: state.currentProject });
  if (state.epicFilter) params.set('epic', state.epicFilter);
  state.board = await api(`/api/board?${params}`);
  lastBoardHash = hashBoard(state.board);
}

/* ------------- topbar ------------- */

function bindTopbar() {
  document.getElementById('project-picker').addEventListener('change', async (e) => {
    state.currentProject = e.target.value;
    state.epicFilter = '';
    state.view = 'board';
    await refresh();
  });
  document.getElementById('epic-filter').addEventListener('change', async (e) => {
    state.epicFilter = e.target.value;
    state.view = 'board';
    await refresh();
  });
  document.getElementById('new-project').addEventListener('click', openProjectModal);
  document.getElementById('new-ticket').addEventListener('click', () => openTicketModal());
  document.getElementById('show-overview').addEventListener('click', async () => {
    state.view = state.view === 'overview' ? 'board' : 'overview';
    await refresh();
  });
  document.getElementById('refresh-now').addEventListener('click', async () => {
    flashIndicator('tick');
    await refresh();
  });
  startEventStream();
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
  eventSource = new EventSource('/events');
  eventSource.addEventListener('open', () => setIndicator(null));
  eventSource.addEventListener('error', () => setIndicator('disconnected'));
  eventSource.addEventListener('hello', () => setIndicator(null));
  eventSource.addEventListener('change', (e) => {
    scheduleRefresh(safeParse(e.data));
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

function renderEmpty() {
  document.getElementById('board').innerHTML =
    '<div class="empty">No projects yet. Click <b>+ Project</b> to create one.</div>';
}

function renderBoard() {
  const root = document.getElementById('board');
  root.style.display = '';
  root.innerHTML = '';
  if (!state.board) return;

  for (const status of BOARD_COLUMNS) {
    const tickets = state.board.buckets[status] || [];
    const col = document.createElement('section');
    col.className = 'column';
    col.dataset.status = status;
    col.innerHTML = `
      <div class="column-head">
        <div class="column-title">
          <span class="dot ${status}"></span>
          ${STATUS_LABELS[status]}
          <span class="column-count">${tickets.length}</span>
        </div>
        <button class="column-add" title="New ticket in ${STATUS_LABELS[status]}">+</button>
      </div>
      <div class="column-body"></div>
    `;
    const body = col.querySelector('.column-body');
    for (const t of tickets) body.appendChild(renderCard(t));
    col.querySelector('.column-add').addEventListener('click', () =>
      openTicketModal({ status })
    );
    bindColumnDnD(col);
    root.appendChild(col);
  }
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
      document.getElementById('epic-filter').value = t.parent_id;
      state.epicFilter = t.parent_id;
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
      document.getElementById('project-picker').value = p.id;
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
          ? `<div class="overview-body">${escapeHtml(p.overview)}</div>`
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
      document.getElementById('epic-filter').value = el.dataset.id;
      // restore board layout
      root.style.display = '';
      await refresh();
    })
  );
}

/* ------------- utils ------------- */

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

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refresh().catch(() => {});
});

init().catch((e) => {
  document.body.innerHTML = `<pre style="padding:24px;color:#f85149">${escapeHtml(e.stack || e.message)}</pre>`;
});
