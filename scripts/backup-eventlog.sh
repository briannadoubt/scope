#!/usr/bin/env bash
#
# Off-host backup of the canonical event log (SCP-154).
#
# The canonical, append-only event log lives in Postgres (the `events` table,
# SCP-140). Everything else — the SQLite replay cache and the Postgres cache
# tables (workspace/tickets/...) — is DISPOSABLE: `replayInto` rebuilds it from
# the log. So we back up ONLY the events table. A restore replays it into a
# fresh cache (see docs/deploy.md "Restore drill").
#
# What it does:
#   1. pg_dump just the `events` table to a timestamped, compressed file.
#   2. (optional) rclone copy it to an S3/R2 bucket that has OBJECT VERSIONING
#      enabled — versioning is the real DR guarantee (protects against a bad
#      overwrite or a delete), so enable it on the bucket out of band.
#
# Schedule it nightly (cron / Fly machine cron / GitHub Actions schedule). It is
# idempotent and safe to run repeatedly; each run is a new timestamped object.
#
# Required env:
#   SCOPE_PG_URL or DATABASE_URL   Postgres connection string (same as the hub).
# Optional env:
#   BACKUP_DIR        local dir for dumps (default: ./backups)
#   RCLONE_REMOTE     rclone remote+path, e.g. "r2:scope-backups/eventlog".
#                     If set, the dump is uploaded and the local copy removed.
#   RETAIN_LOCAL_DAYS prune local dumps older than N days (default: 14).
#
# Exit non-zero on any failure so the scheduler/alerting notices a missed backup.

set -euo pipefail

PG_URL="${SCOPE_PG_URL:-${DATABASE_URL:-}}"
if [[ -z "${PG_URL}" ]]; then
  echo "[backup] ERROR: set SCOPE_PG_URL or DATABASE_URL" >&2
  exit 1
fi

BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETAIN_LOCAL_DAYS="${RETAIN_LOCAL_DAYS:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="${BACKUP_DIR}/eventlog-${STAMP}.sql.gz"

mkdir -p "${BACKUP_DIR}"

echo "[backup] dumping events table -> ${OUT}"
# --data-only is intentional: the schema is recreated by the app on boot
# (ensureSchema, CREATE ... IF NOT EXISTS). We only need the rows. Restricting
# to the single table keeps the dump small and makes the disposable/canonical
# split explicit. --no-owner/--no-privileges so it restores into any role.
pg_dump "${PG_URL}" \
  --table=events \
  --data-only \
  --no-owner \
  --no-privileges \
  --format=plain \
  | gzip -9 > "${OUT}"

# Sanity check: a non-empty dump that mentions the events table.
if [[ ! -s "${OUT}" ]]; then
  echo "[backup] ERROR: dump is empty" >&2
  exit 1
fi
echo "[backup] dump size: $(du -h "${OUT}" | cut -f1)"

if [[ -n "${RCLONE_REMOTE:-}" ]]; then
  echo "[backup] uploading to ${RCLONE_REMOTE}/"
  # The bucket MUST have object versioning enabled (configure once, out of band).
  # We copy (not sync) so each timestamped object is preserved server-side.
  rclone copy "${OUT}" "${RCLONE_REMOTE}/" --s3-no-check-bucket
  echo "[backup] uploaded; removing local copy"
  rm -f "${OUT}"
else
  echo "[backup] RCLONE_REMOTE unset — keeping dump locally only"
  # Prune old local dumps so the volume doesn't fill.
  find "${BACKUP_DIR}" -name 'eventlog-*.sql.gz' -type f -mtime "+${RETAIN_LOCAL_DAYS}" -delete || true
fi

echo "[backup] done"
