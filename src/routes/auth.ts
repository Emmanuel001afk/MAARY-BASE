import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { authenticate, httpError, requireUser } from "../security/auth.js";
import { createAccessToken, createRefreshToken, hashPassword, hashRefreshToken, refreshTokenLifetimeSeconds, verifyAccessToken, verifyPassword } from "../security/crypto.js";

const registerSchema = z.object({ email: z.string().trim().email().max(254), password: z.string().min(12).max(128), displayName: z.string().trim().min(1).max(80) }).strict();
const loginSchema = z.object({ email: z.string().trim().email().max(254), password: z.string().min(1).max(128) }).strict();
const refreshSchema = z.object({ refreshToken: z.string().min(32).max(256) }).strict();
const dummyPasswordHash = hashPassword("no-such-account-password");

async function createSession(userId: string) {
  const sessionId = randomUUID();
  const refreshToken = createRefreshToken();
  const expires = new Date(Date.now() + refreshTokenLifetimeSeconds * 1000);
  await pool.query("INSERT INTO platform_sessions (id, user_id, refresh_token_hash, expires_at) VALUES ($1, $2, $3, $4)", [sessionId, userId, hashRefreshToken(refreshToken), expires]);
  return { accessToken: createAccessToken(userId, sessionId), refreshToken, expiresAt: expires.toISOString(), tokenType: "Bearer", accessTokenExpiresIn: 900 };
}

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  app.post("/v1/auth/register", async (request, reply) => {
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) throw httpError(400, "Provide a valid email, a password of at least 12 characters, and a display name.");
    const email = parsed.data.email.toLowerCase();
    const passwordHash = await hashPassword(parsed.data.password);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query<{ id: string }>("INSERT INTO platform_users (email, password_hash, display_name) VALUES ($1, $2, $3) RETURNING id", [email, passwordHash, parsed.data.displayName]);
      const userId = inserted.rows[0]!.id;
      const sessionId = randomUUID();
      const refreshToken = createRefreshToken();
      const expires = new Date(Date.now() + refreshTokenLifetimeSeconds * 1000);
      await client.query("INSERT INTO platform_sessions (id, user_id, refresh_token_hash, expires_at) VALUES ($1, $2, $3, $4)", [sessionId, userId, hashRefreshToken(refreshToken), expires]);
      await client.query("INSERT INTO platform_audit_events (actor_type, actor_id, actor_user_id, action, resource_type, resource_id) VALUES ('user', $1, $2, 'user.registered', 'user', $1)", [userId, userId]);
      await client.query("COMMIT");
      return reply.code(201).send({ user: { id: userId, email, displayName: parsed.data.displayName, emailVerified: false }, session: { accessToken: createAccessToken(userId, sessionId), refreshToken, expiresAt: expires.toISOString(), tokenType: "Bearer", accessTokenExpiresIn: 900 } });
    } catch (error) {
      await client.query("ROLLBACK");
      if ((error as { code?: string }).code === "23505") throw httpError(409, "An account with this email already exists.");
      throw error;
    } finally {
      client.release();
    }
  });

  app.post("/v1/auth/login", async (request) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) throw httpError(400, "Provide a valid email and password.");
    const email = parsed.data.email.toLowerCase();
    const result = await pool.query<{ id: string; email: string; display_name: string; password_hash: string; disabled_at: Date | null; email_verified_at: Date | null }>("SELECT id, email, display_name, password_hash, disabled_at, email_verified_at FROM platform_users WHERE email = $1", [email]);
    const user = result.rows[0];
    const candidateHash = user?.password_hash ?? await dummyPasswordHash;
    if (!await verifyPassword(parsed.data.password, candidateHash) || !user || user.disabled_at) throw httpError(401, "Invalid email or password.");
    const session = await createSession(user.id);
    return { user: { id: user.id, email: user.email, displayName: user.display_name, emailVerified: Boolean(user.email_verified_at) }, session };
  });

  app.post("/v1/auth/refresh", async (request) => {
    const parsed = refreshSchema.safeParse(request.body);
    if (!parsed.success) throw httpError(400, "A valid refresh token is required.");
    const oldHash = hashRefreshToken(parsed.data.refreshToken);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ id: string; user_id: string; disabled_at: Date | null }>(
        `SELECT s.id, s.user_id, u.disabled_at FROM platform_sessions s
         JOIN platform_users u ON u.id = s.user_id
         WHERE s.refresh_token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
         FOR UPDATE OF s`, [oldHash]);
      const session = result.rows[0];
      if (!session || session.disabled_at) throw httpError(401, "Refresh token is invalid or expired.");
      const nextRefreshToken = createRefreshToken();
      const expires = new Date(Date.now() + refreshTokenLifetimeSeconds * 1000);
      await client.query("UPDATE platform_sessions SET refresh_token_hash = $1, expires_at = $2, last_used_at = now() WHERE id = $3", [hashRefreshToken(nextRefreshToken), expires, session.id]);
      await client.query("COMMIT");
      return { session: { accessToken: createAccessToken(session.user_id, session.id), refreshToken: nextRefreshToken, expiresAt: expires.toISOString(), tokenType: "Bearer", accessTokenExpiresIn: 900 } };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  app.post("/v1/auth/logout", async (request) => {
    const principal = await authenticate(request);
    if (principal.kind !== "user") throw httpError(403, "A user session is required.");
    const token = request.headers.authorization!.slice(7).trim();
    const claims = verifyAccessToken(token)!;
    await pool.query("UPDATE platform_sessions SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL", [claims.sid, principal.userId]);
    return { status: "signed_out" };
  });

  app.get("/v1/auth/me", async (request) => {
    const userId = await requireUser(request);
    const result = await pool.query<{ id: string; email: string; display_name: string; email_verified_at: Date | null; created_at: Date }>("SELECT id, email, display_name, email_verified_at, created_at FROM platform_users WHERE id = $1 AND disabled_at IS NULL", [userId]);
    const user = result.rows[0];
    if (!user) throw httpError(401, "Account is unavailable.");
    return { user: { id: user.id, email: user.email, displayName: user.display_name, emailVerified: Boolean(user.email_verified_at), createdAt: user.created_at } };
  });
}
