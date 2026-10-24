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
- `STORAGE_DIR`: Local object storage directory (`./storage` default).
- `BACKUP_DIR`: Directory for logical backup snapshots (`./data/backups` default).
- `APK_SIGNING_KEY_FILE`: Persistent RSA private key used for Android v1/v2 signing (`./data/apk-signing/private-key.pem` default). `APK_SIGNING_PRIVATE_KEY` can instead supply a PKCS#8 PEM through a secret manager. Keep this identity unchanged for every update to a given installed package.
- `STATEMENT_TIMEOUT_MS`: Per-query PostgreSQL statement timeout (`15000` ms default).
- `MAX_QUERY_ROWS`: Maximum rows returned per query (`1000` default).
- `FUNCTION_TIMEOUT_MS`: Hard execution timeout cap for server functions (`5000` ms default).

Generate fresh values for production secrets (for example, `openssl rand -hex 32`) and keep them outside source control. Set `NODE_ENV=production` before exposing the service. In development/test mode the first registered account can bootstrap the local platform; production requires the bootstrap header above. Public platform registration must still be rate-limited and should be closed or constrained by an operator policy where open account creation is not desired.

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

### Android signing-key recovery
Back up `APK_SIGNING_KEY_FILE` separately in an encrypted secret store. Logical database backups do not include this private key. Android will reject an update signed by a replacement key, so losing it can require users to uninstall and reinstall the app. Never place the key in Git or in a downloadable release artifact. After every release build, run `npm run verify:apk` with Android `apksigner` installed.

---

## 5. Upgrades & Migrations

1. Create a full backup before upgrading (`npm run cli -- backup create`).
2. Pull the new release and install dependencies (`npm ci`).
3. Apply platform migrations (`npm run db:migrate`). Platform migrations in `src/db/migrations/` are tracked in `platform_migrations` and executed inside a single transaction.
4. Project-specific schema migrations are tracked independently in `platform_project_migrations` and support transactional rollback via `down_sql` (`POST /v1/projects/:ref/database/migrations/:version/rollback`).
