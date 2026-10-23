import { pool, withTransaction } from "../db/pool.js";
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

const PLATFORM_ACCESS_TTL_SECONDS = 3600 * 8; // 8 hours
const PLATFORM_REFRESH_TTL_SECONDS = 3600 * 24 * 30; // 30 days

export async function registerPlatformUser(input: {
  email: string;
  password: string;
  name?: string;
  ipAddress?: string;
  userAgent?: string;
}): Promise<PlatformAuthResult> {
  const email = input.email.trim().toLowerCase();
  if (!email || !email.includes("@")) {
    throw new ValidationError("A valid email address is required.");
  }
  if (!input.password || input.password.length < 8) {
    throw new ValidationError("Password must be at least 8 characters long.");
  }

  const passwordHash = await hashPassword(input.password);

  // Serialize first-account bootstrap across concurrent registrations. The lock
  // and insert share one transaction so only one account can become superadmin.
  const user = await withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock($1, $2)", [1977001, 1]);

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

    const insertRes = await client.query<PlatformUser>(
      `INSERT INTO platform_users (email, password_hash, name, is_superadmin, status, last_login_at)
       VALUES ($1, $2, $3, $4, 'active', now())
       RETURNING id, email, name, is_superadmin, status, last_login_at, created_at, updated_at`,
      [email, passwordHash, (input.name ?? "").trim() || email.split("@")[0]!, isFirstUser]
    );
    return insertRes.rows[0]!;
  });

  await recordAuditEvent({
    actorType: "user",
    actorId: user.id,
    action: "platform.user.registered",
    resourceType: "platform_user",
    resourceId: user.id,
    metadata: { email: user.email, isSuperadmin: user.is_superadmin },
  });

  return issuePlatformTokens(user, input.ipAddress, input.userAgent);
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
  if (!row) {
    throw new UnauthorizedError("Invalid email or password.");
  }

  const valid = await verifyPassword(input.password, row.password_hash);
  if (!valid) {
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
  userAgent?: string
): Promise<PlatformAuthResult> {
  const rawRefreshToken = `mb_prt_${generateRandomToken(32)}`;
  const refreshHash = hashToken(rawRefreshToken);
  const expiresAt = new Date(
    Date.now() + PLATFORM_REFRESH_TTL_SECONDS * 1000
  ).toISOString();

  const sessionRes = await pool.query<{ id: string }>(
    `INSERT INTO platform_sessions (user_id, refresh_token_hash, user_agent, ip_address, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [user.id, refreshHash, userAgent ?? null, ipAddress ?? null, expiresAt]
  );

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
  const sessionRes = await pool.query<{
    id: string;
    user_id: string;
    revoked_at: string | null;
    expires_at: string;
  }>(
    `SELECT id, user_id, revoked_at, expires_at
     FROM platform_sessions
     WHERE refresh_token_hash = $1`,
    [refreshHash]
  );
  const session = sessionRes.rows[0];
  if (!session) {
    throw new UnauthorizedError("Invalid refresh token.");
  }
  if (session.revoked_at) {
    // Revoke all user sessions on replay of revoked token
    await pool.query(
      "UPDATE platform_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL",
      [session.user_id]
    );
    throw new UnauthorizedError("Refresh token has already been revoked.");
  }
  if (new Date(session.expires_at).getTime() < Date.now()) {
    throw new UnauthorizedError("Refresh token has expired.");
  }

  // Rotate refresh token
  await pool.query(
    "UPDATE platform_sessions SET revoked_at = now() WHERE id = $1",
    [session.id]
  );

  const user = await getPlatformUserById(session.user_id);
  if (user.status !== "active") {
    throw new ForbiddenError(`Platform account is ${user.status}.`);
  }

  return issuePlatformTokens(user, ipAddress, userAgent);
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
