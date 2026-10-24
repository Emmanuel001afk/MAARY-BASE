import { existsSync } from "node:fs";
import { access, constants, mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getMigrationStatus } from "../db/migrate.js";
import { pool } from "../db/pool.js";
import { ValidationError } from "../lib/errors.js";
import { config } from "../config.js";
import { requirePlatformUser } from "../middleware/auth.middleware.js";
import {
  buildApkWithGradle,
  getApkStatus,
  loadApkForDownload,
} from "../services/apk.service.js";
import { listAuditEvents } from "../services/audit.service.js";
import {
  createDatabaseBackup,
  listDatabaseBackups,
  restoreDatabaseBackup,
  verifyBackupIntegrity,
} from "../services/backup.service.js";
import {
  enableDatabaseExtension,
  listDatabaseExtensions,
} from "../services/database.service.js";
import { workerSupervisor } from "../services/functions-jobs.service.js";
import {
  listPlatformUsers,
  loginPlatformUser,
  logoutPlatformSession,
  refreshPlatformSession,
  registerPlatformUser,
} from "../services/platform-auth.service.js";

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export async function registerPlatformRoutes(
  app: FastifyInstance
): Promise<void> {
  app.get("/v1/platform", async () => {
    const poolStats = pool.getStats();
    let databaseReachable = true;
    let migrationInfo = { appliedCount: 0, pendingCount: 0 };
    try {
      await pool.query("SELECT 1");
      const mig = await getMigrationStatus();
      migrationInfo = {
        appliedCount: mig.applied.length,
        pendingCount: mig.pending.length,
      };
    } catch {
      databaseReachable = false;
    }

    const storageWritable = await (async () => {
      try {
        await mkdir(config.STORAGE_DIR, { recursive: true });
        await access(config.STORAGE_DIR, constants.W_OK);
        return true;
      } catch {
        return false;
      }
    })();

    const workerRunning = workerSupervisor.isRunning();
    const apk = await getApkStatus();
    // The artifact states ("available"/"missing"/"invalid") describe the build
    // artifact; the service map below uses the platform-wide state vocabulary.
    const androidServiceState =
      apk.state === "available" ? "operational" : apk.state === "invalid" ? "failed" : "missing";

    // Public service states are derived from the same control-plane data as the
    // authenticated status page; nothing here is hard-coded to "operational".
    const counts = await (async () => {
      const result = {
        projectTables: 0,
        tablesWithoutRls: 0,
        realtimeEvents: 0,
        functionsDeployed: 0,
        functionInvocations: 0,
        backups: 0,
        restoredBackups: 0,
      };
      if (!databaseReachable) return result;
      try {
        const [tables, unsecured, events, functions, invocations, backups, restored] = await Promise.all([
          pool.query<{ count: string }>(
            "SELECT COUNT(*)::text AS count FROM information_schema.tables WHERE table_schema LIKE 'proj\\_%' AND table_type = 'BASE TABLE'"
          ),
          pool.query<{ count: string }>(
            "SELECT COUNT(*)::text AS count FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname LIKE 'proj\\_%' AND c.relkind = 'r' AND NOT c.relrowsecurity"
          ),
          pool.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM platform_realtime_events"),
          pool.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM platform_functions"),
          pool.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM platform_function_logs"),
          pool.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM platform_backups"),
          pool.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM platform_backups WHERE restored_at IS NOT NULL"),
        ]);
        result.projectTables = Number(tables.rows[0]?.count ?? 0);
        result.tablesWithoutRls = Number(unsecured.rows[0]?.count ?? 0);
        result.realtimeEvents = Number(events.rows[0]?.count ?? 0);
        result.functionsDeployed = Number(functions.rows[0]?.count ?? 0);
        result.functionInvocations = Number(invocations.rows[0]?.count ?? 0);
        result.backups = Number(backups.rows[0]?.count ?? 0);
        result.restoredBackups = Number(restored.rows[0]?.count ?? 0);
      } catch {
        // Counts are best-effort; database health is already reported.
      }
      return result;
    })();

    const overallHealthy =
      databaseReachable &&
      migrationInfo.pendingCount === 0 &&
      storageWritable &&
      workerRunning;

    return {
      name: "MARRY BASE",
      aliases: ["MAARY BASE"],
      version: config.APP_VERSION,
      commit: config.APP_COMMIT ?? process.env.GIT_COMMIT ?? null,
      status: overallHealthy ? "operational" : "degraded",
      statusDetail:
        "Public health summary derived from live checks (database, migrations, storage, worker). Feature-level states reflect this instance's configuration; authenticated operators should use /v1/platform/status and /v1/projects/:ref/status for the full report.",
      branding: {
        logoPngUrl: "/v1/platform/logo",
        logoSvgUrl: "/v1/platform/logo.svg",
        appIconPngUrl: "/v1/platform/app-icon",
        appIconSvgUrl: "/v1/platform/app-icon.svg",
        apkDownloadUrl: apk.state === "available" ? "/v1/platform/apk/download" : null,
      },
      database: {
        engine: "PostgreSQL",
        mode: poolStats.mode,
        status: databaseReachable ? "operational" : "unavailable",
        migrations: migrationInfo,
      },
      services: {
        controlPlane: databaseReachable ? "operational" : "unavailable",
        dataApi: databaseReachable ? "operational" : "unavailable",
        authentication: databaseReachable ? "operational" : "unavailable",
        rowLevelSecurity: !databaseReachable
          ? "unavailable"
          : counts.tablesWithoutRls > 0
            ? "partially_implemented"
            : "operational",
        objectStorage: storageWritable ? "operational" : "requires_configuration",
        realtime: !databaseReachable
          ? "unavailable"
          : counts.realtimeEvents > 0
            ? "operational"
            : "implemented_unverified",
        serverFunctions: !databaseReachable
          ? "unavailable"
          : counts.functionsDeployed === 0
            ? "requires_configuration"
            : counts.functionInvocations > 0
              ? "operational"
              : "implemented_unverified",
        backgroundJobs: workerRunning ? "operational" : "requires_configuration",
        backupsAndRecovery: !storageWritable
          ? "requires_configuration"
          : counts.backups === 0
            ? "requires_configuration"
            : counts.restoredBackups > 0
              ? "operational"
              : "implemented_unverified",
        managementStudio: existsSync(resolve(process.cwd(), "public", "dashboard", "index.html"))
          ? "operational"
          : "unavailable",
        cliAndSdk: existsSync(resolve(process.cwd(), "src", "sdk", "index.ts")) ||
          existsSync(resolve(process.cwd(), "dist", "sdk", "index.js"))
          ? "operational"
          : "unavailable",
        androidCompanion: androidServiceState,
      },
      android: {
        state: apk.state,
        statusLabel: apk.statusLabel,
        summary: apk.summary,
        buildEnvironment: apk.buildEnvironment,
      },
      endpoints: {
        health: "/health",
        readiness: "/ready",
        metrics: "/v1/metrics",
        status: "/v1/platform/status",
      },
    };
  });

  // Platform Logo & App Icon Endpoints
  app.get("/v1/platform/logo", async (_request, reply) => {
    const logoPath = resolve(process.cwd(), "assets", "logo.png");
    const buf = await readFile(logoPath);
    return reply.header("content-type", "image/png").send(buf);
  });

  app.get("/v1/platform/logo.svg", async (_request, reply) => {
    const svgPath = resolve(process.cwd(), "assets", "logo.svg");
    const buf = await readFile(svgPath);
    return reply.header("content-type", "image/svg+xml").send(buf);
  });

  app.get("/v1/platform/app-icon", async (_request, reply) => {
    const iconPath = resolve(process.cwd(), "assets", "app-icon.png");
    const buf = await readFile(iconPath);
    return reply.header("content-type", "image/png").send(buf);
  });

  app.get("/v1/platform/app-icon.svg", async (_request, reply) => {
    const svgPath = resolve(process.cwd(), "assets", "app-icon.svg");
    const buf = await readFile(svgPath);
    return reply.header("content-type", "image/svg+xml").send(buf);
  });

  // Android Artifact Endpoints (real Gradle artifact; status is derived, never faked)
  app.get("/v1/platform/apk/status", async (request) => {
    await requirePlatformUser(request);
    return getApkStatus();
  });

  app.post("/v1/platform/apk/build", async (request, reply) => {
    const user = await requirePlatformUser(request);
    const body = (request.body ?? {}) as {
      versionName?: string;
      versionCode?: number;
    };
    const result = await buildApkWithGradle({
      versionName: body.versionName,
      versionCode: body.versionCode,
      actorId: user?.id ?? null,
    });
    const status = await getApkStatus();
    return reply.code(201).send({ build: result, status });
  });

  app.get("/v1/platform/apk/download", async (request, reply) => {
    const { buffer, info } = await loadApkForDownload();
    return reply
      .header("content-type", "application/vnd.android.package-archive")
      .header("content-disposition", `attachment; filename="${info.fileName}"`)
      .header("x-apk-sha256", info.checksumSha256 ?? "")
      .send(buffer);
  });

  // Platform Operator Auth
  app.post("/v1/platform/auth/register", async (request, reply) => {
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError(
        parsed.error.issues.map((i) => i.message).join("; ")
      );
    }
    const bootstrapHeader = request.headers["x-platform-bootstrap-token"];
    const result = await registerPlatformUser({
      ...parsed.data,
      bootstrapToken: typeof bootstrapHeader === "string" ? bootstrapHeader : undefined,
      ipAddress: request.ip,
      userAgent: request.headers["user-agent"],
    });
    return reply.code(201).send(result);
  });

  app.post("/v1/platform/auth/login", async (request) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError("Valid email and password are required.");
    }
    return loginPlatformUser({
      ...parsed.data,
      ipAddress: request.ip,
      userAgent: request.headers["user-agent"],
    });
  });

  app.post("/v1/platform/auth/refresh", async (request) => {
    const body = (request.body ?? {}) as { refreshToken?: string };
    if (!body.refreshToken) {
      throw new ValidationError("refreshToken is required.");
    }
    return refreshPlatformSession(
      body.refreshToken,
      request.ip,
      request.headers["user-agent"]
    );
  });

  app.post("/v1/platform/auth/logout", async (request) => {
    const user = await requirePlatformUser(request);
    await logoutPlatformSession(user.id);
    return { status: "logged_out" };
  });

  app.get("/v1/platform/auth/me", async (request) => {
    const user = await requirePlatformUser(request);
    return { user };
  });

  app.get("/v1/platform/users", async (request) => {
    await requirePlatformUser(request);
    const users = await listPlatformUsers();
    return { users };
  });

  // Platform Audit Trail
  app.get("/v1/platform/audit", async (request) => {
    await requirePlatformUser(request);
    const q = (request.query ?? {}) as Record<string, string | undefined>;
    return listAuditEvents({
      projectId: q.projectId,
      action: q.action,
      actorType: q.actorType,
      resourceType: q.resourceType,
      limit: q.limit ? Number(q.limit) : 50,
      offset: q.offset ? Number(q.offset) : 0,
    });
  });

  // PostgreSQL Extensions
  app.get("/v1/platform/extensions", async (request) => {
    await requirePlatformUser(request);
    const extensions = await listDatabaseExtensions();
    return { extensions };
  });

  app.post("/v1/platform/extensions", async (request) => {
    const user = await requirePlatformUser(request);
    const body = (request.body ?? {}) as { name?: string };
    if (!body.name) {
      throw new ValidationError("Extension name is required.");
    }
    return enableDatabaseExtension(body.name, user.id);
  });

  // Platform-wide Backups
  app.get("/v1/platform/backups", async (request) => {
    await requirePlatformUser(request);
    const backups = await listDatabaseBackups();
    return { backups };
  });

  app.post("/v1/platform/backups", async (request, reply) => {
    const user = await requirePlatformUser(request);
    const body = (request.body ?? {}) as {
      projectId?: string;
      name?: string;
    };
    const backup = await createDatabaseBackup({
      projectId: body.projectId,
      name: body.name,
      actorId: user.id,
    });
    return reply.code(201).send({ backup });
  });

  app.post("/v1/platform/backups/:backupId/verify", async (request) => {
    await requirePlatformUser(request);
    const { backupId } = request.params as { backupId: string };
    return verifyBackupIntegrity(backupId);
  });

  app.post("/v1/platform/backups/:backupId/restore", async (request) => {
    const user = await requirePlatformUser(request);
    const { backupId } = request.params as { backupId: string };
    return restoreDatabaseBackup(backupId, { actorId: user.id });
  });
}
