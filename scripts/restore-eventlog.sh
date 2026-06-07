#!/usr/bin/env bash
#
# Restore the canonical event log from a backup (SCP-154 disaster recovery).
#
# This restores ONLY the `events` table (the canonical, append-only log). It
# does NOT restore the cache — that's the point: after loading the log into a
# fresh/empty database, the hub replays it (`replayInto`) to rebuild every cache
# table and the SQLite cache. See docs/deploy.md "Restore drill" for the full
# procedure and the verification step.
#
# Usage:
#   SCOPE_PG_URL=postgres://...  ./scripts/restore-eventlog.sh <dump.sql.gz>
#   # or pull straight from object storage first:
#   rclone copy r2:scope-backups/eventlog/eventlog-<stamp>.sql.gz .
#
# The target database must already have the schema (the hub creates it on boot
# via ensureSchema). This script truncates `events` then loads the dump, so a
# restore is repeatable and doesn't double-insert. Because upload is
# INSERT ... ON CONFLICT DO NOTHING and replay is deterministic, loading the
# same log always yields the same board.

set -euo pipefail

PG_URL="${SCOPE_PG_URL:-${DATABASE_URL:-}}"
DUMP="${1:-}"

if [[ -z "${PG_URL}" ]]; then
  echo "[restore] ERROR: set SCOPE_PG_URL or DATABASE_URL" >&2
  exit 1
fi
if [[ -z "${DUMP}" || ! -f "${DUMP}" ]]; then
  echo "[restore] ERROR: pass a dump file: restore-eventlog.sh <dump.sql.gz>" >&2
  exit 1
fi

echo "[restore] truncating events in target (cache will be rebuilt by replay)"
psql "${PG_URL}" -v ON_ERROR_STOP=1 -c 'TRUNCATE TABLE events;'

echo "[restore] loading ${DUMP} -> events"
gunzip -c "${DUMP}" | psql "${PG_URL}" -v ON_ERROR_STOP=1

COUNT="$(psql "${PG_URL}" -t -A -c 'SELECT count(*) FROM events;')"
echo "[restore] events table now holds ${COUNT} rows"
echo "[restore] NEXT: boot the hub (it replays into a fresh cache), then verify the board — see docs/deploy.md"
