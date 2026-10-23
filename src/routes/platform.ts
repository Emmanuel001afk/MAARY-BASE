import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getMigrationStatus } from "../db/migrate.js";
import { pool } from "../db/pool.js";
import { ValidationError } from "../lib/errors.js";
import {
  optionalPlatformUser,
  requirePlatformUser,
} from "../middleware/auth.middleware.js";
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
    let migrationInfo = { appliedCount: 0, pendingCount: 0 };
    try {
      const mig = await getMigrationStatus();
      migrationInfo = {
        appliedCount: mig.applied.length,
        pendingCount: mig.pending.length,
      };
    } catch {
      // Ignore if DB not yet queried
    }

    return {
      name: "MARRY BASE",
      aliases: ["MAARY BASE"],
      version: "1.0.0",
      status: "operational",
      branding: {
        logoPngUrl: "/v1/platform/logo",
        logoSvgUrl: "/v1/platform/logo.svg",
      },
      database: {
        engine: "PostgreSQL",
        mode: poolStats.mode,
        status: "operational",
        migrations: migrationInfo,
      },
      modules: {
        controlPlane: "operational",
        databaseApi: "operational",
        authentication: "operational",
        projectIsolation: "operational",
        rowLevelSecurity: "operational",
        objectStorage: "operational",
        realtime: "operational",
        serverFunctions: "operational",
        backgroundJobs: "operational",
        backupsAndRecovery: "operational",
        administrationDashboard: "operational",
        cliAndSdk: "operational",
        mobileApkBuilder: "unavailable",
      },
    };
  });

  // Platform Logo Endpoints
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

  // APK generation is deliberately disabled until this repository has a real
  // Android build pipeline. ZIP-shaped output is not a valid installable APK.
  const apkBuildUnavailable = async (_request: unknown, reply: any) =>
    reply.code(501).send({
      error: "not_implemented",
      message: "APK generation requires a real Android build pipeline and is not available from this server.",
    });
  app.post("/v1/platform/apk/build", apkBuildUnavailable);
  app.get("/v1/platform/apk/download", apkBuildUnavailable);

  // Platform Operator Auth
  app.post("/v1/platform/auth/register", async (request, reply) => {
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError(
        parsed.error.issues.map((i) => i.message).join("; ")
      );
    }
    const result = await registerPlatformUser({
      ...parsed.data,
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
