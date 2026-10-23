import { timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { pool, withTransaction, type DatabaseClient } from "../db/pool.js";
import {
  generateRandomToken,
  hashPassword,
  hashToken,
  signJwt,
  verifyPassword,
} from "../lib/crypto.js";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from "../lib/errors.js";
import { recordAuditEvent } from "./audit.service.js";

export interface PlatformUser {
  id: string;
  email: string;
  name: string;
  is_superadmin: boolean;
  status: "active" | "suspended" | "disabled";
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PlatformAuthResult {
  user: PlatformUser;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

const PLATFORM_ACCESS_TTL_SECONDS = 15 * 60; // 15 minutes
const PLATFORM_REFRESH_TTL_SECONDS = 3600 * 24 * 30; // 30 days
const dummyPasswordHash = hashPassword("nonexistent-platform-user-password");

function secretsEqual(candidate: string | undefined, expected: string): boolean {
  if (!candidate) return false;
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function lockPlatformBootstrap(client: DatabaseClient): Promise<void> {
  // Embedded PGlite serializes a client transaction with its in-process mutex.
  // External PostgreSQL needs a database-wide lock to prevent two simultaneous
  // first registrations from both receiving the superadmin role.
  if (!config.DATABASE_URL.startsWith("pglite://") && config.DATABASE_URL !== "memory://") {
    await client.query("SELECT pg_advisory_xact_lock(1346458194, 2)");
  }
}

export async function registerPlatformUser(input: {
  email: string;
  password: string;
  name?: string;
  ipAddress?: string;
  userAgent?: string;
  bootstrapToken?: string;
}): Promise<PlatformAuthResult> {
  const email = input.email.trim().toLowerCase();
  if (!email || !email.includes("@")) {
    throw new ValidationError("A valid email address is required.");
  }
  if (!input.password || input.password.length < 8) {
    throw new ValidationError("Password must be at least 8 characters long.");
  }

  const passwordHash = await hashPassword(input.password);
  const created = await withTransaction(async (client) => {
    await lockPlatformBootstrap(client);
    const existing = await client.query(
      "SELECT id FROM platform_users WHERE email = $1",
      [email]
    );
    if (existing.rowCount && existing.rowCount > 0) {
      throw new ConflictError("A platform account with this email already exists.");
    }

    const countRes = await client.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM platform_users"
    );
    const isFirstUser = Number(countRes.rows[0]?.count ?? 0) === 0;
    if (
      isFirstUser &&
      config.NODE_ENV === "production" &&
      secretsEqual(input.bootstrapToken, config.PLATFORM_BOOTSTRAP_TOKEN) === false
    ) {
      throw new ForbiddenError("A valid bootstrap token is required for initial platform setup.");
    }

    const insertRes = await client.query<PlatformUser>(
      `INSERT INTO platform_users (email, password_hash, name, is_superadmin, status, last_login_at)
       VALUES ($1, $2, $3, $4, 'active', now())
       RETURNING id, email, name, is_superadmin, status, last_login_at, created_at, updated_at`,
      [email, passwordHash, (input.name ?? "").trim() || email.split("@")[0]!, isFirstUser]
    );
    const user = insertRes.rows[0]!;
    const auth = await issuePlatformTokens(user, input.ipAddress, input.userAgent, client);
    return { user, auth };
  });

  await recordAuditEvent({
    actorType: "user",
    actorId: created.user.id,
    action: "platform.user.registered",
    resourceType: "platform_user",
    resourceId: created.user.id,
    metadata: { email: created.user.email, isSuperadmin: created.user.is_superadmin },
  });

  return created.auth;
}

export async function loginPlatformUser(input: {
  email: string;
  password: string;
  ipAddress?: string;
  userAgent?: string;
}): Promise<PlatformAuthResult> {
  const email = input.email.trim().toLowerCase();
  const res = await pool.query<PlatformUser & { password_hash: string }>(
    `SELECT id, email, password_hash, name, is_superadmin, status, last_login_at, created_at, updated_at
     FROM platform_users WHERE email = $1`,
    [email]
  );
  const row = res.rows[0];
  const passwordHash = row?.password_hash ?? await dummyPasswordHash;
  const valid = await verifyPassword(input.password, passwordHash);
  if (!row || !valid) {
    throw new UnauthorizedError("Invalid email or password.");
  }

  if (row.status !== "active") {
    throw new ForbiddenError(`Platform account is ${row.status}.`);
  }

  const updateRes = await pool.query<PlatformUser>(
    `UPDATE platform_users SET last_login_at = now(), updated_at = now()
     WHERE id = $1
     RETURNING id, email, name, is_superadmin, status, last_login_at, created_at, updated_at`,
    [row.id]
  );
  const user = updateRes.rows[0]!;

  await recordAuditEvent({
    actorType: "user",
    actorId: user.id,
    action: "platform.user.login",
    resourceType: "platform_user",
    resourceId: user.id,
    metadata: { email: user.email },
  });

  return issuePlatformTokens(user, input.ipAddress, input.userAgent);
}

async function issuePlatformTokens(
  user: PlatformUser,
  ipAddress?: string,
  userAgent?: string,
  client?: DatabaseClient
): Promise<PlatformAuthResult> {
  const rawRefreshToken = `mb_prt_${generateRandomToken(32)}`;
  const refreshHash = hashToken(rawRefreshToken);
  const expiresAt = new Date(
    Date.now() + PLATFORM_REFRESH_TTL_SECONDS * 1000
  ).toISOString();

  const sessionSql = `INSERT INTO platform_sessions (user_id, refresh_token_hash, user_agent, ip_address, expires_at)
    VALUES ($1, $2, $3, $4, $5) RETURNING id`;
  const sessionValues = [user.id, refreshHash, userAgent ?? null, ipAddress ?? null, expiresAt];
  const sessionRes = client
    ? await client.query<{ id: string }>(sessionSql, sessionValues)
    : await pool.query<{ id: string }>(sessionSql, sessionValues);

  const accessToken = signJwt(
    {
      sub: user.id,
      email: user.email,
      role: user.is_superadmin ? "platform_superadmin" : "platform_user",
      token_type: "platform_access",
      session_id: sessionRes.rows[0]!.id,
    },
    PLATFORM_ACCESS_TTL_SECONDS
  );

  return {
    user,
    accessToken,
    refreshToken: rawRefreshToken,
    expiresIn: PLATFORM_ACCESS_TTL_SECONDS,
  };
}

export async function refreshPlatformSession(
  rawRefreshToken: string,
  ipAddress?: string,
  userAgent?: string
): Promise<PlatformAuthResult> {
  const refreshHash = hashToken(rawRefreshToken);
  const outcome = await withTransaction(async (client) => {
    const sessionRes = await client.query<{
      id: string;
      user_id: string;
      revoked_at: string | null;
      expires_at: string;
    }>(
      `SELECT id, user_id, revoked_at, expires_at
       FROM platform_sessions
       WHERE refresh_token_hash = $1
       FOR UPDATE`,
      [refreshHash]
    );
    const session = sessionRes.rows[0];
    if (!session) return { kind: "invalid" as const };

    if (session.revoked_at) {
      // Reuse of a rotated refresh token is treated as possible credential theft.
      await client.query(
        "UPDATE platform_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL",
        [session.user_id]
      );
      return { kind: "replay" as const, userId: session.user_id };
    }
    if (new Date(session.expires_at).getTime() <= Date.now()) {
      return { kind: "expired" as const };
    }

    const userRes = await client.query<PlatformUser>(
      `SELECT id, email, name, is_superadmin, status, last_login_at, created_at, updated_at
       FROM platform_users WHERE id = $1 FOR UPDATE`,
      [session.user_id]
    );
    const user = userRes.rows[0];
    if (!user || user.status !== "active") {
      await client.query(
        "UPDATE platform_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL",
        [session.user_id]
      );
      return { kind: "inactive" as const, status: user?.status ?? "missing", userId: session.user_id };
    }

    await client.query(
      "UPDATE platform_sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL",
      [session.id]
    );
    const result = await issuePlatformTokens(user, ipAddress, userAgent, client);
    return { kind: "success" as const, result, userId: user.id };
  });

  if (outcome.kind === "invalid") {
    throw new UnauthorizedError("Invalid refresh token.");
  }
  if (outcome.kind === "expired") {
    throw new UnauthorizedError("Refresh token has expired.");
  }
  if (outcome.kind === "replay") {
    await recordAuditEvent({
      actorType: "user",
      actorId: outcome.userId,
      action: "platform.user.refresh_reuse_detected",
      resourceType: "platform_session",
      resourceId: outcome.userId,
    });
    throw new UnauthorizedError("Refresh token reuse detected; all active sessions were revoked.");
  }
  if (outcome.kind === "inactive") {
    throw new ForbiddenError(`Platform account is ${outcome.status}.`);
  }

  await recordAuditEvent({
    actorType: "user",
    actorId: outcome.userId,
    action: "platform.user.session_refreshed",
    resourceType: "platform_session",
    resourceId: outcome.userId,
  });
  return outcome.result;
}

export async function logoutPlatformSession(
  userId: string,
  sessionId?: string
): Promise<void> {
  if (sessionId) {
    await pool.query(
      "UPDATE platform_sessions SET revoked_at = now() WHERE id = $1 AND user_id = $2",
      [sessionId, userId]
    );
  } else {
    await pool.query(
      "UPDATE platform_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL",
      [userId]
    );
  }
}

export async function getPlatformUserById(userId: string): Promise<PlatformUser> {
  const res = await pool.query<PlatformUser>(
    `SELECT id, email, name, is_superadmin, status, last_login_at, created_at, updated_at
     FROM platform_users WHERE id = $1`,
    [userId]
  );
  const user = res.rows[0];
  if (!user) {
    throw new NotFoundError("Platform user not found.");
  }
  return user;
}

export async function listPlatformUsers(): Promise<PlatformUser[]> {
  const res = await pool.query<PlatformUser>(
    `SELECT id, email, name, is_superadmin, status, last_login_at, created_at, updated_at
     FROM platform_users ORDER BY created_at ASC`
  );
  return res.rows;
}
