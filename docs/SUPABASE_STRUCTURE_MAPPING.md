# Supabase Studio → MARI BASE Structure Mapping

> Research snapshot: Supabase `master` commit
> [`9391f60ec973113d69f5fa7a09a4860e50f56a50`](https://github.com/supabase/supabase/tree/9391f60ec973113d69f5fa7a09a4860e50f56a50),
> inspected on 2026-10-26. This is a functional information-architecture and
> API mapping, not a code fork. MARI BASE is an independent platform and is not
> affiliated with Supabase.

## 1. Why the old UI felt like “one page”

The backend already had separate modules, but the Studio exposed them as one
flat list of routes. Supabase Studio instead uses **four distinct visual
levels**:

```text
┌──────────────────────────────────────────────────────────────────────────┐
│ Top scope bar: organization / project / branch search / health / account │
├────────────────┬──────────────────────┬─────────────────────────────────┤
│ Primary        │ Contextual product   │ Main content                    │
│ product sidebar│ menu (grouped)       │ header → tabs → cards / tables   │
│                │                      │                                 │
│ Home           │ e.g. Database        │ e.g. Tables                     │
│ Database       │ ├ Management         │ ├ page actions                  │
│ Auth           │ ├ Access control     │ ├ object list                   │
│ Storage        │ ├ Configuration      │ └ inspector / editor            │
│ Functions      │ └ Platform           │                                 │
│ Realtime       │                      │                                 │
│ Logs           │                      │                                 │
│ Settings       │                      │                                 │
└────────────────┴──────────────────────┴─────────────────────────────────┘
```

MARI BASE now implements the same reading order:

1. `Topbar` — active organization, active project, health, theme, operator.
2. `Sidebar` — grouped Home / Database / Products / Operate / Platform routes.
3. `Context menu` — the second-level menu for the selected product. Every item
   either navigates to a real page, activates a real local tab, or scrolls to a
   real control.
4. `page-root` — the existing data-driven page for that destination.

The second-level menu is generated from
[`public/dashboard/js/navigation.js`](../public/dashboard/js/navigation.js).
It is intentionally data-driven, so adding a product does not mean adding
another opaque monolithic page.

## 2. Source files inspected

| Concern | Supabase source |
| :--- | :--- |
| Organization / project scope and primary routes | [`NavigationBar.utils.tsx`](https://github.com/supabase/supabase/blob/9391f60ec973113d69f5fa7a09a4860e50f56a50/apps/studio/components/layouts/Navigation/NavigationBar/NavigationBar.utils.tsx) and [`Sidebar.tsx`](https://github.com/supabase/supabase/blob/9391f60ec973113d69f5fa7a09a4860e50f56a50/apps/studio/components/interfaces/Sidebar.tsx) |
| Product-menu registry | [`mobileProductMenuRegistry.tsx`](https://github.com/supabase/supabase/blob/9391f60ec973113d69f5fa7a09a4860e50f56a50/apps/studio/components/layouts/ProjectLayout/LayoutHeader/MobileMenuContent/mobileProductMenuRegistry.tsx) |
| Database submenu | [`DatabaseMenu.utils.tsx`](https://github.com/supabase/supabase/blob/9391f60ec973113d69f5fa7a09a4860e50f56a50/apps/studio/components/layouts/DatabaseLayout/DatabaseMenu.utils.tsx) |
| Auth submenu | [`AuthLayout.utils.ts`](https://github.com/supabase/supabase/blob/9391f60ec973113d69f5fa7a09a4860e50f56a50/apps/studio/components/layouts/AuthLayout/AuthLayout.utils.ts) |
| Storage submenu | [`StorageMenuV2.tsx`](https://github.com/supabase/supabase/blob/9391f60ec973113d69f5fa7a09a4860e50f56a50/apps/studio/components/interfaces/Storage/StorageMenuV2.tsx) |
| Functions / Realtime / Logs submenus | [`EdgeFunctionsLayout.tsx`](https://github.com/supabase/supabase/blob/9391f60ec973113d69f5fa7a09a4860e50f56a50/apps/studio/components/layouts/EdgeFunctionsLayout/EdgeFunctionsLayout.tsx), [`RealtimeMenu.utils.ts`](https://github.com/supabase/supabase/blob/9391f60ec973113d69f5fa7a09a4860e50f56a50/apps/studio/components/layouts/RealtimeLayout/RealtimeMenu.utils.ts), [`LogsSidebarMenuV2.tsx`](https://github.com/supabase/supabase/blob/9391f60ec973113d69f5fa7a09a4860e50f56a50/apps/studio/components/layouts/LogsLayout/LogsSidebarMenuV2.tsx) |
| Settings / organization submenus | [`SettingsMenu.utils.tsx`](https://github.com/supabase/supabase/blob/9391f60ec973113d69f5fa7a09a4860e50f56a50/apps/studio/components/layouts/ProjectSettingsLayout/SettingsMenu.utils.tsx), [`OrganizationSettingsLayout.tsx`](https://github.com/supabase/supabase/blob/9391f60ec973113d69f5fa7a09a4860e50f56a50/apps/studio/components/layouts/ProjectLayout/OrganizationSettingsLayout.tsx) |

## 3. Primary sidebar mapping

Supabase groups route generation into `useGenerateToolRoutes`,
`generateProductRoutes`, `generateOtherRoutes`, and `generateSettingsRoutes`.
MARI BASE's equivalent groups are:

| Supabase group / item | MARI BASE section | Studio tab | Backend |
| :--- | :--- | :--- | :--- |
| Project Overview | Workspace → Overview | `overview` | `GET /v1/projects/:ref` |
| Organization: Projects / Team / Usage / Settings | Workspace → Workspaces | `organizations` | `GET /v1/organizations` |
| Connect / project URL and keys | Workspace → Connect | `connect` | `/ready`, `/v1/platform`, project keys |
| — (new explanatory route) | Workspace → Structure map | `map` | static mapping + live endpoint list |
| Table Editor | Database → Table Editor | `database` | `/database/tables`, `/rest/:table` |
| SQL Editor / Explorer | Database → SQL & Policies | `sql` | `/database/sql`, `/database/queries`, `/database/policies` |
| Migrations | Database → Migrations | `migrations` | `/database/migrations` |
| Data API / API Docs | Products → API & Explorer | `api` | `/rest`, `/rpc`, `/openapi.json` |
| Authentication | Products → Authentication | `auth` | `/auth/*` |
| Storage | Products → Storage | `storage` | `/storage/*` |
| Edge Functions | Products → Functions & Jobs | `functions` | `/functions/*`, `/jobs/*`, `/schedules/*` |
| Realtime | Products → Realtime | `realtime` | `/realtime/*`, `/realtime/ws` |
| Advisors / Observability / Logs | Operate → Logs & Monitoring | `logs` | `/v1/metrics`, `/v1/platform/diagnostics`, `/audit` |
| Database Backups | Operate → Backups & Settings | `backups` | `/backups/*`, `/v1/platform/apk/*` |
| Project Settings / API Keys / Vault | Operate → Security & Team | `security` | `/api-keys`, `/secrets`, `/members` |
| Platform administration | Platform → Platform Admin | `platform` | `/v1/platform/*` |
| SDK / API docs | Platform → SDK, CLI & Docs | `docs` | static generated snippets |

## 4. Contextual product-menu mapping

Supabase's registry uses one secondary menu per product. MARI BASE maps those
groups to existing working controls rather than fake links:

| Supabase product | Supabase secondary groups | MARI BASE destination |
| :--- | :--- | :--- |
| Table Editor | schema / tables / entity types / new table | `database`: schema table list, visual column builder, row browser, schema inspector |
| SQL Editor | saved queries / snippets / folders / running queries | `sql`: shared query library, workbench, query shortcuts, RLS policies |
| Database | Database Management, Access Control, Configuration, Platform | `database` + `sql` + `migrations` + `backups` + `platform` |
| Authentication | Manage, Notifications, Configuration | `auth` local tabs: users, tester, sessions, auth policies, operator security |
| Storage | Manage, Configuration | `storage` local tabs: buckets, policies, settings, signed URLs, multipart upload |
| Edge Functions | Manage: Functions and Secrets | `functions` local tabs: functions, secrets, jobs, schedules |
| Realtime | Tools: Inspector; Configuration: Policies, Settings | `realtime` local tabs: inspector, publish, history, channel config |
| Logs | API Gateway, Postgres, PostgREST, Auth, Storage, Realtime, Functions, Cron | `logs` local tabs: health, structured errors, audit; function logs on `functions` |
| Project Settings | General, API Keys, Data API, Vault, Webhooks, Billing | `backups` project settings, `security` keys/secrets/team, `api` Data API |
| Organization Settings | General, Security, SSO, OAuth Apps, Webhooks, Audit Logs | `organizations` details/members/projects; `platform` operators/audit |

Items that Supabase offers but MARI BASE does not implement are deliberately
**not** shown as clickable product links. Examples: Supabase SSO, billing,
branching, vector/analytics buckets, GraphQL, and hosted-platform upgrades.
The structure map labels these as gaps instead of pretending they exist.

## 5. Service / architecture mapping

| Supabase service | Responsibility | MARI BASE equivalent |
| :--- | :--- | :--- |
| Studio | Operator dashboard | `public/dashboard`, also bundled into `android/app/src/main/assets/dashboard` |
| Envoy / Kong gateway | Public request gateway | `src/app.ts` Fastify gateway and route registration |
| Postgres | System database + project schemas | PostgreSQL 16 or PGlite; platform tables + `proj_<slug>` schemas |
| GoTrue | End-user auth | `src/routes/project-auth.ts`, `src/services/project-auth.service.ts` |
| PostgREST | Auto REST / RPC | `src/routes/data-api.ts`, `src/services/data-api.service.ts` |
| pg_meta | Catalog metadata | `src/services/database.service.ts` diagnostics and schema inspection |
| Realtime | WebSocket changes, broadcast, presence | `src/routes/realtime.ts`, `src/services/realtime.service.ts` |
| Storage API | Buckets, objects, policies | `src/routes/storage.ts`, `src/services/storage.service.ts` |
| Edge Functions | Isolated user code | `src/services/functions-jobs.service.ts` child workers |
| pg_cron / queues | Scheduled and durable work | `platform_jobs`, `platform_schedules`, worker supervisor |
| Supavisor / pooler | Connection pooling | `src/db/pool.ts` |
| GraphQL | GraphQL API | No equivalent; MARI BASE uses REST, RPC, and SQL |
| Hosted control plane | Organizations / billing / branches | `src/routes/organizations.ts` and `src/routes/platform.ts`; no billing/branches |

## 6. Data-storage mapping

MARI BASE keeps a single control plane and isolates each project in a private
PostgreSQL schema:

```text
platform_organizations ─┬─ platform_organization_members
                        └─ platform_projects ─┬─ platform_environments
                                              ├─ platform_project_members
                                              ├─ platform_api_keys
                                              ├─ platform_secrets
                                              ├─ platform_project_migrations
                                              ├─ platform_rls_policies
                                              ├─ platform_storage_buckets
                                              ├─ platform_storage_objects
                                              ├─ platform_realtime_channels
                                              ├─ platform_functions
                                              ├─ platform_jobs
                                              ├─ platform_schedules
                                              ├─ platform_backups
                                              └─ platform_saved_queries

proj_<project-slug>     ← project-owned application tables
role_<project-slug>     ← least-privilege owner role
role_<project-slug>_rls ← RLS-enforcing client role
auth.uid()/role()/email()/jwt()/project_id() ← transaction-local JWT claims
```

End-user identity tables (`project_auth_users`, `project_auth_identities`,
`project_auth_sessions`, `project_auth_tokens`) are shared control-plane tables
but are scoped by `project_id`. Object bytes live under `STORAGE_DIR`; their
metadata, checksum, bucket, and policy records live in PostgreSQL.

## 7. Where this is implemented

- Public, authentication-free guide: `/guide/` (`public/guide/index.html`).
- Studio primary sidebar: `public/dashboard/index.html`.
- Studio product-menu data: `public/dashboard/js/navigation.js`.
- Studio pages and structure-map rendering: `public/dashboard/js/pages.js`.
- Context-menu behavior: `public/dashboard/app.js`.
- Studio styling: `public/dashboard/styles.css`.
- Static asset routing: `src/routes/dashboard.ts`.
- Android parity: `android/app/src/main/assets/dashboard/` plus
  `MainActivity.java` setup hints.
