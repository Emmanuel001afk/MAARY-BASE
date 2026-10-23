# MAARY BASE Architecture

## 1. Architectural Principles & Module Boundaries

MAARY BASE is structured into clearly separated layers with explicit contracts:

```text
Clients / Dashboard / SDK / CLI
        │
        ▼
Fastify HTTP & WebSocket API Layer (src/routes/*, src/middleware/auth.middleware.ts)
        │
        ├── Control Plane Service (src/services/project.service.ts, platform-auth.service.ts)
        ├── Database & Migration Service (src/services/database.service.ts)
        ├── Data API & OpenAPI Engine (src/services/data-api.service.ts)
        ├── Project Identity & Auth Service (src/services/project-auth.service.ts)
        ├── Object Storage Service (src/services/storage.service.ts)
        ├── Realtime Broker (src/services/realtime.service.ts)
        ├── Functions & Background Queue Service (src/services/functions-jobs.service.ts)
        └── Backup & Audit Service (src/services/backup.service.ts, audit.service.ts)
        │
        ▼
Unified PostgreSQL Pool & Transaction Layer (src/db/pool.ts)
        │
        ▼
PostgreSQL Engine (External PostgreSQL via pg.Pool OR Embedded PostgreSQL via PGlite)
```

---

## 2. Multi-Project Isolation & PostgreSQL Row-Level Security

Every project created on MAARY BASE receives:
1. **Dedicated PostgreSQL Schema (`proj_<slug>`)**: All project tables, views, indexes, sequences, and RPC functions reside inside `"proj_<slug>"`, cleanly separated from platform control-plane tables (`public.platform_*`).
2. **Dedicated PostgreSQL Database Role (`role_<slug>`)**: A non-superuser role with `USAGE` granted only on `"proj_<slug>"` and the `auth` helper schema. It has zero privileges on `public.platform_*` or any other project's schema (`proj_<other>`).
3. **Transactional RLS Context (`withRlsTransaction`)**:
   - Every project Data API query and non-service SQL query runs inside a transaction that configures:
     - `SET LOCAL search_path TO "proj_<slug>", auth, public`
     - `SET LOCAL statement_timeout = <ms>`
     - `set_config('request.jwt.claim.sub', <userId>, true)`
     - `set_config('request.jwt.claim.role', <role>, true)`
     - `set_config('request.jwt.claim.email', <email>, true)`
     - `set_config('request.jwt.claim.project_id', <projectId>, true)`
     - `set_config('request.jwt.claims', <json>, true)`
     - `SET LOCAL ROLE "role_<slug>"` (unless `service_role` bypass is explicitly authorized).
   - PostgreSQL natively evaluates all `ENABLE ROW LEVEL SECURITY` / `FORCE ROW LEVEL SECURITY` policies (`USING` and `WITH CHECK` expressions) referencing `auth.uid()`, `auth.role()`, `auth.email()`, and `auth.jwt()`.

---

## 3. Authentication, Token Rotation & Security Model

- **Password Storage**: Passwords are hashed using `node:crypto` `scrypt` with 16-byte random per-user salts and verified using `timingSafeEqual`.
- **Refresh Token Rotation & Reuse Detection**:
  - Refresh tokens are stored as SHA-256 hashes in `project_auth_sessions` grouped by `token_family_id`.
  - When a refresh token is exchanged, it is marked `replaced_at = now()` and a new token is issued in the same family.
  - If a previously rotated refresh token is replayed, MAARY BASE detects token theft/reuse, immediately revokes every session in that `token_family_id`, and records a `auth.token.reuse_detected` security audit event.
- **API Keys & Secrets**:
  - Project API keys (`mb_anon_...`, `mb_service_...`, `mb_key_...`) are stored by their SHA-256 hash (`key_hash`) for authentication lookup, alongside an AES-256-GCM encrypted copy (`encrypted_key`) for authorized control-plane inspection.
  - Project environment secrets (`platform_secrets`) are encrypted at rest using AES-256-GCM with a random 12-byte IV and 16-byte authentication tag derived from `ENCRYPTION_KEY`.

---

## 4. Realtime Delivery Guarantees

- Every table created in a project schema has an `AFTER INSERT OR UPDATE OR DELETE` trigger (`maary_realtime_trigger`) calling `public.maary_capture_row_change()`.
- Because the trigger executes within the same PostgreSQL transaction as the row mutation, change events are only committed to `platform_realtime_events` if the transaction commits.
- The `RealtimeBroker` dispatches committed events over WebSocket to subscribed clients and supports `lastEventId` cursor replay on reconnect, providing **at-least-once delivery within the event retention window** (not claiming distributed exactly-once delivery).

---

## 5. Server Functions & Background Queue Isolation

- Server functions execute inside a restricted `node:vm` context with `codeGeneration: { strings: false, wasm: false }` and a hard CPU/async execution timeout (`timeout_ms`).
- Host globals (`process`, `require`, `fs`, `child_process`) are not exposed to the sandbox. Database access is provided exclusively via `ctx.db.query()`, which executes through `executeProjectSql` inside the project's isolated schema and caller RLS context.
- Background jobs (`platform_jobs`) support priorities, delayed execution (`run_at`), `idempotency_key` deduplication, exponential backoff retries (`2^(attempt-1)` seconds), and transition to `dead_letter` when `attempts >= max_attempts`.

---

## 6. Infrastructure Boundaries & Limitations

- **High Availability & Replication**: Running multiple stateless MAARY BASE API containers behind a load balancer requires an external shared PostgreSQL instance (`DATABASE_URL=postgres://...`) and shared object storage volume/S3 bucket. Database replication, failover, and WAL archiving are responsibilities of the underlying PostgreSQL cluster rather than the API process.
- **Function Runtime**: The built-in `node:vm` sandbox isolates JavaScript execution with timeouts and restricted globals within the Node.js process. For untrusted multi-tenant public cloud hosting against adversarial native-code exploits, pair with container/microVM-level isolation (e.g., gVisor or Firecracker).
