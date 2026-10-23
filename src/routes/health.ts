import type { FastifyInstance } from "fastify";
import { pool } from "../db/pool.js";
export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => ({ status: "ok", service: "maary-base-api", timestamp: new Date().toISOString() }));
  app.get("/ready", async (_request, reply) => {
    try { await pool.query("SELECT 1"); return { status: "ready", dependencies: { postgres: "ok" } }; }
    catch { return reply.code(503).send({ status: "not_ready", dependencies: { postgres: "unavailable" } }); }
  });
}
