import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { pool } from "../db/pool.js";
import { verifyAccessToken } from "./crypto.js";

export type Principal =
  | { kind: "user"; userId: string }
  | { kind: "api_key"; keyId: string; projectId: string; role: "admin" | "developer" | "readonly" };

export function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

export async function authenticate(request: FastifyRequest): Promise<Principal> {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) throw httpError(401, "Authentication required.");
  const token = authorization.slice(7).trim();
  if (!token || token.length > 4096) throw httpError(401, "Invalid credentials.");

  if (token.startsWith("mb_live_")) {
    const separator = token.indexOf(".");
    if (separator < 0) throw httpError(401, "Invalid credentials.");
    const prefix = token.slice(0, separator);
    const secret = token.slice(separator + 1);
    const result = await pool.query<{ id: string; project_id: string; role: "admin" | "developer" | "readonly"; secret_hash: Buffer; expires_at: Date | null; revoked_at: Date | null }>(
      "SELECT id, project_id, role, secret_hash, expires_at, revoked_at FROM platform_api_keys WHERE key_prefix = $1",
      [prefix],
    );
    const key = result.rows[0];
    const candidate = createHash("sha256").update(secret).digest();
    if (!key || key.revoked_at || (key.expires_at && key.expires_at.getTime() <= Date.now()) || candidate.length !== key.secret_hash.length || !timingSafeEqual(candidate, key.secret_hash)) {
      throw httpError(401, "Invalid credentials.");
    }
    await pool.query("UPDATE platform_api_keys SET last_used_at = now() WHERE id = $1", [key.id]);
    return { kind: "api_key", keyId: key.id, projectId: key.project_id, role: key.role };
  }

  const claims = verifyAccessToken(token);
  if (!claims) throw httpError(401, "Invalid or expired access token.");
  const session = await pool.query(
    `SELECT 1 FROM platform_sessions s
     JOIN platform_users u ON u.id = s.user_id
     WHERE s.id = $1 AND s.user_id = $2 AND s.revoked_at IS NULL
       AND s.expires_at > now() AND u.disabled_at IS NULL`,
    [claims.sid, claims.sub],
  );
  if (!session.rowCount) throw httpError(401, "Session is no longer active.");
  return { kind: "user", userId: claims.sub };
}

export async function requireUser(request: FastifyRequest): Promise<string> {
  const principal = await authenticate(request);
  if (principal.kind !== "user") throw httpError(403, "A user session is required for this operation.");
  return principal.userId;
}

const roleRank: Record<string, number> = { readonly: 0, developer: 1, admin: 2, owner: 3 };

export async function requireProjectRole(request: FastifyRequest, projectId: string, minimum: "readonly" | "developer" | "admin"): Promise<Principal> {
  const principal = await authenticate(request);
  let role: string | undefined;
  if (principal.kind === "api_key") {
    if (principal.projectId !== projectId) throw httpError(404, "Project not found.");
    role = principal.role;
  } else {
    const result = await pool.query<{ role: string }>("SELECT role FROM platform_project_members WHERE project_id = $1 AND user_id = $2", [projectId, principal.userId]);
    role = result.rows[0]?.role;
  }
  if (!role) throw httpError(404, "Project not found.");
  const project = await pool.query("SELECT 1 FROM platform_projects WHERE id = $1 AND status = 'active'", [projectId]);
  if (!project.rowCount) throw httpError(404, "Project not found.");
  if ((roleRank[role] ?? -1) < roleRank[minimum]!) throw httpError(403, "Insufficient project permissions.");
  return principal;
}
