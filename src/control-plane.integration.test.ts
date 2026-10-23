import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const testDatabaseUrl = process.env.MAARY_TEST_DATABASE_URL;
if (testDatabaseUrl) {
  process.env.DATABASE_URL = testDatabaseUrl;
  process.env.TOKEN_SECRET ??= "integration-test-secret-not-for-deployment";
}
const { buildApp } = await import("./app.js");
const { pool } = await import("./db/pool.js");

async function applyMigrations(): Promise<void> {
  const directory = fileURLToPath(new URL("./db/migrations/", import.meta.url));
  const files = (await readdir(directory)).filter(file => file.endsWith(".sql")).sort();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(1346458194, 1)");
    await client.query("CREATE TABLE IF NOT EXISTS platform_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    for (const file of files) {
      const existing = await client.query("SELECT 1 FROM platform_migrations WHERE name = $1", [file]);
      if (existing.rowCount) continue;
      await client.query(await readFile(join(directory, file), "utf8"));
      await client.query("INSERT INTO platform_migrations (name) VALUES ($1)", [file]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

test("PostgreSQL control-plane workflow enforces sessions, project isolation, and key revocation", { skip: !testDatabaseUrl && "Set MAARY_TEST_DATABASE_URL to a dedicated PostgreSQL test database." }, async () => {
  await applyMigrations();
  const app = await buildApp();
  const suffix = randomUUID();
  const emails = [`owner-${suffix}@example.test`, `other-${suffix}@example.test`];
  const projectIds: string[] = [];
  const schemas: string[] = [];
  const userIds: string[] = [];
  try {
    const register = async (email: string, displayName: string) => {
      const response = await app.inject({ method: "POST", url: "/v1/auth/register", payload: { email, password: "valid-test-password-123", displayName } });
      assert.equal(response.statusCode, 201, response.body);
      const body = response.json();
      userIds.push(body.user.id);
      return body as { user: { id: string }; session: { accessToken: string; refreshToken: string } };
    };
    const owner = await register(emails[0]!, "Test Owner");
    const other = await register(emails[1]!, "Other User");

    const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: emails[0], password: "valid-test-password-123" } });
    assert.equal(login.statusCode, 200, login.body);
    const rotated = await app.inject({ method: "POST", url: "/v1/auth/refresh", payload: { refreshToken: owner.session.refreshToken } });
    assert.equal(rotated.statusCode, 200, rotated.body);
    const refreshBody = rotated.json() as { session: { accessToken: string; refreshToken: string } };
    const replay = await app.inject({ method: "POST", url: "/v1/auth/refresh", payload: { refreshToken: owner.session.refreshToken } });
    assert.equal(replay.statusCode, 401);

    const createProject = async (token: string, slug: string) => {
      const response = await app.inject({ method: "POST", url: "/v1/projects", headers: { authorization: `Bearer ${token}` }, payload: { name: `Project ${slug}`, slug } });
      assert.equal(response.statusCode, 201, response.body);
      const body = response.json() as { project: { id: string }; environments: Array<{ id: string; name: string }> };
      projectIds.push(body.project.id);
      const env = await pool.query<{ database_schema: string }>("SELECT database_schema FROM platform_environments WHERE project_id = $1", [body.project.id]);
      schemas.push(env.rows[0]!.database_schema);
      assert.equal(body.environments[0]?.name, "development");
      return body.project.id;
    };
    const ownedProject = await createProject(owner.session.accessToken, `test-${suffix.replaceAll("-", "").slice(0, 12)}`);
    const otherProject = await createProject(other.session.accessToken, `other-${suffix.replaceAll("-", "").slice(0, 12)}`);
    const forbidden = await app.inject({ method: "GET", url: `/v1/projects/${ownedProject}`, headers: { authorization: `Bearer ${other.session.accessToken}` } });
    assert.equal(forbidden.statusCode, 404);
    const addMember = await app.inject({ method: "POST", url: `/v1/projects/${ownedProject}/members`, headers: { authorization: `Bearer ${owner.session.accessToken}` }, payload: { email: emails[1], role: "readonly" } });
    assert.equal(addMember.statusCode, 201, addMember.body);
    const memberCanRead = await app.inject({ method: "GET", url: `/v1/projects/${ownedProject}`, headers: { authorization: `Bearer ${other.session.accessToken}` } });
    assert.equal(memberCanRead.statusCode, 200);
    const memberCannotWrite = await app.inject({ method: "POST", url: `/v1/projects/${ownedProject}/environments`, headers: { authorization: `Bearer ${other.session.accessToken}` }, payload: { name: "forbidden" } });
    assert.equal(memberCannotWrite.statusCode, 403);
    const memberList = await app.inject({ method: "GET", url: `/v1/projects/${ownedProject}/members`, headers: { authorization: `Bearer ${owner.session.accessToken}` } });
    assert.equal(memberList.statusCode, 200);
    assert.equal(memberList.json().members.length, 2);

    const createKey = await app.inject({ method: "POST", url: `/v1/projects/${ownedProject}/api-keys`, headers: { authorization: `Bearer ${owner.session.accessToken}` }, payload: { name: "test reader", role: "readonly" } });
    assert.equal(createKey.statusCode, 201, createKey.body);
    const keyBody = createKey.json() as { apiKey: { id: string; token: string } };
    const allowed = await app.inject({ method: "GET", url: `/v1/projects/${ownedProject}`, headers: { authorization: `Bearer ${keyBody.apiKey.token}` } });
    assert.equal(allowed.statusCode, 200);
    const keyCannotWrite = await app.inject({ method: "POST", url: `/v1/projects/${ownedProject}/environments`, headers: { authorization: `Bearer ${keyBody.apiKey.token}` }, payload: { name: "restricted" } });
    assert.equal(keyCannotWrite.statusCode, 403);
    const crossProject = await app.inject({ method: "GET", url: `/v1/projects/${otherProject}`, headers: { authorization: `Bearer ${keyBody.apiKey.token}` } });
    assert.equal(crossProject.statusCode, 404);
    const revoked = await app.inject({ method: "DELETE", url: `/v1/projects/${ownedProject}/api-keys/${keyBody.apiKey.id}`, headers: { authorization: `Bearer ${owner.session.accessToken}` } });
    assert.equal(revoked.statusCode, 200);
    const afterRevoke = await app.inject({ method: "GET", url: `/v1/projects/${ownedProject}`, headers: { authorization: `Bearer ${keyBody.apiKey.token}` } });
    assert.equal(afterRevoke.statusCode, 401);

    const logout = await app.inject({ method: "POST", url: "/v1/auth/logout", headers: { authorization: `Bearer ${refreshBody.session.accessToken}` } });
    assert.equal(logout.statusCode, 200);
    const revokedSession = await app.inject({ method: "GET", url: "/v1/auth/me", headers: { authorization: `Bearer ${refreshBody.session.accessToken}` } });
    assert.equal(revokedSession.statusCode, 401);
  } finally {
    await app.close();
    for (const schema of schemas) {
      if (/^project_[a-f0-9]{32}$/.test(schema)) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
    if (projectIds.length || userIds.length) await pool.query("DELETE FROM platform_audit_events WHERE project_id = ANY($1::uuid[]) OR actor_user_id = ANY($2::uuid[])", [projectIds, userIds]);
    if (projectIds.length) await pool.query("DELETE FROM platform_projects WHERE id = ANY($1::uuid[])", [projectIds]);
    if (userIds.length) await pool.query("DELETE FROM platform_users WHERE id = ANY($1::uuid[])", [userIds]);
    if (testDatabaseUrl) await pool.end();
  }
});
