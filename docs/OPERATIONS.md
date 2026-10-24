# MAARY BASE Operations & Deployment Guide

## 1. Hardware & Runtime Requirements

| Environment | CPU | RAM | Disk Storage | Notes |
| :--- | :--- | :--- | :--- | :--- |
| **Local Development / Testing** | 1+ vCPU | 512 MB+ | 1 GB+ | Uses embedded PostgreSQL (`pglite://`) or local Docker PostgreSQL. |
| **Production Single-Node** | 2+ vCPU | 2 GB+ | 20 GB+ SSD | External PostgreSQL 17 recommended with dedicated persistent volumes for `/var/lib/postgresql/data`, `/app/storage`, and `/app/data/backups`. |

---

## 2. Environment Configuration

Required and optional environment variables (validated at startup in `src/config.ts`):

- `NODE_ENV`: `development` | `test` | `production`
- `HOST`: Bind address (`0.0.0.0` for container/preview environments)
- `PORT`: HTTP/WebSocket port (`4100` default)
- `DATABASE_URL`:
  - External PostgreSQL: `postgres://user:pass@host:5432/maary`
  - Embedded persistent PostgreSQL: `pglite://./data/postgres`
  - Embedded in-memory PostgreSQL: `pglite://memory`
- `JWT_SECRET`: Unique secret for signing HS256 JWTs and storage tokens (minimum 32 characters; production startup rejects the built-in development default).
- `ENCRYPTION_KEY`: Unique master key for AES-256-GCM encryption of project secrets and stored API keys (production startup rejects the built-in development default).
- `PLATFORM_BOOTSTRAP_TOKEN`: Unique one-time setup credential required in production to create the initial platform superadmin. Send it as `x-platform-bootstrap-token` on the first platform registration only; it is not needed for later ordinary platform accounts.
- `TRUST_PROXY`: Defaults to `false`. Set `true` only when the API is reachable exclusively through a trusted reverse proxy that overwrites forwarded headers.
- `STORAGE_BACKEND`: `local` (default) or `s3`. S3 mode also requires `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`.
- `STORAGE_DIR`: Local object storage directory (`./storage` default). Must be on persistent storage in production.
- `BACKUP_DIR`: Directory for logical backup snapshots (`./data/backups` default). Must be on persistent storage.
- `WORKER_ENABLED` / `WORKER_POLL_INTERVAL_MS`: Durable job worker (enabled unless `NODE_ENV=test`). Disabling it leaves jobs queued and makes job status `requires_configuration`.
- `RATE_LIMIT_MAX`: Requests per minute per client (`600` in `.env.example`, `1000` default), enforced by `@fastify/rate-limit`.
- `AUTO_MIGRATE`: Apply pending platform migrations on startup (`true` default). The Compose file enables it; for controlled deployments set it to `false` and run migrations explicitly.
- `APK_ARTIFACT_PATH` / `APK_METADATA_PATH`: Where the API expects a Gradle-built APK and its metadata sidecar (`releases/marry-base.apk`, `releases/marry-base.apk.json`). The API only inspects, reports and serves these files.
- `ANDROID_PROJECT_DIR`: Gradle project used for on-host builds (`android` default).
- `JAVA_BIN`: Java executable used to detect a JDK and run Gradle (`java` default). A JDK 17+ and `ANDROID_HOME` are required for `POST /v1/platform/apk/build`; otherwise the endpoint reports `409 apk_build_unavailable`.
- `APK_BUILD_TIMEOUT_MS`: Hard limit for an on-host Gradle build (`900000` default).
- `STATEMENT_TIMEOUT_MS`: Per-query PostgreSQL statement timeout (`15000` ms default).
- `MAX_QUERY_ROWS`: Maximum rows returned per query (`1000` default).
- `FUNCTION_TIMEOUT_MS`: Hard execution timeout cap for server functions (`5000` ms default).

Generate fresh values for production secrets (for example, `openssl rand -hex 32`) and keep them outside source control. Set `NODE_ENV=production` before exposing the service. In development/test mode the first registered account can bootstrap the local platform; production requires the bootstrap header above. Public platform registration must still be rate-limited and should be closed or constrained by an operator policy where open account creation is not desired.

### Docker Compose deployment

`docker-compose.yml` runs PostgreSQL 17 and the API with health checks and persistent volumes:

```bash
cp .env.example .env
# Edit .env: set POSTGRES_PASSWORD, JWT_SECRET, ENCRYPTION_KEY, PLATFORM_BOOTSTRAP_TOKEN
# (each 32+ random characters) and optionally CORS_ORIGIN / TRUST_PROXY.
docker compose up -d --build
curl -fsS http://localhost:4100/ready
```

Volumes: `postgres-data` (database), `app-data` (`/app/data`, backups), `app-storage`
(`/app/storage`, objects). `./releases` is mounted read-only so the API can serve a CI-built APK.
The container starts with `AUTO_MIGRATE=true`; the first production registration must include the
`x-platform-bootstrap-token` header. Stop with `docker compose down` (volumes are retained);
`docker compose down -v` destroys data and is intentionally destructive.

### Persistence and restarts

- **External PostgreSQL** (production): all control-plane and project data survives restarts and
  container replacement; keep the database volume or managed cluster backing it up.
- **Embedded persistent PostgreSQL** (`pglite://./data/postgres`): stored on disk and survives
  restarts (verified in this repository by creating a project and row, restarting the process, then
  reading both back). It is single-process; do not run two API instances against one directory.
- **Embedded in-memory** (`pglite://memory`): test only — data is lost when the process exits.
- Object storage and backups are plain directories (or S3 in `STORAGE_BACKEND=s3`); both must be on
  persistent volumes. The readiness probe checks storage writability, and `/v1/projects/:ref/status`
  reports the storage backend in use.

---

## 3. Health, Readiness & Observability

- **Liveness (`GET /health`)**: Returns `200 OK` if the Node.js HTTP server is responsive.
- **Readiness (`GET /ready`)**: Executes `SELECT 1` against PostgreSQL, checks that platform migrations are current, and verifies write permissions on `STORAGE_DIR`. Returns `503 Service Unavailable` if PostgreSQL, migrations, or storage are not ready.
- **Metrics (`GET /v1/metrics` or `GET /v1/metrics?format=prometheus`)**: Exposes process uptime, RSS/heap memory, database query counters, active project counts, storage bytes/objects, realtime WebSocket connection counts, and job queue counts by status.

---

## 4. Backup, Verification & Recovery Procedures

### Creating a Backup
```bash
# Backup a specific project
npm run cli -- backup create <projectSlug>

# Or backup all projects on the platform
npm run cli -- backup create
```

### Verifying Backup Integrity
Every backup file written to `BACKUP_DIR` has its SHA-256 hash stored in `platform_backups.checksum_sha256`. Before restoring, verify the file on disk has not been corrupted or modified:
```bash
npm run cli -- backup verify <backupId>
```

### Restoring a Backup
Restoration verifies the SHA-256 checksum first, then transactionally recreates missing tables, restores rows, re-applies RLS policies, and re-attaches realtime triggers:
```bash
npm run cli -- backup restore <backupId>
```

### Android artifact provenance and signing
The server does not sign packages. CI produces the APK with Gradle, verifies it with `apksigner`,
`aapt2 dump badging` and `zipalign`, and uploads it as the `marry-base-android-apk` workflow
artifact; `releases/marry-base.apk` and its `.apk.json` sidecar are intentionally not committed.
For distribution, configure a release keystore in `android/app/build.gradle` and keep that identity
stable: Android rejects updates signed by a different key. Never commit a keystore or its passwords.
Run `npm run verify:apk` (needs `apksigner` from the Android build-tools) after publishing a release.

---

## 5. Upgrades & Migrations

1. Create a full backup before upgrading (`npm run cli -- backup create`, or Platform administration → Platform backups).
2. Pull the new release and install dependencies (`npm ci`).
3. Apply platform migrations (`npm run db:migrate`). Platform migrations in `src/db/migrations/` are tracked in `platform_migrations` and executed inside a single transaction.
4. Project-specific schema migrations are tracked independently in `platform_project_migrations` and support transactional rollback via `down_sql` (`POST /v1/projects/:ref/database/migrations/:version/rollback`).
5. For Compose deployments: `docker compose build --pull && docker compose up -d`. The API applies
   pending migrations at start (watch `docker compose logs -f api`), and `/ready` must return `200`
   with `{"dependencies":{"migrations":"ok"}}` before routing traffic to it.
6. Verify after upgrade: `/v1/platform/version` (applied/pending counts), `/v1/platform/status`
   (per-subsystem checks) and the studio's Platform administration page. Roll back by redeploying the
   previous image and restoring the pre-upgrade backup if a migration must be undone.
