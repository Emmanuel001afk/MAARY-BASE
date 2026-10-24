import type { FastifyInstance, FastifyRequest } from "fastify";
import { ValidationError } from "../lib/errors.js";
import {
  requirePlatformUser,
  requireProjectControlAccess,
} from "../middleware/auth.middleware.js";
import {
  getPlatformStatus,
  getProjectApiCatalogue,
  getProjectConnectionInfo,
  getProjectDatabaseRoles,
  getProjectLogs,
  getProjectStatus,
  platformVersion,
} from "../services/operations.service.js";

function baseUrlFor(request: FastifyRequest): string {
  const protoHeader = request.headers["x-forwarded-proto"];
  const protocol =
    typeof protoHeader === "string" && protoHeader.length > 0
      ? protoHeader.split(",")[0]!.trim()
      : request.protocol;
  const host = request.headers.host ?? "localhost";
  return `${protocol}://${host}`;
}

export async function registerObservabilityRoutes(
  app: FastifyInstance
): Promise<void> {
  app.get("/v1/platform/status", async (request) => {
    await requirePlatformUser(request);
    return getPlatformStatus();
  });

  app.get("/v1/platform/version", async (request) => {
    await requirePlatformUser(request);
    return platformVersion();
  });

  app.get("/v1/projects/:projectRef/status", async (request) => {
    const { projectRef } = request.params as { projectRef: string };
    const { project } = await requireProjectControlAccess(request, projectRef);
    return getProjectStatus(project);
  });

  app.get("/v1/projects/:projectRef/api/endpoints", async (request) => {
    const { projectRef } = request.params as { projectRef: string };
    const { project } = await requireProjectControlAccess(request, projectRef);
    return getProjectApiCatalogue(project, baseUrlFor(request));
  });

  app.get("/v1/projects/:projectRef/logs", async (request) => {
    const { projectRef } = request.params as { projectRef: string };
    const { project } = await requireProjectControlAccess(request, projectRef);
    const query = (request.query ?? {}) as Record<string, string | undefined>;
    const knownSources = ["all", "audit", "function", "job", "realtime", "backup", "storage"];
    const source = query.source ?? "all";
    if (!knownSources.includes(source)) {
      throw new ValidationError(
        `Unknown log source. Use one of: ${knownSources.join(", ")}.`
      );
    }
    const knownLevels = ["all", "info", "warn", "error"];
    const level = query.level ?? "all";
    if (!knownLevels.includes(level)) {
      throw new ValidationError(`Unknown log level. Use one of: ${knownLevels.join(", ")}.`);
    }
    const limit = query.limit ? Number(query.limit) : 100;
    if (!Number.isFinite(limit) || limit < 1) {
      throw new ValidationError("limit must be a positive number.");
    }
    return getProjectLogs(project, { source, level, limit });
  });

  app.get("/v1/projects/:projectRef/database/roles", async (request) => {
    const { projectRef } = request.params as { projectRef: string };
    const { project } = await requireProjectControlAccess(request, projectRef);
    return getProjectDatabaseRoles(project);
  });

  app.get("/v1/projects/:projectRef/database/connection", async (request) => {
    const { projectRef } = request.params as { projectRef: string };
    const { project } = await requireProjectControlAccess(request, projectRef);
    return getProjectConnectionInfo(project);
  });
}
