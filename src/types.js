/**
 * Shared JSDoc type definitions for scope's public API.
 *
 * This module exports no runtime values — it exists so the data-layer modules
 * (`repo.js`, `db.js`, `columns.js`) and the public entry (`index.js`) can
 * reference one canonical set of `@typedef`s via `import('./types.js').Ticket`.
 * The `.d.ts` emit (see `npm run build:types`) turns these into the shipped
 * TypeScript declarations, so keep them faithful to the runtime shapes.
 */

/**
 * A better-sqlite3 database handle, as returned by {@link openDb}. Typed
 * through the `better-sqlite3` package's own declarations (a devDependency);
 * falls back to a loose handle if those types aren't installed.
 * @typedef {import('better-sqlite3').Database} Database
 */

/** @typedef {'epic'|'story'|'bug'} TicketType */
/** @typedef {'low'|'medium'|'high'|'urgent'} Priority */
/** @typedef {'blocks'|'blocked_by'|'relates_to'|'duplicates'|'duplicate_of'} RelationType */
/**
 * The six built-in statuses. Note that workspaces may define their own columns,
 * so a ticket's `status` is any configured column id — this union covers the
 * defaults, not the full range a customized workspace can hold.
 * @typedef {'backlog'|'todo'|'in_progress'|'in_review'|'done'|'cancelled'} Status
 */

/**
 * A single ticket row, as returned by {@link getTicket} / {@link listTickets}.
 * @typedef {object} Ticket
 * @property {string} id           Display id, e.g. `"MA-3"`. Immutable.
 * @property {string} uid          Internal ULID identity (stable across rekeys).
 * @property {number} number       Display number, unique within the workspace.
 * @property {TicketType} type
 * @property {string} title
 * @property {string} description
 * @property {string} status       A workspace column id (see {@link Status}).
 * @property {Priority} priority
 * @property {string|null} parent_id  Parent epic's id, or null.
 * @property {string|null} branch
 * @property {string|null} pr_url
 * @property {string|null} assignee
 * @property {string[]} labels
 * @property {number|null} rank     Manual ordering within a column.
 * @property {string} created_at    ISO 8601.
 * @property {string} updated_at    ISO 8601.
 */

/**
 * A board column / status definition.
 * @typedef {object} Column
 * @property {string} id
 * @property {string} label
 * @property {string} color         Hex string, e.g. `"#2563eb"`.
 * @property {'open'|'done'|'cancelled'} kind
 * @property {number} order
 */

/**
 * The singleton workspace row, as returned by {@link getWorkspace}.
 * @typedef {object} Workspace
 * @property {number} id            Always `1`.
 * @property {string} key           Ticket key prefix, e.g. `"MA"`.
 * @property {string} name
 * @property {string} description
 * @property {string} overview
 * @property {Column[]} columns
 * @property {number} next_ticket_number
 * @property {string} created_at
 * @property {string} updated_at
 */

/**
 * Input to {@link createTicket}.
 * @typedef {object} CreateTicketInput
 * @property {TicketType} type
 * @property {string} title
 * @property {string} [description]
 * @property {string} [status]      Defaults to `"backlog"`.
 * @property {Priority} [priority]  Defaults to `"medium"`.
 * @property {string} [parent]      Parent epic id.
 * @property {string} [branch]
 * @property {string} [prUrl]
 * @property {string} [assignee]
 * @property {string[]} [labels]
 * @property {string} [actor]       Who is making the change (for the event log).
 * @property {string|null} [model]  Optional model attribution.
 */

/**
 * Mutable fields accepted by {@link updateTicket}. Field names are the DB
 * column names (`parent_id`, `pr_url`), not the camelCase create-input names.
 * @typedef {object} UpdateTicketFields
 * @property {string} [title]
 * @property {string} [description]
 * @property {string} [status]
 * @property {Priority} [priority]
 * @property {string|null} [parent_id]
 * @property {string|null} [branch]
 * @property {string|null} [pr_url]
 * @property {string|null} [assignee]
 * @property {string[]} [labels]
 * @property {number|null} [rank]
 */

/**
 * Filter for {@link listTickets}.
 * @typedef {object} ListTicketsFilter
 * @property {TicketType} [type]
 * @property {string} [status]
 * @property {string|null} [parentId]
 * @property {string} [assignee]
 */

/**
 * Epic rollup returned by {@link epicProgress}.
 * @typedef {object} EpicProgress
 * @property {number} total                 Work items (stories/bugs) in the subtree.
 * @property {Record<string, number>} counts  Count per status id.
 * @property {number} done                  Items in a `done`-kind column.
 * @property {number} percent               `done / total`, rounded to a whole percent.
 */

/**
 * A comment row.
 * @typedef {object} Comment
 * @property {number} id
 * @property {string|null} author   Rendered attribution.
 * @property {string} body
 * @property {string} [created_at]  ISO 8601 (present on reads).
 * @property {string} [ticket_id]   Present on the create return.
 */

/**
 * An outbound relation edge, as returned by {@link listRelations}.
 * @typedef {object} Relation
 * @property {RelationType} type
 * @property {string} to_ticket_id
 * @property {string|null} title
 * @property {string|null} status
 * @property {TicketType|null} ticket_type
 */

/**
 * A ticket-scoped history entry, as returned by {@link listHistory}.
 * @typedef {object} HistoryEntry
 * @property {string} field
 * @property {string|null} old_value
 * @property {string|null} new_value
 * @property {string|null} changed_by
 * @property {string} changed_at    ISO 8601.
 */

/**
 * A stateful workspace handle returned by {@link openWorkspace}: the data-layer
 * API with the underlying `db` pre-bound into every method.
 *
 * Keep this member list in sync with `REPO_METHODS` in `index.js` — the runtime
 * builds these methods from that array, and this typedef is what describes them
 * to TypeScript consumers.
 *
 * @typedef {object} WorkspaceHandle
 * @property {Database} db          The underlying better-sqlite3 handle.
 * @property {string} scopeDir      Absolute path to the `.scope/` directory.
 * @property {() => void} close     Close the database handle.
 * @property {(ops: object[], meta?: { actor?: string, model?: string|null }) => { applied: number, results: any[], refs: object }} applyBatch
 * @property {() => Workspace} getWorkspace
 * @property {(fields?: Partial<Workspace>, who?: string|null, model?: string|null) => Workspace} updateWorkspace
 * @property {(newKey: string, meta?: { actor?: string, model?: string|null }) => { key: string, reprefixed: number }} rekeyWorkspace
 * @property {(input: CreateTicketInput) => Ticket} createTicket
 * @property {(id: string) => Ticket|null} getTicket
 * @property {(filter?: ListTicketsFilter) => Ticket[]} listTickets
 * @property {(query: string, opts?: { limit?: number }) => Ticket[]} searchTickets
 * @property {(id: string, fields: UpdateTicketFields, who?: string|null, model?: string|null) => Ticket} updateTicket
 * @property {(id: string, who?: string|null, model?: string|null) => void} deleteTicket
 * @property {(fromId: string, toId: string, type: RelationType, who?: string|null, model?: string|null) => void} addRelation
 * @property {(fromId: string, toId: string, type: RelationType, who?: string|null, model?: string|null) => void} removeRelation
 * @property {(ticketId: string) => Relation[]} listRelations
 * @property {(ticketId: string, body: string, author?: string|null, model?: string|null) => Comment} addComment
 * @property {(ticketId: string) => Comment[]} listComments
 * @property {(ticketId: string) => HistoryEntry[]} listHistory
 * @property {(epicId: string) => Ticket[]} listEpicChildren
 * @property {(epicId: string) => EpicProgress} epicProgress
 */

export {};
