import type { FastifyInstance } from "fastify";
import { ValidationError } from "../lib/errors.js";
import {
  requireProjectControlAccess,
  resolveProjectServiceAuth,
} from "../middleware/auth.middleware.js";
import {
  cancelBackgroundJob,
  deleteSchedule,
  deleteServerFunction,
  deployServerFunction,
  enqueueBackgroundJob,
  getBackgroundJobById,
  getServerFunctionBySlug,
  invokeServerFunction,
  listBackgroundJobs,
  listFunctionLogs,
  listSchedules,
  listServerFunctions,
  processDueBackgroundJobs,
  upsertSchedule,
} from "../services/functions-jobs.service.js";

export async function registerFunctionsAndJobsRoutes(
  app: FastifyInstance
): Promise<void> {
  // Server Functions Management
  app.get("/v1/projects/:projectRef/functions", async (request) => {
    const { projectRef } = request.params as { projectRef: string };
    const { project } = await requireProjectControlAccess(request, projectRef);
    const functions = await listServerFunctions(project.id);
    return { functions };
  });

  app.post(
    "/v1/projects/:projectRef/functions",
    async (request, reply) => {
      const { projectRef } = request.params as { projectRef: string };
      const { project, platformUser } = await requireProjectControlAccess(
        request,
        projectRef,
        ["owner", "admin", "developer"]
      );
      const body = (request.body ?? {}) as {
        slug?: string;
        name?: string;
        description?: string;
        code?: string;
        entrypoint?: string;
        verifyJwt?: boolean;
        timeoutMs?: number;
        status?: "active" | "disabled";
        envVars?: Record<string, string>;
      };
      if (!body.slug || !body.code) {
        throw new ValidationError("Function 'slug' and 'code' are required.");
      }
      const fn = await deployServerFunction(project, {
        slug: body.slug,
        name: body.name,
        description: body.description,
        code: body.code,
        entrypoint: body.entrypoint,
        verifyJwt: body.verifyJwt,
        timeoutMs: body.timeoutMs,
        status: body.status,
        envVars: body.envVars,
        actorId: platformUser?.id ?? null,
      });
      return reply.code(201).send({ function: fn });
    }
  );

  app.get("/v1/projects/:projectRef/functions/:slug", async (request) => {
    const { projectRef, slug } = request.params as {
      projectRef: string;
      slug: string;
    };
    const { project } = await requireProjectControlAccess(request, projectRef);
    const fn = await getServerFunctionBySlug(project.id, slug);
    return { function: fn };
  });

  app.delete("/v1/projects/:projectRef/functions/:slug", async (request) => {
    const { projectRef, slug } = request.params as {
      projectRef: string;
      slug: string;
    };
    const { project, platformUser } = await requireProjectControlAccess(
      request,
      projectRef,
      ["owner", "admin", "developer"]
    );
    await deleteServerFunction(project.id, slug, platformUser?.id ?? null);
    return { deleted: true, slug };
  });

  // Invoke Server Function
  app.all(
    "/v1/projects/:projectRef/functions/:slug/invoke",
    async (request, reply) => {
      const { projectRef, slug } = request.params as {
        projectRef: string;
        slug: string;
      };
      const { project, auth, hasValidCredentials } =
        await resolveProjectServiceAuth(request, projectRef, {
          allowAnonymousWithoutKey: true,
        });

      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(request.headers)) {
        if (typeof v === "string") headers[k] = v;
      }

      const result = await invokeServerFunction(
        project,
        slug,
        {
          method: request.method,
          headers,
          query: (request.query ?? {}) as Record<string, unknown>,
          body: request.body,
        },
        auth,
        { hasValidCredentials }
      );

      return reply.code(result.statusCode).send(result);
    }
  );

  // Function Invocation Logs
  app.get("/v1/projects/:projectRef/functions-logs", async (request) => {
    const { projectRef } = request.params as { projectRef: string };
    const { project } = await requireProjectControlAccess(request, projectRef);
    const q = (request.query ?? {}) as { slug?: string; limit?: string };
    const logs = await listFunctionLogs(project.id, {
      slug: q.slug,
      limit: q.limit ? Number(q.limit) : 50,
    });
    return { logs };
  });

  // Background Jobs & Queue Operations
  app.get("/v1/projects/:projectRef/jobs", async (request) => {
    const { projectRef } = request.params as { projectRef: string };
    const { project } = await requireProjectControlAccess(request, projectRef);
    const q = (request.query ?? {}) as {
      status?: string;
      queueName?: string;
      limit?: string;
    };
    const jobs = await listBackgroundJobs(project.id, {
      status: q.status,
      queueName: q.queueName,
      limit: q.limit ? Number(q.limit) : 50,
    });
    return { jobs };
  });

  app.post("/v1/projects/:projectRef/jobs", async (request, reply) => {
    const { projectRef } = request.params as { projectRef: string };
    const { project, platformUser } = await requireProjectControlAccess(
      request,
      projectRef,
      ["owner", "admin", "developer"]
    );
    const body = (request.body ?? {}) as {
      queueName?: string;
      jobType?: "function" | "sql_maintenance" | "webhook" | "storage_cleanup";
      payload?: Record<string, unknown>;
      priority?: number;
      delaySeconds?: number;
      maxAttempts?: number;
      timeoutMs?: number;
      idempotencyKey?: string;
    };
    if (!body.jobType) {
      throw new ValidationError(
        "Job 'jobType' ('function', 'sql_maintenance', 'webhook', 'storage_cleanup') is required."
      );
    }
    const job = await enqueueBackgroundJob(project, {
      queueName: body.queueName,
      jobType: body.jobType,
      payload: body.payload,
      priority: body.priority,
      delaySeconds: body.delaySeconds,
      maxAttempts: body.maxAttempts,
      timeoutMs: body.timeoutMs,
      idempotencyKey: body.idempotencyKey,
      actorId: platformUser?.id ?? null,
    });
    return reply.code(201).send({ job });
  });

  app.post("/v1/projects/:projectRef/jobs/process", async (request) => {
    const { projectRef } = request.params as { projectRef: string };
    const { project } = await requireProjectControlAccess(
      request,
      projectRef,
      ["owner", "admin", "developer"]
    );
    const body = (request.body ?? {}) as { limit?: number };
    const processed = await processDueBackgroundJobs({
      projectId: project.id,
      limit: body.limit ?? 10,
    });
    return { processed, count: processed.length };
  });

  app.get("/v1/projects/:projectRef/jobs/:jobId", async (request) => {
    const { projectRef, jobId } = request.params as {
      projectRef: string;
      jobId: string;
    };
    const { project } = await requireProjectControlAccess(request, projectRef);
    const job = await getBackgroundJobById(project.id, jobId);
    return { job };
  });

  app.post("/v1/projects/:projectRef/jobs/:jobId/cancel", async (request) => {
    const { projectRef, jobId } = request.params as {
      projectRef: string;
      jobId: string;
    };
    const { project } = await requireProjectControlAccess(
      request,
      projectRef,
      ["owner", "admin", "developer"]
    );
    const job = await cancelBackgroundJob(project.id, jobId);
    return { job };
  });

  // Scheduled Jobs / Cron Tasks
  app.get("/v1/projects/:projectRef/schedules", async (request) => {
    const { projectRef } = request.params as { projectRef: string };
    const { project } = await requireProjectControlAccess(request, projectRef);
    const schedules = await listSchedules(project.id);
    return { schedules };
  });

  app.post("/v1/projects/:projectRef/schedules", async (request, reply) => {
    const { projectRef } = request.params as { projectRef: string };
    const { project, platformUser } = await requireProjectControlAccess(
      request,
      projectRef,
      ["owner", "admin", "developer"]
    );
    const body = (request.body ?? {}) as {
      name?: string;
      cronExpression?: string;
      intervalSeconds?: number;
      jobType?: "function" | "sql_maintenance" | "webhook" | "storage_cleanup";
      targetSlug?: string;
      payload?: Record<string, unknown>;
      enabled?: boolean;
    };
    if (!body.name || !body.jobType) {
      throw new ValidationError("Schedule 'name' and 'jobType' are required.");
    }
    const schedule = await upsertSchedule(project, {
      name: body.name,
      cronExpression: body.cronExpression,
      intervalSeconds: body.intervalSeconds,
      jobType: body.jobType,
      targetSlug: body.targetSlug,
      payload: body.payload,
      enabled: body.enabled,
      actorId: platformUser?.id ?? null,
    });
    return reply.code(201).send({ schedule });
  });

  app.delete(
    "/v1/projects/:projectRef/schedules/:scheduleId",
    async (request) => {
      const { projectRef, scheduleId } = request.params as {
        projectRef: string;
        scheduleId: string;
      };
      const { project } = await requireProjectControlAccess(
        request,
        projectRef,
        ["owner", "admin", "developer"]
      );
      await deleteSchedule(project.id, scheduleId);
      return { deleted: true };
    }
  );
}
