import type { FastifyInstance } from "fastify";
import { ValidationError } from "../lib/errors.js";
import { requireProjectControlAccess } from "../middleware/auth.middleware.js";
import {
  alterProjectTable,
  applyProjectMigration,
  createProjectRlsPolicy,
  createProjectTable,
  type CreateTableColumnInput,
  deleteProjectRlsPolicy,
  dropProjectTable,
  executeProjectSql,
  getTableSchema,
  inspectProjectSchema,
  listProjectMigrations,
  rollbackProjectMigration,
  setProjectTableRls,
} from "../services/database.service.js";
import { realtimeBroker } from "../services/realtime.service.js";

export async function registerDatabaseRoutes(
  app: FastifyInstance
): Promise<void> {
  // List all tables & schema details in project
  app.get("/v1/projects/:projectRef/database/tables", async (request) => {
    const { projectRef } = request.params as { projectRef: string };
    const { project } = await requireProjectControlAccess(request, projectRef);
    const tables = await inspectProjectSchema(project);
    return { schema: project.schema_name, tables };
  });

  // Get single table schema
  app.get(
    "/v1/projects/:projectRef/database/tables/:tableName",
    async (request) => {
      const { projectRef, tableName } = request.params as {
        projectRef: string;
        tableName: string;
      };
      const { project } = await requireProjectControlAccess(
        request,
        projectRef
      );
      const table = await getTableSchema(project, tableName);
      return { table };
    }
  );

  // Create table
  app.post(
    "/v1/projects/:projectRef/database/tables",
    async (request, reply) => {
      const { projectRef } = request.params as { projectRef: string };
      const { project, platformUser } = await requireProjectControlAccess(
        request,
        projectRef,
        ["owner", "admin", "developer"]
      );
      const body = (request.body ?? {}) as {
        name?: string;
        columns?: CreateTableColumnInput[];
        enableRls?: boolean;
      };
      if (!body.name || !Array.isArray(body.columns)) {
        throw new ValidationError("Table 'name' and 'columns' array are required.");
      }
      const table = await createProjectTable(project, {
        name: body.name,
        columns: body.columns,
        enableRls: body.enableRls,
        actorId: platformUser?.id ?? null,
      });
      return reply.code(201).send({ table });
    }
  );

  // Alter table (add/drop/rename column, create/drop index)
  app.patch(
    "/v1/projects/:projectRef/database/tables/:tableName",
    async (request) => {
      const { projectRef, tableName } = request.params as {
        projectRef: string;
        tableName: string;
      };
      const { project, platformUser } = await requireProjectControlAccess(
        request,
        projectRef,
        ["owner", "admin", "developer"]
      );
      const body = (request.body ?? {}) as any;
      if (!body.action) {
        throw new ValidationError("Table alter 'action' is required.");
      }
      const table = await alterProjectTable(
        project,
        tableName,
        body,
        platformUser?.id ?? null
      );
      return { table };
    }
  );

  // Drop table
  app.delete(
    "/v1/projects/:projectRef/database/tables/:tableName",
    async (request) => {
      const { projectRef, tableName } = request.params as {
        projectRef: string;
        tableName: string;
      };
      const { project, platformUser } = await requireProjectControlAccess(
        request,
        projectRef,
        ["owner", "admin", "developer"]
      );
      const q = (request.query ?? {}) as { confirmName?: string };
      const body = (request.body ?? {}) as { confirmName?: string };
      await dropProjectTable(
        project,
        tableName,
        body.confirmName ?? q.confirmName,
        platformUser?.id ?? null
      );
      return { dropped: true, tableName };
    }
  );

  // Enable / disable Row-Level Security on table
  app.post(
    "/v1/projects/:projectRef/database/tables/:tableName/rls",
    async (request) => {
      const { projectRef, tableName } = request.params as {
        projectRef: string;
        tableName: string;
      };
      const { project, platformUser } = await requireProjectControlAccess(
        request,
        projectRef,
        ["owner", "admin", "developer"]
      );
      const body = (request.body ?? {}) as {
        enabled?: boolean;
        force?: boolean;
      };
      if (typeof body.enabled !== "boolean") {
        throw new ValidationError("Boolean 'enabled' is required.");
      }
      const table = await setProjectTableRls(
        project,
        tableName,
        body.enabled,
        body.force ?? true,
        platformUser?.id ?? null
      );
      return { table };
    }
  );

  // Create RLS policy
  app.post(
    "/v1/projects/:projectRef/database/policies",
    async (request, reply) => {
      const { projectRef } = request.params as { projectRef: string };
      const { project, platformUser } = await requireProjectControlAccess(
        request,
        projectRef,
        ["owner", "admin", "developer"]
      );
      const body = (request.body ?? {}) as {
        tableName?: string;
        policyName?: string;
        command?: "ALL" | "SELECT" | "INSERT" | "UPDATE" | "DELETE";
        usingExpression?: string | null;
        checkExpression?: string | null;
        enableRlsOnTable?: boolean;
      };
      if (!body.tableName || !body.policyName) {
        throw new ValidationError(
          "Both 'tableName' and 'policyName' are required."
        );
      }
      const policy = await createProjectRlsPolicy(project, {
        tableName: body.tableName,
        policyName: body.policyName,
        command: body.command,
        usingExpression: body.usingExpression,
        checkExpression: body.checkExpression,
        enableRlsOnTable: body.enableRlsOnTable,
        actorId: platformUser?.id ?? null,
      });
      return reply.code(201).send({ policy });
    }
  );

  // Delete RLS policy
  app.delete(
    "/v1/projects/:projectRef/database/policies/:tableName/:policyName",
    async (request) => {
      const { projectRef, tableName, policyName } = request.params as {
        projectRef: string;
        tableName: string;
        policyName: string;
      };
      const { project, platformUser } = await requireProjectControlAccess(
        request,
        projectRef,
        ["owner", "admin", "developer"]
      );
      await deleteProjectRlsPolicy(
        project,
        tableName,
        policyName,
        platformUser?.id ?? null
      );
      return { deleted: true, tableName, policyName };
    }
  );

  // Execute Project SQL
  app.post("/v1/projects/:projectRef/database/sql", async (request) => {
    const { projectRef } = request.params as { projectRef: string };
    const { project, platformUser, memberRole } =
      await requireProjectControlAccess(request, projectRef);

    const body = (request.body ?? {}) as {
      sql?: string;
      params?: unknown[];
      readOnly?: boolean;
      allowDestructive?: boolean;
      impersonate?: {
        role?: "anon" | "authenticated" | "service_role";
        userId?: string;
        email?: string;
      };
    };

    if (!body.sql) {
      throw new ValidationError("SQL query string 'sql' is required.");
    }

    const forceReadOnly = memberRole === "viewer" || Boolean(body.readOnly);

    const res = await executeProjectSql(project, {
      sql: body.sql,
      params: body.params,
      readOnly: forceReadOnly,
      allowDestructive: Boolean(body.allowDestructive),
      rlsContext: body.impersonate
        ? {
            role: body.impersonate.role ?? "authenticated",
            userId: body.impersonate.userId ?? null,
            email: body.impersonate.email ?? null,
          }
        : { role: "service_role" },
      actorId: platformUser?.id ?? null,
    });

    await realtimeBroker.flushDatabaseEvents();
    return res;
  });

  // Project Database Migrations
  app.get("/v1/projects/:projectRef/database/migrations", async (request) => {
    const { projectRef } = request.params as { projectRef: string };
    const { project } = await requireProjectControlAccess(request, projectRef);
    const migrations = await listProjectMigrations(project.id);
    return { migrations };
  });

  app.post(
    "/v1/projects/:projectRef/database/migrations",
    async (request, reply) => {
      const { projectRef } = request.params as { projectRef: string };
      const { project, platformUser } = await requireProjectControlAccess(
        request,
        projectRef,
        ["owner", "admin", "developer"]
      );
      const body = (request.body ?? {}) as {
        version?: string;
        name?: string;
        upSql?: string;
        downSql?: string;
      };
      if (!body.version || !body.name || !body.upSql) {
        throw new ValidationError(
          "Migration 'version', 'name', and 'upSql' are required."
        );
      }
      const migration = await applyProjectMigration(project, {
        version: body.version,
        name: body.name,
        upSql: body.upSql,
        downSql: body.downSql,
        actorId: platformUser?.id ?? null,
      });
      await realtimeBroker.flushDatabaseEvents();
      return reply.code(201).send({ migration });
    }
  );

  app.post(
    "/v1/projects/:projectRef/database/migrations/:version/rollback",
    async (request) => {
      const { projectRef, version } = request.params as {
        projectRef: string;
        version: string;
      };
      const { project, platformUser } = await requireProjectControlAccess(
        request,
        projectRef,
        ["owner", "admin", "developer"]
      );
      const migration = await rollbackProjectMigration(
        project,
        version,
        platformUser?.id ?? null
      );
      await realtimeBroker.flushDatabaseEvents();
      return { migration };
    }
  );
}
