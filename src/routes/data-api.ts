import type { FastifyInstance } from "fastify";
import { ValidationError } from "../lib/errors.js";
import { resolveProjectServiceAuth } from "../middleware/auth.middleware.js";
import {
  deleteTableRows,
  generateProjectOpenApiSpec,
  insertTableRows,
  invokeProjectRpc,
  parseQueryParamsToFilters,
  queryTableRows,
  updateTableRows,
} from "../services/data-api.service.js";
import { realtimeBroker } from "../services/realtime.service.js";

export async function registerDataApiRoutes(
  app: FastifyInstance
): Promise<void> {
  // Auto-generated OpenAPI 3.1 Spec
  app.get("/v1/projects/:projectRef/openapi.json", async (request) => {
    const { projectRef } = request.params as { projectRef: string };
    const { project } = await resolveProjectServiceAuth(request, projectRef, {
      requiredScope: "db:read",
    });
    return generateProjectOpenApiSpec(project);
  });

  // Read / Query Table Rows
  app.get("/v1/projects/:projectRef/rest/:table", async (request) => {
    const { projectRef, table } = request.params as {
      projectRef: string;
      table: string;
    };
    const { project, auth } = await resolveProjectServiceAuth(
      request,
      projectRef,
      { requiredScope: "db:read" }
    );
    const parsedQuery = parseQueryParamsToFilters(
      (request.query ?? {}) as Record<string, unknown>
    );
    return queryTableRows(
      project,
      table,
      {
        select: parsedQuery.select,
        filters: parsedQuery.filters,
        orExpression: parsedQuery.orExpression,
        orders: parsedQuery.orders,
        limit: parsedQuery.limit,
        offset: parsedQuery.offset,
        single: parsedQuery.single,
        count: parsedQuery.count,
      },
      auth
    );
  });

  // Insert / Upsert Table Rows
  app.post("/v1/projects/:projectRef/rest/:table", async (request, reply) => {
    const { projectRef, table } = request.params as {
      projectRef: string;
      table: string;
    };
    const { project, auth } = await resolveProjectServiceAuth(
      request,
      projectRef,
      { requiredScope: "db:write" }
    );
    const parsedQuery = parseQueryParamsToFilters(
      (request.query ?? {}) as Record<string, unknown>
    );
    const prefer = String(request.headers.prefer ?? "");
    const ignoreDuplicates = prefer.includes("resolution=ignore-duplicates");

    const rows = await insertTableRows(
      project,
      table,
      (request.body ?? {}) as any,
      {
        onConflict: parsedQuery.onConflict,
        ignoreDuplicates,
        select: parsedQuery.select,
      },
      auth
    );
    await realtimeBroker.flushDatabaseEvents();
    return reply.code(201).send({
      data: parsedQuery.single ? (rows[0] ?? null) : rows,
      count: rows.length,
    });
  });

  // Update Table Rows
  app.patch("/v1/projects/:projectRef/rest/:table", async (request) => {
    const { projectRef, table } = request.params as {
      projectRef: string;
      table: string;
    };
    const { project, auth } = await resolveProjectServiceAuth(
      request,
      projectRef,
      { requiredScope: "db:write" }
    );
    const parsedQuery = parseQueryParamsToFilters(
      (request.query ?? {}) as Record<string, unknown>
    );
    const body = request.body as Record<string, unknown>;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new ValidationError("PATCH body must be a JSON object.");
    }

    const rows = await updateTableRows(
      project,
      table,
      body,
      {
        filters: parsedQuery.filters,
        orExpression: parsedQuery.orExpression,
        select: parsedQuery.select,
      },
      auth
    );
    await realtimeBroker.flushDatabaseEvents();
    return {
      data: parsedQuery.single ? (rows[0] ?? null) : rows,
      count: rows.length,
    };
  });

  // Delete Table Rows
  app.delete("/v1/projects/:projectRef/rest/:table", async (request) => {
    const { projectRef, table } = request.params as {
      projectRef: string;
      table: string;
    };
    const { project, auth } = await resolveProjectServiceAuth(
      request,
      projectRef,
      { requiredScope: "db:write" }
    );
    const parsedQuery = parseQueryParamsToFilters(
      (request.query ?? {}) as Record<string, unknown>
    );
    const rows = await deleteTableRows(
      project,
      table,
      {
        filters: parsedQuery.filters,
        orExpression: parsedQuery.orExpression,
        select: parsedQuery.select,
      },
      auth
    );
    await realtimeBroker.flushDatabaseEvents();
    return {
      data: parsedQuery.single ? (rows[0] ?? null) : rows,
      count: rows.length,
    };
  });

  // Stored Procedure / Function RPC
  app.post("/v1/projects/:projectRef/rpc/:fn", async (request) => {
    const { projectRef, fn } = request.params as {
      projectRef: string;
      fn: string;
    };
    const { project, auth } = await resolveProjectServiceAuth(
      request,
      projectRef,
      { requiredScope: "db:read" }
    );
    const data = await invokeProjectRpc(
      project,
      fn,
      (request.body ?? {}) as Record<string, unknown>,
      auth
    );
    await realtimeBroker.flushDatabaseEvents();
    return { data };
  });
}
