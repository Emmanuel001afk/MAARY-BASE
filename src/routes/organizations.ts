import type { FastifyInstance } from "fastify";
import { ValidationError } from "../lib/errors.js";
import { requirePlatformUser } from "../middleware/auth.middleware.js";
import {
  createOrganization,
  deleteOrganization,
  listOrganizationMembers,
  listOrganizationsForUser,
  type OrganizationRecord,
  type OrganizationRole,
  removeOrganizationMember,
  requireOrganizationAccess,
  updateOrganization,
  upsertOrganizationMember,
} from "../services/organization.service.js";
import { listProjectsForUser } from "../services/project.service.js";

export async function registerOrganizationRoutes(
  app: FastifyInstance
): Promise<void> {
  app.get("/v1/organizations", async (request) => {
    const user = await requirePlatformUser(request);
    const organizations = await listOrganizationsForUser(user);
    return { organizations };
  });

  app.post("/v1/organizations", async (request, reply) => {
    const user = await requirePlatformUser(request);
    const body = (request.body ?? {}) as {
      name?: string;
      slug?: string;
      description?: string;
      billingTier?: OrganizationRecord["billing_tier"];
      settings?: Record<string, unknown>;
    };
    if (!body.name) {
      throw new ValidationError("Organization 'name' is required.");
    }
    const organization = await createOrganization({
      name: body.name,
      slug: body.slug,
      description: body.description,
      billingTier: body.billingTier,
      settings: body.settings,
      ownerId: user.id,
    });
    return reply.code(201).send({ organization });
  });

  app.get("/v1/organizations/:orgRef", async (request) => {
    const { orgRef } = request.params as { orgRef: string };
    const user = await requirePlatformUser(request);
    const { organization, role } = await requireOrganizationAccess(
      orgRef,
      user
    );
    const [members, projects] = await Promise.all([
      listOrganizationMembers(organization.id),
      listProjectsForUser(user, { organizationId: organization.id }),
    ]);
    return { organization, memberRole: role, members, projects };
  });

  app.patch("/v1/organizations/:orgRef", async (request) => {
    const { orgRef } = request.params as { orgRef: string };
    const user = await requirePlatformUser(request);
    const { organization } = await requireOrganizationAccess(orgRef, user, [
      "owner",
      "admin",
    ]);
    const body = (request.body ?? {}) as {
      name?: string;
      description?: string;
      billingTier?: OrganizationRecord["billing_tier"];
      settings?: Record<string, unknown>;
    };
    const updated = await updateOrganization(organization.id, body, user.id);
    return { organization: updated };
  });

  app.delete("/v1/organizations/:orgRef", async (request) => {
    const { orgRef } = request.params as { orgRef: string };
    const user = await requirePlatformUser(request);
    const { organization } = await requireOrganizationAccess(orgRef, user, [
      "owner",
    ]);
    const q = (request.query ?? {}) as { confirmSlug?: string };
    const body = (request.body ?? {}) as { confirmSlug?: string };
    await deleteOrganization(
      organization,
      body.confirmSlug ?? q.confirmSlug,
      user.id
    );
    return { deleted: true, slug: organization.slug };
  });

  app.get("/v1/organizations/:orgRef/members", async (request) => {
    const { orgRef } = request.params as { orgRef: string };
    const user = await requirePlatformUser(request);
    const { organization } = await requireOrganizationAccess(orgRef, user);
    const members = await listOrganizationMembers(organization.id);
    return { members };
  });

  app.post("/v1/organizations/:orgRef/members", async (request, reply) => {
    const { orgRef } = request.params as { orgRef: string };
    const user = await requirePlatformUser(request);
    const { organization } = await requireOrganizationAccess(orgRef, user, [
      "owner",
      "admin",
    ]);
    const body = (request.body ?? {}) as {
      userId?: string;
      email?: string;
      role?: OrganizationRole;
    };
    if (!body.role) {
      throw new ValidationError("Member 'role' is required.");
    }
    const member = await upsertOrganizationMember({
      organizationId: organization.id,
      userId: body.userId,
      email: body.email,
      role: body.role,
      actorId: user.id,
    });
    return reply.code(201).send({ member });
  });

  app.delete(
    "/v1/organizations/:orgRef/members/:userId",
    async (request) => {
      const { orgRef, userId } = request.params as {
        orgRef: string;
        userId: string;
      };
      const user = await requirePlatformUser(request);
      const { organization } = await requireOrganizationAccess(orgRef, user, [
        "owner",
        "admin",
      ]);
      await removeOrganizationMember({
        organizationId: organization.id,
        targetUserId: userId,
        actorId: user.id,
      });
      return { removed: true };
    }
  );

  app.get("/v1/organizations/:orgRef/projects", async (request) => {
    const { orgRef } = request.params as { orgRef: string };
    const user = await requirePlatformUser(request);
    const { organization } = await requireOrganizationAccess(orgRef, user);
    const projects = await listProjectsForUser(user, {
      organizationId: organization.id,
    });
    return { projects };
  });
}
