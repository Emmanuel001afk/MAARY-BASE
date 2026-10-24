import type { FastifyInstance } from "fastify";
import {
  UnauthorizedError,
  ValidationError,
} from "../lib/errors.js";
import {
  requireProjectControlAccess,
  resolveProjectServiceAuth,
} from "../middleware/auth.middleware.js";
import {
  adminCreateProjectUser,
  adminDeleteProjectUser,
  adminListProjectSessions,
  adminRevokeProjectSession,
  adminUpdateProjectUser,
  createOAuthAuthorizationUrl,
  exchangeOAuthIdentity,
  getProjectAuthConfig,
  getProjectUserById,
  listProjectUsers,
  refreshProjectUserSession,
  requestPasswordRecovery,
  resetPasswordWithToken,
  signInProjectUserWithPassword,
  signOutProjectUser,
  signUpProjectUser,
  updateProjectAuthConfig,
  updateProjectUserProfile,
  verifyProjectUserEmail,
} from "../services/project-auth.service.js";

export async function registerProjectAuthRoutes(
  app: FastifyInstance
): Promise<void> {
  // Project Auth Policy Configuration
  app.get("/v1/projects/:projectRef/auth/config", async (request) => {
    const { projectRef } = request.params as { projectRef: string };
    const { project } = await requireProjectControlAccess(request, projectRef);
    const config = await getProjectAuthConfig(project.id);
    return { config };
  });

  app.patch("/v1/projects/:projectRef/auth/config", async (request) => {
    const { projectRef } = request.params as { projectRef: string };
    const { project, platformUser } = await requireProjectControlAccess(
      request,
      projectRef,
      ["owner", "admin"]
    );
    const body = (request.body ?? {}) as any;
    const config = await updateProjectAuthConfig(
      project.id,
      body,
      platformUser?.id ?? null
    );
    return { config };
  });

  // Public / Client Authentication Endpoints (require project apikey or bearer token)
  app.post(
    "/v1/projects/:projectRef/auth/signup",
    async (request, reply) => {
      const { projectRef } = request.params as { projectRef: string };
      const { project } = await resolveProjectServiceAuth(request, projectRef);
      const body = (request.body ?? {}) as {
        email?: string;
        password?: string;
        phone?: string;
        data?: Record<string, unknown>;
        user_metadata?: Record<string, unknown>;
      };
      if (!body.email || !body.password) {
        throw new ValidationError("Both 'email' and 'password' are required.");
      }
      const res = await signUpProjectUser(project, {
        email: body.email,
        password: body.password,
        phone: body.phone,
        userMetadata: body.user_metadata ?? body.data,
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"],
      });
      return reply.code(201).send(res);
    }
  );

  app.post("/v1/projects/:projectRef/auth/login", async (request) => {
    const { projectRef } = request.params as { projectRef: string };
    const { project } = await resolveProjectServiceAuth(request, projectRef);
    const body = (request.body ?? {}) as {
      email?: string;
      password?: string;
    };
    if (!body.email || !body.password) {
      throw new ValidationError("Both 'email' and 'password' are required.");
    }
    return signInProjectUserWithPassword(project, {
      email: body.email,
      password: body.password,
      ipAddress: request.ip,
      userAgent: request.headers["user-agent"],
    });
  });

  app.post("/v1/projects/:projectRef/auth/token", async (request) => {
    const { projectRef } = request.params as { projectRef: string };
    const { project } = await resolveProjectServiceAuth(request, projectRef);
    const q = (request.query ?? {}) as { grant_type?: string };
    const body = (request.body ?? {}) as {
      grant_type?: string;
      email?: string;
      password?: string;
      refresh_token?: string;
    };
    const grantType = q.grant_type ?? body.grant_type ?? "password";
    if (grantType === "password") {
      if (!body.email || !body.password) {
        throw new ValidationError("Both 'email' and 'password' are required.");
      }
      return signInProjectUserWithPassword(project, {
        email: body.email,
        password: body.password,
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"],
      });
    }
    if (grantType === "refresh_token") {
      if (!body.refresh_token) {
        throw new ValidationError("'refresh_token' is required.");
      }
      return refreshProjectUserSession(project, body.refresh_token, {
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"],
      });
    }
    throw new ValidationError(`Unsupported grant_type '${grantType}'.`);
  });

  app.post("/v1/projects/:projectRef/auth/refresh", async (request) => {
    const { projectRef } = request.params as { projectRef: string };
    const { project } = await resolveProjectServiceAuth(request, projectRef);
    const body = (request.body ?? {}) as {
      refresh_token?: string;
      refreshToken?: string;
    };
    const token = body.refresh_token ?? body.refreshToken;
    if (!token) {
      throw new ValidationError("refreshToken is required.");
    }
    return refreshProjectUserSession(project, token, {
      ipAddress: request.ip,
      userAgent: request.headers["user-agent"],
    });
  });

  app.post("/v1/projects/:projectRef/auth/logout", async (request) => {
    const { projectRef } = request.params as { projectRef: string };
    const { project, auth } = await resolveProjectServiceAuth(
      request,
      projectRef
    );
    if (!auth.userId) {
      throw new UnauthorizedError("Authenticated user token is required.");
    }
    const sessionId =
      typeof auth.claims?.session_id === "string"
        ? auth.claims.session_id
        : undefined;
    await signOutProjectUser(project.id, auth.userId, sessionId);
    return { status: "logged_out" };
  });

  app.post("/v1/projects/:projectRef/auth/verify", async (request) => {
    const { projectRef } = request.params as { projectRef: string };
    const { project } = await resolveProjectServiceAuth(request, projectRef, {
      allowAnonymousWithoutKey: true,
    });
    const body = (request.body ?? {}) as { token?: string };
    if (!body.token) {
      throw new ValidationError("Verification 'token' is required.");
    }
    const user = await verifyProjectUserEmail(project, body.token);
    return { user, verified: true };
  });

  app.post("/v1/projects/:projectRef/auth/recover", async (request) => {
    const { projectRef } = request.params as { projectRef: string };
    const { project } = await resolveProjectServiceAuth(request, projectRef);
    const body = (request.body ?? {}) as { email?: string };
    if (!body.email) {
      throw new ValidationError("'email' is required.");
    }
    return requestPasswordRecovery(project, body.email);
  });

  app.post("/v1/projects/:projectRef/auth/reset-password", async (request) => {
    const { projectRef } = request.params as { projectRef: string };
    const { project } = await resolveProjectServiceAuth(request, projectRef, {
      allowAnonymousWithoutKey: true,
    });
    const body = (request.body ?? {}) as {
      token?: string;
      password?: string;
    };
    if (!body.token || !body.password) {
      throw new ValidationError("Both 'token' and new 'password' are required.");
    }
    const user = await resetPasswordWithToken(
      project,
      body.token,
      body.password
    );
    return { user, passwordReset: true };
  });

  // OAuth Provider Flows
  app.get(
    "/v1/projects/:projectRef/auth/oauth/:provider/authorize",
    async (request) => {
      const { projectRef, provider } = request.params as {
        projectRef: string;
        provider: string;
      };
      const { project } = await resolveProjectServiceAuth(request, projectRef, {
        allowAnonymousWithoutKey: true,
      });
      const q = (request.query ?? {}) as { redirect_uri?: string };
      const redirectUri =
        q.redirect_uri ?? `http://localhost:3000/auth/callback`;
      return createOAuthAuthorizationUrl(project, provider, redirectUri);
    }
  );

  app.post(
    "/v1/projects/:projectRef/auth/oauth/:provider/callback",
    async (request) => {
      const { projectRef, provider } = request.params as {
        projectRef: string;
        provider: string;
      };
      const { project } = await resolveProjectServiceAuth(request, projectRef, {
        allowAnonymousWithoutKey: true,
      });
      const body = (request.body ?? {}) as {
        state?: string;
        providerUserId?: string;
        email?: string;
        userMetadata?: Record<string, unknown>;
      };
      if (!body.state || !body.providerUserId || !body.email) {
        throw new ValidationError(
          "'state', 'providerUserId', and 'email' are required."
        );
      }
      return exchangeOAuthIdentity(project, {
        provider,
        state: body.state,
        providerUserId: body.providerUserId,
        email: body.email,
        userMetadata: body.userMetadata,
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"],
      });
    }
  );

  // Authenticated User Self-Service
  app.get("/v1/projects/:projectRef/auth/user", async (request) => {
    const { projectRef } = request.params as { projectRef: string };
    const { project, auth } = await resolveProjectServiceAuth(
      request,
      projectRef
    );
    if (!auth.userId) {
      throw new UnauthorizedError("User Bearer token is required.");
    }
    const user = await getProjectUserById(project.id, auth.userId);
    return { user };
  });

  app.patch("/v1/projects/:projectRef/auth/user", async (request) => {
    const { projectRef } = request.params as { projectRef: string };
    const { project, auth } = await resolveProjectServiceAuth(
      request,
      projectRef
    );
    if (!auth.userId) {
      throw new UnauthorizedError("User Bearer token is required.");
    }
    const body = (request.body ?? {}) as {
      password?: string;
      phone?: string;
      data?: Record<string, unknown>;
      user_metadata?: Record<string, unknown>;
    };
    const user = await updateProjectUserProfile(project.id, auth.userId, {
      password: body.password,
      phone: body.phone,
      userMetadata: body.user_metadata ?? body.data,
    });
    return { user };
  });

  // Admin User Management
  app.get("/v1/projects/:projectRef/auth/admin/users", async (request) => {
    const { projectRef } = request.params as { projectRef: string };
    const { project } = await requireProjectControlAccess(request, projectRef);
    const q = (request.query ?? {}) as {
      search?: string;
      limit?: string;
      offset?: string;
    };
    return listProjectUsers(project.id, {
      search: q.search,
      limit: q.limit ? Number(q.limit) : 50,
      offset: q.offset ? Number(q.offset) : 0,
    });
  });

  app.post(
    "/v1/projects/:projectRef/auth/admin/users",
    async (request, reply) => {
      const { projectRef } = request.params as { projectRef: string };
      const { project, platformUser } = await requireProjectControlAccess(
        request,
        projectRef,
        ["owner", "admin", "developer"]
      );
      const body = (request.body ?? {}) as {
        email?: string;
        password?: string;
        emailVerified?: boolean;
        role?: string;
        userMetadata?: Record<string, unknown>;
        appMetadata?: Record<string, unknown>;
      };
      if (!body.email) {
        throw new ValidationError("'email' is required.");
      }
      const user = await adminCreateProjectUser(project, {
        ...body,
        email: body.email,
        actorId: platformUser?.id ?? null,
      });
      return reply.code(201).send({ user });
    }
  );

  app.get(
    "/v1/projects/:projectRef/auth/admin/users/:userId",
    async (request) => {
      const { projectRef, userId } = request.params as {
        projectRef: string;
        userId: string;
      };
      const { project } = await requireProjectControlAccess(
        request,
        projectRef
      );
      const user = await getProjectUserById(project.id, userId);
      return { user };
    }
  );

  app.patch(
    "/v1/projects/:projectRef/auth/admin/users/:userId",
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
      const body = (request.body ?? {}) as any;
      const user = await adminUpdateProjectUser(
        project.id,
        userId,
        body,
        platformUser?.id ?? null
      );
      return { user };
    }
  );

  app.delete(
    "/v1/projects/:projectRef/auth/admin/users/:userId",
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
      await adminDeleteProjectUser(
        project.id,
        userId,
        platformUser?.id ?? null
      );
      return { deleted: true, userId };
    }
  );

  app.get("/v1/projects/:projectRef/auth/admin/sessions", async (request) => {
    const { projectRef } = request.params as { projectRef: string };
    const { project } = await requireProjectControlAccess(request, projectRef);
    const q = (request.query ?? {}) as { limit?: string };
    const sessions = await adminListProjectSessions(
      project.id,
      q.limit ? Number(q.limit) : 100
    );
    return { sessions };
  });

  app.delete(
    "/v1/projects/:projectRef/auth/admin/sessions/:sessionId",
    async (request) => {
      const { projectRef, sessionId } = request.params as {
        projectRef: string;
        sessionId: string;
      };
      const { project, platformUser } = await requireProjectControlAccess(
        request,
        projectRef,
        ["owner", "admin"]
      );
      await adminRevokeProjectSession(
        project.id,
        sessionId,
        platformUser?.id ?? null
      );
      return { revoked: true, sessionId };
    }
  );
}
