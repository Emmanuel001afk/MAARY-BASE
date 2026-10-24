import { access, constants, mkdir } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { getMigrationStatus } from "../db/migrate.js";
import { pool } from "../db/pool.js";
import { workerSupervisor } from "../services/functions-jobs.service.js";
import { realtimeBroker } from "../services/realtime.service.js";

export async function registerHealthRoutes(
  app: FastifyInstance
): Promise<void> {
  app.get("/health", async () => ({
    status: "ok",
    service: "maary-base-api",
    version: config.APP_VERSION,
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  }));

  app.get("/ready", async (_request, reply) => {
    const dependencies: Record<string, string> = {
      postgres: "unavailable",
      migrations: "unknown",
      storage: "unavailable",
    };

    try {
      await pool.query("SELECT 1");
      dependencies.postgres = "ok";
    } catch {
      return reply.code(503).send({
        status: "not_ready",
        dependencies,
      });
    }

    try {
      const migStatus = await getMigrationStatus();
      dependencies.migrations =
        migStatus.pending.length === 0 ? "ok" : "pending_migrations";
    } catch {
      dependencies.migrations = "unavailable";
    }

    try {
      await mkdir(config.STORAGE_DIR, { recursive: true });
      await access(config.STORAGE_DIR, constants.W_OK);
      dependencies.storage = "ok";
    } catch {
      dependencies.storage = "unavailable";
    }

    const isReady =
      dependencies.postgres === "ok" &&
      dependencies.migrations === "ok" &&
      dependencies.storage === "ok";

    if (!isReady) {
      return reply.code(503).send({
        status: "not_ready",
        dependencies,
      });
    }

    return {
      status: "ready",
      version: config.APP_VERSION,
      dependencies,
      pool: pool.getStats(),
      worker: {
        enabled: config.WORKER_ENABLED,
        running: workerSupervisor.isRunning(),
      },
    };
  });

  app.get("/v1/metrics", async (request, reply) => {
    const [projRes, usersRes, jobsRes, storageRes] = await Promise.all([
      pool.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM platform_projects WHERE deleted_at IS NULL"
      ),
      pool.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM project_auth_users"
      ),
      pool.query<{ status: string; count: string }>(
        "SELECT status, COUNT(*)::text AS count FROM platform_jobs GROUP BY status"
      ),
      pool.query<{ bytes: string; objects: string }>(
        "SELECT COALESCE(SUM(size_bytes), 0)::text AS bytes, COUNT(*)::text AS objects FROM platform_storage_objects"
      ),
    ]);

    const poolStats = pool.getStats();
    const realtimeStats = realtimeBroker.getStats();
    const mem = process.memoryUsage();
    const jobsByStatus: Record<string, number> = {};
    for (const r of jobsRes.rows) {
      jobsByStatus[r.status] = Number(r.count);
    }

    const metricsPayload = {
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      memory: {
        rssBytes: mem.rss,
        heapUsedBytes: mem.heapUsed,
        heapTotalBytes: mem.heapTotal,
      },
      database: poolStats,
      projects: {
        activeCount: Number(projRes.rows[0]?.count ?? 0),
        totalAuthUsers: Number(usersRes.rows[0]?.count ?? 0),
      },
      storage: {
        totalBytes: Number(storageRes.rows[0]?.bytes ?? 0),
        totalObjects: Number(storageRes.rows[0]?.objects ?? 0),
      },
      realtime: {
        connectedClients: realtimeStats.connectedClients,
        activeSubscriptions: realtimeStats.subscriptions,
      },
      jobs: jobsByStatus,
    };

    const accept = request.headers.accept ?? "";
    if (
      accept.includes("text/plain") ||
      (request.query as Record<string, unknown>)?.format === "prometheus"
    ) {
      const lines = [
        `# HELP maary_uptime_seconds Process uptime in seconds`,
        `# TYPE maary_uptime_seconds gauge`,
        `maary_uptime_seconds ${metricsPayload.uptimeSeconds}`,
        `# HELP maary_memory_rss_bytes Resident set size in bytes`,
        `# TYPE maary_memory_rss_bytes gauge`,
        `maary_memory_rss_bytes ${metricsPayload.memory.rssBytes}`,
        `# HELP maary_db_queries_total Total database queries executed`,
        `# TYPE maary_db_queries_total counter`,
        `maary_db_queries_total ${poolStats.totalQueries}`,
        `# HELP maary_projects_active Active platform projects`,
        `# TYPE maary_projects_active gauge`,
        `maary_projects_active ${metricsPayload.projects.activeCount}`,
        `# HELP maary_storage_bytes_total Total stored object bytes`,
        `# TYPE maary_storage_bytes_total gauge`,
        `maary_storage_bytes_total ${metricsPayload.storage.totalBytes}`,
        `# HELP maary_realtime_connections Active WebSocket connections`,
        `# TYPE maary_realtime_connections gauge`,
        `maary_realtime_connections ${metricsPayload.realtime.connectedClients}`,
      ];
      return reply
        .header("content-type", "text/plain; version=0.0.4")
        .send(lines.join("\n") + "\n");
    }

    return metricsPayload;
  });
}
