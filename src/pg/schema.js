/**
 * Multi-tenant Postgres schema for the hosted node (SCP-140).
 *
 * Two layers, mirroring the local SQLite design (ADR 0001/0002, SCP-124):
 *
 *  1. `events` — the canonical append-only log. One row per event; the full
 *     envelope is stored verbatim in `body` (so replay reconstructs the exact
 *     event object), with tenant_id/event_id/ts/kind extracted for keys and
 *     ordering. Upload is INSERT ... ON CONFLICT DO NOTHING, which reproduces
 *     the file-union + idempotency that ULID filenames give the local store.
 *
 *  2. cache tables — `workspace`, `tickets`, `ticket_relations`,
 *     `ticket_comments`, `ticket_history` — the disposable projection that
 *     `replayInto` rebuilds (the Postgres port lands in SCP-141). Every table
 *     carries `tenant_id`; a project IS a tenant (the sync/sharing boundary,
 *     ADR 0003). Row-Level Security keyed on tenant_id is SCP-144.
 *
 * `ensureSchema` is idempotent (CREATE ... IF NOT EXISTS), safe to run on boot.
 */

export const SCHEMA_SQL = /* sql */ `
-- canonical event log -----------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
  tenant_id  text  NOT NULL,
  event_id   text  NOT NULL,            -- ULID (the event envelope id)
  ts         text  NOT NULL,            -- ISO string, kept verbatim for compareEvents fidelity
  kind       text  NOT NULL,
  body       jsonb NOT NULL,            -- the full event envelope {v,id,ts,actor,model?,kind,payload}
  PRIMARY KEY (tenant_id, event_id)
);
-- canonical-order reads within a tenant (ts then id, matching compareEvents)
CREATE INDEX IF NOT EXISTS idx_events_canonical ON events (tenant_id, ts, event_id);

-- replayed cache: workspace singleton (one per tenant/project) -------------
CREATE TABLE IF NOT EXISTS workspace (
  tenant_id          text PRIMARY KEY,
  key                text NOT NULL,
  name               text NOT NULL,
  description        text NOT NULL DEFAULT '',
  overview           text NOT NULL DEFAULT '',
  next_ticket_number integer NOT NULL DEFAULT 1,
  created_at         text NOT NULL,
  updated_at         text NOT NULL
);

-- replayed cache: tickets --------------------------------------------------
CREATE TABLE IF NOT EXISTS tickets (
  tenant_id   text NOT NULL,
  id          text NOT NULL,            -- display id "KEY-N"
  uid         text NOT NULL,            -- ULID identity (stable across renumber)
  number      integer NOT NULL,
  type        text NOT NULL,
  title       text NOT NULL,
  description text NOT NULL DEFAULT '',
  status      text NOT NULL,
  priority    text NOT NULL,
  parent_id   text,
  branch      text,
  pr_url      text,
  assignee    text,
  labels      jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at  text NOT NULL,
  updated_at  text NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tickets_uid    ON tickets (tenant_id, uid);
CREATE INDEX        IF NOT EXISTS idx_tickets_status ON tickets (tenant_id, status);
CREATE INDEX        IF NOT EXISTS idx_tickets_parent ON tickets (tenant_id, parent_id);

-- replayed cache: relations (both directions materialized, as in SQLite) ---
CREATE TABLE IF NOT EXISTS ticket_relations (
  tenant_id      text NOT NULL,
  from_ticket_id text NOT NULL,
  to_ticket_id   text NOT NULL,
  type           text NOT NULL,
  created_at     text NOT NULL,
  PRIMARY KEY (tenant_id, from_ticket_id, to_ticket_id, type)
);

-- replayed cache: comments -------------------------------------------------
CREATE TABLE IF NOT EXISTS ticket_comments (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id  text NOT NULL,
  ticket_id  text NOT NULL,
  author     text,
  body       text NOT NULL,
  created_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_ticket ON ticket_comments (tenant_id, ticket_id);

-- replayed cache: field history (changed_by carries rendered attribution) --
CREATE TABLE IF NOT EXISTS ticket_history (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id  text NOT NULL,
  ticket_id  text NOT NULL,
  field      text NOT NULL,
  old_value  text,
  new_value  text,
  changed_by text,
  changed_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_history_ticket ON ticket_history (tenant_id, ticket_id);
`;

/** Create every table/index if absent. Idempotent; safe on every boot. */
export async function ensureSchema(clientOrPool) {
  await clientOrPool.query(SCHEMA_SQL);
}

/** Drop everything (tests only). */
export async function dropSchema(clientOrPool) {
  await clientOrPool.query(`
    DROP TABLE IF EXISTS ticket_history, ticket_comments, ticket_relations,
                         tickets, workspace, events CASCADE;
  `);
}
