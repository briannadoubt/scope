import { STATUSES } from './enums.js';

export const COLUMN_KINDS = Object.freeze(['open', 'done', 'cancelled']);

const DEFAULT_COLORS = Object.freeze({
  backlog: '#64748b',
  todo: '#2563eb',
  in_progress: '#7c3aed',
  in_review: '#ca8a04',
  done: '#16a34a',
  cancelled: '#6b7280',
});

const DEFAULT_LABELS = Object.freeze({
  backlog: 'Backlog',
  todo: 'Todo',
  in_progress: 'In Progress',
  in_review: 'In Review',
  done: 'Done',
  cancelled: 'Cancelled',
});

export const DEFAULT_COLUMNS = Object.freeze(
  STATUSES.map((id, idx) => Object.freeze({
    id,
    label: DEFAULT_LABELS[id] || id,
    color: DEFAULT_COLORS[id] || '#64748b',
    kind: id === 'done' ? 'done' : id === 'cancelled' ? 'cancelled' : 'open',
    order: (idx + 1) * 10,
  }))
);

export function normalizeColumns(input = DEFAULT_COLUMNS) {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error('Workspace columns must be a non-empty array.');
  }
  const seen = new Set();
  return input.map((column, idx) => {
    if (!column || typeof column !== 'object') throw new Error('Workspace column must be an object.');
    const id = String(column.id || '').trim();
    if (!/^[a-z][a-z0-9_]{1,31}$/.test(id)) {
      throw new Error(`Invalid column id "${column.id}" — use lowercase letters, digits, and underscores.`);
    }
    if (seen.has(id)) throw new Error(`Duplicate column id "${id}".`);
    seen.add(id);
    const label = String(column.label || '').trim();
    if (!label) throw new Error(`Column "${id}" needs a label.`);
    const kind = column.kind || 'open';
    if (!COLUMN_KINDS.includes(kind)) throw new Error(`Invalid column kind "${kind}".`);
    const order = Number.isFinite(Number(column.order)) ? Number(column.order) : (idx + 1) * 10;
    const color = /^#[0-9a-fA-F]{6}$/.test(String(column.color || ''))
      ? String(column.color)
      : DEFAULT_COLORS[id] || '#64748b';
    return { id, label, color, kind, order };
  }).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

export function parseColumns(raw) {
  if (!raw) return DEFAULT_COLUMNS.map((c) => ({ ...c }));
  try {
    return normalizeColumns(JSON.parse(raw));
  } catch {
    return DEFAULT_COLUMNS.map((c) => ({ ...c }));
  }
}

export function statusIds(columns) {
  return normalizeColumns(columns).map((c) => c.id);
}

export function openColumns(columns) {
  return normalizeColumns(columns).filter((c) => c.kind !== 'cancelled');
}

export function terminalColumns(columns) {
  return normalizeColumns(columns).filter((c) => c.kind === 'cancelled');
}

export function doneColumnIds(columns) {
  return normalizeColumns(columns).filter((c) => c.kind === 'done').map((c) => c.id);
}
