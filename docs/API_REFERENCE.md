# MARI BASE API Reference

All project-scoped endpoints accept either a `:projectRef` slug (e.g. `acme-api`) or UUID.

## Authentication

1. **Platform Control Plane**:
   - `Authorization: Bearer <platform_access_jwt>` or `HttpOnly` cookie `maary_platform_token` (issued on `/v1/platform/auth/login` or `/register`).
   - Project-scoped control endpoints also accept `apikey: <project_service_role_key>`.
2. **Project Client Services (REST, RPC, Auth, Storage, Functions, Realtime)**:
   - `apikey: <mb_anon_... | mb_service_... | mb_key_...>`
   - Optional authenticated end-user context: `Authorization: Bearer <project_user_access_jwt>`

---

## 1. Health, Readiness & Platform Administration

- `GET /health` — Process liveness check.
- `GET /ready` — Verifies PostgreSQL query execution, applied migrations, and `STORAGE_DIR` writability (`503` if degraded).
- `GET /v1/metrics` — JSON or Prometheus (`?format=prometheus`) operational metrics.
- `GET /v1/platform` — Live module verification statuses and database mode.
- `GET /v1/platform/diagnostics` — Detailed runtime, memory, pool, worker, storage, and module probes (requires operator auth).
- `GET /v1/platform/auth/status` — Reports whether initial Superadmin bootstrap is open and whether `PLATFORM_BOOTSTRAP_TOKEN` is required.
- `POST /v1/platform/auth/register` — Register operator (`{ email, password, name?, bootstrapToken? }`).
- `POST /v1/platform/auth/login` — Authenticate operator (`{ email, password }`).
- `POST /v1/platform/auth/refresh` — Rotate refresh token (`{ refreshToken }`).
- `POST /v1/platform/auth/logout` — Revoke current operator session.
- `GET /v1/platform/auth/me` & `PATCH /v1/platform/auth/me` — Read or update operator profile.
- `POST /v1/platform/auth/change-password` — Rotate operator password (`{ currentPassword, newPassword }`).
- `GET /v1/platform/apk/status` — Truthful inspection of Gradle/JDK/Android SDK availability and verified `.apk` artifact metadata.
- `POST /v1/platform/apk/build` — Trigger a real Gradle APK build when host Android toolchain is installed (`503` with actionable diagnostics otherwise).
- `GET /v1/platform/apk/download` — Download a verified, `apksigner`-checked Android `.apk` artifact (`404` if not yet built).
- **Superadmin-Only Endpoints**:
  - `GET /v1/platform/users`, `POST /v1/platform/users`, `PATCH /v1/platform/users/:userId`
  - `GET /v1/platform/extensions` & `POST /v1/platform/extensions`
  - `GET /v1/platform/backups`, `POST /v1/platform/backups`, `POST /v1/platform/backups/:backupId/verify`, `POST /v1/platform/backups/:backupId/restore`
  - `GET /v1/platform/audit` & `GET /v1/platform/logs/errors`

---

## 2. Organizations / Workspaces

- `GET /v1/organizations` — List workspaces accessible to the authenticated operator.
- `POST /v1/organizations` — Create workspace (`{ name, slug?, description?, billingTier? }`).
- `GET /v1/organizations/:orgRef` — Workspace details, members, and assigned projects.
- `PATCH /v1/organizations/:orgRef` — Update workspace name, tier, description, or settings.
- `DELETE /v1/organizations/:orgRef` — Delete workspace (`{ confirmSlug }`).
- `GET /v1/organizations/:orgRef/members`, `POST /v1/organizations/:orgRef/members`, `DELETE /v1/organizations/:orgRef/members/:userId`

---

## 3. Projects, Environments, Keys, Secrets & Logs

- `GET /v1/projects?organizationId=<id>` & `POST /v1/projects`
- `GET /v1/projects/:projectRef` — Project metadata, environments, quota usage, and live subsystem overview.
- `GET /v1/projects/:projectRef/diagnostics` — Detailed quota usage and subsystem verification.
- `PATCH /v1/projects/:projectRef` — Update name, description, `organizationId`, `status` (`active`|`suspended`|`archived`), `quotas`, or `settings`.
- `DELETE /v1/projects/:projectRef` — Drop isolated schema, roles, and project resources (`{ confirmSlug }`).
- `GET|POST /v1/projects/:projectRef/environments` & `DELETE /v1/projects/:projectRef/environments/:envId`
- `GET|POST /v1/projects/:projectRef/members` & `DELETE /v1/projects/:projectRef/members/:userId`
- `GET|POST /v1/projects/:projectRef/api-keys`, `POST .../api-keys/:keyId/rotate`, `DELETE .../api-keys/:keyId`
- `GET|POST /v1/projects/:projectRef/secrets` & `DELETE .../secrets/:secretId`
- `GET /v1/projects/:projectRef/audit` & `GET /v1/projects/:projectRef/logs/errors`
- `GET|POST /v1/projects/:projectRef/backups`, `POST .../backups/:backupId/verify`, `POST .../backups/:backupId/restore`

---

## 4. Database, SQL, RLS, Migrations & Data API

- `GET|POST /v1/projects/:projectRef/database/tables`
- `PATCH /v1/projects/:projectRef/database/tables/:tableName` — `add_column` (with optional FK `references`), `drop_column`, `rename_column`, `alter_column` (change `type`, set/drop `defaultValue`, toggle `notNull`), `rename_table` (`toName`), `create_index`, `drop_index`, `toggle_rls`.
- `DELETE /v1/projects/:projectRef/database/tables/:tableName`
- `POST /v1/projects/:projectRef/database/tables/:tableName/rls`
- `GET /v1/projects/:projectRef/database/diagnostics` — Least-privilege role verification and relation sizes.
- `POST /v1/projects/:projectRef/database/policies` & `DELETE .../database/policies/:tableName/:policyName`
- `POST /v1/projects/:projectRef/database/sql` — accepts optional `savedQueryId` to record run statistics for a saved query.
- `GET|POST /v1/projects/:projectRef/database/queries` — shared saved-query library (name, description, SQL, favorite). Mutations require `developer`+.
- `PATCH|DELETE /v1/projects/:projectRef/database/queries/:queryId` — rename/update/pin (`favorite`), or delete; `PATCH` with `{ "markRun": true }` records an execution.
- `GET|POST /v1/projects/:projectRef/database/migrations` & `POST .../database/migrations/:version/rollback`
- `GET /v1/projects/:projectRef/openapi.json`
- `GET|POST|PATCH|DELETE /v1/projects/:projectRef/rest/:table` — PostgREST-style filters (`col=eq.value`, `gt`, `lt`, `like`, `in`, …), `order=col.asc|desc`, `limit`/`offset` pagination, `select=col,col` projection, relationship embedding, and `count=exact` for filtered totals.
- `POST /v1/projects/:projectRef/rpc/:fn`

---

## 5. Project Authentication, Storage, Realtime, Functions & Jobs

- **Auth**: `GET|PATCH .../auth/config`, `POST .../auth/signup`, `POST .../auth/login`, `POST .../auth/token`, `POST .../auth/refresh`, `POST .../auth/logout`, `POST .../auth/verify`, `POST .../auth/recover`, `POST .../auth/reset-password`, `GET .../auth/oauth/:provider/authorize`, `POST .../auth/oauth/:provider/callback`, `GET|PATCH .../auth/user`, `GET|POST .../auth/admin/users`, `GET|PATCH|DELETE .../auth/admin/users/:userId`, `GET .../auth/admin/sessions`, `DELETE .../auth/admin/sessions/:sessionId`.
- **Storage**: `GET|POST .../storage/buckets`, `GET|PATCH|DELETE .../storage/buckets/:bucketName`, `GET|POST .../storage/buckets/:bucketName/policies`, `DELETE .../policies/:policyId`, `GET .../objects`, `GET|POST|DELETE .../objects/*` (`?metadata=true`), `POST .../sign/*`, `GET .../signed/download`, `POST .../signed/upload`, multipart upload endpoints.
- **Realtime**: `WS /v1/projects/:projectRef/realtime/ws?apikey=...`, `GET .../realtime/status`, `GET|POST .../realtime/channels`, `POST .../realtime/broadcast`, `GET .../realtime/events`.
- **Functions & Jobs**: `GET|POST .../functions`, `GET|DELETE .../functions/:slug`, `ALL .../functions/:slug/invoke`, `GET .../functions/:slug/logs`, `GET|POST .../jobs`, `POST .../jobs/process`, `POST .../jobs/:jobId/retry`, `POST .../jobs/:jobId/cancel`, `GET|POST .../schedules`, `DELETE .../schedules/:scheduleId`.
