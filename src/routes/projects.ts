import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { httpError, requireProjectRole, requireUser } from "../security/auth.js";

const projectInput = z.object({ name: z.string().trim().min(2).max(80), slug: z.string().trim().toLowerCase().regex(/^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/, "Use a 1-48 character lowercase slug.") }).strict();
const environmentInput = z.object({ name: z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_-]{0,31}$/) }).strict();
const memberInput = z.object({ email: z.string().trim().email().max(254), role: z.enum(["admin", "developer", "readonly"]) }).strict();
const memberRoleInput = z.object({ role: z.enum(["admin", "developer", "readonly"]) }).strict();
const keyInput = z.object({ name: z.string().trim().min(1).max(80), role: z.enum(["admin", "developer", "readonly"]), expiresAt: z.string().datetime().optional() }).strict();
const uuid = z.string().uuid();
const roleRank: Record<string, number> = { readonly: 0, developer: 1, admin: 2, owner: 3 };

function parseUuid(value: string): string {
  const parsed = uuid.safeParse(value);
  if (!parsed.success) throw httpError(404, "Project not found.");
  return parsed.data;
}

function schemaFor(id: string): string {
  return `project_${id.replaceAll("-", "")}`;
}

function quoteSchema(identifier: string): string {
  if (!/^project_[a-f0-9]{32}$/.test(identifier)) throw new Error("Invalid generated schema identifier.");
  return `"${identifier}"`;
}

async function writeAudit(client: { query: (text: string, values?: unknown[]) => Promise<unknown> }, userId: string, projectId: string, action: string, resourceType: string, resourceId: string) {
  await client.query("INSERT INTO platform_audit_events (project_id, actor_type, actor_id, actor_user_id, action, resource_type, resource_id) VALUES ($1, 'user', $2, $3, $4, $5, $6)", [projectId, userId, userId, action, resourceType, resourceId]);
}

async function lockProjectAdmin(client: { query: (text: string, values?: unknown[]) => Promise<{ rows: Array<{ role: string }> }> }, projectId: string, userId: string): Promise<string> {
  const result = await client.query(
    `SELECT m.role FROM platform_project_members m
     JOIN platform_projects p ON p.id = m.project_id
     WHERE m.project_id = $1 AND m.user_id = $2 AND p.status = 'active'
     FOR UPDATE OF m, p`, [projectId, userId]);
  const role = result.rows[0]?.role;
  if (!role) throw httpError(404, "Project not found.");
  if ((roleRank[role] ?? -1) < roleRank.admin!) throw httpError(403, "Insufficient project permissions.");
  return role;
}

export async function registerProjectRoutes(app: FastifyInstance): Promise<void> {
  app.post("/v1/projects", async (request, reply) => {
    const userId = await requireUser(request);
    const parsed = projectInput.safeParse(request.body);
    if (!parsed.success) throw httpError(400, "Provide a project name and a valid lowercase slug.");
    const id = randomUUID();
    const schema = schemaFor(id);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("INSERT INTO platform_projects (id, slug, name) VALUES ($1, $2, $3)", [id, parsed.data.slug, parsed.data.name]);
      await client.query(`CREATE SCHEMA ${quoteSchema(schema)}`);
      const environment = await client.query<{ id: string }>("INSERT INTO platform_environments (project_id, name, database_schema) VALUES ($1, 'development', $2) RETURNING id", [id, schema]);
      await client.query("INSERT INTO platform_project_members (project_id, user_id, role) VALUES ($1, $2, 'owner')", [id, userId]);
      await writeAudit(client, userId, id, "project.created", "project", id);
      await client.query("COMMIT");
      return reply.code(201).send({ project: { id, name: parsed.data.name, slug: parsed.data.slug, status: "active", createdAt: new Date().toISOString() }, environments: [{ id: environment.rows[0]!.id, name: "development", status: "active" }] });
    } catch (error) {
      await client.query("ROLLBACK");
      if ((error as { code?: string }).code === "23505") throw httpError(409, "That project slug is already in use.");
      throw error;
    } finally {
      client.release();
    }
  });

  app.get("/v1/projects", async (request) => {
    const userId = await requireUser(request);
    const result = await pool.query(
      `SELECT p.id, p.name, p.slug, p.status, p.created_at, m.role,
              count(e.id)::int AS environment_count
       FROM platform_projects p JOIN platform_project_members m ON m.project_id = p.id
       LEFT JOIN platform_environments e ON e.project_id = p.id
       WHERE m.user_id = $1 GROUP BY p.id, m.role ORDER BY p.created_at DESC`, [userId]);
    return { projects: result.rows.map(row => ({ id: row.id, name: row.name, slug: row.slug, status: row.status, role: row.role, environmentCount: row.environment_count, createdAt: row.created_at })) };
  });

  app.get<{ Params: { projectId: string } }>("/v1/projects/:projectId", async (request) => {
    const projectId = parseUuid(request.params.projectId);
    await requireProjectRole(request, projectId, "readonly");
    const result = await pool.query("SELECT id, name, slug, status, created_at, updated_at FROM platform_projects WHERE id = $1", [projectId]);
    const project = result.rows[0];
    if (!project) throw httpError(404, "Project not found.");
    return { project: { id: project.id, name: project.name, slug: project.slug, status: project.status, createdAt: project.created_at, updatedAt: project.updated_at } };
  });

  app.get<{ Params: { projectId: string } }>("/v1/projects/:projectId/environments", async (request) => {
    const projectId = parseUuid(request.params.projectId);
    await requireProjectRole(request, projectId, "readonly");
    const result = await pool.query("SELECT id, name, created_at FROM platform_environments WHERE project_id = $1 ORDER BY created_at", [projectId]);
    return { environments: result.rows.map(row => ({ id: row.id, name: row.name, status: "active", createdAt: row.created_at })) };
  });

  app.post<{ Params: { projectId: string } }>("/v1/projects/:projectId/environments", async (request, reply) => {
    const projectId = parseUuid(request.params.projectId);
    const userId = await requireUser(request);
    await requireProjectRole(request, projectId, "admin");
    const parsed = environmentInput.safeParse(request.body);
    if (!parsed.success) throw httpError(400, "Provide a valid environment name.");
    const schema = schemaFor(randomUUID());
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await lockProjectAdmin(client, projectId, userId);
      const created = await client.query<{ id: string; name: string; created_at: Date }>("INSERT INTO platform_environments (project_id, name, database_schema) VALUES ($1, $2, $3) RETURNING id, name, created_at", [projectId, parsed.data.name, schema]);
      await client.query(`CREATE SCHEMA ${quoteSchema(schema)}`);
      const environment = created.rows[0]!;
      await writeAudit(client, userId, projectId, "environment.created", "environment", environment.id);
      await client.query("COMMIT");
      return reply.code(201).send({ environment: { id: environment.id, name: environment.name, status: "active", createdAt: environment.created_at } });
    } catch (error) {
      await client.query("ROLLBACK");
      if ((error as { code?: string }).code === "23505") throw httpError(409, "An environment with that name already exists.");
      throw error;
    } finally {
      client.release();
    }
  });

  app.get<{ Params: { projectId: string } }>("/v1/projects/:projectId/members", async (request) => {
    const projectId = parseUuid(request.params.projectId);
    await requireProjectRole(request, projectId, "admin");
    const result = await pool.query("SELECT u.id, u.email, u.display_name, m.role, m.created_at FROM platform_project_members m JOIN platform_users u ON u.id = m.user_id WHERE m.project_id = $1 ORDER BY m.created_at", [projectId]);
    return { members: result.rows.map(member => ({ userId: member.id, email: member.email, displayName: member.display_name, role: member.role, addedAt: member.created_at })) };
  });

  app.post<{ Params: { projectId: string } }>("/v1/projects/:projectId/members", async (request, reply) => {
    const projectId = parseUuid(request.params.projectId);
    const actorId = await requireUser(request);
    await requireProjectRole(request, projectId, "admin");
    const parsed = memberInput.safeParse(request.body);
    if (!parsed.success) throw httpError(400, "Provide a valid email and member role.");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const actorRole = await lockProjectAdmin(client, projectId, actorId);
      if (parsed.data.role === "admin" && actorRole !== "owner") throw httpError(403, "Only the project owner can grant administrator access.");
      const user = await client.query<{ id: string }>("SELECT id FROM platform_users WHERE email = $1 AND disabled_at IS NULL", [parsed.data.email.toLowerCase()]);
      if (!user.rowCount) throw httpError(404, "No active account exists for that email.");
      const memberId = user.rows[0]!.id;
      await client.query("INSERT INTO platform_project_members (project_id, user_id, role) VALUES ($1, $2, $3)", [projectId, memberId, parsed.data.role]);
      await writeAudit(client, actorId, projectId, "project.member_added", "project_member", memberId);
      await client.query("COMMIT");
      return reply.code(201).send({ member: { userId: memberId, email: parsed.data.email.toLowerCase(), role: parsed.data.role } });
    } catch (error) {
      await client.query("ROLLBACK");
      if ((error as { code?: string }).code === "23505") throw httpError(409, "That account is already a project member.");
      throw error;
    } finally {
      client.release();
    }
  });

  app.patch<{ Params: { projectId: string; userId: string } }>("/v1/projects/:projectId/members/:userId", async (request) => {
    const projectId = parseUuid(request.params.projectId);
    const memberId = parseUuid(request.params.userId);
    const actorId = await requireUser(request);
    await requireProjectRole(request, projectId, "admin");
    const parsed = memberRoleInput.safeParse(request.body);
    if (!parsed.success) throw httpError(400, "Provide a supported member role.");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const actorRole = await lockProjectAdmin(client, projectId, actorId);
      const target = await client.query<{ role: string }>("SELECT role FROM platform_project_members WHERE project_id = $1 AND user_id = $2 FOR UPDATE", [projectId, memberId]);
      if (!target.rowCount) throw httpError(404, "Project member not found.");
      if (target.rows[0]!.role === "owner") throw httpError(403, "The project owner role cannot be changed here.");
      if ((target.rows[0]!.role === "admin" || parsed.data.role === "admin") && actorRole !== "owner") throw httpError(403, "Only the project owner can change administrator access.");
      await client.query("UPDATE platform_project_members SET role = $1 WHERE project_id = $2 AND user_id = $3", [parsed.data.role, projectId, memberId]);
      await writeAudit(client, actorId, projectId, "project.member_role_changed", "project_member", memberId);
      await client.query("COMMIT");
      return { member: { userId: memberId, role: parsed.data.role } };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  app.delete<{ Params: { projectId: string; userId: string } }>("/v1/projects/:projectId/members/:userId", async (request) => {
    const projectId = parseUuid(request.params.projectId);
    const memberId = parseUuid(request.params.userId);
    const actorId = await requireUser(request);
    await requireProjectRole(request, projectId, "admin");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const actorRole = await lockProjectAdmin(client, projectId, actorId);
      const target = await client.query<{ role: string }>("SELECT role FROM platform_project_members WHERE project_id = $1 AND user_id = $2 FOR UPDATE", [projectId, memberId]);
      if (!target.rowCount) throw httpError(404, "Project member not found.");
      if (target.rows[0]!.role === "owner") throw httpError(403, "The project owner cannot be removed.");
      if (target.rows[0]!.role === "admin" && actorRole !== "owner") throw httpError(403, "Only the project owner can remove an administrator.");
      await client.query("DELETE FROM platform_project_members WHERE project_id = $1 AND user_id = $2", [projectId, memberId]);
      await writeAudit(client, actorId, projectId, "project.member_removed", "project_member", memberId);
      await client.query("COMMIT");
      return { status: "removed" };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  app.post<{ Params: { projectId: string } }>("/v1/projects/:projectId/archive", async (request) => {
    const projectId = parseUuid(request.params.projectId);
    const userId = await requireUser(request);
    await requireProjectRole(request, projectId, "admin");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await lockProjectAdmin(client, projectId, userId);
      const result = await client.query("UPDATE platform_projects SET status = 'archived', updated_at = now() WHERE id = $1 AND status = 'active' RETURNING id", [projectId]);
      if (!result.rowCount) throw httpError(404, "Active project not found.");
      await writeAudit(client, userId, projectId, "project.archived", "project", projectId);
      await client.query("COMMIT");
      return { status: "archived" };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  app.get<{ Params: { projectId: string } }>("/v1/projects/:projectId/api-keys", async (request) => {
    const projectId = parseUuid(request.params.projectId);
    await requireUser(request);
    await requireProjectRole(request, projectId, "admin");
    const result = await pool.query("SELECT id, name, key_prefix, role, expires_at, revoked_at, created_at, last_used_at FROM platform_api_keys WHERE project_id = $1 ORDER BY created_at DESC", [projectId]);
    return { apiKeys: result.rows.map(key => ({ id: key.id, name: key.name, prefix: key.key_prefix, role: key.role, expiresAt: key.expires_at, revoked: Boolean(key.revoked_at), createdAt: key.created_at, lastUsedAt: key.last_used_at })) };
  });

  app.post<{ Params: { projectId: string } }>("/v1/projects/:projectId/api-keys", async (request, reply) => {
    const projectId = parseUuid(request.params.projectId);
    const userId = await requireUser(request);
    await requireProjectRole(request, projectId, "admin");
    const parsed = keyInput.safeParse(request.body);
    if (!parsed.success) throw httpError(400, "Provide a name, supported role, and valid optional expiry time.");
    const id = randomUUID();
    const prefix = `mb_live_${id}`;
    const secret = randomBytes(32).toString("base64url");
    const token = `${prefix}.${secret}`;
    const expiresAt = parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null;
    if (expiresAt && expiresAt.getTime() <= Date.now()) throw httpError(400, "API key expiry must be in the future.");
    const secretHash = createHash("sha256").update(secret).digest();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await lockProjectAdmin(client, projectId, userId);
      await client.query("INSERT INTO platform_api_keys (id, project_id, name, key_prefix, secret_hash, role, expires_at, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)", [id, projectId, parsed.data.name, prefix, secretHash, parsed.data.role, expiresAt, userId]);
      await writeAudit(client, userId, projectId, "api_key.created", "api_key", id);
      await client.query("COMMIT");
      return reply.code(201).send({ apiKey: { id, name: parsed.data.name, prefix, role: parsed.data.role, expiresAt, token, warning: "Copy this credential now. It cannot be retrieved again." } });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  app.delete<{ Params: { projectId: string; keyId: string } }>("/v1/projects/:projectId/api-keys/:keyId", async (request) => {
    const projectId = parseUuid(request.params.projectId);
    const keyId = parseUuid(request.params.keyId);
    const userId = await requireUser(request);
    await requireProjectRole(request, projectId, "admin");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await lockProjectAdmin(client, projectId, userId);
      const result = await client.query("UPDATE platform_api_keys SET revoked_at = now() WHERE id = $1 AND project_id = $2 AND revoked_at IS NULL RETURNING id", [keyId, projectId]);
      if (!result.rowCount) throw httpError(404, "Active API key not found.");
      await writeAudit(client, userId, projectId, "api_key.revoked", "api_key", keyId);
      await client.query("COMMIT");
      return { status: "revoked" };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });
}
