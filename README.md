# MAARY BASE

MAARY BASE is an independent, self-hostable backend platform under active development. PostgreSQL is the data engine; this repository implements the management/API layer around it. It is **not yet a feature-complete Supabase alternative**. Current working capabilities and gaps are listed below.

## Current implementation

Implemented in this repository:

- Fastify API with structured errors, security headers, CORS configuration, request-size limits, and global rate limiting.
- PostgreSQL connection pooling and transactional, version-tracked SQL migrations.
- Password registration and login using salted scrypt hashes; short-lived signed access tokens; opaque refresh tokens with rotation and revocable sessions.
- User accounts and project membership roles (`owner`, `admin`, `developer`, `readonly`), with member listing/addition/role changes/removal. Added members must already have an account; project access is authorized on the server.
- Project creation provisions a separate PostgreSQL schema per project and an initial `development` environment. Additional environments create their own schemas. Schemas share the configured PostgreSQL server/database; this is logical isolation, not separate database instances or a hostile-tenant sandbox.
- Project-scoped API keys with role limits, optional expiry, digest-only storage, one-time display, revocation, and audit events.
- Project archival without destructive deletion.
- `/health` process liveness and `/ready` PostgreSQL + required-migration readiness checks.
- Docker Compose for a persistent PostgreSQL instance and API container.

Not implemented yet: end-user authentication for project applications, email verification/recovery or external identity providers, collaborative membership management, SQL/data REST APIs, database policies/RLS provisioning, migrations per project, storage, realtime, user-code functions, queues/scheduling, dashboard, metrics, backups/restore, and multi-node replication. `/v1/platform` exposes this module status; “planned” modules are not working features.

## Requirements

- Node.js 22+ and npm (tested with Node 22).
- Docker Compose v2 for the containerized local setup.
- PostgreSQL 17 is used by the provided Compose setup. A compatible PostgreSQL server may be used separately.

## Local containerized setup

1. Copy `.env.example` to `.env`.
2. Replace `POSTGRES_PASSWORD` with a unique URL-safe password and use the **same** value in `DATABASE_URL` (URL-encode special characters). Replace `TOKEN_SECRET` with at least 32 random characters, for example `openssl rand -hex 32`. Do not use the example values in a deployed environment.
3. Start the database and API: `docker compose up --build -d`.
   - PostgreSQL data persists in the `maary_postgres` named volume.
   - The API applies pending platform migrations before starting.
   - API is bound to `127.0.0.1:4100` on the host by default; change `PORT` to choose another host port.
4. Check `curl http://localhost:4100/health` and `curl http://localhost:4100/ready`. Readiness remains 503 until PostgreSQL is reachable and all required migrations have been applied.
5. Stop services with `docker compose down`. This preserves the volume. `docker compose down -v` deletes the local database volume and all its data.

## Run API from source

With PostgreSQL available at the address in `DATABASE_URL`:

```sh
cp .env.example .env
# Edit POSTGRES_PASSWORD, DATABASE_URL and TOKEN_SECRET in .env
npm ci
npm run db:migrate
npm run dev
```

The API listens on `0.0.0.0:4100` by default. For a local-only listener set `HOST=127.0.0.1`. To run the production build, use `npm run build` followed by `npm start`. Migrations run separately for this source workflow; the API does not silently apply schema changes on every process start.

## API overview

All control-plane routes are versioned under `/v1`. JSON requests use `Content-Type: application/json`. Protected endpoints accept `Authorization: Bearer <access-token>`; project API keys are accepted only for their own project and their assigned role. Access tokens expire after 15 minutes; refresh tokens are opaque, rotate on each successful refresh, and expire after 30 days.

| Method | Path | Access | Behavior |
|---|---|---|---|
| GET | `/health` | Public | Process liveness only |
| GET | `/ready` | Public | PostgreSQL and required migrations |
| GET | `/v1/platform` | Public | Version and honest module status |
| POST | `/v1/auth/register` | Public, rate limited | Create an account (password minimum 12 chars) and session |
| POST | `/v1/auth/login` | Public, rate limited | Authenticate and create a session |
| POST | `/v1/auth/refresh` | Refresh token | Rotate refresh token and issue a new access token |
| POST | `/v1/auth/logout` | User session | Revoke the current session |
| GET | `/v1/auth/me` | User session | Current account profile |
| POST | `/v1/projects` | User session | Create project, owner membership, and development schema |
| GET | `/v1/projects` | User session | List projects the user belongs to |
| GET | `/v1/projects/:projectId` | Project member or project key | Inspect a project |
| GET/POST | `/v1/projects/:projectId/environments` | Member / admin+ | List or create a schema-backed environment |
| GET/POST | `/v1/projects/:projectId/members` | Admin+ | List members / add an existing account as a member |
| PATCH/DELETE | `/v1/projects/:projectId/members/:userId` | Admin+ (owner-only for admin grants/removal) | Change role or remove member; owner is protected |
| POST | `/v1/projects/:projectId/archive` | Admin/owner | Archive project; does not drop its schemas |
| GET/POST | `/v1/projects/:projectId/api-keys` | User admin/owner | List keys / create a key shown only once |
| DELETE | `/v1/projects/:projectId/api-keys/:keyId` | User admin/owner | Revoke a key |

Example registration:

```sh
curl -X POST http://localhost:4100/v1/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"dev@example.test","password":"a-long-unique-password","displayName":"Developer"}'
```

The response includes `session.accessToken` and `session.refreshToken`. Use the access token to create projects. The key creation response contains a bearer secret once—store it securely. Never put an admin key in browser code. Email verification is not provided yet, so registration currently creates an unverified account; do not treat this as a production-ready consumer identity system.

## Database migrations and recovery

Platform migration SQL lives in `src/db/migrations/`; the runner serializes all pending migrations in a PostgreSQL transaction and records applied filenames in `platform_migrations`. Back up the PostgreSQL database and test restores before upgrades. No backup/restore automation or tested recovery workflow is included yet. Project environments currently have schemas, but project migrations and a public SQL editor/API are not implemented.

## Configuration and security

See `.env.example`. The application intentionally fails startup if `DATABASE_URL` or `TOKEN_SECRET` is missing/invalid. Set an unpredictable token secret per installation and back it up securely; replacing it invalidates outstanding access tokens. Production deployments must terminate TLS at a trusted ingress, restrict CORS to explicit trusted origins, protect the environment file, and provision PostgreSQL backups, monitoring, and firewall rules. The Compose database port is loopback-bound. The API container is also loopback-published by default.

Project schemas share PostgreSQL’s server process and platform database. API authorization prevents users and project-scoped keys from crossing project membership boundaries in the control-plane routes, but schema names are not a security boundary against a database administrator or a compromised platform process. Do not grant ordinary client code database credentials. API keys and authentication currently have no account recovery, verification email, MFA, or identity-provider integration.

## Development verification

```sh
npm ci
DATABASE_URL=postgres://user:password@localhost:5432/maary TOKEN_SECRET=at-least-32-characters-for-local-tests npm run typecheck
DATABASE_URL=postgres://user:password@localhost:5432/maary TOKEN_SECRET=at-least-32-characters-for-local-tests npm test
DATABASE_URL=postgres://user:password@localhost:5432/maary TOKEN_SECRET=at-least-32-characters-for-local-tests npm run build
```

The suite includes unit tests for password/token cryptography, API tests for health/input/anonymous access, and a PostgreSQL-backed control-plane integration test for registration, refresh rotation, schema-backed project creation, cross-project denial, key scopes/revocation, and session logout. The integration test runs only when `MAARY_TEST_DATABASE_URL` points to a dedicated disposable PostgreSQL database; CI provisions PostgreSQL 17 and runs it. Docker/PostgreSQL were unavailable in the current workspace, so that integration test was skipped here. TypeScript/build success alone does not verify live database behavior.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for boundaries, migration details, and next implementation stages.
