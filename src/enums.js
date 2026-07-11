/**
 * Canonical domain enums — the single source of truth for ticket types,
 * statuses, priorities, and relation types. Extracted as a leaf module (no
 * imports) so both repo.js (DB constraints) and event-schema.js (event
 * validation) consume the same lists without an import cycle. The two can
 * therefore never drift apart.
 */

/** @type {readonly ['epic', 'story', 'bug']} */
export const TICKET_TYPES = Object.freeze(['epic', 'story', 'bug']);
/** @type {readonly ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'cancelled']} */
export const STATUSES = Object.freeze([
  'backlog',
  'todo',
  'in_progress',
  'in_review',
  'done',
  'cancelled',
]);
/** @type {readonly ['low', 'medium', 'high', 'urgent']} */
export const PRIORITIES = Object.freeze(['low', 'medium', 'high', 'urgent']);
/** @type {readonly ['blocks', 'blocked_by', 'relates_to', 'duplicates', 'duplicate_of']} */
export const RELATION_TYPES = Object.freeze([
  'blocks',
  'blocked_by',
  'relates_to',
  'duplicates',
  'duplicate_of',
]);

/** The inverse relation auto-created for each relation type. */
export const RELATION_INVERSE = Object.freeze({
  blocks: 'blocked_by',
  blocked_by: 'blocks',
  relates_to: 'relates_to',
  duplicates: 'duplicate_of',
  duplicate_of: 'duplicates',
});

/** Event field names a `ticket.set_field` may target (camelCase). */
export const TICKET_FIELDS = Object.freeze([
  'title',
  'description',
  'status',
  'priority',
  'parentId',
  'branch',
  'prUrl',
  'assignee',
  'labels',
  'rank',
]);

/** DB column name -> event field name (for translating updateTicket writes). */
export const COLUMN_TO_FIELD = Object.freeze({
  title: 'title',
  description: 'description',
  status: 'status',
  priority: 'priority',
  parent_id: 'parentId',
  branch: 'branch',
  pr_url: 'prUrl',
  assignee: 'assignee',
  labels: 'labels',
  rank: 'rank',
});
