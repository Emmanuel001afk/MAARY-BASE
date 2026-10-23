# MARRY BASE

<p align="center">
  <img src="assets/logo.png" alt="MARRY BASE Official Logo" width="180" />
</p>

**MARRY BASE** (also aliased as `MAARY BASE`) is an independent, self-hostable, general-purpose backend platform built on PostgreSQL and TypeScript/Fastify. It provides an integrated control plane, multi-project schema and role isolation, native PostgreSQL Row-Level Security (RLS), authentication and identity management, auto-generated REST and RPC Data APIs, object storage, WebSocket realtime subscriptions, isolated server functions, background job queues, logical backups and restoration, a web management studio, a CLI, a TypeScript SDK, and an integrated **Android `.apk` builder & packager**.

---

## Capabilities Overview

| Subsystem | Implementation Status | Key Capabilities |
| :--- | :--- | :--- |
| **Control Plane & Projects** | Operational | Multi-project lifecycle, environments (`development`, `staging`, `production`, custom), RBAC (`owner`, `admin`, `developer`, `viewer`), scoped API keys with rotation, AES-256-GCM encrypted secrets, audit logging. |
| **Database Infrastructure** | Operational | Supports external PostgreSQL (`postgres://`) and embedded PostgreSQL (`pglite://`), per-project schema isolation (`proj_<slug>`) + dedicated PostgreSQL roles (`role_<slug>`), table/column/index/FK management, versioned project migrations with SHA-256 checksums and rollback, SQL editor with destructive-query safeguards, extension management. |
| **Row-Level Security (RLS)** | Operational | Native PostgreSQL `ENABLE/FORCE ROW LEVEL SECURITY` and `CREATE POLICY` integrated with `auth.uid()`, `auth.role()`, `auth.email()`, `auth.project_id()`, and `auth.jwt()` SQL session helpers. |
| **Authentication & Identity** | Operational | Project user registration, `scrypt` password hashing, email verification tokens, password recovery, JWT access tokens + opaque refresh token rotation with reuse detection (`token_family_id`), OAuth provider authorization & callback identity linking, admin user management (ban/unban/delete). |
| **Data APIs & OpenAPI** | Operational | Auto-generated REST CRUD (`/v1/projects/:ref/rest/:table`), PostgREST-compatible filtering (`eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `like`, `ilike`, `in`, `is`, `contains`, `or`), ordering, pagination, count, many-to-one & one-to-many foreign-key relationship embedding, stored procedure RPC (`/v1/projects/:ref/rpc/:fn`), live OpenAPI 3.1 spec (`/v1/projects/:ref/openapi.json`). |
| **Object Storage** | Operational | Public & private buckets, bucket access policies (`path_prefix`, `allow_owner_only`, role checks), MIME validation, file-size limits, storage quotas, SHA-256 checksums, HMAC signed download/upload URLs, multipart resumable uploads, abandoned upload cleanup. |
| **Realtime Services** | Operational | Authenticated WebSocket server (`/v1/projects/:ref/realtime/ws`), automatic PostgreSQL row-change capture via `SECURITY DEFINER` triggers (`INSERT`, `UPDATE`, `DELETE`), channel broadcast, presence tracking, reconnection event replay via `lastEventId`. |
| **Server Functions & Jobs** | Operational | Versioned JS functions executed in a sandboxed `node:vm` runtime with CPU timeouts, console log capture, encrypted secret injection, and project-scoped DB bridge; durable PostgreSQL background job queue with retries, exponential backoff, dead-letter state, idempotency keys, and recurring schedules. |
| **Management Studio, CLI & SDK** | Operational | Interactive browser dashboard (`/` and `/dashboard`) branded with the official MARRY BASE logo, CLI (`npm run cli -- ...`), and fluent TypeScript SDK (`createMaaryClient`). |
| **Android APK Builder & Mobile** | Operational | Built-in Android `.apk` packager & RSA v1 JAR signer (`releases/marry-base.apk`), native Android project source (`android/`), CLI builder (`npm run build:apk`), and REST endpoints (`POST /v1/platform/apk/build` requires a platform access token; `GET /v1/platform/apk/download` serves the APK). |
| **Operations & Backups** | Operational | `/health`, `/ready`, `/v1/metrics` (JSON & Prometheus format), logical project/platform backups with SHA-256 integrity verification and transactional restoration. |

---

## Requirements

- **Node.js**: 22+
- **Database**:
  - External PostgreSQL 15+ (`DATABASE_URL=postgres://...` via Docker Compose or self-hosted PostgreSQL), **or**
  - Embedded persistent PostgreSQL (`DATABASE_URL=pglite://./data/postgres`) for zero-dependency local operation, **or**
  - Embedded in-memory PostgreSQL (`DATABASE_URL=pglite://memory`) for fast isolated integration testing.

---

## Quick Start

### 1. Local Self-Contained Operation (No Docker Required)

```bash
npm install
cp .env.example .env
npm run db:migrate
npm run dev
```

Open `http://localhost:4100` in your browser to access the **MAARY BASE Management Studio**.

### 2. Docker Compose Deployment (External PostgreSQL 17)

```bash
cp .env.example .env
# Set NODE_ENV=production and unique POSTGRES_PASSWORD, JWT_SECRET, ENCRYPTION_KEY,
# and PLATFORM_BOOTSTRAP_TOKEN values in .env (see docs/OPERATIONS.md).
docker compose up -d --build
```

---

## Developer Workflows

### CLI Usage

```bash
# Check platform health, database mode, and migration status
npm run cli -- status

# Apply platform migrations
npm run cli -- db migrate

# Create an isolated project (outputs anon and service_role keys)
npm run cli -- projects create "Acme App" acme-app

# Inspect project diagnostics and schema tables
npm run cli -- projects inspect acme-app

# Execute SQL inside the project's isolated schema
npm run cli -- sql acme-app "CREATE TABLE todos (id serial PRIMARY KEY, title text NOT NULL);"

# Create, verify, and restore a logical backup
npm run cli -- backup create acme-app
npm run cli -- backup list acme-app
npm run cli -- backup verify <backupId>
npm run cli -- backup restore <backupId>
```

### TypeScript Client SDK (`src/sdk/index.ts`)

```ts
import { createMaaryClient } from "./src/sdk/index.js";

const maary = createMaaryClient("http://localhost:4100", "<PROJECT_ANON_KEY>", {
  projectRef: "acme-app",
});

// 1. Authenticate an application user
await maary.auth.signUp({
  email: "developer@acme.io",
  password: "StrongPassword123!",
});

// 2. Query & mutate database tables (enforcing PostgreSQL Row-Level Security)
const { data: created } = await maary
  .from("todos")
  .insert({ title: "Launch on MAARY BASE" });

const { data: todos } = await maary
  .from("todos")
  .select("id,title")
  .eq("title", "Launch on MAARY BASE")
  .limit(10);

// 3. Upload and create signed URLs in Object Storage
await maary.storage.from("avatars").upload("users/profile.txt", "Hello World", {
  mimeType: "text/plain",
});

// 4. Invoke an isolated Server Function
const fnRes = await maary.functions.invoke("hello-world", {
  body: { event: "signup" },
});

// 5. Subscribe to live PostgreSQL row changes over WebSocket
const channel = await maary.realtime
  .channel("db:todos")
  .on("postgres_changes", (event) => {
    console.log("Row change:", event.operation, event.record);
  })
  .subscribe();
```

---

## Verification & Testing

```bash
# Run TypeScript typechecking
npm run typecheck

# Compile production build to dist/
npm run build

# Run the full integration test suite
npm test
```

---

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — System architecture, security boundaries, project isolation, and subsystem design.
- [`docs/API_REFERENCE.md`](docs/API_REFERENCE.md) — Complete HTTP & WebSocket API reference.
- [`docs/OPERATIONS.md`](docs/OPERATIONS.md) — Deployment, backups, recovery, metrics, hardware requirements, and troubleshooting.
