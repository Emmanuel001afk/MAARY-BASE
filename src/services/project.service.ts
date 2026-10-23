import { rm } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.js";
import { pool, withTransaction } from "../db/pool.js";
import {
  decryptSecret,
  encryptSecret,
   type EncryptedSecretPayload,
  generateApiKey,
  hashToken,
} from "../lib/crypto.js";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from "../lib/errors.js";
import {
  assertValidIdentifier,
  quoteIdent,
  toProjectSchemaName,
} from "../lib/sql-safety.js";
import { getProjectMetrics, recordAuditEvent } from "./audit.service.js";
import type { PlatformUser } from "./platform-auth.service.js";

export type ProjectRole = "owner" | "admin" | "developer" | "viewer";

export interface ProjectRecord {
  id: string;
  slug: string;
  name: string;
  description: string;
  schema_name: string;
  db_role_name: string;
  owner_id: string | null;
  status: "active" | "suspended" | "archived";
  settings: Record<string, unknown>;
  quotas: {
    maxTables: number;
    maxRowsPerQuery: number;
    maxStorageBytes: number;
    maxFunctions: number;
    maxRealtimeConnections: number;
  };
  created_at: string;
  updated_at: string;
}

export interface EnvironmentRecord {
  id: string;
  project_id: string;
  name: string;
  slug: string;
  is_production: boolean;
  config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface ApiKeyRecord {
  id: string;
  project_id: string;
  environment_id: string | null;
  name: string;
  role: "anon" | "authenticated" | "service_role" | "custom";
  key_prefix: string;
  scopes: string[];
  rate_limit_per_min: number;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  created_at: string;
  raw_key?: string;
}

const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/;
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function createProject(input: {
  name: string;
  slug?: string;
  description?: string;
  ownerId?: string | null;
  quotas?: Partial<ProjectRecord["quotas"]>;
  settings?: Record<string, unknown>;
}): Promise<{
  project: ProjectRecord;
  environments: EnvironmentRecord[];
  apiKeys: { anonKey: string; serviceRoleKey: string; keys: ApiKeyRecord[] };
}> {
  const name = input.name.trim();
  if (!name || name.length < 2) {
    throw new ValidationError("Project name must be at least 2 characters.");
  }

  const slug = (
    input.slug ??
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
  ).toLowerCase();

  if (!SLUG_REGEX.test(slug)) {
    throw new ValidationError(
      "Project slug must be 3-48 characters, lowercase alphanumeric and hyphens."
    );
  }

  const schemaName = toProjectSchemaName(slug);
  const dbRoleName = `role_${slug.replace(/[^a-z0-9_]/g, "_").slice(0, 48)}`;
  assertValidIdentifier(dbRoleName, "role");

  const existing = await pool.query(
    "SELECT id FROM platform_projects WHERE slug = $1 OR schema_name = $2",
    [slug, schemaName]
  );
  if (existing.rowCount && existing.rowCount > 0) {
    throw new ConflictError(`Project with slug '${slug}' already exists.`);
  }

  const defaultQuotas = {
    maxTables: 100,
    maxRowsPerQuery: 1000,
    maxStorageBytes: 104_857_600,
    maxFunctions: 50,
    maxRealtimeConnections: 100,
    ...(input.quotas ?? {}),
  };

  const anonGenerated = generateApiKey("anon");
  const serviceGenerated = generateApiKey("service");

  const result = await withTransaction(async (client) => {
    const rlsRoleName = `${dbRoleName}_rls`;
    assertValidIdentifier(rlsRoleName, "role");
    const roleIdent = quoteIdent(dbRoleName);
    const rlsRoleIdent = quoteIdent(rlsRoleName);
    const schemaIdent = quoteIdent(schemaName);

    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${dbRoleName}') THEN
          CREATE ROLE ${roleIdent} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${rlsRoleName}') THEN
          CREATE ROLE ${rlsRoleIdent} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
        END IF;
      END
      $$;
    `);
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${schemaIdent} AUTHORIZATION ${roleIdent}`);
    await client.query(`ALTER SCHEMA ${schemaIdent} OWNER TO ${roleIdent}`);
    await client.query(
      `REVOKE ALL ON SCHEMA ${schemaIdent} FROM PUBLIC, maary_rls_user, maary_anon, maary_authenticated, maary_service_role`
    );
    await client.query(
      `GRANT ALL ON SCHEMA ${schemaIdent} TO ${roleIdent}`
    );
    await client.query(
      `GRANT USAGE ON SCHEMA ${schemaIdent} TO ${rlsRoleIdent}`
    );
    await client.query(
      `REVOKE CREATE ON SCHEMA public FROM PUBLIC, ${roleIdent}, ${rlsRoleIdent}`
    );
    await client.query(
      `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC, ${roleIdent}, ${rlsRoleIdent}`
    );
    await client.query(
      `REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, ${roleIdent}, ${rlsRoleIdent}`
    );
    await client.query(
      `GRANT USAGE ON SCHEMA auth TO ${roleIdent}, ${rlsRoleIdent}, maary_rls_user`
    );
    await client.query(
      `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO ${roleIdent}, ${rlsRoleIdent}, maary_rls_user`
    );
    await client.query(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${roleIdent} IN SCHEMA ${schemaIdent} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${rlsRoleIdent}`
    );
    await client.query(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${roleIdent} IN SCHEMA ${schemaIdent} GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${rlsRoleIdent}`
    );
    await client.query(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${roleIdent} IN SCHEMA ${schemaIdent} GRANT EXECUTE ON FUNCTIONS TO ${rlsRoleIdent}`
    );
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schemaIdent} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${roleIdent}, ${rlsRoleIdent}`
    );
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schemaIdent} GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${roleIdent}, ${rlsRoleIdent}`
    );
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schemaIdent} GRANT EXECUTE ON FUNCTIONS TO ${roleIdent}, ${rlsRoleIdent}`
    );

    const projRes = await client.query<ProjectRecord>(
      `INSERT INTO platform_projects (
        slug, name, description, schema_name, db_role_name, owner_id, status, settings, quotas
      ) VALUES ($1, $2, $3, $4, $5, $6, 'active', $7::jsonb, $8::jsonb)
      RETURNING *`,
      [
        slug,
        name,
        input.description ?? "",
        schemaName,
        dbRoleName,
        input.ownerId ?? null,
        JSON.stringify(input.settings ?? {}),
        JSON.stringify(defaultQuotas),
      ]
    );
    const project = projRes.rows[0]!;

    if (input.ownerId) {
      await client.query(
        `INSERT INTO platform_project_members (project_id, user_id, role, permissions)
         VALUES ($1, $2, 'owner', '["*"]'::jsonb)`,
        [project.id, input.ownerId]
      );
    }

    const envDefs = [
      { name: "Development", slug: "development", is_production: false },
      { name: "Staging", slug: "staging", is_production: false },
      { name: "Production", slug: "production", is_production: true },
    ];
    const environments: EnvironmentRecord[] = [];
    for (const envDef of envDefs) {
      const envRes = await client.query<EnvironmentRecord>(
        `INSERT INTO platform_environments (project_id, name, slug, is_production, config)
         VALUES ($1, $2, $3, $4, '{}'::jsonb)
         RETURNING *`,
        [project.id, envDef.name, envDef.slug, envDef.is_production]
      );
      environments.push(envRes.rows[0]!);
    }

    await client.query(
      `INSERT INTO platform_auth_configs (project_id) VALUES ($1) ON CONFLICT DO NOTHING`,
      [project.id]
    );

    const anonEncrypted = encryptSecret(anonGenerated.rawKey);
    const serviceEncrypted = encryptSecret(serviceGenerated.rawKey);

    const anonKeyRes = await client.query<ApiKeyRecord>(
      `INSERT INTO platform_api_keys (
        project_id, name, role, key_prefix, key_hash, encrypted_key, scopes, rate_limit_per_min, created_by
      ) VALUES ($1, 'anon (public)', 'anon', $2, $3, $4::jsonb, '["db:read","db:write","auth:public","storage:read","storage:write","realtime:subscribe","functions:invoke"]'::jsonb, 600, $5)
      RETURNING id, project_id, environment_id, name, role, key_prefix, scopes, rate_limit_per_min, expires_at, revoked_at, last_used_at, created_at`,
      [
        project.id,
        anonGenerated.keyPrefix,
        anonGenerated.keyHash,
        JSON.stringify(anonEncrypted),
        input.ownerId ?? null,
      ]
    );

    const serviceKeyRes = await client.query<ApiKeyRecord>(
      `INSERT INTO platform_api_keys (
        project_id, name, role, key_prefix, key_hash, encrypted_key, scopes, rate_limit_per_min, created_by
      ) VALUES ($1, 'service_role (secret)', 'service_role', $2, $3, $4::jsonb, '["*"]'::jsonb, 3000, $5)
      RETURNING id, project_id, environment_id, name, role, key_prefix, scopes, rate_limit_per_min, expires_at, revoked_at, last_used_at, created_at`,
      [
        project.id,
        serviceGenerated.keyPrefix,
        serviceGenerated.keyHash,
        JSON.stringify(serviceEncrypted),
        input.ownerId ?? null,
      ]
    );

    return {
      project,
      environments,
      apiKeys: {
        anonKey: anonGenerated.rawKey,
        serviceRoleKey: serviceGenerated.rawKey,
        keys: [
          { ...anonKeyRes.rows[0]!, raw_key: anonGenerated.rawKey },
          { ...serviceKeyRes.rows[0]!, raw_key: serviceGenerated.rawKey },
        ],
      },
    };
  });

  await recordAuditEvent({
    projectId: result.project.id,
    actorType: input.ownerId ? "user" : "system",
    actorId: input.ownerId ?? null,
    action: "project.created",
    resourceType: "project",
    resourceId: result.project.id,
    metadata: { slug: result.project.slug, schema: result.project.schema_name },
  });

  return result;
}

export async function getProjectByRef(
  projectRef: string
): Promise<ProjectRecord> {
  const isUuid = UUID_REGEX.test(projectRef);
  const res = await pool.query<ProjectRecord>(
    isUuid
      ? "SELECT * FROM platform_projects WHERE id = $1 AND deleted_at IS NULL"
      : "SELECT * FROM platform_projects WHERE slug = $1 AND deleted_at IS NULL",
    [projectRef]
  );
  const project = res.rows[0];
  if (!project) {
    throw new NotFoundError(`Project '${projectRef}' was not found.`);
  }
  return project;
}

export async function listProjectsForUser(
  user?: PlatformUser | null
): Promise<Array<ProjectRecord & { member_role?: string }>> {
  if (!user || user.is_superadmin) {
    const res = await pool.query<ProjectRecord>(
      `SELECT * FROM platform_projects WHERE deleted_at IS NULL ORDER BY created_at DESC`
    );
    return res.rows.map((r) => ({ ...r, member_role: "owner" }));
  }

  const res = await pool.query<ProjectRecord & { member_role: string }>(
    `SELECT p.*, COALESCE(m.role, CASE WHEN p.owner_id = $1 THEN 'owner' ELSE 'viewer' END) AS member_role
     FROM platform_projects p
     LEFT JOIN platform_project_members m ON m.project_id = p.id AND m.user_id = $1
     WHERE p.deleted_at IS NULL
       AND (p.owner_id = $1 OR m.user_id = $1 OR p.owner_id IS NULL)
     ORDER BY p.created_at DESC`,
    [user.id]
  );
  return res.rows;
}

export async function getUserProjectRole(
  projectId: string,
  user: PlatformUser
): Promise<ProjectRole | null> {
  if (user.is_superadmin) return "owner";
  const projRes = await pool.query<{ owner_id: string | null }>(
    "SELECT owner_id FROM platform_projects WHERE id = $1",
    [projectId]
  );
  if (!projRes.rows[0]) return null;
  if (projRes.rows[0].owner_id === user.id || projRes.rows[0].owner_id === null) {
    return "owner";
  }
  const memRes = await pool.query<{ role: ProjectRole }>(
    "SELECT role FROM platform_project_members WHERE project_id = $1 AND user_id = $2",
    [projectId, user.id]
  );
  return memRes.rows[0]?.role ?? null;
}

export async function assertProjectRole(
  projectId: string,
  user: PlatformUser,
  allowedRoles: ProjectRole[]
): Promise<ProjectRole> {
  const role = await getUserProjectRole(projectId, user);
  if (!role || !allowedRoles.includes(role)) {
    throw new ForbiddenError(
      `Insufficient project permissions. Required one of: ${allowedRoles.join(", ")}.`
    );
  }
  return role;
}

export async function updateProject(
  projectId: string,
  updates: {
    name?: string;
    description?: string;
    status?: "active" | "suspended" | "archived";
    settings?: Record<string, unknown>;
    quotas?: Partial<ProjectRecord["quotas"]>;
  },
  actorId?: string | null
): Promise<ProjectRecord> {
  const current = await getProjectByRef(projectId);
  const newName = updates.name ? updates.name.trim() : current.name;
  const newDescription =
    updates.description !== undefined
      ? updates.description
      : current.description;
  const newStatus = updates.status ?? current.status;
  const newSettings = updates.settings
    ? { ...current.settings, ...updates.settings }
    : current.settings;
  const newQuotas = updates.quotas
    ? { ...current.quotas, ...updates.quotas }
    : current.quotas;

  const res = await pool.query<ProjectRecord>(
    `UPDATE platform_projects
     SET name = $1, description = $2, status = $3, settings = $4::jsonb, quotas = $5::jsonb, updated_at = now()
     WHERE id = $6
     RETURNING *`,
    [
      newName,
      newDescription,
      newStatus,
      JSON.stringify(newSettings),
      JSON.stringify(newQuotas),
      current.id,
    ]
  );

  await recordAuditEvent({
    projectId: current.id,
    actorType: actorId ? "user" : "system",
    actorId: actorId ?? null,
    action: "project.updated",
    resourceType: "project",
    resourceId: current.id,
    metadata: { status: newStatus, name: newName },
  });

  return res.rows[0]!;
}

export async function deleteProject(
  projectRef: string,
  confirmSlug: string,
  actorId?: string | null
): Promise<void> {
  const project = await getProjectByRef(projectRef);
  if (confirmSlug !== project.slug) {
    throw new ValidationError(
      `Confirmation slug '${confirmSlug}' does not match project slug '${project.slug}'.`
    );
  }

  await withTransaction(async (client) => {
    if (project.schema_name) {
      const schemaIdent = quoteIdent(project.schema_name);
      await client.query(`DROP SCHEMA IF EXISTS ${schemaIdent} CASCADE`);
    }
    await client.query("DELETE FROM platform_projects WHERE id = $1", [
      project.id,
    ]);
  });

  await recordAuditEvent({
    projectId: null,
    actorType: actorId ? "user" : "system",
    actorId: actorId ?? null,
    action: "project.deleted",
    resourceType: "project",
    resourceId: project.id,
    metadata: { slug: project.slug, schema: project.schema_name },
  });

  // Clean up project storage folder if present
  try {
    await rm(join(config.STORAGE_DIR, project.id), {
      recursive: true,
      force: true,
    });
  } catch {
    // Ignore filesystem cleanup error if directory doesn't exist
  }
}

export async function listEnvironments(
  projectId: string
): Promise<EnvironmentRecord[]> {
  const res = await pool.query<EnvironmentRecord>(
    `SELECT * FROM platform_environments WHERE project_id = $1 ORDER BY created_at ASC`,
    [projectId]
  );
  return res.rows;
}

export async function createEnvironment(
  projectId: string,
  input: {
    name: string;
    slug?: string;
    isProduction?: boolean;
    config?: Record<string, unknown>;
  },
  actorId?: string | null
): Promise<EnvironmentRecord> {
  const name = input.name.trim();
  const slug = (input.slug ?? name.toLowerCase().replace(/[^a-z0-9-]+/g, "-")).toLowerCase();
  if (!name || !slug) {
    throw new ValidationError("Environment name and slug are required.");
  }

  const existing = await pool.query(
    "SELECT id FROM platform_environments WHERE project_id = $1 AND (name = $2 OR slug = $3)",
    [projectId, name, slug]
  );
  if (existing.rowCount && existing.rowCount > 0) {
    throw new ConflictError(`Environment '${name}' already exists in this project.`);
  }

  const res = await pool.query<EnvironmentRecord>(
    `INSERT INTO platform_environments (project_id, name, slug, is_production, config)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     RETURNING *`,
    [
      projectId,
      name,
      slug,
      Boolean(input.isProduction),
      JSON.stringify(input.config ?? {}),
    ]
  );

  await recordAuditEvent({
    projectId,
    actorType: actorId ? "user" : "system",
    actorId: actorId ?? null,
    action: "environment.created",
    resourceType: "environment",
    resourceId: res.rows[0]!.id,
    metadata: { name, slug },
  });

  return res.rows[0]!;
}

export async function deleteEnvironment(
  projectId: string,
  environmentId: string,
  actorId?: string | null
): Promise<void> {
  const envs = await listEnvironments(projectId);
  if (envs.length <= 1) {
    throw new ValidationError("Cannot delete the last remaining environment.");
  }
  const target = envs.find((e) => e.id === environmentId);
  if (!target) {
    throw new NotFoundError("Environment not found.");
  }
  await pool.query(
    "DELETE FROM platform_environments WHERE id = $1 AND project_id = $2",
    [environmentId, projectId]
  );
  await recordAuditEvent({
    projectId,
    actorType: actorId ? "user" : "system",
    actorId: actorId ?? null,
    action: "environment.deleted",
    resourceType: "environment",
    resourceId: environmentId,
    metadata: { name: target.name },
  });
}

// Project Members
export async function listProjectMembers(projectId: string): Promise<
  Array<{
    id: string;
    project_id: string;
    user_id: string;
    email: string;
    name: string;
    role: ProjectRole;
    permissions: string[];
    created_at: string;
  }>
> {
  const res = await pool.query<{
    id: string;
    project_id: string;
    user_id: string;
    email: string;
    name: string;
    role: ProjectRole;
    permissions: string[];
    created_at: string;
  }>(
    `SELECT m.id, m.project_id, m.user_id, u.email, u.name, m.role, m.permissions, m.created_at
     FROM platform_project_members m
     JOIN platform_users u ON u.id = m.user_id
     WHERE m.project_id = $1
     ORDER BY m.created_at ASC`,
    [projectId]
  );
  return res.rows;
}

export async function upsertProjectMember(
  projectId: string,
  input: {
    email?: string;
    userId?: string;
    role: ProjectRole;
    permissions?: string[];
  },
  actorId?: string | null
): Promise<{
  id: string;
  project_id: string;
  user_id: string;
  role: ProjectRole;
  permissions: string[];
}> {
  let targetUserId = input.userId;
  if (!targetUserId && input.email) {
    const userRes = await pool.query<{ id: string }>(
      "SELECT id FROM platform_users WHERE email = $1",
      [input.email.trim().toLowerCase()]
    );
    if (!userRes.rows[0]) {
      throw new NotFoundError(`Platform user with email '${input.email}' not found.`);
    }
    targetUserId = userRes.rows[0].id;
  }
  if (!targetUserId) {
    throw new ValidationError("Either userId or email is required.");
  }

  const res = await pool.query<{
    id: string;
    project_id: string;
    user_id: string;
    role: ProjectRole;
    permissions: string[];
  }>(
    `INSERT INTO platform_project_members (project_id, user_id, role, permissions, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, now())
     ON CONFLICT (project_id, user_id)
     DO UPDATE SET role = EXCLUDED.role, permissions = EXCLUDED.permissions, updated_at = now()
     RETURNING id, project_id, user_id, role, permissions`,
    [
      projectId,
      targetUserId,
      input.role,
      JSON.stringify(input.permissions ?? []),
    ]
  );

  await recordAuditEvent({
    projectId,
    actorType: actorId ? "user" : "system",
    actorId: actorId ?? null,
    action: "project.member.upserted",
    resourceType: "project_member",
    resourceId: targetUserId,
    metadata: { role: input.role },
  });

  return res.rows[0]!;
}

export async function removeProjectMember(
  projectId: string,
  userId: string,
  actorId?: string | null
): Promise<void> {
  const owners = await pool.query(
    "SELECT id FROM platform_project_members WHERE project_id = $1 AND role = 'owner'",
    [projectId]
  );
  const target = await pool.query<{ role: string }>(
    "SELECT role FROM platform_project_members WHERE project_id = $1 AND user_id = $2",
    [projectId, userId]
  );
  if (!target.rows[0]) {
    throw new NotFoundError("Project member not found.");
  }
  if (target.rows[0].role === "owner" && (owners.rowCount ?? 0) <= 1) {
    throw new ValidationError("Cannot remove the last owner of a project.");
  }
  await pool.query(
    "DELETE FROM platform_project_members WHERE project_id = $1 AND user_id = $2",
    [projectId, userId]
  );
  await recordAuditEvent({
    projectId,
    actorType: actorId ? "user" : "system",
    actorId: actorId ?? null,
    action: "project.member.removed",
    resourceType: "project_member",
    resourceId: userId,
  });
}

// API Keys Management
export async function listApiKeys(
  projectId: string,
  revealRawKeys = false
): Promise<ApiKeyRecord[]> {
  const res = await pool.query<
    ApiKeyRecord & { encrypted_key: EncryptedSecretPayload | null }
  >(
    `SELECT id, project_id, environment_id, name, role, key_prefix, encrypted_key, scopes, rate_limit_per_min, expires_at, revoked_at, last_used_at, created_at
     FROM platform_api_keys
     WHERE project_id = $1
     ORDER BY created_at ASC`,
    [projectId]
  );

  return res.rows.map((row) => {
    let rawKey: string | undefined;
    if (revealRawKeys && row.encrypted_key && !row.revoked_at) {
      try {
        rawKey = decryptSecret(row.encrypted_key);
      } catch {
        rawKey = undefined;
      }
    }
    const { encrypted_key: _enc, ...rest } = row;
    return rawKey ? { ...rest, raw_key: rawKey } : rest;
  });
}

export async function createProjectApiKey(
  projectId: string,
  input: {
    name: string;
    role: "anon" | "service_role" | "custom";
    scopes?: string[];
    environmentId?: string | null;
    rateLimitPerMin?: number;
    expiresAt?: string | null;
    actorId?: string | null;
  }
): Promise<ApiKeyRecord & { raw_key: string }> {
  const prefix =
    input.role === "anon"
      ? "anon"
      : input.role === "service_role"
        ? "service"
        : "key";
  const generated = generateApiKey(prefix);
  const encrypted = encryptSecret(generated.rawKey);
  const defaultScopes =
    input.role === "service_role"
      ? ["*"]
      : input.role === "anon"
        ? [
            "db:read",
            "db:write",
            "auth:public",
            "storage:read",
            "storage:write",
            "realtime:subscribe",
            "functions:invoke",
          ]
        : (input.scopes ?? ["db:read"]);

  const res = await pool.query<ApiKeyRecord>(
    `INSERT INTO platform_api_keys (
      project_id, environment_id, name, role, key_prefix, key_hash, encrypted_key, scopes, rate_limit_per_min, expires_at, created_by
    ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11)
    RETURNING id, project_id, environment_id, name, role, key_prefix, scopes, rate_limit_per_min, expires_at, revoked_at, last_used_at, created_at`,
    [
      projectId,
      input.environmentId ?? null,
      input.name.trim(),
      input.role,
      generated.keyPrefix,
      generated.keyHash,
      JSON.stringify(encrypted),
      JSON.stringify(defaultScopes),
      input.rateLimitPerMin ?? 600,
      input.expiresAt ?? null,
      input.actorId ?? null,
    ]
  );

  await recordAuditEvent({
    projectId,
    actorType: input.actorId ? "user" : "system",
    actorId: input.actorId ?? null,
    action: "apikey.created",
    resourceType: "api_key",
    resourceId: res.rows[0]!.id,
    metadata: { name: input.name, role: input.role, prefix: generated.keyPrefix },
  });

  return { ...res.rows[0]!, raw_key: generated.rawKey };
}

export async function rotateProjectApiKey(
  projectId: string,
  keyId: string,
  actorId?: string | null
): Promise<ApiKeyRecord & { raw_key: string }> {
  const existingRes = await pool.query<ApiKeyRecord>(
    `SELECT * FROM platform_api_keys WHERE id = $1 AND project_id = $2`,
    [keyId, projectId]
  );
  const existing = existingRes.rows[0];
  if (!existing) {
    throw new NotFoundError("API key not found.");
  }

  await pool.query(
    `UPDATE platform_api_keys SET revoked_at = now() WHERE id = $1`,
    [keyId]
  );

  const replacement = await createProjectApiKey(projectId, {
    name: existing.name,
    role:
      existing.role === "authenticated"
        ? "custom"
        : (existing.role as "anon" | "service_role" | "custom"),
    scopes: existing.scopes,
    environmentId: existing.environment_id,
    rateLimitPerMin: existing.rate_limit_per_min,
    expiresAt: existing.expires_at,
    actorId,
  });

  await recordAuditEvent({
    projectId,
    actorType: actorId ? "user" : "system",
    actorId: actorId ?? null,
    action: "apikey.rotated",
    resourceType: "api_key",
    resourceId: replacement.id,
    metadata: { previousKeyId: keyId, newKeyId: replacement.id },
  });

  return replacement;
}

export async function revokeProjectApiKey(
  projectId: string,
  keyId: string,
  actorId?: string | null
): Promise<void> {
  const res = await pool.query(
    `UPDATE platform_api_keys SET revoked_at = now()
     WHERE id = $1 AND project_id = $2 AND revoked_at IS NULL
     RETURNING id`,
    [keyId, projectId]
  );
  if (!res.rowCount) {
    throw new NotFoundError("Active API key not found.");
  }
  await recordAuditEvent({
    projectId,
    actorType: actorId ? "user" : "system",
    actorId: actorId ?? null,
    action: "apikey.revoked",
    resourceType: "api_key",
    resourceId: keyId,
  });
}

export async function verifyProjectApiKey(rawKey: string): Promise<{
  apiKey: ApiKeyRecord;
  project: ProjectRecord;
}> {
  const keyHash = hashToken(rawKey);
  const res = await pool.query<ApiKeyRecord>(
    `SELECT id, project_id, environment_id, name, role, key_prefix, scopes, rate_limit_per_min, expires_at, revoked_at, last_used_at, created_at
     FROM platform_api_keys
     WHERE key_hash = $1`,
    [keyHash]
  );
  const apiKey = res.rows[0];
  if (!apiKey) {
    throw new UnauthorizedError("Invalid API key.");
  }
  if (apiKey.revoked_at) {
    throw new UnauthorizedError("API key has been revoked.");
  }
  if (
    apiKey.expires_at &&
    new Date(apiKey.expires_at).getTime() < Date.now()
  ) {
    throw new UnauthorizedError("API key has expired.");
  }

  const project = await getProjectByRef(apiKey.project_id);
  if (project.status !== "active") {
    throw new ForbiddenError(
      `Project '${project.slug}' is currently ${project.status}.`
    );
  }

  void pool
    .query("UPDATE platform_api_keys SET last_used_at = now() WHERE id = $1", [
      apiKey.id,
    ])
    .catch(() => {});

  return { apiKey, project };
}

// Encrypted Secrets Store
export interface SecretMetadata {
  id: string;
  project_id: string;
  environment_id: string | null;
  name: string;
  description: string;
  version: number;
  masked_value: string;
  decrypted_value?: string;
  created_at: string;
  updated_at: string;
}

export async function listProjectSecrets(
  projectId: string,
  options: { environmentId?: string; reveal?: boolean } = {}
): Promise<SecretMetadata[]> {
  const params: unknown[] = [projectId];
  let envCondition = "";
  if (options.environmentId) {
    params.push(options.environmentId);
    envCondition = `AND environment_id = $2`;
  }
  const res = await pool.query<{
    id: string;
    project_id: string;
    environment_id: string | null;
    name: string;
    encrypted_value: string;
    iv: string;
    auth_tag: string;
    description: string;
    version: number;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT * FROM platform_secrets WHERE project_id = $1 ${envCondition} ORDER BY name ASC`,
    params
  );

  return res.rows.map((row) => {
    let plain: string | undefined;
    if (options.reveal) {
      try {
        plain = decryptSecret({
          encryptedValue: row.encrypted_value,
          iv: row.iv,
          authTag: row.auth_tag,
        });
      } catch {
        plain = undefined;
      }
    }
    return {
      id: row.id,
      project_id: row.project_id,
      environment_id: row.environment_id,
      name: row.name,
      description: row.description,
      version: row.version,
      masked_value: "••••••••",
      ...(plain !== undefined ? { decrypted_value: plain } : {}),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  });
}

export async function upsertProjectSecret(
  projectId: string,
  input: {
    name: string;
    value: string;
    description?: string;
    environmentId?: string | null;
    actorId?: string | null;
  }
): Promise<SecretMetadata> {
  const name = input.name.trim().toUpperCase();
  if (!/^[A-Z_][A-Z0-9_]{0,63}$/.test(name)) {
    throw new ValidationError(
      "Secret name must be uppercase alphanumeric with underscores (e.g. STRIPE_API_KEY)."
    );
  }
  const enc = encryptSecret(input.value);

  const res = await pool.query<{
    id: string;
    project_id: string;
    environment_id: string | null;
    name: string;
    description: string;
    version: number;
    created_at: string;
    updated_at: string;
  }>(
    `INSERT INTO platform_secrets (
      project_id, environment_id, name, encrypted_value, iv, auth_tag, description, version, updated_by
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8)
    ON CONFLICT (project_id, environment_id, name)
    DO UPDATE SET
      encrypted_value = EXCLUDED.encrypted_value,
      iv = EXCLUDED.iv,
      auth_tag = EXCLUDED.auth_tag,
      description = COALESCE(NULLIF(EXCLUDED.description, ''), platform_secrets.description),
      version = platform_secrets.version + 1,
      updated_by = EXCLUDED.updated_by,
      updated_at = now()
    RETURNING id, project_id, environment_id, name, description, version, created_at, updated_at`,
    [
      projectId,
      input.environmentId ?? null,
      name,
      enc.encryptedValue,
      enc.iv,
      enc.authTag,
      input.description ?? "",
      input.actorId ?? null,
    ]
  );

  await recordAuditEvent({
    projectId,
    actorType: input.actorId ? "user" : "system",
    actorId: input.actorId ?? null,
    action: "secret.upserted",
    resourceType: "secret",
    resourceId: res.rows[0]!.id,
    metadata: { name, version: res.rows[0]!.version },
  });

  return {
    ...res.rows[0]!,
    masked_value: "••••••••",
  };
}

export async function deleteProjectSecret(
  projectId: string,
  secretNameOrId: string,
  actorId?: string | null
): Promise<void> {
  const isUuid = UUID_REGEX.test(secretNameOrId);
  const res = await pool.query<{ id: string; name: string }>(
    isUuid
      ? "DELETE FROM platform_secrets WHERE id = $1 AND project_id = $2 RETURNING id, name"
      : "DELETE FROM platform_secrets WHERE name = $1 AND project_id = $2 RETURNING id, name",
    [secretNameOrId, projectId]
  );
  if (!res.rowCount) {
    throw new NotFoundError("Secret not found.");
  }
  await recordAuditEvent({
    projectId,
    actorType: actorId ? "user" : "system",
    actorId: actorId ?? null,
    action: "secret.deleted",
    resourceType: "secret",
    resourceId: res.rows[0]!.id,
    metadata: { name: res.rows[0]!.name },
  });
}

export async function getDecryptedSecretsMap(
  projectId: string,
  environmentId?: string
): Promise<Record<string, string>> {
  const secrets = await listProjectSecrets(projectId, {
    environmentId,
    reveal: true,
  });
  const map: Record<string, string> = {};
  for (const s of secrets) {
    if (s.decrypted_value !== undefined) {
      map[s.name] = s.decrypted_value;
    }
  }
  return map;
}

export async function getProjectDiagnostics(project: ProjectRecord): Promise<{
  project: ProjectRecord;
  usage: {
    tableCount: number;
    userCount: number;
    storageBytes: number;
    storageObjects: number;
    functionCount: number;
    queuedJobs: number;
    metrics: Record<string, number>;
  };
}> {
  const [tablesRes, usersRes, storageRes, fnRes, jobsRes, metrics] =
    await Promise.all([
      pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE'`,
        [project.schema_name]
      ),
      pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM project_auth_users WHERE project_id = $1`,
        [project.id]
      ),
      pool.query<{ bytes: string; objects: string }>(
        `SELECT COALESCE(SUM(size_bytes), 0)::text AS bytes, COUNT(*)::text AS objects FROM platform_storage_objects WHERE project_id = $1`,
        [project.id]
      ),
      pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM platform_functions WHERE project_id = $1`,
        [project.id]
      ),
      pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM platform_jobs WHERE project_id = $1 AND status IN ('queued', 'running')`,
        [project.id]
      ),
      getProjectMetrics(project.id),
    ]);

  return {
    project,
    usage: {
      tableCount: Number(tablesRes.rows[0]?.count ?? 0),
      userCount: Number(usersRes.rows[0]?.count ?? 0),
      storageBytes: Number(storageRes.rows[0]?.bytes ?? 0),
      storageObjects: Number(storageRes.rows[0]?.objects ?? 0),
      functionCount: Number(fnRes.rows[0]?.count ?? 0),
      queuedJobs: Number(jobsRes.rows[0]?.count ?? 0),
      metrics,
    },
  };
}
