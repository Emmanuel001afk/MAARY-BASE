# MAARY BASE API Reference

All project-scoped endpoints accept either a `:projectRef` slug (e.g. `acme-app`) or project UUID.

## Authentication Headers

1. **Platform Control Plane**:
   - `Authorization: Bearer <platform_access_jwt>` (or `apikey: <project_service_role_key>` for project-scoped control endpoints).
2. **Project Services (Data API, Auth, Storage, Functions, Realtime)**:
   - `apikey: <mb_anon_... | mb_service_... | mb_key_...>`
   - Optional user context: `Authorization: Bearer <project_user_access_jwt>`

---

## 1. Health, Readiness & Platform Control Plane

- `GET /health` — Process liveness check.
- `GET /ready` — Checks PostgreSQL query execution, migration state, and storage directory writability (returns `503` if unhealthy).
- `GET /v1/metrics` — Operational metrics in JSON or Prometheus text format (`?format=prometheus`).
- `GET /v1/platform` — Platform version, database mode, and module statuses.
- `POST /v1/platform/apk/build` — Build the APK (requires a platform access JWT).
- `GET /v1/platform/apk/download` — Download the current APK.
- `POST /v1/platform/auth/register` — Register a platform account (`{ email, password, name }`). In production, the first account must include the configured `x-platform-bootstrap-token` header to receive the initial superadmin role; later accounts are ordinary accounts.
- `POST /v1/platform/auth/login` — Sign in platform operator (`{ email, password }`).
- `POST /v1/platform/auth/refresh` — Rotate platform refresh token (`{ refreshToken }`).
- `POST /v1/platform/auth/logout` — Revoke current platform session.
- `GET /v1/platform/auth/me` — Current platform operator profile.
- `GET /v1/platform/audit` — Query platform audit trail.
- `GET /v1/platform/extensions` & `POST /v1/platform/extensions` — List and enable supported PostgreSQL extensions.

---

## 2. Projects, Environments, RBAC, Keys & Secrets

- `GET /v1/projects` — List accessible projects.
- `POST /v1/projects` — Create isolated project (`{ name, slug?, description?, quotas?, settings? }`).
- `GET /v1/projects/:projectRef` — Inspect project, environments, and resource usage.
- `PATCH /v1/projects/:projectRef` — Update project settings, status (`active`, `suspended`, `archived`), or quotas.
- `DELETE /v1/projects/:projectRef?confirmSlug=<slug>` — Safely delete project and drop its PostgreSQL schema.
- `GET /v1/projects/:projectRef/environments` & `POST /v1/projects/:projectRef/environments` & `DELETE /v1/projects/:projectRef/environments/:envId`
- `GET /v1/projects/:projectRef/members` & `POST /v1/projects/:projectRef/members` & `DELETE /v1/projects/:projectRef/members/:userId`
- `GET /v1/projects/:projectRef/api-keys?reveal=true` & `POST /v1/projects/:projectRef/api-keys`
- `POST /v1/projects/:projectRef/api-keys/:keyId/rotate` & `DELETE /v1/projects/:projectRef/api-keys/:keyId`
- `GET /v1/projects/:projectRef/secrets?reveal=true` & `POST /v1/projects/:projectRef/secrets` & `DELETE /v1/projects/:projectRef/secrets/:secretId`

---

## 3. Database Management, SQL, RLS & Migrations

- `GET /v1/projects/:projectRef/database/tables` — Inspect all tables, columns, primary keys, foreign keys, indexes, row counts, and RLS policies.
- `POST /v1/projects/:projectRef/database/tables` — Create table (`{ name, columns, enableRls }`).
- `PATCH /v1/projects/:projectRef/database/tables/:tableName` — Alter table (`add_column`, `drop_column`, `rename_column`, `create_index`, `drop_index`).
- `DELETE /v1/projects/:projectRef/database/tables/:tableName` — Drop table.
- `POST /v1/projects/:projectRef/database/tables/:tableName/rls` — Enable/disable/force Row-Level Security (`{ enabled, force }`).
- `POST /v1/projects/:projectRef/database/policies` — Create PostgreSQL RLS policy (`{ tableName, policyName, command, usingExpression, checkExpression }`).
- `DELETE /v1/projects/:projectRef/database/policies/:tableName/:policyName` — Delete RLS policy.
- `POST /v1/projects/:projectRef/database/sql` — Execute parameterized SQL inside the project schema (`{ sql, params?, readOnly?, allowDestructive?, impersonate? }`).
- `GET /v1/projects/:projectRef/database/migrations` & `POST /v1/projects/:projectRef/database/migrations` & `POST /v1/projects/:projectRef/database/migrations/:version/rollback`

---

## 4. Data API (Auto-Generated REST, Relationships, RPC & OpenAPI)

- `GET /v1/projects/:projectRef/openapi.json` — Live OpenAPI 3.1 specification for the project schema.
- `GET /v1/projects/:projectRef/rest/:table`
  - Query parameters:
    - `select`: columns and embedded relationships, e.g. `id,title,author:authors(id,display_name),comments(id,body)`
    - Filters: `<col>=eq.<val>`, `neq`, `gt`, `gte`, `lt`, `lte`, `like`, `ilike`, `in.(a,b)`, `is.null`, `is.true`, `contains`, `or=(status.eq.active,status.eq.draft)`
    - `order`: `created_at.desc,id.asc`
    - `limit`, `offset`, `single=true`, `count=exact`
- `POST /v1/projects/:projectRef/rest/:table` — Insert single object or array of objects (`?on_conflict=<col>` for upserts).
- `PATCH /v1/projects/:projectRef/rest/:table` — Update rows matching filter parameters.
- `DELETE /v1/projects/:projectRef/rest/:table` — Delete rows matching filter parameters.
- `POST /v1/projects/:projectRef/rpc/:fn` — Invoke a PostgreSQL function in the project schema.

---

## 5. Project Authentication & Identity

- `GET /v1/projects/:projectRef/auth/config` & `PATCH /v1/projects/:projectRef/auth/config`
- `POST /v1/projects/:projectRef/auth/signup` — Register user (`{ email, password, phone?, user_metadata? }`).
- `POST /v1/projects/:projectRef/auth/login` — Authenticate with email & password.
- `POST /v1/projects/:projectRef/auth/token` — OAuth2-style token endpoint (`grant_type=password|refresh_token`).
- `POST /v1/projects/:projectRef/auth/refresh` — Rotate refresh token (`{ refresh_token }`).
- `POST /v1/projects/:projectRef/auth/logout` — Revoke user session.
- `POST /v1/projects/:projectRef/auth/verify` — Verify email token (`{ token }`).
- `POST /v1/projects/:projectRef/auth/recover` & `POST /v1/projects/:projectRef/auth/reset-password`
- `GET /v1/projects/:projectRef/auth/oauth/:provider/authorize` & `POST /v1/projects/:projectRef/auth/oauth/:provider/callback`
- `GET /v1/projects/:projectRef/auth/user` & `PATCH /v1/projects/:projectRef/auth/user`
- Admin routes: `GET|POST /v1/projects/:projectRef/auth/admin/users`, `GET|PATCH|DELETE /v1/projects/:projectRef/auth/admin/users/:userId`

---

## 6. Object Storage

- `GET|POST /v1/projects/:projectRef/storage/buckets`
- `GET|PATCH|DELETE /v1/projects/:projectRef/storage/buckets/:bucketName`
- `GET|POST /v1/projects/:projectRef/storage/buckets/:bucketName/policies` & `DELETE .../policies/:policyId`
- `GET /v1/projects/:projectRef/storage/buckets/:bucketName/objects`
- `POST /v1/projects/:projectRef/storage/buckets/:bucketName/objects/*` — Upload object.
- `GET /v1/projects/:projectRef/storage/buckets/:bucketName/objects/*` — Download object (or `?metadata=true`).
- `DELETE /v1/projects/:projectRef/storage/buckets/:bucketName/objects/*` — Delete object.
- `POST /v1/projects/:projectRef/storage/buckets/:bucketName/sign/*` — Generate signed URL (`{ operation: "download" | "upload", expiresIn }`).
- `GET /v1/projects/:projectRef/storage/signed/download?token=...` & `POST /v1/projects/:projectRef/storage/signed/upload?token=...`
- Multipart routes:
  - `POST /v1/projects/:projectRef/storage/multipart/initiate`
  - `POST /v1/projects/:projectRef/storage/multipart/:uploadId/parts/:partNumber`
  - `POST /v1/projects/:projectRef/storage/multipart/:uploadId/complete`
  - `POST /v1/projects/:projectRef/storage/multipart/cleanup`

---

## 7. Realtime, Functions, Jobs & Backups

- `GET /v1/projects/:projectRef/realtime/ws` — WebSocket connection (`?apikey=...`).
- `POST /v1/projects/:projectRef/realtime/broadcast` — Publish broadcast event (`{ topic, event, payload }`).
- `GET /v1/projects/:projectRef/realtime/events` — Query persisted realtime events.
- `GET|POST /v1/projects/:projectRef/functions` & `GET|DELETE /v1/projects/:projectRef/functions/:slug`
- `ALL /v1/projects/:projectRef/functions/:slug/invoke` — Invoke function.
- `GET /v1/projects/:projectRef/functions-logs` — Inspect function invocation logs.
- `GET|POST /v1/projects/:projectRef/jobs`, `POST /v1/projects/:projectRef/jobs/process`, `POST /v1/projects/:projectRef/jobs/:jobId/cancel`
- `GET|POST /v1/projects/:projectRef/schedules` & `DELETE /v1/projects/:projectRef/schedules/:scheduleId`
- `GET|POST /v1/projects/:projectRef/backups`, `POST /v1/projects/:projectRef/backups/:backupId/verify`, `POST /v1/projects/:projectRef/backups/:backupId/restore`
