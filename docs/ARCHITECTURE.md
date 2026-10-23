# Architecture and roadmap

## Initial architecture

The first implementation uses PostgreSQL as the durable relational engine and a TypeScript/Fastify API as the platform layer. This is not a claim that a new database engine has been created. PostgreSQL-specific capabilities will be documented honestly.

Clients -> Fastify HTTP API -> platform services -> PostgreSQL.

Planned modules include project/environment control, authentication and authorization, database API, object storage, realtime delivery, server functions, background queues, dashboard, audit, operations, backups, and multi-node synchronization.

## Security boundaries

- Local database port is bound to loopback by default.
- Keep credentials in environment variables or a secret manager.
- Validate external input at API boundaries.
- Do not expose arbitrary SQL execution or public signup by default.
- Administrative credentials must remain server-side.
- Add auditable access decisions and security-sensitive events as those modules are implemented.

## Roadmap

1. Foundation: configuration, API lifecycle, PostgreSQL, migrations, health checks, tests.
2. Control plane: projects, environments, roles, API keys, audit trail, authorization policies.
3. Database API: schema/query interfaces, migration management, row-level access policies, API generation.
4. Identity: users, sessions, recovery, token rotation, MFA extension points.
5. Storage: buckets, metadata, local filesystem adapter, policies, quotas.
6. Realtime: authenticated subscriptions with documented delivery guarantees.
7. Execution: queues, scheduled tasks, server functions, retries and limits.
8. Operations: dashboard, metrics, logs, backups, restore verification, upgrades and rollback.
9. Distribution: single-node self-hosting, then documented replication and synchronization.

Each stage requires tests and documentation. Running multiple API instances does not itself provide database replication or multi-master consistency.
