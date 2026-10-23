# Architecture, guarantees, and roadmap

## Implemented architecture

MAARY BASE is currently a single-node control-plane application, not a collection of independently deployed microservices:

```text
Developer/client -> Fastify HTTP API -> control-plane services -> PostgreSQL
                                                   └-> per-project PostgreSQL schemas
```

The control-plane metadata tables (`platform_*`) live in the configured platform database. Each project environment is allocated a schema with a generated, validated identifier in the same PostgreSQL database. Project metadata and project schemas are provisioned transactionally. This is useful logical separation but shares the database's availability, CPU, storage, and administrator trust boundary; it is not an isolated database server or a tenant sandbox.

- `src/routes/auth.ts`: account registration/login, refresh rotation, logout, and profile.
- `src/security/crypto.ts`: scrypt password hashes, HMAC-SHA256 signed access tokens, opaque refresh-token digests.
- `src/security/auth.ts`: user session/API-key verification and project-role checks.
- `src/routes/projects.ts`: project/environment schema provisioning, membership administration, project-key lifecycle, archive operation, and audit events.
- `src/db/migrations/`: platform metadata migrations; migration runner is transactional and records ordered SQL filenames.
- `src/db/pool.ts`: bounded shared PostgreSQL pool with connection timeouts.

The API key authorizer computes a digest and compares it in constant time; project-level roles are enforced server-side. Project archive is non-destructive. Audit records are committed atomically with project, environment, and API-key mutations. Project keys can access only their associated active project and cannot be used for user-only actions.

## Operational boundaries and current guarantees

- Access tokens last 15 minutes and are signed with `TOKEN_SECRET`; active session state is checked for protected user routes. Refresh credentials last 30 days, are stored as SHA-256 digests, and rotate while the session row is locked. Logout revokes the associated session.
- Passwords are salted scrypt hashes (`N=16384`, `r=8`, `p=1`); plaintext passwords are not stored.
- Control-plane queries use parameterized values. Dynamic schema identifiers are generated from UUIDs and additionally checked against a strict allowlist before SQL interpolation.
- Migration transactions depend on PostgreSQL transactional DDL for the included statements. The runner takes a PostgreSQL transaction-scoped advisory lock before checking or applying migrations, so concurrent runner processes serialize on the same database.
- `/health` means the process is serving. `/ready` checks PostgreSQL and the required control-plane migration, and returns 503 when either fails.
- Compose stores Postgres data in a named Docker volume. API containers run migrations before startup. There are no automated database backups, restore tests, metrics pipeline, cross-node coordination, or disaster-recovery guarantees yet.

## Not implemented

No claim is made yet for a public data REST/GraphQL API, SQL editor, project RLS policy management, project end-user auth, email verification/recovery, external identity providers, MFA, membership invitations, file/object storage, realtime subscriptions, user-code execution, job queues, dashboard, backup/restore, or replication. The `/v1/platform` response reports these as planned. No arbitrary user code is executed.

## Roadmap

1. Add live PostgreSQL integration tests for migration concurrency/failure, schema isolation, auth/session rotation, project authorization and API-key revocation.
2. Implement membership administration and environment lifecycle with safe, audited resource cleanup.
3. Implement project database access through a schema-aware API with server-side authorization, transaction/resource limits, migrations, and explicit RLS design; never expose platform database credentials.
4. Build end-user identity, verified recovery flows, and project-consumer authorization policies.
5. Add storage via a filesystem/object-store adapter with quota, content validation, and access policies.
6. Add authenticated realtime delivery, then queued jobs and scheduled processing with documented at-least-once semantics and isolation.
7. Build a dashboard and developer CLI against the real control-plane and service endpoints.
8. Add backup/restore tests, structured audit/operational metrics, upgrades, and deployment hardening.
9. Evaluate multi-node operation only after clear coordination and failure guarantees exist.

A project schema is not a substitute for row-level policies or independent database instances. Multiple API processes also do not by themselves provide replication, exactly-once delivery, or high availability.
