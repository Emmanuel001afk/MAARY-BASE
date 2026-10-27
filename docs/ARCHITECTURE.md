# MARI BASE Architecture

## 1. Layered System Boundaries

```text
Management Studio (public/dashboard) · Android App (android/) · SDK (src/sdk) · CLI (src/cli)
        │
        ▼
Fastify HTTP & WebSocket API Layer (src/app.ts, src/routes/*, src/middleware/auth.middleware.ts)
        │
        ├── Platform Auth & Superadmin RBAC (src/services/platform-auth.service.ts)
        ├── Organizations & Inherited Team RBAC (src/services/organization.service.ts)
        ├── Project Lifecycle, Keys & Encrypted Secrets (src/services/project.service.ts)
        ├── Database Schema, Alter, Migrations & Diagnostics (src/services/database.service.ts)
        ├── PostgREST-Compatible Data API & OpenAPI 3.1 (src/services/data-api.service.ts)
        ├── Project End-User Auth, Sessions & OAuth (src/services/project-auth.service.ts)
        ├── Object Storage, Policies & Signed URLs (src/services/storage.service.ts)
        ├── WebSocket Realtime Broker & Change Capture (src/services/realtime.service.ts)
        ├── Isolated Child-Worker Functions & Job Queue (src/services/functions-jobs.service.ts)
        ├── Live Module Diagnostics & Error Logging (src/services/diagnostics.service.ts)
        └── Disaster-Recovery Backups & Gradle APK Inspector (src/services/backup.service.ts, android-artifact.service.ts)
        │
        ▼
Unified PostgreSQL Pool & RLS Transaction Layer (src/db/pool.ts)
        │
        ▼
PostgreSQL 16+ (pg.Pool)  OR  Embedded PGlite (local dev / test)
```

---

## 1.1 Management Studio Information Architecture

The Studio uses a four-level, Supabase-inspired structure: a scope topbar, a grouped primary sidebar, a contextual product menu, and a focused content area. `public/dashboard/js/navigation.js` is the single source of truth for `PRIMARY_SECTIONS`, `PRODUCT_MENUS`, `PHONE_SERVER_COMMANDS`, and `SUPABASE_SERVICE_MAP`; `app.js` renders the context menu on every route change. Each context-menu item points to a real page, local tab, or DOM control.

Two project-free pages document the platform:

- `/guide/` and Studio **Structure map** — visual navigation hierarchy, Supabase source mapping, service/data mapping, and honest feature gaps.
- Studio **Connect** and `/guide/#phone-as-server` — phone-as-client, Android emulator, and phone-as-server paths with copyable commands and a live `/ready` + `/v1/platform` check.

See [`SUPABASE_STRUCTURE_MAPPING.md`](SUPABASE_STRUCTURE_MAPPING.md) and [`PHONE_AS_SERVER.md`](PHONE_AS_SERVER.md) for the complete mapping and connection runbook.

---

## 2. Multi-Project Isolation & PostgreSQL Row-Level Security

Every provisioned project receives strict database-level isolation:

1. **Dedicated Schema (`proj_<slug>`)**: User tables, indexes, sequences, and RPC functions live inside `"proj_<slug>"`, isolated from `public.platform_*` control-plane metadata and all sibling projects.
2. **Dual Least-Privilege Roles (`003_security_hardening.sql`)**:
   - `role_<slug>`: Schema owner role (`NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`, `NOBYPASSRLS`) used only for controlled schema DDL and `service_role` operations.
   - `role_<slug>_rls`: Client execution role without table ownership, guaranteeing that `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY` policies cannot be bypassed by `anon` or `authenticated` requests.
   - `PUBLIC` create privileges are revoked so project roles cannot create objects outside their assigned schema.
3. **Transactional Claims (`withRlsTransaction`)**:
   - Configures `SET LOCAL search_path`, `SET LOCAL statement_timeout`, `request.jwt.claim.{sub,role,email,project_id}`, and `SET LOCAL ROLE` inside a single transaction for every Data API and impersonated SQL query.

---

## 3. Control-Plane RBAC: Superadmin vs Workspace vs Project

- **Platform Superadmin (`platform_users.is_superadmin`)**: Required for instance-wide administration (`/v1/platform/users`, `/v1/platform/extensions`, `/v1/platform/backups`, `/v1/platform/audit`, `/v1/platform/logs/errors`). Initial bootstrap is serialized with `LOCK TABLE platform_users IN EXCLUSIVE MODE` and gated by `PLATFORM_BOOTSTRAP_TOKEN` in production.
- **Organizations (`platform_organizations`)**: Group multiple projects under shared team roles (`owner`, `admin`, `developer`, `viewer`). Workspace members inherit project access automatically; when both workspace and direct project memberships exist, the higher role wins.
- **Backup Tenant Isolation**: Project-scoped backup verification and restoration enforce `expectedProjectId`, blocking cross-project IDOR access to other projects' or platform-wide snapshots.

---

## 4. Isolated Function Worker & Durable Background Queue

- **Child-Process Worker Isolation**: Server functions execute in a dedicated short-lived Node.js child process (`node --permission --disallow-code-generation-from-strings --max-old-space-size=64`) with stripped environment variables and hard kill timeouts. Database queries from `ctx.db.query()` proxy back over IPC through `executeProjectSql` within the project's isolated schema.
- **Durable Jobs & SSRF Protection**: Background jobs (`platform_jobs`) claim work with `FOR UPDATE SKIP LOCKED`, support manual retry (`POST /jobs/:id/retry`), exponential backoff, dead-letter transitions, and outbound `webhook` delivery guarded against loopback/link-local/RFC1918 SSRF targets unless `WEBHOOK_ALLOW_PRIVATE_NETWORKS=true`.

---

## 5. Truthful Observability & Android Companion Architecture

- **Truthful Module States**: `evaluatePlatformModules()` and `getProjectLiveStatusOverview()` probe actual database queries, migration state, filesystem writability, worker liveness, and compiled APK availability — returning accurate states (`operational_verified`, `implemented_unverified`, `partially_implemented`, `requires_configuration`, `unavailable`, `failed`).
- **Native Android App (`android/`)**: Standard Android Gradle project (`com.marrybase.platform`, `MainActivity.java`) implementing native `/ready` + `/v1/platform` verification, HTTPS enforcement for remote hosts (with explicit local/LAN HTTP opt-in), `SharedPreferences` URL persistence, origin-locked `WebView` with file/content access disabled, SSL error cancellation, and inline connection recovery.
