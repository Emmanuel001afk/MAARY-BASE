# MARRY BASE verification report

This document records what was actually executed, what passed, and what could not be verified in the
development environment. It is deliberately explicit about that difference.

## Environment

- Node.js v22.22.3, npm 10.9.8, Linux x86_64 sandbox.
- Database: embedded PGlite — in-memory for the automated suites, a persistent directory for the
  manual HTTP smoke test.
- **No JDK, Android SDK, emulator or physical device were available.** Outbound access is limited to
  package registries and GitHub; `services.gradle.org`, `dl.google.com` and GitHub release assets are
  unreachable, so a Gradle build could not be executed here. CI is configured to run it.

## Automated suites actually run

Command: `npm test` → **25 tests, 25 pass, 0 fail** (≈38 s). Every test below was executed in this
environment and its output inspected, both with no APK present and with a valid APK artifact in place
(the state CI runs in).

| # | Test | Result |
| :-- | :--- | :--- |
| 1 | Health and readiness endpoints return operational status and MARRY BASE identity | pass |
| 2 | Dashboard routes serve the Management Studio, logo and assets | pass |
| 3 | Android artifact endpoints report real status and never fabricate a package (missing/invalid/download-404/409) | pass |
| 4 | Mobile client source is CSP-friendly and keeps server data out of HTML | pass |
| 5 | Unknown endpoint returns a structured 404 | pass |
| 6 | Platform operator registration, login, session refresh and audit trail | pass |
| 7 | Project authentication: signup, verification, rotation/reuse detection, recovery, OAuth, admin ban | pass |
| 8 | Data API CRUD, filtering, pagination, FK embedding, RPC, OpenAPI, RLS | pass |
| 9 | Platform refresh rotation revokes a session family on replay | pass |
| 10 | Multi-project lifecycle, RBAC, environments, keys, secrets, DDL, migrations, isolation | pass |
| 11 | Storage buckets, policies, quotas, MIME checks, signed URLs, multipart uploads | pass |
| 12 | Functions sandbox, queues, retries, backups, SDK, CLI, live WebSocket realtime | pass |
| 13 | Operational status, logs, roles, connection and API catalogue reflect real state | pass |
| 14 | Adversarial: function sandbox blocks escapes, filesystem access, secret leaks and infinite loops | pass |
| 15 | Adversarial: database privilege boundary holds for `service_role` and dynamic SQL | pass |
| 16 | Adversarial: Android APK delivery is verified and cannot be fabricated (removal → 404, corrupt → rejected) | pass |
| 17 | Adversarial: full platform backup restores tables, defaults, constraints, FKs, indexes, sequences, RLS, users, functions and storage blobs | pass |
| 18 | Adversarial: concurrent operator registrations atomically enforce a single superadmin | pass |
| 19 | Adversarial: S3 adapter executes real SigV4 PUT/GET/DELETE against a local endpoint | pass |
| 20 | Management Studio controls execute real workflows against the server (new) | pass |
| 21 | Management Studio renders every section against the live API (jsdom) | pass |
| 22 | APK inspection accepts a v2/v3 signing block whose footer ends at the central directory | pass |
| 23 | APK inspection rejects a package with no signature evidence | pass |
| 24 | APK inspection accepts v1 JAR signing evidence for older packages | pass |
| 25 | APK inspection reports missing `classes.dex`, missing resources and a corrupt archive | pass |

### CI (GitHub Actions) — executed on the runner

`.github/workflows/ci.yml` was red when this branch started: the previous workflow never compiled the
Android app (it only ran Node steps and packaged an APK in-process), so the first real Gradle job failed.
It now passes end to end:

- `Android Gradle build` — checkout, Temurin JDK 17, Gradle wrapper 8.7, `:app:testDebugUnitTest`,
  `:app:assembleDebug`, then structural checks, `aapt2 dump badging` (package `com.marrybase.platform`,
  `minSdkVersion:'24'`), `apksigner verify` (v2 scheme, 1 signer, debug certificate), `zipalign -c -v 4`,
  and artifact upload. **This is a genuine Gradle build producing a real, signed APK (94,396 bytes).**
- `Typecheck & integration tests` — `npm ci`, downloads that APK, `npm run typecheck`, `check:studio`,
  `check:mobile`, `npm run build`, `npm run verify:apk` (apksigner on the downloaded artifact), and
  `npm test` → 25/25.

Exit status of the final run: **success** (workflow run `40119983334`).

Also run and inspected:

- `npm run typecheck` — pass.
- `npm run check:studio`, `npm run check:mobile` — pass.
- `npm run build` (tsc → `dist/`) — pass.
- `node --check` on each dashboard module — pass.
- Java syntax parse of all four Android sources with a JVM parser (no JVM available for `javac`) — pass.
- XML well-formedness of the manifest and every Android resource — pass.

### What test 20 proves

It drives the real handlers in `public/dashboard/js/actions.js` inside jsdom against a live Fastify
instance: project creation via the modal, table creation via the column-JSON form, row filtering and
pagination metadata, row editing and confirmed deletion, table alteration (adding a column), SQL
execution with the destructive-statement safeguard (blocked unfiltered DELETE, then allowed),
RLS policy creation, bucket creation plus text upload, function deployment and invocation through
the documented `ctx.req.body` contract, job enqueue and processing, migration application, backup
creation → integrity verification → row deletion → **restore with the deleted row back**, API-key
creation, the live API tester, project settings, environment, secret and application-user forms,
OAuth provider configuration validated against the real authorize endpoint, log rendering, and the
APK build form's honest `apk_build_unavailable` path.

This suite found and fixed two real production bugs that the render-only test could not see:
`actions.js` used `badge()` and `icon()` without importing them, so the API tester and the Android
build panel threw at runtime in the browser.

### What test 21 proves

It loads `public/dashboard/index.html` into jsdom, imports the real studio modules, creates an
operator and project through the HTTP API, then for every one of the 16 sections renders the page and
runs its loader against the server, asserting: no “Unable to load this module” fallback, section
content present, correct nav highlight, and no `[object Object]`/`NaN` in the markup. It also browses
a real table, checks log counts and the API base URL, and validates the no-project empty state.

## Manual smoke test (executed)

A server was started with a persistent PGlite directory and probed over HTTP: registration, project
creation, table creation with RLS, row insert through the REST data API, bucket creation, text
upload, function deployment and invocation, job enqueue, project backup, migration application,
`/status`, `/logs`, `/database/roles`, `/database/connection`, `/api/endpoints`, `/openapi.json`,
`/v1/platform/status`, `/v1/platform/version`, `/apk/status`, `/apk/build` (409), `/apk/download`
(404), `/mobile`, and the studio assets. Cross-operator access returned `403`; anon insert under RLS
returned `403 rls_policy_violation`; service-role insert/read returned `201`/`200`.

Additional manual checks (executed):

- **Rate limiting** — with `RATE_LIMIT_MAX=10`, 16 rapid `GET /health` requests returned `200` nine
  times, then `429` for the remainder.
- **Fresh-install honesty** — on a brand-new embedded database `/v1/platform` reported
  `realtime: implemented_unverified`, `serverFunctions: requires_configuration` and
  `backupsAndRecovery: requires_configuration` rather than claiming everything was operational.
- **APK verifier failure paths** — `npm run verify:apk` exits 1 with a clear message for a missing file,
  a 10-byte file, or a missing `apksigner`, instead of crashing with a raw `ENOENT`.
- **`npm run android:build`** on this host exits with `missingPrerequisites` naming Java 17+ and the
  Android SDK, and points at the Gradle and CI commands.

## Not verified here (and why)

| Area | Status | Required verification |
| :--- | :--- | :--- |
| Android Gradle build and packaging | **Verified in CI** — no JDK/Android SDK in the local sandbox, but the `android` job builds a real signed APK on every push (see above) | Local reproduction only: `cd android && ./gradlew :app:testDebugUnitTest :app:assembleDebug` on a JDK 17 + SDK host |
| APK install and on-device behaviour | **Not executed** — no emulator/device | `adb install -r releases/marry-base.apk`, then follow the checklist in `docs/ANDROID.md`. |
| Docker Compose deployment (PostgreSQL 17) | **Not executed** — no Docker daemon in this sandbox; `docker-compose.yml` is YAML-validated only | `docker compose up -d --build`, wait for healthy, then `/ready`, register with the bootstrap token, and `npm test` with `DATABASE_URL=postgres://…`. |
| S3-compatible adapter against a real service | Partially verified — SigV4 requests are asserted against a local HTTP endpoint | Configure real credentials/bucket and upload/download/sign. |
| TLS termination and reverse proxies | **Not executed** | Deploy behind HTTPS, verify cookies/CORS/`TRUST_PROXY`, and that the Android app accepts the certificate. |
| Upgrade of a production database | **Not executed** | Apply the next migration on a restored copy and roll back. |

## Status semantics

- `operational` — every check for the service passed on this instance.
- `implemented_unverified` — implemented and unit/integration tested, but this instance has no
  recorded real use (for example a function that was never invoked).
- `partially_implemented` — some checks fail or configuration is incomplete (for example tables
  without RLS).
- `requires_configuration` — the platform supports it but an operator action is needed first.
- `unavailable` — a dependency (database, storage backend, worker) prevents operation.
- `failed` — a check actively failed (an invalid APK artifact, a worker enabled but not running, …).
- `missing` — the artifact or component has not been produced on this instance yet (no built APK).

`/v1/platform` maps artifact states into this vocabulary (`available` → `operational`,
`invalid` → `failed`, `missing` → `missing`) and keeps the raw artifact state in `android.state`.

`overall` on `/v1/platform/status` is derived from these per-service states; `requires_configuration`
is not upgraded to `operational`.
