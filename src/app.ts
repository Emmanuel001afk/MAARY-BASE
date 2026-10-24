import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import { config } from "./config.js";
import { runMigrations } from "./db/migrate.js";
import { AppError } from "./lib/errors.js";
import { registerDashboardRoutes } from "./routes/dashboard.js";
import { registerDataApiRoutes } from "./routes/data-api.js";
import { registerDatabaseRoutes } from "./routes/database.js";
import { registerFunctionsAndJobsRoutes } from "./routes/functions-jobs.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerObservabilityRoutes } from "./routes/observability.js";
import { registerPlatformRoutes } from "./routes/platform.js";
import { registerProjectAuthRoutes } from "./routes/project-auth.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerRealtimeRoutes } from "./routes/realtime.js";
import { registerStorageRoutes } from "./routes/storage.js";
import { workerSupervisor } from "./services/functions-jobs.service.js";
import { realtimeBroker } from "./services/realtime.service.js";

export async function buildApp() {
  if (config.AUTO_MIGRATE) {
    await runMigrations({ silent: true });
  }

  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
    trustProxy: config.TRUST_PROXY,
    bodyLimit: Math.max(config.MAX_UPLOAD_BYTES + 1_048_576, 10_485_760),
    requestTimeout: 30_000,
  });

  await app.register(helmet, {
    frameguard: { action: "sameorigin" },
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:"],
        connectSrc: ["'self'", "ws:", "wss:", "http:", "https:"],
        frameAncestors: ["'self'"],
      },
    },
  });

  const origins = config.CORS_ORIGIN.split(",").map((o) => o.trim());
  await app.register(cors, {
    origin: origins.includes("*") ? "*" : origins,
    credentials: false,
  });

  await app.register(rateLimit, {
    max: config.RATE_LIMIT_MAX,
    timeWindow: "1 minute",
  });

  await app.register(websocket);

  // Support binary buffers for raw file uploads
  app.addContentTypeParser(
    ["application/octet-stream", "image/png", "image/jpeg", "image/webp", "application/pdf"],
    { parseAs: "buffer" },
    (_req, body, done) => {
      done(null, body);
    }
  );

  app.setErrorHandler((error: any, request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({
        error: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
        requestId: request.id,
      });
    }

    // Map standard PostgreSQL error codes to structured HTTP errors
    if (typeof error?.code === "string") {
      if (error.code === "23505") {
        return reply.code(409).send({
          error: "conflict",
          message: error.detail || "Unique constraint violation.",
          requestId: request.id,
        });
      }
      if (error.code === "23503") {
        return reply.code(400).send({
          error: "foreign_key_violation",
          message: error.detail || "Foreign key constraint violation.",
          requestId: request.id,
        });
      }
      if (error.code === "23502" || error.code === "23514" || error.code === "22P02") {
        return reply.code(400).send({
          error: "validation_error",
          message: error.message || "Database constraint or data type violation.",
          requestId: request.id,
        });
      }
      if (error.code === "42501") {
        return reply.code(403).send({
          error: "rls_policy_violation",
          message:
            "Row-Level Security policy or schema permission denied this operation.",
          requestId: request.id,
        });
      }
    }

    request.log.error({ err: error }, "Request failed");
    const statusCode =
      error?.statusCode && error.statusCode >= 400 && error.statusCode < 500
        ? error.statusCode
        : 500;

    return reply.code(statusCode).send({
      error: statusCode === 500 ? "internal_server_error" : "request_error",
      message:
        statusCode === 500 ? "An unexpected error occurred." : error.message,
      requestId: request.id,
    });
  });

  await registerDashboardRoutes(app);
  await registerHealthRoutes(app);
  await registerObservabilityRoutes(app);
  await registerPlatformRoutes(app);
  await registerProjectRoutes(app);
  await registerDatabaseRoutes(app);
  await registerDataApiRoutes(app);
  await registerProjectAuthRoutes(app);
  await registerStorageRoutes(app);
  await registerRealtimeRoutes(app);
  await registerFunctionsAndJobsRoutes(app);

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({
      error: "not_found",
      message: "The requested endpoint does not exist.",
      requestId: request.id,
    })
  );

  if (config.WORKER_ENABLED) {
    workerSupervisor.start();
  }

  app.addHook("onClose", async () => {
    workerSupervisor.stop();
    realtimeBroker.stopPolling();
  });

  return app;
}
