import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { config } from "./config.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerPlatformRoutes } from "./routes/platform.js";
export async function buildApp() {
 const app = Fastify({ logger: { level: config.LOG_LEVEL }, trustProxy: false, bodyLimit: 1_048_576, requestTimeout: 15_000 });
 await app.register(helmet);
 await app.register(cors, { origin: config.CORS_ORIGIN.split(",").map(origin => origin.trim()), credentials: false });
 await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });
 app.setErrorHandler((error, request, reply) => {
  request.log.error({ err: error }, "Request failed");
  const statusCode = error.statusCode && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
  return reply.code(statusCode).send({ error: statusCode === 500 ? "internal_server_error" : "request_error", message: statusCode === 500 ? "An unexpected error occurred." : error.message, requestId: request.id });
 });
 await registerHealthRoutes(app); await registerPlatformRoutes(app);
 app.setNotFoundHandler((request, reply) => reply.code(404).send({ error: "not_found", message: "The requested endpoint does not exist.", requestId: request.id }));
 return app;
}
