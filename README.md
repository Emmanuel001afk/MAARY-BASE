# MAARY BASE

MAARY BASE is the foundation of an independent, general-purpose, self-hostable backend and database platform.

## Foundation status

This repository is being reset from its former AI browser application into a backend platform. The initial foundation contains a Fastify HTTP API, PostgreSQL connection management, SQL migrations, health/readiness endpoints, local Compose configuration, environment-based configuration, and initial tests. Authentication, project authorization, storage, realtime, background jobs, and the management dashboard are not yet implemented and must not be considered complete.

## Requirements

- Node.js 22+
- npm
- Docker Compose for local PostgreSQL

## Local setup

1. Copy `.env.example` to `.env` and set a strong local database password.
2. Start the database: `docker compose up -d database`.
3. Install packages: `npm install`.
4. Apply migrations: `npm run db:migrate`.
5. Start API: `npm run dev`.

API defaults to `127.0.0.1:4100`.

## Endpoints

- `GET /health` — process health.
- `GET /ready` — checks PostgreSQL connectivity.
- `GET /v1/platform` — platform identity and honest module status.

See `docs/ARCHITECTURE.md` for architecture and staged capability roadmap.
