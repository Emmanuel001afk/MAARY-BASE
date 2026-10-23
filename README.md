# MARRY BASE

<p align="center">
  <img src="assets/logo.png" alt="MARRY BASE Official Logo" width="180" />
</p>

**MARRY BASE** (also aliased as `MAARY BASE`) is an independent, self-hostable, general-purpose backend platform built on PostgreSQL and TypeScript/Fastify. It provides an integrated control plane, multi-project schema and role isolation, authentication, REST and RPC APIs, object storage, realtime subscriptions, server functions, background jobs, backups, a web management studio, a CLI, a TypeScript SDK, and an Android companion app for opening the management dashboard on a reachable MARRY BASE server.

---

## Android app and APK

The Android app is a native WebView shell for the MARRY BASE management dashboard. On first launch, it asks for the URL of a running MARRY BASE server and remembers that URL. Use an HTTPS URL for remote deployments. For a local network deployment, use the server device's reachable LAN address and port (for example, `http://192.168.1.10:4100`); `localhost` on a phone refers to the phone itself.

The APK is built with the Android Gradle Plugin, not by manually assembling ZIP/DEX/manifest bytes.

### Download the APK from GitHub Actions

1. Open the repository's **Actions** tab.
2. Select the latest **MAARY BASE CI** run for your branch.
3. Open the **Build Android APK** job and wait for it to succeed.
4. Download the `maary-base-android-debug-apk` artifact from the run's **Artifacts** section.
5. Extract the downloaded ZIP; it contains `app-debug.apk`. Transfer that APK to the Android device and install it.

Artifacts are retained for 30 days. The debug APK is intended for testing and sideloading; a release APK with a managed signing key should be added before store distribution.

---

## Capabilities overview

| Subsystem | Status | Key capabilities |
| :--- | :--- | :--- |
| Control plane and projects | Implemented | Multi-project lifecycle, RBAC, scoped API keys, encrypted secrets, audit logging |
| Database infrastructure | Implemented | External PostgreSQL or embedded PGlite, project schemas, migrations, SQL editor |
| Authentication and identity | Implemented | Password hashing, access tokens, refresh token rotation, OAuth integration |
| Data APIs | Implemented | REST CRUD, filtering, pagination, relationship embedding, RPC and OpenAPI |
| Object storage | Implemented | Public/private buckets, access policies, quotas, checksums, signed URLs |
| Realtime services | Implemented | Authenticated WebSocket subscriptions and broadcasts |
| Server functions and jobs | Implemented with limitations | Versioned functions, execution timeouts, durable job queue |
| Management studio, CLI and SDK | Implemented | Web dashboard, CLI and TypeScript SDK |
| Android companion app | Build configured | Dashboard WebView, configurable server URL, CI-built debug APK artifact |
| Operations and backups | Implemented with limitations | Health endpoints, metrics, logical backups and restoration |

---

## Requirements

- Node.js 22+
- External PostgreSQL 15+ or embedded PGlite for local operation
- Java 17, Android SDK platform 34, Android build-tools 34.0.0, and Gradle 8.2.1 to build the Android app locally

## Quick start

### Backend

```bash
npm ci
cp .env.example .env
npm run db:migrate
npm run dev
```

Open `http://localhost:4100` on a computer on the same device as the server to access the management studio.

### Android APK

With Java 17, Android SDK platform 34/build-tools 34.0.0, and Gradle 8.2.1 installed:

```bash
npm run build:apk
```

The APK is created at `android/app/build/outputs/apk/debug/app-debug.apk`.

### Docker Compose deployment

```bash
cp .env.example .env
# Set strong POSTGRES_PASSWORD, JWT_SECRET, and ENCRYPTION_KEY in .env
docker compose up -d --build
```

## Developer workflows

```bash
npm run typecheck
npm run build
npm test
npm run cli -- status
```

See `docs/ARCHITECTURE.md`, `docs/API_REFERENCE.md`, and `docs/OPERATIONS.md` for additional details.
