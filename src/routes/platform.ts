import { readFile } from "node:fs/promises";
import os from "node:os";
import { resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../config.js";
import { getMigrationStatus } from "../db/migrate.js";
import { pool } from "../db/pool.js";
import { ValidationError } from "../lib/errors.js";
import {
  extractPlatformSessionId,
  requirePlatformUser,
  requireSuperadmin,
} from "../middleware/auth.middleware.js";
import {
  buildAndroidApkWithGradle,
  inspectAndroidEnvironment,
  readVerifiedApkArtifact,
} from "../services/android-artifact.service.js";
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
  evaluatePlatformModules,
  listErrorLogs,
} from "../services/diagnostics.service.js";
import { workerSupervisor } from "../services/functions-jobs.service.js";
import {
  adminCreatePlatformUser,
  adminUpdatePlatformUser,
  changePlatformUserPassword,
  listPlatformUsers,
  loginPlatformUser,
  logoutPlatformSession,
  refreshPlatformSession,
  registerPlatformUser,
  updatePlatformUserProfile,
} from "../services/platform-auth.service.js";
import { realtimeBroker } from "../services/realtime.service.js";

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
      // Handled by evaluatePlatformModules
    }

    const evaluation = await evaluatePlatformModules();
    const m = evaluation.modules;

    return {
      name: "MARI BASE",
      aliases: ["MARI"],
      version: "1.1.0",
      status: evaluation.overallStatus,
      branding: {
        logoPngUrl: "/v1/platform/logo",
        logoSvgUrl: "/v1/platform/logo.svg",
        appIconPngUrl: "/v1/platform/app-icon",
        appIconSvgUrl: "/v1/platform/app-icon.svg",
        apkDownloadUrl: "/v1/platform/apk/download",
        apkStatusUrl: "/v1/platform/apk/status",
      },
      database: {
        engine: "PostgreSQL",
        mode: poolStats.mode,
        status: m.database ?? "failed",
        migrations: migrationInfo,
      },
      modules: {
        controlPlane: m.platformAuth ?? "failed",
        organizations: m.organizations ?? "failed",
        databaseApi: m.dataApi ?? "failed",
        authentication: m.projectAuth ?? "failed",
        projectIsolation: m.projects ?? "failed",
        rowLevelSecurity: m.dataApi ?? "failed",
        objectStorage: m.storage ?? "failed",
        realtime: m.realtime ?? "failed",
        serverFunctions: m.functions ?? "failed",
        backgroundJobs: m.backgroundJobs ?? "requires_configuration",
        backupsAndRecovery: m.backups ?? "failed",
        cliAndSdk: m.cli ?? "operational_verified",
        mobileApkBuilder: m.mobileApkBuilder ?? "requires_configuration",
      },
      moduleDetails: evaluation.moduleDetails,
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

  // Android Gradle APK Status, Build & Download Endpoints
  app.get("/v1/platform/apk/status", async (request) => {
    const q = (request.query ?? {}) as { projectSlug?: string };
    return inspectAndroidEnvironment(q.projectSlug);
  });

  app.post("/v1/platform/apk/build", async (request, reply) => {
    const user = await requirePlatformUser(request);
    const body = (request.body ?? {}) as {
      projectSlug?: string;
      serverUrl?: string;
      versionName?: string;
      versionCode?: number;
      buildType?: "debug" | "release";
    };
    const apk = await buildAndroidApkWithGradle({
      projectSlug: body.projectSlug,
      serverUrl: body.serverUrl,
      versionName: body.versionName,
      versionCode: body.versionCode,
      buildType: body.buildType,
      actorId: user.id,
    });
    return reply.code(201).send({ apk });
  });

  app.get("/v1/platform/apk/download", async (request, reply) => {
    const q = (request.query ?? {}) as { projectSlug?: string };
    const { inspection, buffer } = await readVerifiedApkArtifact(q.projectSlug);
    return reply
      .header("content-type", "application/vnd.android.package-archive")
      .header(
        "content-disposition",
        `attachment; filename="${inspection.fileName}"`
      )
      .header("x-apk-sha256", inspection.checksumSha256)
      .send(buffer);
  });

  // Platform Operator Auth
  const buildSessionCookie = (token: string, maxAgeSeconds: number, isHttps: boolean) =>
    `maary_platform_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${isHttps ? "; Secure" : ""}`;

  app.get("/v1/platform/auth/status", async () => {
    const countRes = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM platform_users`
    );
    const totalUsers = Number(countRes.rows[0]?.count ?? 0);
    return {
      bootstrapAvailable: totalUsers === 0,
      bootstrapTokenRequired: totalUsers === 0 && config.NODE_ENV === "production",
      totalOperators: totalUsers,
    };
  });

  app.post("/v1/platform/auth/register", async (request, reply) => {
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError(
        parsed.error.issues.map((i) => i.message).join("; ")
      );
    }
    const bodyObj = (request.body ?? {}) as { bootstrapToken?: string };
    const bootstrapHeader = request.headers["x-platform-bootstrap-token"];
    const result = await registerPlatformUser({
      ...parsed.data,
      bootstrapToken:
        typeof bootstrapHeader === "string"
          ? bootstrapHeader
          : bodyObj.bootstrapToken,
      ipAddress: request.ip,
      userAgent: request.headers["user-agent"],
    });
    const isHttps =
      request.protocol === "https" ||
      request.headers["x-forwarded-proto"] === "https";
    return reply
      .header(
        "set-cookie",
        buildSessionCookie(result.accessToken, result.expiresIn, isHttps)
      )
      .code(201)
      .send(result);
  });

  app.post("/v1/platform/auth/login", async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError("Valid email and password are required.");
    }
    const result = await loginPlatformUser({
      ...parsed.data,
      ipAddress: request.ip,
      userAgent: request.headers["user-agent"],
    });
    const isHttps =
      request.protocol === "https" ||
      request.headers["x-forwarded-proto"] === "https";
    return reply
      .header(
        "set-cookie",
        buildSessionCookie(result.accessToken, result.expiresIn, isHttps)
      )
      .send(result);
  });

  app.post("/v1/platform/auth/refresh", async (request, reply) => {
    const body = (request.body ?? {}) as { refreshToken?: string };
    if (!body.refreshToken) {
      throw new ValidationError("refreshToken is required.");
    }
    const result = await refreshPlatformSession(
      body.refreshToken,
      request.ip,
      request.headers["user-agent"]
    );
    const isHttps =
      request.protocol === "https" ||
      request.headers["x-forwarded-proto"] === "https";
    return reply
      .header(
        "set-cookie",
        buildSessionCookie(result.accessToken, result.expiresIn, isHttps)
      )
      .send(result);
  });

  app.post("/v1/platform/auth/logout", async (request, reply) => {
    const user = await requirePlatformUser(request);
    const sessionId = extractPlatformSessionId(request);
    await logoutPlatformSession(user.id, sessionId);
    const isHttps =
      request.protocol === "https" ||
      request.headers["x-forwarded-proto"] === "https";
    return reply
      .header("set-cookie", buildSessionCookie("", 0, isHttps))
      .send({ status: "logged_out" });
  });

  app.get("/v1/platform/auth/me", async (request) => {
    const user = await requirePlatformUser(request);
    return { user };
  });

  app.patch("/v1/platform/auth/me", async (request) => {
    const user = await requirePlatformUser(request);
    const body = (request.body ?? {}) as { name?: string };
    const updated = await updatePlatformUserProfile(user.id, body);
    return { user: updated };
  });

  app.post("/v1/platform/auth/change-password", async (request) => {
    const user = await requirePlatformUser(request);
    const body = (request.body ?? {}) as {
      currentPassword?: string;
      newPassword?: string;
    };
    if (!body.currentPassword || !body.newPassword) {
      throw new ValidationError(
        "Both 'currentPassword' and 'newPassword' are required."
      );
    }
    await changePlatformUserPassword({
      userId: user.id,
      currentPassword: body.currentPassword,
      newPassword: body.newPassword,
      keepSessionId: extractPlatformSessionId(request),
    });
    return { passwordChanged: true };
  });

  // Platform Diagnostics (Runtime, Pool, Worker, Storage, Module Health)
  app.get("/v1/platform/diagnostics", async (request) => {
    const user = await requirePlatformUser(request);
    const [evaluation, migrations, androidStatus] = await Promise.all([
      evaluatePlatformModules(),
      getMigrationStatus(),
      inspectAndroidEnvironment(),
    ]);
    const mem = process.memoryUsage();
    const poolStats = pool.getStats();

    return {
      version: "1.0.0",
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      environment: config.NODE_ENV,
      uptimeSeconds: Math.floor(process.uptime()),
      memory: {
        rssBytes: mem.rss,
        heapUsedBytes: mem.heapUsed,
        heapTotalBytes: mem.heapTotal,
        systemTotalBytes: os.totalmem(),
        systemFreeBytes: os.freemem(),
      },
      database: {
        ...poolStats,
        statementTimeoutMs: config.STATEMENT_TIMEOUT_MS,
        maxQueryRows: config.MAX_QUERY_ROWS,
        migrations: {
          applied: migrations.applied,
          pending: migrations.pending,
        },
      },
      storage: {
        backend: config.STORAGE_BACKEND,
        maxUploadBytes: config.MAX_UPLOAD_BYTES,
        ...(user.is_superadmin
          ? { storageDir: config.STORAGE_DIR, s3Bucket: config.S3_BUCKET ?? null }
          : {}),
      },
      worker: {
        ...workerSupervisor.getStats(),
        pollIntervalMs: config.WORKER_POLL_INTERVAL_MS,
        functionTimeoutMs: config.FUNCTION_TIMEOUT_MS,
        webhookAllowPrivateNetworks: config.WEBHOOK_ALLOW_PRIVATE_NETWORKS,
      },
      realtime: realtimeBroker.getStats(),
      android: androidStatus,
      overallStatus: evaluation.overallStatus,
      moduleDetails: evaluation.moduleDetails,
    };
  });

  // Superadmin-Only Platform Administration Routes
  app.get("/v1/platform/users", async (request) => {
    await requireSuperadmin(request);
    const users = await listPlatformUsers();
    return { users };
  });

  app.post("/v1/platform/users", async (request, reply) => {
    const admin = await requireSuperadmin(request);
    const body = (request.body ?? {}) as {
      email?: string;
      password?: string;
      name?: string;
      isSuperadmin?: boolean;
    };
    if (!body.email || !body.password) {
      throw new ValidationError("Operator 'email' and 'password' are required.");
    }
    const user = await adminCreatePlatformUser({
      actorId: admin.id,
      email: body.email,
      password: body.password,
      name: body.name,
      isSuperadmin: body.isSuperadmin,
    });
    return reply.code(201).send({ user });
  });

  app.patch("/v1/platform/users/:userId", async (request) => {
    const admin = await requireSuperadmin(request);
    const { userId } = request.params as { userId: string };
    const body = (request.body ?? {}) as {
      name?: string;
      status?: "active" | "suspended" | "disabled";
      isSuperadmin?: boolean;
      newPassword?: string;
    };
    const user = await adminUpdatePlatformUser({
      actorId: admin.id,
      targetUserId: userId,
      name: body.name,
      status: body.status,
      isSuperadmin: body.isSuperadmin,
      newPassword: body.newPassword,
    });
    return { user };
  });

  app.get("/v1/platform/audit", async (request) => {
    await requireSuperadmin(request);
    const q = (request.query ?? {}) as Record<string, string | undefined>;
    return listAuditEvents({
      projectId: q.projectId,
      action: q.action,
      actorType: q.actorType,
      resourceType: q.resourceType,
      limit: q.limit ? Number(q.limit) : 100,
      offset: q.offset ? Number(q.offset) : 0,
    });
  });

  app.get("/v1/platform/logs/errors", async (request) => {
    await requireSuperadmin(request);
    const q = (request.query ?? {}) as Record<string, string | undefined>;
    const logs = await listErrorLogs({
      projectId: q.projectId,
      source: q.source,
      severity: q.severity,
      search: q.search,
      limit: q.limit ? Number(q.limit) : 100,
    });
    return { logs };
  });

  app.get("/v1/platform/extensions", async (request) => {
    await requireSuperadmin(request);
    const extensions = await listDatabaseExtensions();
    return { extensions };
  });

  app.post("/v1/platform/extensions", async (request) => {
    const admin = await requireSuperadmin(request);
    const body = (request.body ?? {}) as { name?: string };
    if (!body.name) {
      throw new ValidationError("Extension name is required.");
    }
    return enableDatabaseExtension(body.name, admin.id);
  });

  app.get("/v1/platform/backups", async (request) => {
    await requireSuperadmin(request);
    const backups = await listDatabaseBackups();
    return { backups };
  });

  app.post("/v1/platform/backups", async (request, reply) => {
    const admin = await requireSuperadmin(request);
    const body = (request.body ?? {}) as {
      projectId?: string;
      name?: string;
    };
    const backup = await createDatabaseBackup({
      projectId: body.projectId,
      name: body.name,
      actorId: admin.id,
    });
    return reply.code(201).send({ backup });
  });

  app.post("/v1/platform/backups/:backupId/verify", async (request) => {
    await requireSuperadmin(request);
    const { backupId } = request.params as { backupId: string };
    return verifyBackupIntegrity(backupId);
  });

  app.post("/v1/platform/backups/:backupId/restore", async (request) => {
    const admin = await requireSuperadmin(request);
    const { backupId } = request.params as { backupId: string };
    return restoreDatabaseBackup(backupId, { actorId: admin.id });
  });
}
