# MARRY BASE Operations & Self-Hosting Guide

## 1. Runtime & Database Recommendations

| Deployment Tier | CPU / RAM | Database Engine | Storage |
| :--- | :--- | :--- | :--- |
| **Local Dev / CI** | 1+ vCPU, 512 MB+ RAM | `pglite://./data/postgres` or `pglite://memory` | Local filesystem |
| **Production Self-Hosted** | 2+ vCPU, 2 GB+ RAM | External PostgreSQL 16+ (`postgres://...`) | Persistent SSD volumes (`/var/lib/postgresql/data`, `/app/storage`, `/app/data/backups`) |

> **Why external PostgreSQL for production?** Embedded PGlite runs in-process for convenient single-developer onboarding and tests, whereas external PostgreSQL 16+ provides true multi-client connection pooling, native OS role enforcement, concurrent worker throughput, and continuous WAL archiving.

> **Android phone lab:** `npm run start:phone` starts the same Fastify API from Termux with PGlite and `HOST=0.0.0.0`. It is for trusted local/LAN evaluation only, not production. See [`PHONE_AS_SERVER.md`](PHONE_AS_SERVER.md) for exact client URLs, HTTPS requirements, wake-lock guidance, and backups.

---

## 2. Production Environment Variables

Configure `.env` before running `docker compose up -d --build`:

- `NODE_ENV=production` — Enforces non-default cryptographic secrets and bootstrap token protection.
- `DATABASE_URL=postgres://user:password@database:5432/maary`
- `JWT_SECRET` — Minimum 32 random characters (`openssl rand -hex 32`).
- `ENCRYPTION_KEY` — Minimum 32 random characters for AES-256-GCM encryption of project secrets and API keys.
- `PLATFORM_BOOTSTRAP_TOKEN` — Minimum 32 random characters required once to register the initial Superadmin account in production.
- `TRUST_PROXY=true` — Enable only when deployed behind a trusted reverse proxy (Caddy, Nginx, Traefik, Cloudflare) terminating TLS.
- `WEBHOOK_ALLOW_PRIVATE_NETWORKS=false` — Blocks background webhook jobs from targeting loopback/RFC1918 internal addresses (SSRF protection).
- `ANDROID_APK_PATH` — Optional path to a compiled & `apksigner`-verified APK artifact to serve from `GET /v1/platform/apk/download`.

---

## 3. Initial Admin Bootstrap

1. Start the stack (`docker compose up -d --build`) and verify readiness (`curl -f http://127.0.0.1:4100/ready`).
2. Open the Management Studio (`/`) and select **Create account**, or call `POST /v1/platform/auth/register` with header `x-platform-bootstrap-token: <PLATFORM_BOOTSTRAP_TOKEN>`.
3. The first account atomically acquires a table lock and receives `is_superadmin = true` plus a default Organization workspace. Subsequent accounts do not receive superadmin privileges unless promoted by an existing Superadmin in **Platform Admin**.

---

## 4. Backups, Integrity Verification & Disaster Recovery

```bash
# Create a project-scoped snapshot or full-platform snapshot
npm run cli -- backup create <projectSlug>
npm run cli -- backup create

# Verify SHA-256 digest against on-disk archive before restoring
npm run cli -- backup verify <backupId>

# Restore verified archive inside a transaction
npm run cli -- backup restore <backupId>
```

---

## 5. Android Companion Build & CI Pipeline

- Source lives in `android/` (`compileSdk 34`, `minSdk 24`, Java 17, AGP 8.5.2).
- GitHub Actions (`.github/workflows/ci.yml`) compiles `gradle --project-dir android assembleDebug lintDebug`, verifies the binary APK and cryptographic v2+ signature via `node scripts/verify-apk.mjs releases/marry-base-android.apk --require-apksigner`, and uploads the physical `.apk` artifact (`marry-base-android-apk`).
- For production Play Store or enterprise distribution, configure a dedicated release keystore outside Git and sign `assembleRelease` with `apksigner`.
