import type { FastifyInstance } from "fastify";
import { ValidationError } from "../lib/errors.js";
import {
  requirePlatformUser,
  requireProjectControlAccess,
} from "../middleware/auth.middleware.js";
import { listAuditEvents } from "../services/audit.service.js";
import {
  createDatabaseBackup,
  listDatabaseBackups,
  restoreDatabaseBackup,
  verifyBackupIntegrity,
} from "../services/backup.service.js";
import { listErrorLogs } from "../services/diagnostics.service.js";
import { requireOrganizationAccess } from "../services/organization.service.js";
import {
  createEnvironment,
  createProject,
  createProjectApiKey,
  deleteEnvironment,
  deleteProject,
  deleteProjectSecret,
  getProjectDiagnostics,
  getProjectLiveStatusOverview,
  listApiKeys,
  listEnvironments,
  listProjectMembers,
  listProjectsForUser,
  listProjectSecrets,
  type ProjectRole,
  removeProjectMember,
  revokeProjectApiKey,
  rotateProjectApiKey,
  updateProject,
  upsertProjectMember,
  upsertProjectSecret,
} from "../services/project.service.js";

export async function registerProjectRoutes(
  app: FastifyInstance
): Promise<void> {
  app.get("/v1/projects", async (request) => {
    const user = await requirePlatformUser(request);
    const q = (request.query ?? {}) as { organizationId?: string };
    const projects = await listProjectsForUser(user, {
      organizationId: q.organizationId,
    });
    return { projects };
  });

  app.post("/v1/projects", async (request, reply) => {
    const user = await requirePlatformUser(request);
    const body = (request.body ?? {}) as {
      name?: string;
      slug?: string;
      description?: string;
      organizationId?: string;
      quotas?: Record<string, number>;
      settings?: Record<string, unknown>;
    };
    if (!body.name) {
      throw new ValidationError("Project name is required.");
    }
    let targetOrgId: string | undefined;
    if (body.organizationId) {
      const { organization } = await requireOrganizationAccess(
        body.organizationId,
        user,
        ["owner", "admin", "developer"]
      );
      targetOrgId = organization.id;
    }
    const created = await createProject({
      name: body.name,
      slug: body.slug,
      description: body.description,
      ownerId: user.id,
      organizationId: targetOrgId,
      quotas: body.quotas,
      settings: body.settings,
    });
    return reply.code(201).send(created);
  });

  app.get("/v1/projects/:projectRef", async (request) => {
    const { projectRef } = request.params as { projectRef: string };
    const { project, memberRole } = await requireProjectControlAccess(
      request,
      projectRef
    );
    const [environments, diagnostics, overview] = await Promise.all([
      listEnvironments(project.id),
      getProjectDiagnostics(project),
      getProjectLiveStatusOverview(project),
    ]);
    return {
      project,
      memberRole,
      environments,
      usage: diagnostics.usage,
      overview,
    };
  });

  app.get("/v1/projects/:projectRef/diagnostics", async (request) => {
    const { projectRef } = request.params as { projectRef: string };
    const { project } = await requireProjectControlAccess(request, projectRef);
    const [diagnostics, overview] = await Promise.all([
      getProjectDiagnostics(project),
      getProjectLiveStatusOverview(project),
    ]);
    return { ...diagnostics, overview };
  });

  app.patch("/v1/projects/:projectRef", async (request) => {
    const { projectRef } = request.params as { projectRef: string };
    const { project, platformUser } = await requireProjectControlAccess(
      request,
      projectRef,
      ["owner", "admin"]
    );
    const body = (request.body ?? {}) as {
      name?: string;
      description?: string;
      organizationId?: string | null;
      status?: "active" | "suspended" | "archived";
      settings?: Record<string, unknown>;
      quotas?: Record<string, number>;
    };
    if (body.organizationId && platformUser) {
      await requireOrganizationAccess(body.organizationId, platformUser, [
        "owner",
        "admin",
      ]);
    }
    const updated = await updateProject(
      project.id,
      body,
      platformUser?.id ?? null
    );
    return { project: updated };
  });

  app.delete("/v1/projects/:projectRef", async (request) => {
    const { projectRef } = request.params as { projectRef: string };
    const { project, platformUser } = await requireProjectControlAccess(
      request,
      projectRef,
      ["owner"]
    );
    const q = (request.query ?? {}) as { confirmSlug?: string };
    const body = (request.body ?? {}) as { confirmSlug?: string };
    const confirmSlug = body.confirmSlug ?? q.confirmSlug ?? "";
    await deleteProject(project.id, confirmSlug, platformUser?.id ?? null);
    return { deleted: true, slug: project.slug };
  });

  // Environments
  app.get("/v1/projects/:projectRef/environments", async (request) => {
    const { projectRef } = request.params as { projectRef: string };
    const { project } = await requireProjectControlAccess(request, projectRef);
    const environments = await listEnvironments(project.id);
    return { environments };
  });

  app.post(
    "/v1/projects/:projectRef/environments",
    async (request, reply) => {
      const { projectRef } = request.params as { projectRef: string };
      const { project, platformUser } = await requireProjectControlAccess(
        request,
        projectRef,
        ["owner", "admin", "developer"]
      );
      const body = (request.body ?? {}) as {
        name?: string;
        slug?: string;
        isProduction?: boolean;
        config?: Record<string, unknown>;
      };
      if (!body.name) {
        throw new ValidationError("Environment name is required.");
      }
      const environment = await createEnvironment(
        project.id,
        {
          name: body.name,
          slug: body.slug,
          isProduction: body.isProduction,
          config: body.config,
        },
        platformUser?.id ?? null
      );
      return reply.code(201).send({ environment });
    }
  );

  app.delete(
    "/v1/projects/:projectRef/environments/:envId",
    async (request) => {
      const { projectRef, envId } = request.params as {
        projectRef: string;
        envId: string;
      };
      const { project, platformUser } = await requireProjectControlAccess(
        request,
        projectRef,
        ["owner", "admin"]
      );
      await deleteEnvironment(project.id, envId, platformUser?.id ?? null);
      return { deleted: true };
    }
  );

  // Members & RBAC
  app.get("/v1/projects/:projectRef/members", async (request) => {
    const { projectRef } = request.params as { projectRef: string };
    const { project } = await requireProjectControlAccess(request, projectRef);
    const members = await listProjectMembers(project.id);
    return { members };
  });

  app.post("/v1/projects/:projectRef/members", async (request, reply) => {
    const { projectRef } = request.params as { projectRef: string };
    const { project, platformUser } = await requireProjectControlAccess(
      request,
      projectRef,
      ["owner", "admin"]
    );
    const body = (request.body ?? {}) as {
      email?: string;
      userId?: string;
      role?: ProjectRole;
      permissions?: string[];
    };
    if (!body.role || !["owner", "admin", "developer", "viewer"].includes(body.role)) {
      throw new ValidationError(
        "Valid member role ('owner', 'admin', 'developer', 'viewer') is required."
      );
    }
    const member = await upsertProjectMember(
      project.id,
      {
        email: body.email,
        userId: body.userId,
        role: body.role,
        permissions: body.permissions,
      },
      platformUser?.id ?? null
    );
    return reply.code(201).send({ member });
  });

  app.delete(
    "/v1/projects/:projectRef/members/:userId",
    async (request) => {
      const { projectRef, userId } = request.params as {
        projectRef: string;
        userId: string;
      };
      const { project, platformUser } = await requireProjectControlAccess(
        request,
        projectRef,
        ["owner", "admin"]
      );
      await removeProjectMember(project.id, userId, platformUser?.id ?? null);
      return { removed: true };
    }
  );

  // API Keys
  app.get("/v1/projects/:projectRef/api-keys", async (request) => {
    const { projectRef } = request.params as { projectRef: string };
    const { project, memberRole } = await requireProjectControlAccess(
      request,
      projectRef
    );
    const reveal =
      (request.query as Record<string, string>)?.reveal === "true" &&
      (memberRole === "owner" || memberRole === "admin" || memberRole === "developer");
    const apiKeys = await listApiKeys(project.id, reveal);
    return { apiKeys };
  });

  app.post("/v1/projects/:projectRef/api-keys", async (request, reply) => {
    const { projectRef } = request.params as { projectRef: string };
    const { project, platformUser } = await requireProjectControlAccess(
      request,
      projectRef,
      ["owner", "admin"]
    );
    const body = (request.body ?? {}) as {
      name?: string;
      role?: "anon" | "service_role" | "custom";
      scopes?: string[];
      environmentId?: string;
      rateLimitPerMin?: number;
      expiresAt?: string;
    };
    if (!body.name) {
      throw new ValidationError("API key name is required.");
    }
    const apiKey = await createProjectApiKey(project.id, {
      name: body.name,
      role: body.role ?? "custom",
      scopes: body.scopes,
      environmentId: body.environmentId,
      rateLimitPerMin: body.rateLimitPerMin,
      expiresAt: body.expiresAt,
      actorId: platformUser?.id ?? null,
    });
    return reply.code(201).send({ apiKey });
  });

  app.post(
    "/v1/projects/:projectRef/api-keys/:keyId/rotate",
    async (request) => {
      const { projectRef, keyId } = request.params as {
        projectRef: string;
        keyId: string;
      };
      const { project, platformUser } = await requireProjectControlAccess(
        request,
        projectRef,
        ["owner", "admin"]
      );
      const apiKey = await rotateProjectApiKey(
        project.id,
        keyId,
        platformUser?.id ?? null
      );
      return { apiKey };
    }
  );

  app.delete(
    "/v1/projects/:projectRef/api-keys/:keyId",
    async (request) => {
      const { projectRef, keyId } = request.params as {
        projectRef: string;
        keyId: string;
      };
      const { project, platformUser } = await requireProjectControlAccess(
        request,
        projectRef,
        ["owner", "admin"]
      );
      await revokeProjectApiKey(project.id, keyId, platformUser?.id ?? null);
      return { revoked: true };
    }
  );

  // Encrypted Secrets
  app.get("/v1/projects/:projectRef/secrets", async (request) => {
    const { projectRef } = request.params as { projectRef: string };
    const { project, memberRole } = await requireProjectControlAccess(
      request,
      projectRef
    );
    const q = (request.query ?? {}) as {
      environmentId?: string;
      reveal?: string;
    };
    const canReveal = memberRole === "owner" || memberRole === "admin";
    const secrets = await listProjectSecrets(project.id, {
      environmentId: q.environmentId,
      reveal: q.reveal === "true" && canReveal,
    });
    return { secrets };
  });

  app.post("/v1/projects/:projectRef/secrets", async (request, reply) => {
    const { projectRef } = request.params as { projectRef: string };
    const { project, platformUser } = await requireProjectControlAccess(
      request,
      projectRef,
      ["owner", "admin", "developer"]
    );
    const body = (request.body ?? {}) as {
      name?: string;
      value?: string;
      description?: string;
      environmentId?: string;
    };
    if (!body.name || body.value === undefined) {
      throw new ValidationError("Secret 'name' and 'value' are required.");
    }
    const secret = await upsertProjectSecret(project.id, {
      name: body.name,
      value: String(body.value),
      description: body.description,
      environmentId: body.environmentId,
      actorId: platformUser?.id ?? null,
    });
    return reply.code(201).send({ secret });
  });

  app.delete(
    "/v1/projects/:projectRef/secrets/:secretId",
    async (request) => {
      const { projectRef, secretId } = request.params as {
        projectRef: string;
        secretId: string;
      };
      const { project, platformUser } = await requireProjectControlAccess(
        request,
        projectRef,
        ["owner", "admin"]
      );
      await deleteProjectSecret(
        project.id,
        secretId,
        platformUser?.id ?? null
      );
      return { deleted: true };
    }
  );

  // Project Audit Trail
  app.get("/v1/projects/:projectRef/audit", async (request) => {
    const { projectRef } = request.params as { projectRef: string };
    const { project } = await requireProjectControlAccess(request, projectRef);
    const q = (request.query ?? {}) as Record<string, string | undefined>;
    return listAuditEvents({
      projectId: project.id,
      action: q.action,
      actorType: q.actorType,
      resourceType: q.resourceType,
      limit: q.limit ? Number(q.limit) : 50,
      offset: q.offset ? Number(q.offset) : 0,
    });
  });

  // Project Error & Diagnostic Logs
  app.get("/v1/projects/:projectRef/logs/errors", async (request) => {
    const { projectRef } = request.params as { projectRef: string };
    const { project } = await requireProjectControlAccess(request, projectRef);
    const q = (request.query ?? {}) as Record<string, string | undefined>;
    const logs = await listErrorLogs({
      projectId: project.id,
      source: q.source,
      severity: q.severity,
      search: q.search,
      limit: q.limit ? Number(q.limit) : 100,
    });
    return { logs };
  });

  // Project Backups & Restoration
  app.get("/v1/projects/:projectRef/backups", async (request) => {
    const { projectRef } = request.params as { projectRef: string };
    const { project } = await requireProjectControlAccess(request, projectRef);
    const backups = await listDatabaseBackups(project.id);
    return { backups };
  });

  app.post("/v1/projects/:projectRef/backups", async (request, reply) => {
    const { projectRef } = request.params as { projectRef: string };
    const { project, platformUser } = await requireProjectControlAccess(
      request,
      projectRef,
      ["owner", "admin"]
    );
    const body = (request.body ?? {}) as { name?: string };
    const backup = await createDatabaseBackup({
      projectId: project.id,
      name: body.name,
      actorId: platformUser?.id ?? null,
    });
    return reply.code(201).send({ backup });
  });

  app.post(
    "/v1/projects/:projectRef/backups/:backupId/verify",
    async (request) => {
      const { projectRef, backupId } = request.params as {
        projectRef: string;
        backupId: string;
      };
      const { project } = await requireProjectControlAccess(
        request,
        projectRef,
        ["owner", "admin"]
      );
      return verifyBackupIntegrity(backupId, {
        expectedProjectId: project.id,
      });
    }
  );

  app.post(
    "/v1/projects/:projectRef/backups/:backupId/restore",
    async (request) => {
      const { projectRef, backupId } = request.params as {
        projectRef: string;
        backupId: string;
      };
      const { project, platformUser } = await requireProjectControlAccess(
        request,
        projectRef,
        ["owner", "admin"]
      );
      return restoreDatabaseBackup(backupId, {
        actorId: platformUser?.id ?? null,
        expectedProjectId: project.id,
      });
    }
  );
}
