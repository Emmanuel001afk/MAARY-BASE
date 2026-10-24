# MARRY BASE

<p align="center">
  <img src="assets/logo.png" alt="MARRY BASE Official Logo" width="180" />
</p>

**MARRY BASE** (aliased as `MAARY BASE`) is a self-hostable backend development platform built on PostgreSQL, TypeScript, and Fastify. It combines an operator Management Studio, workspaces/organizations, multi-project PostgreSQL schema and role isolation, native Row-Level Security (RLS), end-user authentication, auto-generated REST and RPC Data APIs, object storage, WebSocket realtime streams, isolated child-worker server functions, durable background jobs, SHA-256 verified backups, a CLI, a TypeScript SDK, and a native **Android companion app** compiled via an authentic Gradle build pipeline.

---

## Core Capabilities

| Domain | Capabilities |
| :--- | :--- |
| **Organizations & Projects** | Workspaces (`platform_organizations`) with inherited team RBAC (`owner`, `admin`, `developer`, `viewer`), per-project environments, quotas, scoped API keys (`anon`, `service_role`), and AES-256-GCM encrypted secrets. |
| **Database & Migrations** | External PostgreSQL (`postgres://`) or embedded PGlite (`pglite://`), dedicated schema (`proj_<slug>`) + least-privilege roles (`role_<slug>`, `role_<slug>_rls`), visual/JSON table creation, safe schema alteration (columns, FKs, indexes), versioned migrations with SHA-256 checksums and rollbacks, and scoped SQL workbench. |
| **Row-Level Security (RLS)** | Native PostgreSQL `ENABLE/FORCE ROW LEVEL SECURITY` and policies powered by `auth.uid()`, `auth.role()`, `auth.email()`, `auth.project_id()`, and `auth.jwt()` transactional session claims. |
| **Authentication & Identity** | End-user signup/login, `scrypt` password hashing, refresh-token rotation with reuse detection, active session inspection/revocation, password recovery/reset, OAuth provider configuration, and separate platform Superadmin RBAC. |
| **Data API & OpenAPI** | Auto-generated REST CRUD (`/v1/projects/:ref/rest/:table`) with PostgREST-style filters, sorting, pagination, relationship embedding, PostgreSQL RPC (`/v1/projects/:ref/rpc/:fn`), interactive Studio API Explorer, and live OpenAPI 3.1 schema. |
| **Object Storage** | Public and private buckets, quota & MIME-type limits, backend-enforced bucket policies (`path_prefix`, `allow_owner_only`, roles), SHA-256 checksums, metadata inspection, HMAC signed download/upload URLs, and multipart uploads. |
| **Realtime** | Authenticated WebSocket broker (`/v1/projects/:ref/realtime/ws`), transactional PostgreSQL change-capture triggers, public/private channel configs, HTTP/WS broadcast, presence, and `lastEventId` replay. |
| **Server Functions & Jobs** | Versioned ESM functions executed in isolated, permission-restricted child processes (`--permission`) with `envVars` and encrypted secrets; durable PostgreSQL job queue with retries, SSRF-guarded HTTP webhooks, and recurring schedules. |
| **Observability & Backups** | Truthful live module status verification (`operational_verified`, `requires_configuration`, `unavailable`, `failed`), structured error logs, audit trails, Prometheus/JSON metrics, and v2 disaster-recovery snapshots with SHA-256 verification and safeguarded restore. |
| **Android Companion (`android/`)** | Native Android client (`com.marrybase.platform`, SDK 34, Java 17, AGP 8.5.2) with `/ready` + `/v1/platform` verification, HTTPS enforcement for remote hosts, saved server URLs, connection recovery UI, and origin-locked hardened `WebView`. Compiled and signed via Gradle in `.github/workflows/ci.yml` and uploaded as a physical `.apk` workflow artifact. |

---

## PostgreSQL vs Embedded PGlite

- **Production Self-Hosting (`DATABASE_URL=postgres://...`)**: Strongly recommended for production deployments (via `compose.yaml` with PostgreSQL 16+ or managed PostgreSQL). Provides multi-connection pooling, true OS-level concurrency, native PostgreSQL role enforcement, and point-in-time WAL backups.
- **Local Evaluation & Automated Tests (`DATABASE_URL=pglite://./data/postgres` or `pglite://memory`)**: Runs single-process embedded WebAssembly PostgreSQL with zero external dependencies for instant local onboarding and CI integration tests.

---

## Quick Start

### 1. Local Development (Zero External Dependencies)

```bash
npm ci
cp .env.example .env
npm run db:migrate
npm run dev
```

Open `http://localhost:4100` to enter the **MARRY BASE Management Studio**. In development mode, the first account registered automatically receives initial **Superadmin** privileges and a default workspace.

### 2. Production Docker Compose (PostgreSQL 16)

```bash
cp .env.example .env
# Edit .env and set unique 32+ byte values for:
# POSTGRES_PASSWORD, JWT_SECRET, ENCRYPTION_KEY, PLATFORM_BOOTSTRAP_TOKEN
docker compose up -d --build
curl -f http://127.0.0.1:4100/ready
```

When `NODE_ENV=production`, registering the very first Superadmin account requires supplying `PLATFORM_BOOTSTRAP_TOKEN` (either in the Studio registration screen's Bootstrap Token field or via the `x-platform-bootstrap-token` HTTP header).

---

## Building & Verifying the Android APK

MARRY BASE builds its Android companion app exclusively from the native Gradle project in `android/` — never from fabricated archive bytes.

### Prerequisites for Local Android Builds
- JDK 17+ (`java`)
- Android SDK Platform 34 & Build-Tools 34.0.0 (`ANDROID_HOME` or `ANDROID_SDK_ROOT`)
- Gradle 8.7+ (`gradle`)

```bash
# Compile and sign the debug APK via Gradle and copy to releases/marry-base-android.apk
gradle --project-dir android assembleDebug lintDebug --no-daemon --stacktrace
mkdir -p releases
cp android/app/build/outputs/apk/debug/app-debug.apk releases/marry-base-android.apk

# Verify ZIP structure, binary AXML AndroidManifest.xml, resources.arsc, classes.dex, and apksigner signature
node scripts/verify-apk.mjs releases/marry-base-android.apk --require-apksigner
```

Or invoke via the MARRY BASE CLI when the Android toolchain is installed locally:

```bash
npm run build:android
```

In GitHub Actions (`.github/workflows/ci.yml`), the `android` job provisions JDK 17, Android SDK 34, and Gradle 8.7, compiles `assembleDebug lintDebug`, runs `scripts/verify-apk.mjs --require-apksigner`, and uploads `releases/marry-base-android.apk` as the downloadable `marry-base-android-apk` workflow artifact.

---

## Verification & Testing

```bash
npm run typecheck      # TypeScript strict verification
npm run check:studio   # Management Studio ES module syntax check
npm run check:mobile   # Mobile web companion syntax check
npm test               # Full backend, security, isolation & Studio test suite
npm run build          # Production build to dist/
```

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — System boundaries, multi-project PostgreSQL/RLS isolation, worker security, and Android architecture.
- [`docs/API_REFERENCE.md`](docs/API_REFERENCE.md) — Complete HTTP & WebSocket API reference.
- [`docs/OPERATIONS.md`](docs/OPERATIONS.md) — Self-hosting operations, bootstrap security, backups/restore, monitoring, and upgrades.
