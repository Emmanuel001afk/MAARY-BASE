import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { config } from "./config.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerPlatformRoutes } from "./routes/platform.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerProjectRoutes } from "./routes/projects.js";
export async function buildApp() {
 const app = Fastify({ logger: { level: config.LOG_LEVEL }, trustProxy: false, bodyLimit: 1_048_576, requestTimeout: 15_000 });
 await app.register(helmet);
 await app.register(cors, { origin: config.CORS_ORIGIN.split(",").map(origin => origin.trim()), credentials: false });
 await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });
 app.setErrorHandler((error, request, reply) => {
  const failure = error instanceof Error ? error : new Error("Unknown request failure");
  const status = (failure as Error & { statusCode?: number }).statusCode;
  const statusCode = status && status >= 400 && status < 500 ? status : 500;
  if (statusCode >= 500) request.log.error({ err: failure }, "Request failed");
  else request.log.warn({ statusCode, message: failure.message }, "Request rejected");
  return reply.code(statusCode).send({ error: statusCode === 500 ? "internal_server_error" : "request_error", message: statusCode === 500 ? "An unexpected error occurred." : failure.message, requestId: request.id });
 });
 await registerHealthRoutes(app); await registerPlatformRoutes(app); await registerAuthRoutes(app); await registerProjectRoutes(app);
 app.setNotFoundHandler((request, reply) => reply.code(404).send({ error: "not_found", message: "The requested endpoint does not exist.", requestId: request.id }));
 return app;
}
