import { randomBytes } from "node:crypto";
import { pool, withTransaction, type DatabaseClient } from "../db/pool.js";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "../lib/errors.js";
import { recordAuditEvent } from "./audit.service.js";
import type { PlatformUser } from "./platform-auth.service.js";

export type OrganizationRole = "owner" | "admin" | "developer" | "viewer";

export interface OrganizationRecord {
  id: string;
  name: string;
  slug: string;
  description: string;
  billing_tier: "self-hosted" | "free" | "pro" | "team" | "enterprise";
  owner_id: string | null;
  settings: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  member_role?: OrganizationRole;
  member_count?: number;
  project_count?: number;
}

export interface OrganizationMemberRecord {
  id: string;
  organization_id: string;
  user_id: string;
  role: OrganizationRole;
  created_at: string;
  email: string;
  name: string;
  is_superadmin: boolean;
}

const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/;
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_ROLES = new Set<OrganizationRole>([
  "owner",
  "admin",
  "developer",
  "viewer",
]);
const VALID_TIERS = new Set([
  "self-hosted",
  "free",
  "pro",
  "team",
  "enterprise",
]);

function normalizeOrgSlug(name: string, explicitSlug?: string): string {
  if (explicitSlug) {
    const cleaned = explicitSlug.trim().toLowerCase();
    if (!SLUG_REGEX.test(cleaned)) {
      throw new ValidationError(
        "Organization slug must be 3-48 characters using lowercase letters, numbers, and hyphens."
      );
    }
    return cleaned;
  }
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 34);
  const prefix = base.length >= 3 ? base : "workspace";
  const suffix = randomBytes(3).toString("hex");
  return `${prefix}-${suffix}`;
}

export function normalizeOrgRole(role: string): OrganizationRole {
  if (role === "member") return "developer";
  if (VALID_ROLES.has(role as OrganizationRole)) {
    return role as OrganizationRole;
  }
  return "viewer";
}

export async function ensureDefaultOrganizationForUser(
  user: { id: string; name: string; email: string },
  client?: DatabaseClient
): Promise<OrganizationRecord> {
  const runner = client ?? pool;
  const existing = await runner.query<OrganizationRecord>(
    `SELECT o.*
     FROM platform_organizations o
     LEFT JOIN platform_organization_members m
       ON m.organization_id = o.id AND m.user_id = $1
     WHERE o.owner_id = $1 OR m.user_id = $1
     ORDER BY o.created_at ASC
     LIMIT 1`,
    [user.id]
  );
  if (existing.rows[0]) {
    return existing.rows[0];
  }

  const labelSource =
    user.name?.trim() || user.email.split("@")[0] || "Operator";
  const orgName = `${labelSource} Workspace`;
  const slug = normalizeOrgSlug(orgName);

  const inserted = await runner.query<OrganizationRecord>(
    `INSERT INTO platform_organizations (name, slug, description, billing_tier, owner_id, settings)
     VALUES ($1, $2, $3, 'self-hosted', $4, '{"personal":true}'::jsonb)
     RETURNING *`,
    [orgName, slug, "Default workspace", user.id]
  );
  const org = inserted.rows[0]!;

  await runner.query(
    `INSERT INTO platform_organization_members (organization_id, user_id, role)
     VALUES ($1, $2, 'owner')
     ON CONFLICT (organization_id, user_id) DO NOTHING`,
    [org.id, user.id]
  );

  return org;
}

export async function createOrganization(input: {
  name: string;
  slug?: string;
  description?: string;
  billingTier?: OrganizationRecord["billing_tier"];
  settings?: Record<string, unknown>;
  ownerId: string;
}): Promise<OrganizationRecord> {
  const name = input.name.trim();
  if (name.length < 2 || name.length > 80) {
    throw new ValidationError("Organization name must be between 2 and 80 characters.");
  }
  const slug = normalizeOrgSlug(name, input.slug);
  const billingTier = input.billingTier ?? "self-hosted";
  if (!VALID_TIERS.has(billingTier)) {
    throw new ValidationError(`Invalid billingTier '${billingTier}'.`);
  }

  const duplicate = await pool.query(
    `SELECT 1 FROM platform_organizations WHERE slug = $1`,
    [slug]
  );
  if (duplicate.rowCount && duplicate.rowCount > 0) {
    throw new ConflictError(`Organization slug '${slug}' is already in use.`);
  }

  const org = await withTransaction(async (client) => {
    const res = await client.query<OrganizationRecord>(
      `INSERT INTO platform_organizations (name, slug, description, billing_tier, owner_id, settings)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       RETURNING *`,
      [
        name,
        slug,
        (input.description ?? "").trim(),
        billingTier,
        input.ownerId,
        JSON.stringify(input.settings ?? {}),
      ]
    );
    const created = res.rows[0]!;

    await client.query(
      `INSERT INTO platform_organization_members (organization_id, user_id, role)
       VALUES ($1, $2, 'owner')
       ON CONFLICT (organization_id, user_id) DO UPDATE SET role = 'owner'`,
      [created.id, input.ownerId]
    );

    return created;
  });

  await recordAuditEvent({
    actorType: "user",
    actorId: input.ownerId,
    action: "organization.created",
    resourceType: "organization",
    resourceId: org.id,
    metadata: { slug: org.slug, name: org.name },
  });

  return {
    ...org,
    member_role: "owner",
    member_count: 1,
    project_count: 0,
  };
}

export async function listOrganizationsForUser(
  user: PlatformUser
): Promise<OrganizationRecord[]> {
  if (user.is_superadmin) {
    const res = await pool.query<OrganizationRecord & { raw_role: string | null }>(
      `SELECT
         o.*,
         COALESCE(m.role, CASE WHEN o.owner_id = $1 THEN 'owner' ELSE 'owner' END) AS raw_role,
         (SELECT COUNT(*)::int FROM platform_organization_members om WHERE om.organization_id = o.id) AS member_count,
         (SELECT COUNT(*)::int FROM platform_projects p WHERE p.organization_id = o.id) AS project_count
       FROM platform_organizations o
       LEFT JOIN platform_organization_members m
         ON m.organization_id = o.id AND m.user_id = $1
       ORDER BY o.created_at ASC`,
      [user.id]
    );
    return res.rows.map((r) => {
      const { raw_role, ...rest } = r;
      return {
        ...rest,
        member_role: normalizeOrgRole(raw_role ?? "owner"),
      };
    });
  }

  const res = await pool.query<OrganizationRecord & { raw_role: string | null }>(
    `SELECT
       o.*,
       COALESCE(m.role, CASE WHEN o.owner_id = $1 THEN 'owner' ELSE NULL END) AS raw_role,
       (SELECT COUNT(*)::int FROM platform_organization_members om WHERE om.organization_id = o.id) AS member_count,
       (SELECT COUNT(*)::int FROM platform_projects p WHERE p.organization_id = o.id) AS project_count
     FROM platform_organizations o
     LEFT JOIN platform_organization_members m
       ON m.organization_id = o.id AND m.user_id = $1
     WHERE o.owner_id = $1 OR m.user_id = $1
     ORDER BY o.created_at ASC`,
    [user.id]
  );

  return res.rows.map((r) => {
    const { raw_role, ...rest } = r;
    return {
      ...rest,
      member_role: normalizeOrgRole(raw_role ?? "viewer"),
    };
  });
}

export async function getOrganizationByRef(
  orgRef: string
): Promise<OrganizationRecord> {
  const isUuid = UUID_REGEX.test(orgRef);
  const res = await pool.query<OrganizationRecord>(
    `SELECT
       o.*,
       (SELECT COUNT(*)::int FROM platform_organization_members om WHERE om.organization_id = o.id) AS member_count,
       (SELECT COUNT(*)::int FROM platform_projects p WHERE p.organization_id = o.id) AS project_count
     FROM platform_organizations o
     WHERE ${isUuid ? "o.id = $1::uuid" : "o.slug = $1"}
     LIMIT 1`,
    [orgRef]
  );
  if (!res.rows[0]) {
    throw new NotFoundError(`Organization '${orgRef}' not found.`);
  }
  return res.rows[0];
}

export async function getUserOrganizationRole(
  organizationId: string,
  user: PlatformUser
): Promise<OrganizationRole | null> {
  if (user.is_superadmin) return "owner";
  const res = await pool.query<{ owner_id: string | null; role: string | null }>(
    `SELECT o.owner_id, m.role
     FROM platform_organizations o
     LEFT JOIN platform_organization_members m
       ON m.organization_id = o.id AND m.user_id = $2
     WHERE o.id = $1`,
    [organizationId, user.id]
  );
  const row = res.rows[0];
  if (!row) return null;
  if (row.owner_id === user.id) return "owner";
  if (row.role) return normalizeOrgRole(row.role);
  return null;
}

export async function requireOrganizationAccess(
  orgRef: string,
  user: PlatformUser,
  allowedRoles: OrganizationRole[] = ["owner", "admin", "developer", "viewer"]
): Promise<{ organization: OrganizationRecord; role: OrganizationRole }> {
  const organization = await getOrganizationByRef(orgRef);
  const role = await getUserOrganizationRole(organization.id, user);
  if (!role || !allowedRoles.includes(role)) {
    throw new ForbiddenError(
      "You do not have sufficient permissions in this organization."
    );
  }
  return { organization: { ...organization, member_role: role }, role };
}

export async function updateOrganization(
  organizationId: string,
  patch: {
    name?: string;
    description?: string;
    billingTier?: OrganizationRecord["billing_tier"];
    settings?: Record<string, unknown>;
  },
  actorId: string
): Promise<OrganizationRecord> {
  const current = await getOrganizationByRef(organizationId);
  const name = patch.name !== undefined ? patch.name.trim() : current.name;
  if (name.length < 2 || name.length > 80) {
    throw new ValidationError("Organization name must be between 2 and 80 characters.");
  }
  const description =
    patch.description !== undefined ? patch.description.trim() : current.description;
  const billingTier = patch.billingTier ?? current.billing_tier;
  if (!VALID_TIERS.has(billingTier)) {
    throw new ValidationError(`Invalid billingTier '${billingTier}'.`);
  }
  const settings =
    patch.settings !== undefined
      ? { ...current.settings, ...patch.settings }
      : current.settings;

  const res = await pool.query<OrganizationRecord>(
    `UPDATE platform_organizations
     SET name = $2, description = $3, billing_tier = $4, settings = $5::jsonb, updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [organizationId, name, description, billingTier, JSON.stringify(settings)]
  );

  await recordAuditEvent({
    actorType: "user",
    actorId,
    action: "organization.updated",
    resourceType: "organization",
    resourceId: organizationId,
    metadata: { name, billingTier },
  });

  return res.rows[0]!;
}

export async function deleteOrganization(
  organization: OrganizationRecord,
  confirmSlug: string | undefined,
  actorId: string
): Promise<void> {
  if (confirmSlug !== organization.slug) {
    throw new ValidationError(
      `Confirm deletion by passing confirmSlug='${organization.slug}'.`
    );
  }
  const projectsCountRes = await pool.query<{ cnt: number }>(
    `SELECT COUNT(*)::int AS cnt FROM platform_projects WHERE organization_id = $1`,
    [organization.id]
  );
  if ((projectsCountRes.rows[0]?.cnt ?? 0) > 0) {
    throw new ConflictError(
      "Cannot delete an organization that still contains projects. Delete or transfer its projects first."
    );
  }

  await pool.query(`DELETE FROM platform_organizations WHERE id = $1`, [
    organization.id,
  ]);

  await recordAuditEvent({
    actorType: "user",
    actorId,
    action: "organization.deleted",
    resourceType: "organization",
    resourceId: organization.id,
    metadata: { slug: organization.slug },
  });
}

export async function listOrganizationMembers(
  organizationId: string
): Promise<OrganizationMemberRecord[]> {
  const res = await pool.query<OrganizationMemberRecord>(
    `SELECT
       m.id,
       m.organization_id,
       m.user_id,
       m.role,
       m.created_at,
       u.email,
       u.name,
       u.is_superadmin
     FROM platform_organization_members m
     JOIN platform_users u ON u.id = m.user_id
     WHERE m.organization_id = $1
     ORDER BY m.created_at ASC`,
    [organizationId]
  );
  return res.rows.map((r) => ({
    ...r,
    role: normalizeOrgRole(r.role),
  }));
}

export async function upsertOrganizationMember(input: {
  organizationId: string;
  userId?: string;
  email?: string;
  role: OrganizationRole;
  actorId: string;
}): Promise<OrganizationMemberRecord> {
  if (!VALID_ROLES.has(input.role)) {
    throw new ValidationError(
      "Invalid role: must be 'owner', 'admin', 'developer', or 'viewer'."
    );
  }

  let targetUserId = input.userId?.trim();
  if (!targetUserId && input.email) {
    const userRes = await pool.query<{ id: string }>(
      `SELECT id FROM platform_users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
      [input.email.trim()]
    );
    if (!userRes.rows[0]) {
      throw new NotFoundError(
        `No platform operator found with email '${input.email.trim()}'.`
      );
    }
    targetUserId = userRes.rows[0].id;
  }

  if (!targetUserId || !UUID_REGEX.test(targetUserId)) {
    throw new ValidationError(
      "Either a valid 'userId' UUID or an existing operator 'email' is required."
    );
  }

  const userCheck = await pool.query<{ id: string }>(
    `SELECT id FROM platform_users WHERE id = $1`,
    [targetUserId]
  );
  if (!userCheck.rows[0]) {
    throw new NotFoundError("Target platform operator does not exist.");
  }

  // Prevent demoting the last owner of an organization
  if (input.role !== "owner") {
    const ownersRes = await pool.query<{ user_id: string }>(
      `SELECT user_id FROM platform_organization_members
       WHERE organization_id = $1 AND role = 'owner'`,
      [input.organizationId]
    );
    if (
      ownersRes.rows.length === 1 &&
      ownersRes.rows[0]!.user_id === targetUserId
    ) {
      throw new ValidationError(
        "Cannot demote the last owner of the organization."
      );
    }
  }

  await pool.query(
    `INSERT INTO platform_organization_members (organization_id, user_id, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (organization_id, user_id)
     DO UPDATE SET role = EXCLUDED.role`,
    [input.organizationId, targetUserId, input.role]
  );

  await recordAuditEvent({
    actorType: "user",
    actorId: input.actorId,
    action: "organization.member.upserted",
    resourceType: "organization",
    resourceId: input.organizationId,
    metadata: { targetUserId, role: input.role },
  });

  const members = await listOrganizationMembers(input.organizationId);
  return members.find((m) => m.user_id === targetUserId)!;
}

export async function removeOrganizationMember(input: {
  organizationId: string;
  targetUserId: string;
  actorId: string;
}): Promise<void> {
  const ownersRes = await pool.query<{ user_id: string }>(
    `SELECT user_id FROM platform_organization_members
     WHERE organization_id = $1 AND role = 'owner'`,
    [input.organizationId]
  );
  if (
    ownersRes.rows.length <= 1 &&
    ownersRes.rows.some((r) => r.user_id === input.targetUserId)
  ) {
    throw new ValidationError(
      "Cannot remove the sole owner of an organization."
    );
  }

  const res = await pool.query(
    `DELETE FROM platform_organization_members
     WHERE organization_id = $1 AND user_id = $2`,
    [input.organizationId, input.targetUserId]
  );
  if (!res.rowCount) {
    throw new NotFoundError("Organization member not found.");
  }

  await recordAuditEvent({
    actorType: "user",
    actorId: input.actorId,
    action: "organization.member.removed",
    resourceType: "organization",
    resourceId: input.organizationId,
    metadata: { targetUserId: input.targetUserId },
  });
}
