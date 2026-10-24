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
| **Management Studio, CLI & SDK** | Operational | Responsive browser studio (`/` and `/dashboard`) with dark/light themes, automatic session renewal, safe escaped rendering, complete project workflows, realtime inspection, RBAC, backups, mobile navigation, and keyboard commands; CLI (`npm run cli -- ...`) and fluent TypeScript SDK (`createMaaryClient`). |
| **Android APK Builder & Mobile** | Operational | Polished mobile connection hub, full in-app Management Studio, back-button navigation, generated per-project configuration, multi-density backend-themed icons, binary AXML/ARSC/DEX packaging, and persistent RSA v1 JAR + v2 whole-APK signing. Build with `npm run build:apk` or `POST /v1/platform/apk/build`; download with `GET /v1/platform/apk/download`. |
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

## Management Studio

The dependency-free Management Studio is served directly by Fastify and requires no frontend build step. It includes:

- Project diagnostics, environments, launch checklist, SDK snippets, and recent activity.
- Schema/table management, a row browser, SQL editor with local query history, and native RLS policy controls.
- Versioned migrations and confirmed rollbacks.
- End-user administration and authentication policy settings.
- Bucket/object management, real file or text uploads, and expiring signed downloads.
- Function deployment and invocation, durable job queues, and recurring schedules.
- Live WebSocket inspection, broadcasts, channels, and persisted event history.
- Scoped API keys with one-time credential display, encrypted secrets, and team RBAC.
- Backup creation/verification/restoration, audit search, OpenAPI export, project settings, and signed Android builds.

Use **Ctrl/Cmd + K** to open the command menu and **Ctrl/Cmd + Enter** in the SQL editor to run a query. Navigation is hash-based, so workspace views can be bookmarked and restored.

Studio source is organized under `public/dashboard/`:

```text
public/dashboard/
├── index.html       # Accessible application shell, dialogs, and SVG icon system
├── styles.css       # Responsive dark/light design system
├── app.js           # Authentication, routing, shell events, and command menu
└── js/
    ├── core.js      # API client, token renewal, state, safe rendering, and UI utilities
    ├── pages.js     # Workspace templates, data loaders, and table renderers
    └── actions.js   # Forms, mutations, confirmations, uploads, and realtime actions
```

---

## Android Mobile Client

The downloadable app opens a local connection hub rather than a static information page. It can:

- Verify a server through `/ready`, show basic runtime status, and remember the last working URL on the device.
- Open the complete Management Studio inside the app, with WebView history handled by the Android back button.
- Provide direct health/platform links plus emulator, LAN, HTTPS, and connection troubleshooting guidance.
- Use a project-specific package, version, server URL, and generated `assets/www/config.js` without interpolating server data into HTML.

Use `http://10.0.2.2:4100` from the Android emulator when MARRY BASE runs on the host computer. Use the host's LAN address for a physical test device, and HTTPS for production. The server URL contains no credentials; operator authentication remains inside the Studio.

```bash
# Build the default signed APK at releases/marry-base.apk
npm run build:apk

# Or build a project-specific artifact through the Studio's APK workspace.
# Its download URL is /v1/platform/apk/download?projectSlug=<slug>.
```

Project downloads serve the exact artifact produced by the build. They do not rebuild with default settings, and project builds never replace the default `releases/marry-base.apk`. Mobile source lives in `public/mobile/`; the native source shell under `android/` and the generated DEX in `src/services/apk.service.ts` use the same local client and connection behavior.

### Android signing and upgrade identity

Every APK is signed with both APK Signature Scheme v2 (required by modern Android installers) and a v1/JAR signature. The first local build creates an RSA 2048-bit private key at `data/apk-signing/private-key.pem` with owner-only permissions and reuses it for subsequent builds. **Back up this key securely and never commit it**: losing or replacing it prevents Android from accepting later builds as updates to the same package.

For managed/CI signing, set the `APK_SIGNING_PRIVATE_KEY` secret to a PKCS#8 PEM key, or set `APK_SIGNING_KEY_FILE` to a persistent key path. The optional CI secret is read only during the APK build step. Test builds use an isolated key under `data/test-apk-signing/`.

Verify a built artifact with Android's own tooling:

```bash
# Uses apksigner from ANDROID_HOME/ANDROID_SDK_ROOT, apksigner from PATH,
# or an explicit APKSIGNER executable path.
npm run verify:apk

# A local apksigner JAR is also supported.
JAVA=/path/to/java APKSIGNER_JAR=/path/to/apksigner.jar npm run verify:apk
```

The verification command requires v2 at the application's real SDK range and separately checks the retained v1 signature. CI runs this gate after every APK build.

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

# Validate Management Studio and mobile browser modules
npm run check:studio
npm run check:mobile

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
