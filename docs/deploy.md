# Hosted Scope hub — phase 1 deploy runbook

Phase 1 deploys the existing Express hub (`src/server.js`) as a **single
single-tenant cloud instance** on Fly.io behind public TLS. The canonical event
log lives in Postgres (SCP-140); the SQLite cache on the instance is disposable.

This is deliberately one machine: the hub's real-time fan-out is an in-process
`EventEmitter` (`src/events.js`) and the replay cache is per-process, so a
second instance would have its own bus and cache. Multi-node is a later epic
(SCP-125). **Do not scale `min_machines_running` past 1 in phase 1.**

Covers: SCP-151 (deploy), SCP-153 (CI/CD), SCP-154 (backup/DR), SCP-155
(logging/health/alerting).

---

## Artifacts

| File | Purpose |
| --- | --- |
| `Dockerfile` | Multi-stage image; builds the `better-sqlite3` native addon, ships a slim runtime. |
| `.dockerignore` | Keeps host `node_modules`/state/secrets out of the build context. |
| `fly.toml` | Single instance, persistent volume for `/data/.scope`, SSE-safe proxy timeouts, `/healthz` check. |
| `.github/workflows/deploy.yml` | Builds + `fly deploy` on push to `main` (gated behind CI) or a `deploy-*` tag. |
| `scripts/backup-eventlog.sh` | Nightly `pg_dump` of the `events` table → optional versioned S3/R2. |
| `scripts/restore-eventlog.sh` | Restore the log into a fresh DB; the hub replays it into a clean cache. |
| `src/observability/logging.js` | Zero-dep JSON structured logger + request-logging middleware. |
| `src/observability/healthz.js` | `/healthz` handler; readiness pings Postgres, liveness otherwise. |

---

## Prerequisites

- `flyctl` installed and authenticated (`fly auth login`).
- A Postgres database for the canonical log (Fly Postgres, Neon, Supabase, RDS —
  anything reachable). Have its connection string ready.
- A domain you control for the custom TLS hostname.

---

## First deploy

1. **Edit `fly.toml`** — set `app = "<your-app>"` and `primary_region`.

2. **Create the app and the volume:**
   ```sh
   fly apps create <your-app>
   fly volumes create scope_data --size 1 --region <region>   # matches [mounts].source
   ```

3. **Set secrets** (never commit these — see the secrets table below):
   ```sh
   fly secrets set \
     SCOPE_PG_URL="postgres://user:pass@host:5432/scope?sslmode=require" \
     SCOPE_TOKEN="$(openssl rand -hex 32)"
   ```
   Save the `SCOPE_TOKEN` value — collaborators and the iOS/web client use it as
   the bearer token. (Phase-1 GitHub-OAuth login is SCP-152, owned by the auth
   cluster; this token is the interim/companion credential.)

4. **Deploy:**
   ```sh
   fly deploy --remote-only
   ```

5. **Attach the custom domain + TLS** (Fly issues and renews the cert):
   ```sh
   fly certs add scope.example.com
   # then add the AAAA/A/CNAME records fly prints, and:
   fly certs show scope.example.com   # wait for "Status: Ready"
   ```

6. **Smoke test:**
   ```sh
   curl -fsS https://scope.example.com/healthz            # {"status":"ok","db":"ok",...}
   curl -fsS -H "Authorization: Bearer $SCOPE_TOKEN" \
        https://scope.example.com/api/meta | jq .version
   # SSE survives the proxy (should stay open, emitting hello + keepalives):
   curl -N -H "Authorization: Bearer $SCOPE_TOKEN" https://scope.example.com/events
   ```
   The SSE stream should stay open well past 60s without the proxy closing it —
   that's the `fly.toml` SSE timeout settings doing their job.

---

## CI/CD (SCP-153)

`deploy.yml` is independent of `release.yml` (which ships the CLI to
npm/Homebrew). It deploys the hub when:

- **push to `main`** — runs only after the `CI` workflow succeeds on that commit
  (`workflow_run` gate), and checks out the exact SHA CI validated.
- **push of a `deploy-*` tag** — pin a specific commit: `git tag deploy-2026-06-07 && git push --tags`.
- **manual** — "Run workflow" in the Actions tab (`workflow_dispatch`).

Required repo secret: **`FLY_API_TOKEN`** (`fly tokens create deploy -x 999999h`,
store under Settings → Secrets → Actions).

### Rollback

```sh
fly releases                       # list releases, find the last-good version
fly releases rollback              # roll back one release
# or pin a known-good image:
fly deploy --image registry.fly.io/<app>:<digest>
```
Rolling back the **image** does not roll back Postgres data — the event log is
append-only, so a rollback simply runs older code against the same log.

---

## Backup & disaster recovery (SCP-154)

**What's backed up:** only the canonical `events` table in Postgres. The SQLite
cache and the Postgres cache tables are disposable — `replayInto` rebuilds them
from the log, so they are intentionally *not* backed up.

### Schedule the nightly backup

Provision a versioned bucket once (R2 or S3 with **object versioning ON** — that
versioning is the actual DR guarantee against bad overwrites/deletes), configure
an `rclone` remote, then run on a schedule (GitHub Actions `schedule`, a Fly
cron machine, or any host with `pg_dump` + `rclone`):

```sh
SCOPE_PG_URL="postgres://...:5432/scope?sslmode=require" \
RCLONE_REMOTE="r2:scope-backups/eventlog" \
./scripts/backup-eventlog.sh
```

The script `pg_dump`s `--data-only --table=events`, gzips it to a timestamped
file, and (if `RCLONE_REMOTE` is set) uploads it. Exit code is non-zero on
failure so the scheduler/alert catches a missed backup.

### Restore drill (test this before you need it)

The drill proves the **canonical log + deterministic replay** can reconstruct
the board with zero reliance on any cache.

1. **Pull a backup:**
   ```sh
   rclone copy r2:scope-backups/eventlog/eventlog-<stamp>.sql.gz .
   ```
2. **Restore into a FRESH database** (empty Postgres; the hub creates the schema
   on boot, or run `ensureSchema` first):
   ```sh
   SCOPE_PG_URL="postgres://...new-empty-db..." \
     ./scripts/restore-eventlog.sh eventlog-<stamp>.sql.gz
   ```
   This truncates `events`, loads the dump, and prints the row count.
3. **Boot a hub against the restored DB with an EMPTY cache** (no
   `/data/.scope`) so it replays the log from scratch:
   ```sh
   rm -rf /tmp/restore-cache && mkdir -p /tmp/restore-cache/.scope
   SCOPE_PG_URL="postgres://...new-empty-db..." SCOPE_DIR=/tmp/restore-cache/.scope \
     node bin/scope.js serve --port 8099 --no-open
   ```
4. **Verify the board matches** the source: compare ticket counts / board state
   against the live hub (or a known-good snapshot):
   ```sh
   curl -fsS -H "Authorization: Bearer $SCOPE_TOKEN" \
     http://localhost:8099/api/board | jq '[.buckets[]|length]|add'
   ```
   A matching total (and spot-checked ticket fields) confirms the log replays to
   the same state. Record the drill result; re-run quarterly.

---

## Logging, health & alerting (SCP-155)

- **Logging:** `src/observability/logging.js` emits one JSON object per line to
  stdout/stderr. Fly captures these automatically (`fly logs`). `LOG_LEVEL`
  (env, default `info`) gates verbosity. Optional upgrade to `pino` documented
  in that file's header.
- **Health:** `/healthz` (unauthenticated). Returns `200 {status:"ok"}` when
  Postgres is reachable (or not configured), `503` when the DB is unreachable.
  `fly.toml` polls it; the SQLite cache is excluded from readiness on purpose.
- **Alerting hookup:** point an external uptime monitor (Better Stack /
  UptimeRobot / Pingdom) at `https://scope.example.com/healthz` with a 1-minute
  interval and alert on non-200 or the JSON `status != "ok"`. Optionally forward
  Fly's native metrics/alerts (`fly checks list`) to a notification channel.
  Production tracing/metrics across nodes is deferred to SCP-125.

---

## Required secrets / env

| Name | Where | Purpose |
| --- | --- | --- |
| `SCOPE_PG_URL` (or `DATABASE_URL`) | Fly secret | Canonical Postgres event log + cache. Required for the hosted path; `/healthz` readiness probes it. |
| `SCOPE_TOKEN` | Fly secret | Bearer token clients use (interim until SCP-152 OAuth). |
| `FLY_API_TOKEN` | GitHub Actions secret | Lets `deploy.yml` run `fly deploy`. |
| `RCLONE_REMOTE` + rclone config | backup host/CI | Off-host upload target for `backup-eventlog.sh` (versioned bucket). |
| `LOG_LEVEL` | Fly env (optional) | `debug`/`info`/`warn`/`error`; default `info`. |
| `SCOPE_DIR` | Fly env | Path for the disposable SQLite cache on the volume (`/data/.scope`). |
| `PORT` / `HOST` | Fly env | Internal bind port and `0.0.0.0` host (see integration notes). |
| `SCOPE_CLOUD` | Fly env | Flags the cloud build to disable Bonjour/mTLS/loopback-bypass (see integration notes). |
