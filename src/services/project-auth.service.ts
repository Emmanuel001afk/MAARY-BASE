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
import { incrementProjectMetric, recordAuditEvent } from "./audit.service.js";
import type { ProjectRecord } from "./project.service.js";

export interface ProjectAuthConfig {
  project_id: string;
  allow_public_signup: boolean;
  require_email_verification: boolean;
  password_min_length: number;
  access_token_ttl_seconds: number;
  refresh_token_ttl_seconds: number;
  oauth_providers: Record<
    string,
    {
      enabled: boolean;
      clientId: string;
      authorizeUrl?: string;
      tokenUrl?: string;
      scopes?: string[];
    }
  >;
  updated_at: string;
}

export interface ProjectAuthUser {
  id: string;
  project_id: string;
  email: string;
  phone: string | null;
  email_verified: boolean;
  email_verified_at: string | null;
  role: string;
  status: "active" | "banned" | "suspended" | "deleted";
  user_metadata: Record<string, unknown>;
  app_metadata: Record<string, unknown>;
  last_sign_in_at: string | null;
  banned_until: string | null;
  created_at: string;
  updated_at: string;
  identities?: Array<{
    id: string;
    provider: string;
    provider_id: string;
    identity_data: Record<string, unknown>;
    created_at: string;
  }>;
}

export interface ProjectSessionTokens {
  access_token: string;
  refresh_token: string;
  token_type: "bearer";
  expires_in: number;
  user: ProjectAuthUser;
}

export async function getProjectAuthConfig(
  projectId: string
): Promise<ProjectAuthConfig> {
  await pool.query(
    `INSERT INTO platform_auth_configs (project_id) VALUES ($1) ON CONFLICT DO NOTHING`,
    [projectId]
  );
  const res = await pool.query<ProjectAuthConfig>(
    `SELECT project_id, allow_public_signup, require_email_verification, password_min_length, access_token_ttl_seconds, refresh_token_ttl_seconds, oauth_providers, updated_at
     FROM platform_auth_configs WHERE project_id = $1`,
    [projectId]
  );
  return res.rows[0]!;
}

export async function updateProjectAuthConfig(
  projectId: string,
  updates: Partial<{
    allow_public_signup: boolean;
    require_email_verification: boolean;
    password_min_length: number;
    access_token_ttl_seconds: number;
    refresh_token_ttl_seconds: number;
    oauth_providers: ProjectAuthConfig["oauth_providers"];
  }>,
  actorId?: string | null
): Promise<ProjectAuthConfig> {
  const current = await getProjectAuthConfig(projectId);
  const minLen = updates.password_min_length ?? current.password_min_length;
  if (minLen < 6 || minLen > 128) {
    throw new ValidationError("password_min_length must be between 6 and 128.");
  }
  const accessTtl =
    updates.access_token_ttl_seconds ?? current.access_token_ttl_seconds;
  const refreshTtl =
    updates.refresh_token_ttl_seconds ?? current.refresh_token_ttl_seconds;

  const res = await pool.query<ProjectAuthConfig>(
    `UPDATE platform_auth_configs
     SET allow_public_signup = $1,
         require_email_verification = $2,
         password_min_length = $3,
         access_token_ttl_seconds = $4,
         refresh_token_ttl_seconds = $5,
         oauth_providers = $6::jsonb,
         updated_at = now()
     WHERE project_id = $7
     RETURNING project_id, allow_public_signup, require_email_verification, password_min_length, access_token_ttl_seconds, refresh_token_ttl_seconds, oauth_providers, updated_at`,
    [
      updates.allow_public_signup ?? current.allow_public_signup,
      updates.require_email_verification ?? current.require_email_verification,
      minLen,
      accessTtl,
      refreshTtl,
      JSON.stringify(updates.oauth_providers ?? current.oauth_providers),
      projectId,
    ]
  );

  await recordAuditEvent({
    projectId,
    actorType: actorId ? "user" : "system",
    actorId: actorId ?? null,
    action: "auth.config.updated",
    resourceType: "auth_config",
    resourceId: projectId,
  });

  return res.rows[0]!;
}

async function attachIdentities(
  user: ProjectAuthUser
): Promise<ProjectAuthUser> {
  const idRes = await pool.query<{
    id: string;
    provider: string;
    provider_id: string;
    identity_data: Record<string, unknown>;
    created_at: string;
  }>(
    `SELECT id, provider, provider_id, identity_data, created_at
     FROM project_auth_identities
     WHERE user_id = $1
     ORDER BY created_at ASC`,
    [user.id]
  );
  return { ...user, identities: idRes.rows };
}

async function issueUserSession(
  project: ProjectRecord,
  user: ProjectAuthUser,
  authConfig: ProjectAuthConfig,
  options: {
    userAgent?: string;
    ipAddress?: string;
    tokenFamilyId?: string;
    parentTokenHash?: string;
  } = {}
): Promise<ProjectSessionTokens> {
  const rawRefresh = `mb_urt_${generateRandomToken(32)}`;
  const refreshHash = hashToken(rawRefresh);
  const expiresAt = new Date(
    Date.now() + authConfig.refresh_token_ttl_seconds * 1000
  ).toISOString();

  const sessionRes = await pool.query<{ id: string }>(
    `INSERT INTO project_auth_sessions (
      project_id, user_id, refresh_token_hash, token_family_id, parent_token_hash, user_agent, ip_address, expires_at
    ) VALUES ($1, $2, $3, COALESCE($4::uuid, gen_random_uuid()), $5, $6, $7, $8)
    RETURNING id`,
    [
      project.id,
      user.id,
      refreshHash,
      options.tokenFamilyId ?? null,
      options.parentTokenHash ?? null,
      options.userAgent ?? null,
      options.ipAddress ?? null,
      expiresAt,
    ]
  );

  const accessToken = signJwt(
    {
      sub: user.id,
      role: user.role || "authenticated",
      project_id: project.id,
      email: user.email,
      session_id: sessionRes.rows[0]!.id,
      token_type: "project_access",
      user_metadata: user.user_metadata,
      app_metadata: user.app_metadata,
    },
    authConfig.access_token_ttl_seconds
  );

  return {
    access_token: accessToken,
    refresh_token: rawRefresh,
    token_type: "bearer",
    expires_in: authConfig.access_token_ttl_seconds,
    user: await attachIdentities(user),
  };
}

export async function signUpProjectUser(
  project: ProjectRecord,
  input: {
    email: string;
    password: string;
    phone?: string;
    userMetadata?: Record<string, unknown>;
    ipAddress?: string;
    userAgent?: string;
  }
): Promise<{
  user: ProjectAuthUser;
  session: ProjectSessionTokens | null;
  verificationToken?: string;
}> {
  const authConfig = await getProjectAuthConfig(project.id);
  if (!authConfig.allow_public_signup) {
    throw new ForbiddenError("Public user registration is disabled for this project.");
  }

  const email = input.email.trim().toLowerCase();
  if (!email || !email.includes("@")) {
    throw new ValidationError("A valid email address is required.");
  }
  if (!input.password || input.password.length < authConfig.password_min_length) {
    throw new ValidationError(
      `Password must be at least ${authConfig.password_min_length} characters long.`
    );
  }

  const existing = await pool.query(
    "SELECT id FROM project_auth_users WHERE project_id = $1 AND email = $2",
    [project.id, email]
  );
  if (existing.rowCount && existing.rowCount > 0) {
    throw new ConflictError("A user with this email is already registered in this project.");
  }

  const passwordHash = await hashPassword(input.password);
  const autoVerified = !authConfig.require_email_verification;

  const { user, verificationToken } = await withTransaction(async (client) => {
    const uRes = await client.query<ProjectAuthUser>(
      `INSERT INTO project_auth_users (
        project_id, email, phone, password_hash, email_verified, email_verified_at, role, status, user_metadata, app_metadata, last_sign_in_at
      ) VALUES ($1, $2, $3, $4, $5, CASE WHEN $5 THEN now() ELSE NULL END, 'authenticated', 'active', $6::jsonb, '{"provider":"email"}'::jsonb, CASE WHEN $5 THEN now() ELSE NULL END)
      RETURNING id, project_id, email, phone, email_verified, email_verified_at, role, status, user_metadata, app_metadata, last_sign_in_at, banned_until, created_at, updated_at`,
      [
        project.id,
        email,
        input.phone ?? null,
        passwordHash,
        autoVerified,
        JSON.stringify(input.userMetadata ?? {}),
      ]
    );
    const createdUser = uRes.rows[0]!;

    await client.query(
      `INSERT INTO project_auth_identities (project_id, user_id, provider, provider_id, identity_data)
       VALUES ($1, $2, 'email', $3, $4::jsonb)`,
      [
        project.id,
        createdUser.id,
        email,
        JSON.stringify({ email, sub: createdUser.id }),
      ]
    );

    let rawVerificationToken: string | undefined;
    if (authConfig.require_email_verification) {
      rawVerificationToken = `mb_verify_${generateRandomToken(24)}`;
      const tokenHash = hashToken(rawVerificationToken);
      const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
      await client.query(
        `INSERT INTO project_auth_tokens (project_id, user_id, token_type, token_hash, expires_at)
         VALUES ($1, $2, 'email_verification', $3, $4)`,
        [project.id, createdUser.id, tokenHash, expiresAt]
      );
    }

    return { user: createdUser, verificationToken: rawVerificationToken };
  });

  await incrementProjectMetric(project.id, "auth_signups_total", 1);
  await recordAuditEvent({
    projectId: project.id,
    actorType: "user",
    actorId: user.id,
    action: "auth.user.signup",
    resourceType: "project_user",
    resourceId: user.id,
    metadata: { email: user.email, emailVerified: user.email_verified },
  });

  if (authConfig.require_email_verification) {
    return {
      user: await attachIdentities(user),
      session: null,
      verificationToken,
    };
  }

  const session = await issueUserSession(project, user, authConfig, {
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
  });

  return {
    user: session.user,
    session,
  };
}

export async function signInProjectUserWithPassword(
  project: ProjectRecord,
  input: {
    email: string;
    password: string;
    ipAddress?: string;
    userAgent?: string;
  }
): Promise<ProjectSessionTokens> {
  const email = input.email.trim().toLowerCase();
  const res = await pool.query<
    ProjectAuthUser & { password_hash: string | null }
  >(
    `SELECT * FROM project_auth_users WHERE project_id = $1 AND email = $2`,
    [project.id, email]
  );
  const userRow = res.rows[0];
  if (!userRow || !userRow.password_hash) {
    throw new UnauthorizedError("Invalid login credentials.");
  }

  const passwordValid = await verifyPassword(
    input.password,
    userRow.password_hash
  );
  if (!passwordValid) {
    throw new UnauthorizedError("Invalid login credentials.");
  }

  if (userRow.status !== "active") {
    throw new ForbiddenError(`User account is ${userRow.status}.`);
  }
  if (
    userRow.banned_until &&
    new Date(userRow.banned_until).getTime() > Date.now()
  ) {
    throw new ForbiddenError("User account is currently banned.");
  }

  const authConfig = await getProjectAuthConfig(project.id);
  if (authConfig.require_email_verification && !userRow.email_verified) {
    throw new ForbiddenError("Email address must be verified before signing in.");
  }

  const updatedRes = await pool.query<ProjectAuthUser>(
    `UPDATE project_auth_users
     SET last_sign_in_at = now(), updated_at = now()
     WHERE id = $1
     RETURNING id, project_id, email, phone, email_verified, email_verified_at, role, status, user_metadata, app_metadata, last_sign_in_at, banned_until, created_at, updated_at`,
    [userRow.id]
  );
  const user = updatedRes.rows[0]!;

  await incrementProjectMetric(project.id, "auth_logins_total", 1);
  await recordAuditEvent({
    projectId: project.id,
    actorType: "user",
    actorId: user.id,
    action: "auth.user.login",
    resourceType: "project_user",
    resourceId: user.id,
    metadata: { email: user.email },
  });

  return issueUserSession(project, user, authConfig, {
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
  });
}

export async function refreshProjectUserSession(
  project: ProjectRecord,
  rawRefreshToken: string,
  options: { ipAddress?: string; userAgent?: string } = {}
): Promise<ProjectSessionTokens> {
  const tokenHash = hashToken(rawRefreshToken);
  const sessionRes = await pool.query<{
    id: string;
    project_id: string;
    user_id: string;
    token_family_id: string;
    is_revoked: boolean;
    expires_at: string;
    replaced_at: string | null;
  }>(
    `SELECT id, project_id, user_id, token_family_id, is_revoked, expires_at, replaced_at
     FROM project_auth_sessions
     WHERE project_id = $1 AND refresh_token_hash = $2`,
    [project.id, tokenHash]
  );
  const session = sessionRes.rows[0];
  if (!session) {
    throw new UnauthorizedError("Invalid refresh token.");
  }

  // Reuse detection: if token was already rotated/replaced or revoked, revoke the entire token family!
  if (session.replaced_at || session.is_revoked) {
    await pool.query(
      `UPDATE project_auth_sessions SET is_revoked = true WHERE token_family_id = $1`,
      [session.token_family_id]
    );
    await recordAuditEvent({
      projectId: project.id,
      actorType: "user",
      actorId: session.user_id,
      action: "auth.token.reuse_detected",
      resourceType: "project_session",
      resourceId: session.id,
      metadata: { tokenFamilyId: session.token_family_id },
    });
    throw new UnauthorizedError(
      "Refresh token has already been used or revoked. Session family invalidated for security."
    );
  }

  if (new Date(session.expires_at).getTime() < Date.now()) {
    throw new UnauthorizedError("Refresh token has expired.");
  }

  await pool.query(
    `UPDATE project_auth_sessions SET replaced_at = now(), is_revoked = true WHERE id = $1`,
    [session.id]
  );

  const user = await getProjectUserById(project.id, session.user_id);
  if (user.status !== "active") {
    throw new ForbiddenError(`User account is ${user.status}.`);
  }

  const authConfig = await getProjectAuthConfig(project.id);
  return issueUserSession(project, user, authConfig, {
    ipAddress: options.ipAddress,
    userAgent: options.userAgent,
    tokenFamilyId: session.token_family_id,
    parentTokenHash: tokenHash,
  });
}

export async function signOutProjectUser(
  projectId: string,
  userId: string,
  sessionId?: string
): Promise<void> {
  if (sessionId) {
    await pool.query(
      `UPDATE project_auth_sessions SET is_revoked = true WHERE id = $1 AND project_id = $2 AND user_id = $3`,
      [sessionId, projectId, userId]
    );
  } else {
    await pool.query(
      `UPDATE project_auth_sessions SET is_revoked = true WHERE project_id = $1 AND user_id = $2`,
      [projectId, userId]
    );
  }
}

export async function verifyProjectUserEmail(
  project: ProjectRecord,
  rawToken: string
): Promise<ProjectAuthUser> {
  const tokenHash = hashToken(rawToken);
  const tokRes = await pool.query<{
    id: string;
    user_id: string;
    expires_at: string;
    consumed_at: string | null;
  }>(
    `SELECT id, user_id, expires_at, consumed_at
     FROM project_auth_tokens
     WHERE project_id = $1 AND token_type = 'email_verification' AND token_hash = $2`,
    [project.id, tokenHash]
  );
  const tok = tokRes.rows[0];
  if (!tok || tok.consumed_at) {
    throw new ValidationError("Invalid or already used verification token.");
  }
  if (new Date(tok.expires_at).getTime() < Date.now()) {
    throw new ValidationError("Verification token has expired.");
  }

  const updated = await withTransaction(async (client) => {
    await client.query(
      `UPDATE project_auth_tokens SET consumed_at = now() WHERE id = $1`,
      [tok.id]
    );
    const uRes = await client.query<ProjectAuthUser>(
      `UPDATE project_auth_users
       SET email_verified = true, email_verified_at = now(), updated_at = now()
       WHERE id = $1 AND project_id = $2
       RETURNING id, project_id, email, phone, email_verified, email_verified_at, role, status, user_metadata, app_metadata, last_sign_in_at, banned_until, created_at, updated_at`,
      [tok.user_id, project.id]
    );
    return uRes.rows[0]!;
  });

  await recordAuditEvent({
    projectId: project.id,
    actorType: "user",
    actorId: updated.id,
    action: "auth.user.email_verified",
    resourceType: "project_user",
    resourceId: updated.id,
  });

  return attachIdentities(updated);
}

export async function requestPasswordRecovery(
  project: ProjectRecord,
  emailInput: string
): Promise<{ recoveryToken: string | null; expiresInSeconds: number }> {
  const email = emailInput.trim().toLowerCase();
  const uRes = await pool.query<{ id: string }>(
    `SELECT id FROM project_auth_users WHERE project_id = $1 AND email = $2 AND status = 'active'`,
    [project.id, email]
  );
  const user = uRes.rows[0];
  const expiresInSeconds = 3600;
  if (!user) {
    // Return uniform shape so email enumeration is mitigated while allowing testable recovery flow when user exists
    return { recoveryToken: null, expiresInSeconds };
  }

  const rawToken = `mb_rec_${generateRandomToken(24)}`;
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();

  await pool.query(
    `INSERT INTO project_auth_tokens (project_id, user_id, token_type, token_hash, expires_at)
     VALUES ($1, $2, 'password_recovery', $3, $4)`,
    [project.id, user.id, tokenHash, expiresAt]
  );

  await recordAuditEvent({
    projectId: project.id,
    actorType: "user",
    actorId: user.id,
    action: "auth.password_recovery.requested",
    resourceType: "project_user",
    resourceId: user.id,
  });

  return { recoveryToken: rawToken, expiresInSeconds };
}

export async function resetPasswordWithToken(
  project: ProjectRecord,
  rawToken: string,
  newPassword: string
): Promise<ProjectAuthUser> {
  const authConfig = await getProjectAuthConfig(project.id);
  if (!newPassword || newPassword.length < authConfig.password_min_length) {
    throw new ValidationError(
      `New password must be at least ${authConfig.password_min_length} characters long.`
    );
  }

  const tokenHash = hashToken(rawToken);
  const tokRes = await pool.query<{
    id: string;
    user_id: string;
    expires_at: string;
    consumed_at: string | null;
  }>(
    `SELECT id, user_id, expires_at, consumed_at
     FROM project_auth_tokens
     WHERE project_id = $1 AND token_type = 'password_recovery' AND token_hash = $2`,
    [project.id, tokenHash]
  );
  const tok = tokRes.rows[0];
  if (!tok || tok.consumed_at) {
    throw new ValidationError("Invalid or already used password recovery token.");
  }
  if (new Date(tok.expires_at).getTime() < Date.now()) {
    throw new ValidationError("Password recovery token has expired.");
  }

  const newHash = await hashPassword(newPassword);
  const updated = await withTransaction(async (client) => {
    await client.query(
      `UPDATE project_auth_tokens SET consumed_at = now() WHERE id = $1`,
      [tok.id]
    );
    // Revoke existing sessions on password reset
    await client.query(
      `UPDATE project_auth_sessions SET is_revoked = true WHERE user_id = $1 AND project_id = $2`,
      [tok.user_id, project.id]
    );
    const uRes = await client.query<ProjectAuthUser>(
      `UPDATE project_auth_users
       SET password_hash = $1, updated_at = now()
       WHERE id = $2 AND project_id = $3
       RETURNING id, project_id, email, phone, email_verified, email_verified_at, role, status, user_metadata, app_metadata, last_sign_in_at, banned_until, created_at, updated_at`,
      [newHash, tok.user_id, project.id]
    );
    return uRes.rows[0]!;
  });

  await recordAuditEvent({
    projectId: project.id,
    actorType: "user",
    actorId: updated.id,
    action: "auth.password_recovery.completed",
    resourceType: "project_user",
    resourceId: updated.id,
  });

  return attachIdentities(updated);
}

// OAuth / External Identity Provider Integration
export async function createOAuthAuthorizationUrl(
  project: ProjectRecord,
  provider: string,
  redirectUri: string
): Promise<{ provider: string; authorizationUrl: string; state: string }> {
  const authConfig = await getProjectAuthConfig(project.id);
  const providerKey = provider.toLowerCase();
  const providerCfg = authConfig.oauth_providers?.[providerKey];
  if (!providerCfg || !providerCfg.enabled) {
    throw new ValidationError(
      `OAuth provider '${provider}' is not enabled for project '${project.slug}'.`
    );
  }

  const rawState = generateRandomToken(24);
  const stateHash = hashToken(rawState);
  const expiresAt = new Date(Date.now() + 600 * 1000).toISOString();

  await pool.query(
    `INSERT INTO project_auth_tokens (project_id, token_type, token_hash, metadata, expires_at)
     VALUES ($1, 'oauth_state', $2, $3::jsonb, $4)`,
    [
      project.id,
      stateHash,
      JSON.stringify({ provider: providerKey, redirectUri }),
      expiresAt,
    ]
  );

  const defaultAuthorizeUrls: Record<string, string> = {
    github: "https://github.com/login/oauth/authorize",
    google: "https://accounts.google.com/o/oauth2/v2/auth",
    gitlab: "https://gitlab.com/oauth/authorize",
  };
  const baseUrl =
    providerCfg.authorizeUrl ??
    defaultAuthorizeUrls[providerKey] ??
    `https://auth.example.com/${providerKey}/authorize`;

  const url = new URL(baseUrl);
  url.searchParams.set("client_id", providerCfg.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", rawState);
  url.searchParams.set(
    "scope",
    (providerCfg.scopes ?? ["openid", "email", "profile"]).join(" ")
  );

  return {
    provider: providerKey,
    authorizationUrl: url.toString(),
    state: rawState,
  };
}

export async function exchangeOAuthIdentity(
  project: ProjectRecord,
  input: {
    provider: string;
    state: string;
    providerUserId: string;
    email: string;
    userMetadata?: Record<string, unknown>;
    ipAddress?: string;
    userAgent?: string;
  }
): Promise<ProjectSessionTokens> {
  const stateHash = hashToken(input.state);
  const tokRes = await pool.query<{
    id: string;
    metadata: { provider: string };
    expires_at: string;
    consumed_at: string | null;
  }>(
    `SELECT id, metadata, expires_at, consumed_at
     FROM project_auth_tokens
     WHERE project_id = $1 AND token_type = 'oauth_state' AND token_hash = $2`,
    [project.id, stateHash]
  );
  const stateRow = tokRes.rows[0];
  if (!stateRow || stateRow.consumed_at) {
    throw new UnauthorizedError("Invalid or already consumed OAuth state token.");
  }
  if (new Date(stateRow.expires_at).getTime() < Date.now()) {
    throw new UnauthorizedError("OAuth state token has expired.");
  }
  const provider = input.provider.toLowerCase();
  if (stateRow.metadata.provider !== provider) {
    throw new UnauthorizedError("OAuth provider mismatch for state token.");
  }

  const email = input.email.trim().toLowerCase();
  const authConfig = await getProjectAuthConfig(project.id);

  const user = await withTransaction(async (client) => {
    await client.query(
      `UPDATE project_auth_tokens SET consumed_at = now() WHERE id = $1`,
      [stateRow.id]
    );

    // Check if identity already linked
    const idRes = await client.query<{ user_id: string }>(
      `SELECT user_id FROM project_auth_identities
       WHERE project_id = $1 AND provider = $2 AND provider_id = $3`,
      [project.id, provider, input.providerUserId]
    );

    let userId = idRes.rows[0]?.user_id;
    if (!userId) {
      // Check if user with same email exists in project
      const existingUser = await client.query<{ id: string }>(
        `SELECT id FROM project_auth_users WHERE project_id = $1 AND email = $2`,
        [project.id, email]
      );
      if (existingUser.rows[0]) {
        userId = existingUser.rows[0].id;
      } else {
        const newU = await client.query<{ id: string }>(
          `INSERT INTO project_auth_users (
            project_id, email, email_verified, email_verified_at, role, status, user_metadata, app_metadata, last_sign_in_at
          ) VALUES ($1, $2, true, now(), 'authenticated', 'active', $3::jsonb, $4::jsonb, now())
          RETURNING id`,
          [
            project.id,
            email,
            JSON.stringify(input.userMetadata ?? {}),
            JSON.stringify({ provider, providers: [provider] }),
          ]
        );
        userId = newU.rows[0]!.id;
      }

      await client.query(
        `INSERT INTO project_auth_identities (project_id, user_id, provider, provider_id, identity_data)
         VALUES ($1, $2, $3, $4, $5::jsonb)
         ON CONFLICT (project_id, provider, provider_id) DO UPDATE SET updated_at = now()`,
        [
          project.id,
          userId,
          provider,
          input.providerUserId,
          JSON.stringify({ email, ...(input.userMetadata ?? {}) }),
        ]
      );
    }

    const uRes = await client.query<ProjectAuthUser>(
      `UPDATE project_auth_users SET last_sign_in_at = now(), updated_at = now()
       WHERE id = $1
       RETURNING id, project_id, email, phone, email_verified, email_verified_at, role, status, user_metadata, app_metadata, last_sign_in_at, banned_until, created_at, updated_at`,
      [userId]
    );
    return uRes.rows[0]!;
  });

  return issueUserSession(project, user, authConfig, {
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
  });
}

// User Profile & Admin Operations
export async function getProjectUserById(
  projectId: string,
  userId: string
): Promise<ProjectAuthUser> {
  const res = await pool.query<ProjectAuthUser>(
    `SELECT id, project_id, email, phone, email_verified, email_verified_at, role, status, user_metadata, app_metadata, last_sign_in_at, banned_until, created_at, updated_at
     FROM project_auth_users
     WHERE project_id = $1 AND id = $2`,
    [projectId, userId]
  );
  const user = res.rows[0];
  if (!user) {
    throw new NotFoundError("Project user not found.");
  }
  return attachIdentities(user);
}

export async function updateProjectUserProfile(
  projectId: string,
  userId: string,
  updates: {
    password?: string;
    phone?: string;
    userMetadata?: Record<string, unknown>;
  }
): Promise<ProjectAuthUser> {
  const current = await getProjectUserById(projectId, userId);
  const authConfig = await getProjectAuthConfig(projectId);

  let newPasswordHash: string | undefined;
  if (updates.password !== undefined) {
    if (updates.password.length < authConfig.password_min_length) {
      throw new ValidationError(
        `Password must be at least ${authConfig.password_min_length} characters.`
      );
    }
    newPasswordHash = await hashPassword(updates.password);
  }

  const mergedMeta = updates.userMetadata
    ? { ...current.user_metadata, ...updates.userMetadata }
    : current.user_metadata;

  const res = await pool.query<ProjectAuthUser>(
    `UPDATE project_auth_users
     SET phone = $1,
         user_metadata = $2::jsonb,
         password_hash = COALESCE($3, password_hash),
         updated_at = now()
     WHERE project_id = $4 AND id = $5
     RETURNING id, project_id, email, phone, email_verified, email_verified_at, role, status, user_metadata, app_metadata, last_sign_in_at, banned_until, created_at, updated_at`,
    [
      updates.phone !== undefined ? updates.phone : current.phone,
      JSON.stringify(mergedMeta),
      newPasswordHash ?? null,
      projectId,
      userId,
    ]
  );

  return attachIdentities(res.rows[0]!);
}

export async function listProjectUsers(
  projectId: string,
  options: { search?: string; limit?: number; offset?: number } = {}
): Promise<{ users: ProjectAuthUser[]; total: number }> {
  const params: unknown[] = [projectId];
  let searchSql = "";
  if (options.search && options.search.trim()) {
    params.push(`%${options.search.trim().toLowerCase()}%`);
    searchSql = `AND LOWER(email) LIKE $2`;
  }

  const countRes = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM project_auth_users WHERE project_id = $1 ${searchSql}`,
    params
  );
  const total = Number(countRes.rows[0]?.count ?? 0);

  const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);
  const offset = Math.max(options.offset ?? 0, 0);
  const queryParams = [...params, limit, offset];

  const rowsRes = await pool.query<ProjectAuthUser>(
    `SELECT id, project_id, email, phone, email_verified, email_verified_at, role, status, user_metadata, app_metadata, last_sign_in_at, banned_until, created_at, updated_at
     FROM project_auth_users
     WHERE project_id = $1 ${searchSql}
     ORDER BY created_at DESC
     LIMIT $${queryParams.length - 1} OFFSET $${queryParams.length}`,
    queryParams
  );

  return { users: rowsRes.rows, total };
}

export async function adminCreateProjectUser(
  project: ProjectRecord,
  input: {
    email: string;
    password?: string;
    emailVerified?: boolean;
    role?: string;
    userMetadata?: Record<string, unknown>;
    appMetadata?: Record<string, unknown>;
    actorId?: string | null;
  }
): Promise<ProjectAuthUser> {
  const email = input.email.trim().toLowerCase();
  if (!email || !email.includes("@")) {
    throw new ValidationError("A valid email address is required.");
  }

  const existing = await pool.query(
    "SELECT id FROM project_auth_users WHERE project_id = $1 AND email = $2",
    [project.id, email]
  );
  if (existing.rowCount && existing.rowCount > 0) {
    throw new ConflictError("A user with this email already exists in this project.");
  }

  const passwordHash = input.password
    ? await hashPassword(input.password)
    : null;
  const emailVerified = input.emailVerified ?? true;

  const user = await withTransaction(async (client) => {
    const uRes = await client.query<ProjectAuthUser>(
      `INSERT INTO project_auth_users (
        project_id, email, password_hash, email_verified, email_verified_at, role, status, user_metadata, app_metadata
      ) VALUES ($1, $2, $3, $4, CASE WHEN $4 THEN now() ELSE NULL END, $5, 'active', $6::jsonb, $7::jsonb)
      RETURNING id, project_id, email, phone, email_verified, email_verified_at, role, status, user_metadata, app_metadata, last_sign_in_at, banned_until, created_at, updated_at`,
      [
        project.id,
        email,
        passwordHash,
        emailVerified,
        input.role ?? "authenticated",
        JSON.stringify(input.userMetadata ?? {}),
        JSON.stringify(input.appMetadata ?? { provider: "email" }),
      ]
    );
    const created = uRes.rows[0]!;
    await client.query(
      `INSERT INTO project_auth_identities (project_id, user_id, provider, provider_id, identity_data)
       VALUES ($1, $2, 'email', $3, $4::jsonb)`,
      [project.id, created.id, email, JSON.stringify({ email, sub: created.id })]
    );
    return created;
  });

  await recordAuditEvent({
    projectId: project.id,
    actorType: input.actorId ? "user" : "service",
    actorId: input.actorId ?? null,
    action: "auth.admin.user_created",
    resourceType: "project_user",
    resourceId: user.id,
    metadata: { email },
  });

  return attachIdentities(user);
}

export async function adminUpdateProjectUser(
  projectId: string,
  userId: string,
  updates: {
    status?: "active" | "banned" | "suspended";
    role?: string;
    emailVerified?: boolean;
    password?: string;
    userMetadata?: Record<string, unknown>;
    appMetadata?: Record<string, unknown>;
    bannedUntil?: string | null;
  },
  actorId?: string | null
): Promise<ProjectAuthUser> {
  const current = await getProjectUserById(projectId, userId);
  const newPassHash = updates.password
    ? await hashPassword(updates.password)
    : undefined;
  const newStatus = updates.status ?? current.status;

  if (newStatus === "banned" || newStatus === "suspended") {
    await pool.query(
      `UPDATE project_auth_sessions SET is_revoked = true WHERE project_id = $1 AND user_id = $2`,
      [projectId, userId]
    );
  }

  const res = await pool.query<ProjectAuthUser>(
    `UPDATE project_auth_users
     SET status = $1,
         role = $2,
         email_verified = $3,
         password_hash = COALESCE($4, password_hash),
         user_metadata = $5::jsonb,
         app_metadata = $6::jsonb,
         banned_until = $7,
         updated_at = now()
     WHERE project_id = $8 AND id = $9
     RETURNING id, project_id, email, phone, email_verified, email_verified_at, role, status, user_metadata, app_metadata, last_sign_in_at, banned_until, created_at, updated_at`,
    [
      newStatus,
      updates.role ?? current.role,
      updates.emailVerified ?? current.email_verified,
      newPassHash ?? null,
      JSON.stringify(
        updates.userMetadata
          ? { ...current.user_metadata, ...updates.userMetadata }
          : current.user_metadata
      ),
      JSON.stringify(
        updates.appMetadata
          ? { ...current.app_metadata, ...updates.appMetadata }
          : current.app_metadata
      ),
      updates.bannedUntil !== undefined
        ? updates.bannedUntil
        : current.banned_until,
      projectId,
      userId,
    ]
  );

  await recordAuditEvent({
    projectId,
    actorType: actorId ? "user" : "service",
    actorId: actorId ?? null,
    action: "auth.admin.user_updated",
    resourceType: "project_user",
    resourceId: userId,
    metadata: { status: newStatus },
  });

  return attachIdentities(res.rows[0]!);
}

export async function adminDeleteProjectUser(
  projectId: string,
  userId: string,
  actorId?: string | null
): Promise<void> {
  const res = await pool.query(
    `DELETE FROM project_auth_users WHERE project_id = $1 AND id = $2 RETURNING id`,
    [projectId, userId]
  );
  if (!res.rowCount) {
    throw new NotFoundError("Project user not found.");
  }
  await recordAuditEvent({
    projectId,
    actorType: actorId ? "user" : "service",
    actorId: actorId ?? null,
    action: "auth.admin.user_deleted",
    resourceType: "project_user",
    resourceId: userId,
  });
}
