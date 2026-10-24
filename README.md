# MARRY BASE

<p align="center">
  <img src="assets/logo.png" alt="MARRY BASE official logo" width="180" />
</p>

**MARRY BASE** (also written `MAARY BASE`) is an independent, self-hostable backend platform built on PostgreSQL and TypeScript/Fastify. It provides a control plane for projects, isolated PostgreSQL schemas with native Row-Level Security, application authentication, generated REST/RPC APIs, object storage, WebSocket realtime, isolated server functions, durable background jobs, backups with verified restore, a categorized Management Studio, a CLI, a TypeScript SDK, and a native Android companion app built with the Android Gradle Plugin.

The platform deliberately distinguishes **what is verified** from **what is merely implemented**. Runtime status endpoints, the studio, and this document derive service state from live checks rather than from the existence of a route or class.

---

## Capabilities and verification state

| Area | State | What exists | How it is verified |
| :--- | :--- | :--- | :--- |
| **Control plane & projects** | Operational | Multi-project lifecycle, environment labels, RBAC (`owner`/`admin`/`developer`/`viewer`), scoped API keys with rotation, AES-256-GCM encrypted secrets, audit trail. | Automated lifecycle, RBAC and isolation tests. |
| **PostgreSQL** | Operational | External PostgreSQL 15+ or embedded PGlite (persistent directory or memory). Per-project schemas (`proj_<slug>`), dedicated non-superuser roles, migrations with checksums and rollback, SQL editor with destructive-statement safeguards. | Automated DDL/migration tests plus live `/ready` and per-project status probes. |
| **Row-Level Security** | Operational | `ENABLE`/`FORCE ROW LEVEL SECURITY`, policies, `auth.uid()`, `auth.role()`, `auth.email()`, `auth.project_id()`, `auth.jwt()`, session-scoped claims, per-project privilege boundary that survives `service_role`. | Automated anon/authenticated/service-role tests, including attempt to read the control plane. |
| **Authentication** | Operational | Project user signup/login, scrypt hashing, email verification, password recovery, JWT access tokens, opaque refresh rotation with reuse detection, OAuth identity linking, admin user management. Platform operators use a separate session system. | Automated flow tests (including token replay) and browser-level studio test. |
| **Data API & OpenAPI** | Operational | REST CRUD per table, PostgREST-style filters (`eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `like`, `ilike`, `in`, `is`, `contains`, `or`), ordering, pagination, counts, FK relationship embedding, RPC, OpenAPI 3.1. | Automated CRUD/filter/RLS tests; live endpoint catalogue in the studio. |
| **Object storage** | Operational | Local filesystem or S3-compatible adapter, public/private buckets, per-bucket policies, MIME validation, size limits, quotas, SHA-256 checksums, signed download/upload URLs, multipart uploads. | Automated upload/ACL/signing tests. Backend enforcement, not just UI hiding. |
| **Realtime** | Operational | Authenticated WebSocket endpoint, PostgreSQL trigger capture, broadcast, presence, replay via `lastEventId`. | Automated live WebSocket delivery test; studio inspector connects for real. |
| **Server functions** | Implemented, environment-specific | Versioned JavaScript handlers in a `node:vm` sandbox with a separate OS subprocess boundary, CPU/time limits, captured console logs, secret injection, project-scoped DB bridge. | Sandbox-escape and invocation tests pass; per-project status reports `implemented_unverified` until an invocation is recorded on that instance. |
| **Background jobs** | Operational when a worker runs | Durable PostgreSQL queue, retries with backoff, dead-letter state, idempotency keys, recurring schedules. | Automated retry/dead-letter/schedule tests; status reports `requires_configuration` when `WORKER_ENABLED=false`. |
| **Backups** | Operational | Logical project and platform snapshots, SHA-256 integrity verification, transactional restore, restore timestamps. | Automated create → verify → mutate → restore test; the studio shows whether a restore has ever been exercised. |
| **Management Studio** | Operational | 16 categorized sections covering every subsystem, with live data, validation, confirmations, empty states and responsive layout. | DOM-level end-to-end test renders every section against a live server. |
| **CLI & SDK** | Operational | `npm run cli` and `src/sdk/index.ts`. Not published to npm; use from the repository. | Exercised by the automated suite. |
| **Android companion** | Built in CI; not built on servers without the SDK | Native connection hub (URL policy, `/ready` probe, persistence, TLS enforcement) that then hosts the studio; genuine Gradle/AGP build. | Gradle unit tests + `assembleDebug` + `apksigner`/`aapt2` verification in CI. The server reports `not_built` when no artifact is present and **never fabricates an APK**. |

Every state above is also exposed at `GET /v1/platform/status` (operator-authenticated) and `GET /v1/projects/:ref/status`, with a human-readable summary, the evidence used, and the next action when configuration is incomplete.

---

## Requirements

- **Node.js 22+**
- **Database** — one of:
  - External PostgreSQL 15+ (`DATABASE_URL=postgres://…`, recommended for production),
  - Embedded persistent PostgreSQL (`DATABASE_URL=pglite://./data/postgres`),
  - Embedded in-memory PostgreSQL (`DATABASE_URL=pglite://memory`, for tests only — data is lost on exit).
- **Android build only** — JDK 17+ and the Android SDK (platform 34, build-tools). The server itself does not require Java.

---

## Quick start

### 1. Local, no Docker

```bash
npm install
cp .env.example .env
npm run db:migrate
npm run dev
```

Open `http://localhost:4100`. Register the first operator in the browser.

### 2. Docker Compose with external PostgreSQL 17

```bash
cp .env.example .env
# Set NODE_ENV=production and unique JWT_SECRET, ENCRYPTION_KEY, PLATFORM_BOOTSTRAP_TOKEN,
# POSTGRES_PASSWORD (see docs/OPERATIONS.md).
docker compose up -d --build
```

The API container mounts `/app/data` (backups) and `/app/storage` (objects). Include a Gradle-built APK at `/app/releases/marry-base.apk` (image build or volume mount) if you want in-app downloads; otherwise the API reports `not_built`.

---

## Management Studio

The dependency-free studio is served by Fastify at `/` and `/dashboard`; no frontend build step is required. Navigation is hash-based and bookmarkable.

| Group | Section | What you can do |
| :--- | :--- | :--- |
| Workspace | **Overview** | Live per-service status, real usage counts, environments, endpoint URL, recent audit activity, next actions. |
| Database | **Tables & rows** | Visual schema panel (columns, types, indexes, relationships, policies), create/alter/drop tables, filter-sort-paginate rows, insert/edit/delete rows, toggle RLS. |
| Database | **SQL editor** | Run scoped SQL with role impersonation, destructive-query safeguards and local history. |
| Database | **Migrations** | Apply checksummed migrations, review history, roll back with confirmation. |
| Database | **Roles & RLS** | Project roles and grants, current connection details (never passwords), tables missing RLS, policy editor. |
| Build | **Authentication** | Project users, roles, verification, suspension, policy (signup, verification, TTLs), OAuth/OIDC provider configuration with a real authorize-URL check, token configuration reference. |
| Build | **API** | Generated endpoint catalogue with copyable examples, OpenAPI export, live API tester with a real key, scoped key management. |
| Build | **Storage** | Buckets with usage and limits, upload (file or text), object browser, signed downloads, visibility and deletion. |
| Build | **Realtime** | Connection info, live WebSocket inspector, broadcasts, channels, persisted events. |
| Build | **Functions** | Deploy/version/invoke handlers, captured logs, recent invocation history. |
| Build | **Jobs & schedules** | Enqueue jobs, filter the queue, process due work, cancel, create and remove recurring schedules. |
| Observe | **Logs & diagnostics** | Unified stream across audit, functions, jobs, realtime, storage and backups with source/level filters and service context. |
| Observe | **Backups & recovery** | Create, verify and restore snapshots; migration status; recovery checklist. |
| Configure | **Project settings** | General settings, environments, encrypted secrets, team RBAC, danger zone. |
| Configure | **Platform administration** | Platform service checks, deployment diagnostics, operator accounts, Gradle APK status/build, platform backups, global audit. |
| Configure | **SDK, CLI & docs** | Real base URL, SDK snippet, cURL example, CLI commands, client route reference, integration checklist. |

Keyboard: `Ctrl/Cmd + K` opens the command menu, `Ctrl/Cmd + Enter` runs the SQL editor.

Studio source: `public/dashboard/{index.html,styles.css,app.js,js/{core,pages,actions}.js}`.

---

## API, CLI and SDK

- **REST/RPC base:** `http://<host>:4100/v1/projects/<projectRef>`
  - `/rest/:table`, `/rpc/:fn`, `/openapi.json`
- **Auth:** `/auth/login`, `/auth/refresh`, `/auth/logout`, `/auth/user`, `/auth/recover`, `/auth/reset-password`, `/auth/verify`, `/auth/oauth/:provider`
- **Storage:** `/storage/buckets`, `/storage/buckets/:bucket/objects/:path`, `/storage/buckets/:bucket/sign/:path`
- **Functions:** `/functions/:slug/invoke`
- **Realtime:** `ws(s)://<host>/v1/projects/<projectRef>/realtime/ws?apikey=…`
- **Operations (new):** `/v1/platform/status`, `/v1/platform/version`, `/v1/projects/:ref/status`, `/v1/projects/:ref/logs`, `/v1/projects/:ref/database/roles`, `/v1/projects/:ref/database/connection`, `/v1/projects/:ref/api/endpoints`, `/v1/platform/apk/status`

See [`docs/API_REFERENCE.md`](docs/API_REFERENCE.md) for the full reference.

### CLI

```bash
npm run cli -- status
npm run cli -- projects create "Acme App" acme-app
npm run cli -- projects inspect acme-app
npm run cli -- sql acme-app "SELECT current_schema();"
npm run cli -- functions deploy acme-app hello ./hello.js
npm run cli -- functions invoke acme-app hello '{"name":"Ada"}'
npm run cli -- backup create acme-app
npm run cli -- backup verify <backupId>
npm run cli -- backup restore <backupId>
npm run cli -- apk status
npm run cli -- apk build 1.1.0 2      # requires JDK 17 + Android SDK
```

### SDK

```ts
import { createMaaryClient } from "./src/sdk/index.js";

const maary = createMaaryClient("http://localhost:4100", "<PROJECT_ANON_KEY>", {
  projectRef: "acme-app",
});

const { data, error } = await maary
  .from("todos")
  .select("*")
  .order("created_at", { ascending: false });
```

The SDK is repository source, not an npm package. It is exercised by the automated test suite.

---

## Android companion app

The native app owns the device-side connection workflow; the Management Studio is served by the connected instance.

**Native responsibilities**

- Validate the server address (HTTPS anywhere; plain HTTP only for loopback, emulator loopback and RFC1918/link-local hosts; no embedded credentials, query strings or fragments).
- Probe `/ready` and show the server's own dependency report (database, migrations, storage, worker).
- Persist the last verified server, reopen it on launch, and expose “Change server”, “Reload” and “Open in browser”.
- Reject invalid TLS certificates (no “proceed anyway”), block mixed content, and keep file/universal file access disabled.
- Show a native error dialog with retry when the studio cannot load.

**Studio responsibilities** — projects, schema, SQL, auth, storage, functions, jobs, realtime, logs, backups and settings.

### Building the APK — genuine Gradle pipeline only

```bash
# Workstation / CI with JDK 17 and ANDROID_HOME pointing at an SDK with platform 34
cd android
./gradlew :app:testDebugUnitTest
./gradlew :app:assembleDebug -PmarryVersionName=1.1.0 -PmarryVersionCode=2
```

Or, from the repository root: `npm run android:build`. This invokes Gradle and copies
`android/app/build/outputs/apk/debug/app-debug.apk` to `releases/marry-base.apk` with a
metadata sidecar.

The server does **not** generate Android bytecode, AXML, ARSC, DEX or signatures, and there is no
ZIP-fabrication fallback. Without a JDK and SDK it returns HTTP 409 `apk_build_unavailable`
listing the missing prerequisites. `GET /v1/platform/apk/download` returns 404 with an actionable
message until a verified artifact exists. CI builds the APK, verifies it with `apksigner`, `aapt2`
and `zipalign`, uploads it as a workflow artifact, and only then runs the integration suite.

Signing: CI uses the generated debug keystore so the artifact is installable and verifiable. For
store distribution, configure a release keystore (see [`docs/ANDROID.md`](docs/ANDROID.md)); the
signing identity must stay stable across updates.

---

## Verification

```bash
npm run typecheck     # TypeScript
npm run check:studio  # dashboard modules parse
npm run check:mobile  # mobile browser hub parses
npm run build         # production bundle (tsc → dist/)
npm test              # 21 integration/DOM tests
```

Test suites cover: health/readiness, operator auth and session rotation, project lifecycle and
RBAC isolation, data API CRUD/filters/RLS, storage ACLs and signed URLs, functions sandbox,
jobs/retries, backup restore, realtime WebSocket delivery, CLI/SDK, Android artifact honesty, the
new operational endpoints, and full studio rendering/navigation against a live server.

See [`docs/VERIFICATION.md`](docs/VERIFICATION.md) for what was actually executed in this
environment and what remains environment-dependent (notably the Android Gradle build).

---

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — boundaries, isolation model, subsystems, studio architecture.
- [`docs/API_REFERENCE.md`](docs/API_REFERENCE.md) — HTTP & WebSocket endpoints.
- [`docs/OPERATIONS.md`](docs/OPERATIONS.md) — installation, configuration, backups, upgrades, troubleshooting.
- [`docs/ANDROID.md`](docs/ANDROID.md) — Android architecture, build, signing, verification.
- [`docs/VERIFICATION.md`](docs/VERIFICATION.md) — executed test evidence, manual probes, unverified items.
- [`docs/IMPLEMENTATION_REPORT.md`](docs/IMPLEMENTATION_REPORT.md) — final report: what was completed, verified, and what remains unverified.
