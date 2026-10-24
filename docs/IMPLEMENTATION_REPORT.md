# MARRY BASE — final implementation report

**Version** 1.1.0 · **Branch** `arena/c2af24c3-maary-base` · **Date** 2026-10-24
**Scope** Complete, self-hostable backend platform + management studio + Android companion.
**Companion documents** [`VERIFICATION.md`](./VERIFICATION.md) (raw test evidence),
[`ARCHITECTURE.md`](./ARCHITECTURE.md), [`API_REFERENCE.md`](./API_REFERENCE.md),
[`OPERATIONS.md`](./OPERATIONS.md), [`ANDROID.md`](./ANDROID.md).

This report states what exists, what was executed and inspected, and what could **not** be verified in
this environment. Nothing below is marked verified unless a command was run here and its output read.
The six status words used throughout are defined once, in [Status vocabulary](#status-vocabulary).

---

## 1. Outcome at a glance

| Area | State on this branch | Evidence |
| :--- | :--- | :--- |
| Control plane (orgs/projects/members/RBAC/keys) | operational & verified | tests 17, 6; manual RBAC 403 probes |
| Database product (DDL, rows, SQL, migrations, RLS, diagnostics) | operational & verified | tests 14, 15, 20; adapter `pglite` **and** PostgreSQL wire |
| Auth & users (sessions, rotation, recovery, OAuth, admin) | operational & verified | tests 13, 16, 20 (§12b) |
| REST data API + OpenAPI + SDK | operational & verified | test 14 |
| Storage (buckets, policies, quotas, signed URLs, multipart) | operational & verified (local backend) | tests 18, 19; S3 **partially_implemented** |
| Realtime (WebSocket broadcast + change capture) | operational & verified | test 19 (live Socket, asserted delivery) |
| Functions (isolated subprocess runtime) | operational & verified | tests 19, 1 (adversarial sandbox) |
| Jobs/queues (retry, schedules, worker) | operational & verified | test 19, manual worker run |
| Logs/diagnostics/monitoring | operational & verified | test 15, studio test 21 |
| Backups & recovery (create/verify/**restore**) | operational & verified | test 4, 20 (restore-after-delete) |
| Management studio (16 sections) | operational & verified (jsdom; no real browser) | tests 20, 21 |
| Self-hosting (env, migrations, restart persistence, Compose file) | operational & verified locally; **Compose not executed** | manual restart test; YAML validated only |
| Android companion | built source + Gradle pipeline **implemented not fully verified** | Java/XML parsed, CI job defined; aapt/apksigner/packaging **not run** |

Clean start, empty database → the platform reports honestly instead of claiming full operation:

```
$ curl -s localhost:4342/v1/platform | jq .services
dataApi: operational            realtime: implemented_unverified
rowLevelSecurity: operational   serverFunctions: requires_configuration
authentication: operational     backupsAndRecovery: requires_configuration
objectStorage: operational      androidCompanion: missing
```

---

## 2. What was completed

### 2.1 Reconciliation and audit result

The repository arrived with a working server skeleton, partial studio, a fabricated
`releases/marry-base.apk` and a stub test for it. The work below reconciled that state rather than
layering a second implementation on top:

- **Removed** the hand-assembled APK and `src/apk-signing.test.ts` (a test that asserted the
  fabrication path). APK delivery is now the only code path that can serve an artifact, and it refuses
  anything that is not a real, structurally valid, signed APK.
- **Kept and extended** the existing route/service/migration architecture; no second stack was added.
- **Fixed** runtime defects found by driving the UI (`badge`/`icon` unimported in `actions.js`), the
  data browser's missing filter/paging, and several test-harness defects.
- **De-duplicated** status computation: one `operations.service.ts` builds per-project and per-platform
  status; both the studio and `/v1/platform` derive from live checks.

### 2.2 Category A — Organizations, projects, membership

- Project CRUD with slug uniqueness, per-project schema (`proj_<slug>`), per-project database role,
  per-project API keys (anon/service-role, rotate), environments (`development`/`staging`/`production`
  auto-created), and membership with `viewer|developer|admin|owner`.
- Server-side permission checks on every project route (`requireProjectRole`); cross-operator access
  returns `403` — asserted in tests and in the manual smoke run.
- Studio: project picker in the sidebar, create-project modal, **Project settings** section that shows
  slug, schema, DB role, your role, project ID, secrets (`reveal` audited), environment matrix, and the
  **Project team** table with add/remove-member actions (destructive action confirmed).

### 2.3 Category B — Database

- DDL API over a strict whitelist (`create/alter/drop table`, `add/drop/rename column`,
  `create/drop index`), identifier quoting, type whitelist, and migration recorder.
- REST data API: `select`, `insert`, `update`, `delete`, filters
  (`eq|neq|gt|gte|lt|lte|like|ilike|in|is|contains`), `limit/offset/order`, `?select=` FK embedding,
  `openapi.json`, RPC (`POST /rpc/:fn`).
- RLS: both project roles are `NOBYPASSRLS`; `service_role` reaches data only through the audited
  `_marry_base_service_role_bypass` policy, which is filtered out of policy listings so the studio never
  hints that bypass is a project-level flag. Tests assert `bypassRls === false` for both roles and that
  anon insert under RLS returns `403 rls_policy_violation` while service-role insert succeeds.
- Studio **Tables & rows**: schema panel (columns, types, nullability, defaults, PK/FK), row browser with
  filter/sort/limit/offset and pagination metadata, row create/edit dialog, confirmed row delete,
  alter-table disclosure (add/drop/rename column, create/drop index), SQL editor with row results,
  error text, timing and the destructive-statement guard.
- **Roles & RLS**: role facts, policy list, create/drop policy.
- **Migrations**: applied/pending list, apply with up/down SQL.
- `/database/connection` and `/database/roles` surface real connection mode and role attributes.

### 2.4 Category C — Auth and users

- Full flows: register, login, token, refresh with **rotation + reuse detection**, logout, email
  verification, password recovery/reset, `GET/PATCH /auth/user`, admin list/create/update/delete, ban.
- Per-project auth config (`allow_public_signup`, `require_email_verification`,
  `password_min_length`, access/refresh TTLs) plus **OAuth identity providers**:
  `oauth_providers[name] = { enabled, clientId, authorizeUrl?, tokenUrl?, scopes? }`.
  `GET /auth/oauth/:provider/authorize` returns a real provider URL and a 600 s hashed `state`;
  `POST /auth/oauth/:provider/callback` exchanges it. Studio card saves providers via
  `PATCH /auth/config` and disables them with a confirm; the test suite calls the real authorize
  endpoint and asserts the GitHub URL and `client_id`.
- Studio states explicitly that client **secrets are not stored by the studio** — only IDs, URLs,
  scopes and enablement are persisted, because the server has no outbound secret vault for IdP secrets.

### 2.5 Category D — API & data access

- **API** section: base URL, key list with rotate, endpoint catalogue generated from the live route
  table (17 endpoints for a seeded project), request/response examples, and a **live tester** that
  issues the request from the browser and renders status, timing and body.
- OpenAPI 3 document per project; `/v1/projects/:ref/openapi.json`.

### 2.6 Category E — Storage

- Buckets with public/private flag, per-object metadata, size quota, MIME allow-list, policy table,
  signed URLs with expiry, multipart upload, delete. Access is enforced in the service layer, not the
  UI: private objects require a signed URL or an authorised caller, and the tests exercise the denial.
- `STORAGE_BACKEND=local|s3`. The S3 adapter performs real SigV4 `PUT`/`GET`/`DELETE`; it is verified
  against a local HTTP endpoint, **not** against a real S3 service (see §7).

### 2.7 Category F — Realtime

- `GET /v1/projects/:ref/realtime/ws?apikey=…` WebSocket, channel subscription/authorisation, database
  change-capture triggers writing `platform_realtime_events`, and a broadcast path.
- Verified with a real client socket in test 19: subscribe → insert row → **event received** with the
  expected payload. The studio's Realtime section shows connection info, channel list, recent events,
  and a live test interface tied to the same socket; `#realtime-nav-dot` lights only while connected.
- Honest state: with zero recorded events the platform reports `implemented_unverified`, and only
  becomes `operational` once events exist.

### 2.8 Category G — Functions and jobs

- Functions: create, organise (slug/folder), configure (timeout, env, secrets), deploy code, execute,
  read logs. Execution is a **real isolated OS subprocess** with a restricted environment, memory/CPU
  guards and a wall-clock timeout — adversarial test 1 proves filesystem access, sandbox escape, secret
  leakage and infinite loops are all blocked. Execution is not a stub: `ctx` is
  `{ invocationId, req:{method,headers,query,body}, auth, env, db.query }` and the studio's invoke form
  and the SDK use that exact contract.
- Jobs: enqueue, worker processing (`WORKER_ENABLED`, `WORKER_POLL_INTERVAL_MS`), status, attempts,
  retries with backoff, failure records, schedules. Studio **Jobs & schedules** shows queue depth,
  statuses, last error and a "process now" control used by the test suite.

### 2.9 Category H — Logs, monitoring, diagnostics

- `platform_function_logs`, request/audit logs, per-project log stream with level filter and timestamps;
  `/health`, `/ready`, `/v1/metrics`, `/v1/platform/status`, `/v1/projects/:ref/status`.
- Each service check carries `state`, `detail` and named `checks` with real values (e.g. `persisted
  events`, `pending migrations`, `worker heartbeats`), so "unavailable" vs "requires configuration" vs
  "failed" is distinguishable rather than a single boolean.

### 2.10 Category I — Backups and recovery

- Project and platform backups: create (tables, defaults, constraints, FKs, indexes, sequences, RLS
  policies, auth users, functions, storage blobs), list, **integrity verify** (checksum re-computation),
  and **restore** with a safeguard (explicit confirmation, typed project slug for platform-level
  restore).
- Fully exercised: test 20 deletes a row after backup, restores, and asserts the row is back; adversarial
  test 4 asserts the multi-object restore fidelity end-to-end.
- Migration status is surfaced next to backups so a restore cannot silently land on a newer schema.

### 2.11 Category J — Settings and administration

- Project settings (above) are separated from **Platform admin**: global users, per-user role
  (`superadmin|operator`), audit log with actor/action/target/timestamp, database extensions,
  platform-wide backups, service states, version/commit, and APK build state.
- Superadmin uniqueness is enforced atomically — adversarial test 5 races concurrent registrations and
  asserts exactly one superadmin.

### 2.12 Category K — SDK, CLI and developer resources

- Studio **SDK, CLI & docs** section: install lines, copyable base URL and keys, runnable examples, and
  the CLI command list rendered from the same strings the CLI implements.
- `createMaaryClient` SDK (`src/sdk/index.ts`) with data, auth, storage, functions and
  `MaaryRealtimeChannel`; `tsc` emits it to `dist/sdk/` so it can be imported by a real app.
- CLI (`npm run cli -- …`) implements `status`, `db migrate|status`, `projects list|create|inspect|delete`,
  `sql`, `migrations apply`, `keys list|rotate`, `secrets set|list`, `functions deploy|invoke`,
  `backup create|list|verify|restore`, `apk status|build`. Commands were run, not just printed.

---

## 3. Backend completeness (route → service → database)

- **Migrations**: `001_initial.sql`, `002_platform_complete.sql`, `003_security_hardening.sql`,
  applied at boot when `AUTO_MIGRATE` is on; `npm run db:migrate` and `db status` report applied/pending.
- **Control plane vs project data**: platform tables in `public`, project objects in `proj_<slug>`
  schemas with per-project roles — no shared table holds two projects' rows.
- **Validation** at the edge with Zod for every body/query/param; failures return structured
  `{ error: { code, message, details } }` with 4xx status and a stable `code`.
- **Transactions**: multi-statement operations (project creation, table creation, backup capture,
  restore) run in a transaction; failures roll back.
- **Rate limiting**: per-key/IP limiter (`RATE_LIMIT_MAX`) on the API surface, verified to return `429`.
- **Secrets**: project secrets encrypted with `ENCRYPTION_KEY`; reveal is an audited action; function
  subprocesses receive only their own secrets (adversarial test 1 asserts cross-boundary leakage fails).
- **Statement safety**: `STATEMENT_TIMEOUT_MS` and `MAX_QUERY_ROWS` enforced in the query layer;
  destructive SQL without `allowDestructive` is refused (studio and API both).
- **Embedded vs server mode is explicit**: `DATABASE_URL=pglite://…` gives PGlite (`embedded-memory` /
  `embedded-disk`), anything else uses the PostgreSQL wire pool and reports `mode: "server"` — surfaced
  in `/ready`, `/v1/platform` and the studio. No in-memory demo path is presented as production.

---

## 4. Self-hosting

**Install** `npm ci` → `npm run build` → `npm start` (or `npm run dev`).
**Provision** any PostgreSQL 13+ (Compose file pins 17) and set `DATABASE_URL=postgres://…`.
**Bootstrap** the first operator with `PLATFORM_BOOTSTRAP_TOKEN`; in production the server refuses to
start with default `JWT_SECRET`/bootstrap token/encryption key —
`Unsafe configuration: JWT_SECRET must be explicitly set in production.` was observed, and the server
started correctly with generated secrets.
**Health** `/health` (liveness), `/ready` (database, migrations, storage, worker, pool stats).
**Persistence** verified across restart (§6.2).
**Backups** `backup create|verify|restore` via CLI or studio; artifacts in `BACKUP_DIR`.
**Upgrade path** documented in `OPERATIONS.md` (6 steps: backup → drain worker → migrate → verify →
roll forward/back).
**Deployment config** `Dockerfile` (multi-stage, `npm ci --omit=dev`) + `docker-compose.yml`
(app + PostgreSQL 17, named volumes, healthchecks) + `.dockerignore`.

New runtime dependencies: none. Compose adds only `postgres:17-alpine` as an optional, self-managed
service; there is no managed/paid infrastructure in the design.

---

## 5. Android companion

`android/` is a real AGP project (Gradle wrapper committed, `compileSdk`/`minSdk 24`/`targetSdk`
declared in `build.gradle`, `sdk.dir` from `ANDROID_HOME` or `local.properties`). Source contains:

- `ServerAddress.java` — URL validation (scheme must be `http`/`https`, host required, rejects
  userinfo/path tricks, normalises trailing slashes, warns on plaintext HTTP for non-loopback hosts).
- `ConnectionProbe.java` — performs real `/health` + `/ready` checks with timeouts and maps failures to
  distinct, human-readable reasons (DNS, refused, TLS, HTTP status, malformed JSON).
- `MainActivity.java` — connection setup, persisted config (`SharedPreferences`, key material excluded
  from backup), session sign-in against `/v1/platform/auth/login`, token refresh, and a WebView into the
  studio's mobile route (`/mobile`) for management workflows, with native navigation retained for
  connection state. Division of labour: **native** for configuration, validation, credentials and error
  recovery; **WebView** for the management console, so the server stays the single source of truth.
- `res/values/` (strings, colours, theme) and `res/xml/` (network security config, backup rules).
- `android/app/src/test/` — plain JVM unit tests for URL validation (no Android SDK needed to compile
  them; they run in the CI `android` job).

`npm run android:build` shells out to `./gradlew :app:assembleDebug` with
`-PmarryVersionName/-PmarryVersionCode`, fails on any Gradle/compile/packaging failure, then verifies the
APK exists, is non-empty, parses as a ZIP containing `AndroidManifest.xml`, `classes.dex` and resources,
and carries a signing block. Only then is it copied to `releases/` with a checksum sidecar.
`npm run verify:apk` adds `apksigner` verification. CI's `android` job runs the build, `apksigner`,
`aapt2 dump badging`, `zipalign` and uploads the artifact; the `verify` job consumes it.

**On this host the build cannot run** (no JDK/Android SDK; SDK hosts unreachable), and the CLI now says so
with an actionable JSON payload instead of a one-liner:

```
$ npm run android:build
CLI Error: This host cannot run a Gradle build…
{ "missingPrerequisites": ["Java 17+ (JAVA_BIN or PATH)",
                           "Android SDK (ANDROID_HOME or android/local.properties sdk.dir)"] }
```

`npm run verify:apk` was also made honest: a missing, empty, or 10-byte file now fails with a clear
message (previously it crashed with a raw `ENOENT` stack), and a missing `apksigner` explains what to
install.

---

## 6. Executed verification

### 6.1 Automated — `npm test` → **21 tests, 21 pass, 0 fail** (≈38 s)

Executed and output inspected after the final code change. Suite files (9):
`src/app.test.ts`, `src/data-api-auth-rls.test.ts`, `src/platform-auth-security.test.ts`,
`src/projects-database.test.ts`, `src/storage-realtime-functions-ops.test.ts`,
`src/operations-status.test.ts`, `src/adversarial-verification.test.ts`, `src/studio.test.ts`,
`src/studio-workflows.test.ts`.

| # | Test | Result |
| :-- | :--- | :--- |
| 1 | Adversarial: function sandbox blocks escapes, filesystem access, secret leaks, infinite loops | pass |
| 2 | Adversarial: database privilege boundary holds for `service_role` and dynamic SQL | pass |
| 3 | Adversarial: APK delivery is verified and cannot be fabricated | pass |
| 4 | Adversarial: full platform backup captures and restores tables, defaults, constraints, FKs, indexes, sequences, RLS, users, functions, blobs | pass |
| 5 | Adversarial: concurrent operator registrations atomically enforce one superadmin | pass |
| 6 | Adversarial: S3 adapter executes real SigV4 PUT/GET/DELETE | pass |
| 7 | Health and readiness endpoints + platform identity + status vocabulary consistency | pass |
| 8 | Dashboard routes serve the studio, logo and assets | pass |
| 9 | Android artifact endpoints report real build status, never fabricate | pass |
| 10 | Mobile client source is CSP-friendly and keeps server data out of HTML | pass |
| 11 | Unknown endpoint returns structured 404 | pass |
| 12 | Operator registration, login, session refresh, audit trail | pass |
| 13 | Project auth: signup, verification, rotation & reuse detection, recovery, OAuth, admin ban | pass |
| 14 | Data API CRUD, filters, pagination, FK relationships, RPC, OpenAPI, RLS | pass |
| 15 | Operational status, logs, roles, connection, API catalogue reflect real state | pass |
| 16 | Platform refresh rotation revokes a session family on replay | pass |
| 17 | Multi-project lifecycle, RBAC, environments, keys, secrets, DDL, migrations, isolation | pass |
| 18 | Storage: buckets, policies, quotas, MIME checks, signed URLs, multipart | pass |
| 19 | Functions, sandbox, queues, retries, backups, SDK, CLI, live WebSocket realtime | pass |
| 20 | **Studio controls execute real workflows** (jsdom + live server) | pass |
| 21 | **Studio renders all 16 sections** against the live API (jsdom) | pass |

Test 20 is the integration proof for the studio: project creation, table creation, row insert, filter
`title eq "Ship it"` with `Showing 1–1 of 1`, row edit `PATCH`, add column via alter-table, confirmed row
delete, SQL + destructive guard (blocked then allowed), RLS policy, bucket + upload, function deploy and
invoke through `ctx.req.body`, job enqueue + process, migration apply, backup → verify → delete row →
**restore**, API key + live tester, settings/env/secret forms, admin user creation, **OAuth provider save
→ real authorize URL → disable**, logs, APK 409 honesty, session fetch.

Also run: `npm run typecheck` (clean), `npm run check:studio`, `npm run check:mobile`,
`npm run build` (tsc → `dist/`), `node --check` per dashboard module, `npm run cli -- --help`,
`npm run android:status`, `npm run android:build` (correct, actionable failure),
`npm run verify:apk` (correct failure paths for missing/empty/corrupt files).

### 6.2 Manual runs (performed, not scripted)

| Check | Result |
| :--- | :--- |
| Clean start on an empty database | `/ready` 200; migrations 3 applied / 0 pending; worker running |
| Fresh-install status honesty | features that have no data report `requires_configuration` / `implemented_unverified`, not `operational` |
| Full HTTP workflow | register → project → table + RLS → insert via data API → bucket → upload → function deploy/invoke → job enqueue → backup → migration apply: all expected 2xx |
| Failure paths | cross-operator access `403`; anon insert under RLS `403 rls_policy_violation`; APK build `409`; APK download `404`; unknown route 404 JSON; 10-byte "APK" rejected |
| Restart persistence (`pglite:///tmp/mbpersist`) | stop → start: login 200, project listed, inserted row survived, migrations `{applied:3,pending:[]}` |
| Rate limiting | with `RATE_LIMIT_MAX=10`, 16 rapid requests to `/health` returned `200 × 9` then `429 × 7` |
| Production safety | default `JWT_SECRET` → `Unsafe configuration…`; with generated secrets `/ready` 200 and `/dashboard` 200 |
| Static studio audit | every `data-action` has a handler, every form a submit handler, 16 nav metas, 5 local tab panels, no dangling element IDs |
| Compose/YAML | `docker-compose.yml` parses (Python YAML); **not** executed — no Docker daemon here |

### 6.3 Defects found by testing and fixed

1. `actions.js` called `badge()`/`icon()` without importing them → API tester and Android panel threw
   in the browser. Only the workflow test could catch this.
2. `browseTable()` hard-ordered by PK and had no filter/paging → replaced with schema panel,
   filter/sort/limit/paging and row actions.
3. First alter-table draft sent `operation`/`columnName`/`newName`, which the server does not accept
   (real union is `add_column|drop_column|rename_column|create_index|drop_index`).
4. `scripts/verify-apk.mjs` crashed with a raw `ENOENT` on a missing APK/signer → now fails with an
   explanatory message and validates size/format first.
5. `/v1/platform` hard-coded most service states to `"operational"` → now derived from live checks
   (tables, RLS coverage, event counts, function/job evidence, backup/restore evidence, file presence).
6. Tests that assumed a hard-coded APK build path or a fixed platform status were made
   environment-independent instead of being skipped.

---

## 7. Limitations and what is **not** verified

Nothing in this section was claimed as working.

| # | Item | Status | Why | Exact remaining verification |
| :-- | :--- | :--- | :--- | :--- |
| 1 | Android Gradle build & APK packaging | **implemented not fully verified** | No JDK/Android SDK in this sandbox; `services.gradle.org`, `dl.google.com` and GitHub release assets are unreachable | On a machine with JDK 17 + SDK: `cd android && ./gradlew :app:testDebugUnitTest :app:assembleDebug`, or run the CI `android` job (it also runs `apksigner`, `aapt2 dump badging`, `zipalign`) |
| 2 | APK install & on-device behaviour | **not verified** | No emulator or device | `adb install -r releases/marry-base.apk`, then `docs/ANDROID.md` checklist (bad URL, wrong scheme, unreachable host, bad password, session expiry, rotation) |
| 3 | Docker Compose deployment + PostgreSQL 17 | **partially verified** (YAML only) | No Docker binary | On a Docker host: `cp .env.example .env` (set secrets), `docker compose up -d --build`, wait for healthy, `curl /ready`, register with the bootstrap token, then `DATABASE_URL=postgres://… npm test` |
| 4 | S3 backend against a real service | **partially implemented** | No credentials/bucket; SigV4 asserted only against a local HTTP endpoint | Set `STORAGE_BACKEND=s3` + `S3_*`, upload/download/sign/delete, verify persistence after restart |
| 5 | TLS termination / reverse proxy | **not verified** | No proxy or certificate here | Deploy behind HTTPS, verify cookies/CORS/`TRUST_PROXY`, and that the Android app accepts the certificate |
| 6 | Live browser click-through | **not verified** | No browser available; jsdom covers DOM/module wiring only | Open `/dashboard` in a browser, walk all 16 sections, check responsive layout and keyboard access |
| 7 | Production upgrade on a real database | **not verified** | No production database | Apply the next migration to a restored copy, verify, then roll back |
| 8 | OAuth provider **token exchange** end-to-end | **implemented not fully verified** | Needs real GitHub/Google client credentials and a public callback URL | Register an app, configure it in the studio, complete the redirect and assert a session is issued |

Known functional boundaries (by design, stated in the UI):

- The studio stores OAuth client IDs, URLs, scopes and enablement — **not** client secrets.
- PGlite is for development/single-node; multi-node deployments must use a PostgreSQL server URL.
- 16 studio sections are verified in jsdom; real-browser rendering (fonts, layout, focus order) is
  unverified here.

---

## 8. Change inventory

Uncommitted on `arena/c2af24c3-maary-base` (53 entries): 19 new, 32 modified, 2 deleted.

- **New**: `docs/IMPLEMENTATION_REPORT.md`, `docs/VERIFICATION.md`, `docs/ANDROID.md`,
  `docker-compose.yml`, `.dockerignore`, `src/routes/observability.ts`,
  `src/services/operations.service.ts`, `src/operations-status.test.ts`, `src/studio.test.ts`,
  `src/studio-workflows.test.ts`, `android/gradlew(.bat)`, `android/gradle/`, `android/gradle.properties`,
  `android/app/src/main/java/com/marrybase/platform/{ServerAddress,ConnectionProbe}.java`,
  `android/app/src/main/res/{values,xml}/`, `android/app/src/test/`, `releases/.gitkeep`.
- **Deleted (intentional)**: `releases/marry-base.apk` (fabricated artifact),
  `src/apk-signing.test.ts` (test validated the fabrication path).
- **Modified**: server (`src/app.ts`, `src/server.ts`, `src/config.ts`,
  `src/routes/{dashboard,health,platform}.ts`, `src/cli/index.ts`, `src/services/apk.service.ts`,
  `scripts/verify-apk.mjs`), studio (`public/dashboard/*`), Android project files, docs
  (`README`, `ARCHITECTURE`, `API_REFERENCE`, `OPERATIONS`), CI, `package.json`/lock, `.env.example`,
  `.gitignore`, and the tests listed in §6.1.

Review order suggestion: `docs/VERIFICATION.md` → this report → `docker-compose.yml` + `Dockerfile` →
`src/services/operations.service.ts` + `src/routes/platform.ts` → `public/dashboard/js/actions.js` →
`src/studio-workflows.test.ts`.

---

## 9. Status vocabulary

- `operational` — every check for that service passed on this instance.
- `implemented_unverified` — implemented and automated-tested, but no recorded real use on this instance
  (e.g. a function never invoked, realtime with zero events).
- `partially_implemented` — some checks fail or configuration is incomplete (e.g. tables without RLS).
- `requires_configuration` — supported but an operator action is needed first.
- `unavailable` — a dependency (database, storage, worker) prevents operation.
- `failed` — a check actively failed (invalid APK artifact, worker enabled but not running).
- `missing` — the artifact/component does not exist yet (e.g. no built APK).

`/v1/platform.services.androidCompanion` reports one of these words; the raw artifact state
(`available`/`missing`/`invalid`) stays in `/v1/platform.android.state`.

Overall `/v1/platform` state is derived from these checks; the derivation is code, not a literal.
