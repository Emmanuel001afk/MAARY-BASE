import type { FastifyRequest } from "fastify";
import { pool } from "../db/pool.js";
import { verifyJwt } from "../lib/crypto.js";
import {
  ForbiddenError,
  UnauthorizedError,
} from "../lib/errors.js";
import type { DataAuthContext } from "../services/data-api.service.js";
import {
  getPlatformUserById,
  type PlatformUser,
} from "../services/platform-auth.service.js";
import {
  assertProjectRole,
  getProjectByRef,
  getUserProjectRole,
  type ProjectRecord,
  type ProjectRole,
  verifyProjectApiKey,
} from "../services/project.service.js";

export interface ResolvedProjectAccess {
  project: ProjectRecord;
  auth: DataAuthContext;
  scopes: string[];
  platformUser?: PlatformUser;
  hasValidCredentials: boolean;
}

function parseCookieValue(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    if (key === name) {
      try {
        return decodeURIComponent(part.slice(idx + 1).trim());
      } catch {
        return part.slice(idx + 1).trim();
      }
    }
  }
  return null;
}

function extractBearerToken(req: FastifyRequest): string | null {
  const authHeader = req.headers.authorization;
  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7).trim();
  }
  const platformToken = req.headers["x-platform-token"];
  if (typeof platformToken === "string" && platformToken.trim()) {
    return platformToken.trim();
  }
  const cookieToken = parseCookieValue(req.headers.cookie, "maary_platform_token");
  if (cookieToken && cookieToken.trim()) {
    return cookieToken.trim();
  }
  return null;
}

function extractRawApiKey(req: FastifyRequest): string | null {
  const headerKey = req.headers["apikey"] ?? req.headers["x-api-key"];
  if (typeof headerKey === "string" && headerKey.trim()) {
    return headerKey.trim();
  }
  const query = req.query as Record<string, unknown> | undefined;
  if (query && typeof query.apikey === "string" && query.apikey.trim()) {
    return query.apikey.trim();
  }
  const bearer = extractBearerToken(req);
  if (bearer && bearer.startsWith("mb_")) {
    return bearer;
  }
  return null;
}

export async function requirePlatformUser(
  req: FastifyRequest
): Promise<PlatformUser> {
  const token = extractBearerToken(req);
  if (!token || token.startsWith("mb_")) {
    throw new UnauthorizedError("Platform administrator Bearer token is required.");
  }

  const claims = verifyJwt(token);
  if (claims.token_type !== "platform_access") {
    throw new ForbiddenError("Token is not a valid platform control-plane token.");
  }

  if (claims.session_id) {
    const sess = await pool.query<{ revoked_at: string | null }>(
      `SELECT revoked_at FROM platform_sessions WHERE id = $1`,
      [claims.session_id]
    );
    if (!sess.rows[0] || sess.rows[0].revoked_at) {
      throw new UnauthorizedError("Platform session has been revoked.");
    }
  }

  const user = await getPlatformUserById(claims.sub);
  if (user.status !== "active") {
    throw new ForbiddenError(`Platform account is ${user.status}.`);
  }
  return user;
}

export async function requireSuperadmin(
  req: FastifyRequest
): Promise<PlatformUser> {
  const user = await requirePlatformUser(req);
  if (!user.is_superadmin) {
    throw new ForbiddenError(
      "Platform superadmin privileges are required for this operation."
    );
  }
  return user;
}

export function extractPlatformSessionId(req: FastifyRequest): string | undefined {
  const token = extractBearerToken(req);
  if (!token || token.startsWith("mb_")) return undefined;
  try {
    const claims = verifyJwt(token);
    return typeof claims.session_id === "string" ? claims.session_id : undefined;
  } catch {
    return undefined;
  }
}

export async function optionalPlatformUser(
  req: FastifyRequest
): Promise<PlatformUser | null> {
  try {
    return await requirePlatformUser(req);
  } catch {
    return null;
  }
}

export async function requireProjectControlAccess(
  req: FastifyRequest,
  projectRef: string,
  allowedRoles: ProjectRole[] = ["owner", "admin", "developer", "viewer"]
): Promise<{
  project: ProjectRecord;
  platformUser?: PlatformUser;
  memberRole: ProjectRole;
}> {
  const project = await getProjectByRef(projectRef);

  // Check if authenticated via service_role API key for this specific project
  const rawApiKey = extractRawApiKey(req);
  if (rawApiKey) {
    const { apiKey } = await verifyProjectApiKey(rawApiKey);
    if (apiKey.project_id !== project.id) {
      throw new ForbiddenError(
        "Cross-project access denied: API key does not belong to this project."
      );
    }
    if (apiKey.role === "service_role") {
      return { project, memberRole: "admin" };
    }
    throw new ForbiddenError(
      "Control-plane operations require a platform account or project service_role key."
    );
  }

  const user = await requirePlatformUser(req);
  const memberRole = await assertProjectRole(project.id, user, allowedRoles);
  return { project, platformUser: user, memberRole };
}

export async function resolveProjectServiceAuth(
  req: FastifyRequest,
  projectRef: string,
  options: {
    requiredScope?: string;
    allowAnonymousWithoutKey?: boolean;
  } = {}
): Promise<ResolvedProjectAccess> {
  const project = await getProjectByRef(projectRef);
  if (project.status !== "active") {
    throw new ForbiddenError(
      `Project '${project.slug}' is currently ${project.status}.`
    );
  }

  const rawApiKey = extractRawApiKey(req);
  const bearerToken = extractBearerToken(req);
  const jwtToken =
    bearerToken && !bearerToken.startsWith("mb_") ? bearerToken : null;

  let role: "anon" | "authenticated" | "service_role" = "anon";
  let scopes: string[] = [];
  let userId: string | null = null;
  let email: string | null = null;
  let claims: Record<string, unknown> | undefined;
  let platformUser: PlatformUser | undefined;
  let hasValidCredentials = false;

  if (rawApiKey) {
    const { apiKey } = await verifyProjectApiKey(rawApiKey);
    if (apiKey.project_id !== project.id) {
      throw new ForbiddenError(
        "Cross-project access denied: API key does not belong to this project."
      );
    }
    hasValidCredentials = true;
    scopes = Array.isArray(apiKey.scopes) ? apiKey.scopes : [];
    if (apiKey.role === "service_role") {
      role = "service_role";
    } else if (apiKey.role === "authenticated") {
      role = "authenticated";
    } else {
      role = "anon";
    }
  }

  if (jwtToken) {
    const verified = verifyJwt(jwtToken);
    if (verified.token_type === "platform_access") {
      const pUser = await getPlatformUserById(verified.sub);
      if (pUser.status !== "active") {
        throw new ForbiddenError("Platform account is inactive.");
      }
      const memberRole = await getUserProjectRole(project.id, pUser);
      if (!memberRole) {
        throw new ForbiddenError(
          "Cross-project access denied: user is not a member of this project."
        );
      }
      platformUser = pUser;
      role = memberRole === "viewer" ? "authenticated" : "service_role";
      scopes =
        memberRole === "viewer"
          ? ["db:read", "auth:read", "storage:read", "functions:invoke", "realtime:subscribe"]
          : ["*"];
      userId = pUser.id;
      email = pUser.email;
      claims = verified;
      hasValidCredentials = true;
    } else if (verified.token_type === "project_access") {
      if (verified.project_id !== project.id) {
        throw new ForbiddenError(
          "Cross-project access denied: access token belongs to a different project."
        );
      }
      if (verified.session_id) {
        const sessRes = await pool.query<{ is_revoked: boolean }>(
          `SELECT is_revoked FROM project_auth_sessions WHERE id = $1 AND project_id = $2`,
          [verified.session_id, project.id]
        );
        if (!sessRes.rows[0] || sessRes.rows[0].is_revoked) {
          throw new UnauthorizedError("User session has been revoked.");
        }
      }
      const uRes = await pool.query<{ status: string; email: string }>(
        `SELECT status, email FROM project_auth_users WHERE id = $1 AND project_id = $2`,
        [verified.sub, project.id]
      );
      if (!uRes.rows[0] || uRes.rows[0].status !== "active") {
        throw new ForbiddenError("User account is not active.");
      }

      role = "authenticated";
      userId = verified.sub;
      email = verified.email ?? uRes.rows[0].email;
      claims = verified;
      hasValidCredentials = true;
      if (scopes.length === 0) {
        scopes = [
          "db:read",
          "db:write",
          "auth:user",
          "storage:read",
          "storage:write",
          "realtime:subscribe",
          "functions:invoke",
        ];
      }
    } else {
      throw new UnauthorizedError("Unsupported JWT token type.");
    }
  }

  if (!hasValidCredentials && !options.allowAnonymousWithoutKey) {
    throw new UnauthorizedError(
      "Authentication required: provide a project API key ('apikey' header) or Bearer token."
    );
  }

  if (
    hasValidCredentials &&
    options.requiredScope &&
    !scopes.includes("*") &&
    !scopes.includes(options.requiredScope)
  ) {
    throw new ForbiddenError(
      `Insufficient credential scope: '${options.requiredScope}' is required.`
    );
  }

  return {
    project,
    auth: {
      role,
      userId,
      email,
      claims,
    },
    scopes,
    platformUser,
    hasValidCredentials,
  };
}
