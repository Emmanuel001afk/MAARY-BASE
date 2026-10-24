import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { buildApp } from "./app.js";

const execFileAsync = promisify(execFile);

test("Organizations, inherited project RBAC, cookie auth, and Superadmin boundaries", async () => {
  const app = await buildApp();
  try {
    // 1. Register initial Superadmin and verify HttpOnly cookie authentication works
    const superEmail = `super-${Date.now()}@marrybase.dev`;
    const superReg = await app.inject({
      method: "POST",
      url: "/v1/platform/auth/register",
      payload: { email: superEmail, password: "StrongPassword123!", name: "Super Admin" },
    });
    assert.equal(superReg.statusCode, 201, superReg.body);
    const superUser = superReg.json().user;
    assert.equal(superUser.is_superadmin, true);
    const superToken = superReg.json().accessToken as string;
    const setCookieHeader = superReg.headers["set-cookie"];
    assert.ok(setCookieHeader, "Expected HttpOnly session cookie on registration");
    const cookiePair = String(Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader).split(";")[0]!;

    // Cookie-only request to /v1/platform/auth/me succeeds (powers Management Studio)
    const meViaCookie = await app.inject({
      method: "GET",
      url: "/v1/platform/auth/me",
      headers: { cookie: cookiePair },
    });
    assert.equal(meViaCookie.statusCode, 200);
    assert.equal(meViaCookie.json().user.email, superEmail);

    // Register two ordinary operators: teammate & outsider
    const teamEmail = `team-${Date.now()}@marrybase.dev`;
    const teamReg = await app.inject({
      method: "POST",
      url: "/v1/platform/auth/register",
      payload: { email: teamEmail, password: "StrongPassword123!", name: "Team Dev" },
    });
    assert.equal(teamReg.statusCode, 201);
    assert.equal(teamReg.json().user.is_superadmin, false);
    const teamToken = teamReg.json().accessToken as string;

    const outsiderEmail = `outsider-${Date.now()}@marrybase.dev`;
    const outsiderReg = await app.inject({
      method: "POST",
      url: "/v1/platform/auth/register",
      payload: { email: outsiderEmail, password: "StrongPassword123!", name: "Outsider" },
    });
    const outsiderToken = outsiderReg.json().accessToken as string;

    // 2. Non-superadmin is blocked from all superadmin endpoints
    for (const url of [
      "/v1/platform/users",
      "/v1/platform/audit",
      "/v1/platform/logs/errors",
      "/v1/platform/extensions",
      "/v1/platform/backups",
    ]) {
      const denied = await app.inject({
        method: "GET",
        url,
        headers: { authorization: `Bearer ${teamToken}` },
      });
      assert.equal(denied.statusCode, 403, `Expected 403 for non-superadmin on ${url}`);
    }

    // 3. Create an Organization and add Team Dev as 'developer'
    const orgRes = await app.inject({
      method: "POST",
      url: "/v1/organizations",
      headers: { authorization: `Bearer ${superToken}` },
      payload: { name: "Lagos Cloud Team", slug: `lagos-cloud-${Date.now()}`, billingTier: "team" },
    });
    assert.equal(orgRes.statusCode, 201, orgRes.body);
    const org = orgRes.json().organization;

    const addMemRes = await app.inject({
      method: "POST",
      url: `/v1/organizations/${org.slug}/members`,
      headers: { authorization: `Bearer ${superToken}` },
      payload: { email: teamEmail, role: "developer" },
    });
    assert.equal(addMemRes.statusCode, 201, addMemRes.body);

    // 4. Provision a project inside the Organization
    const projRes = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { authorization: `Bearer ${superToken}` },
      payload: { name: "Fintech Ledger", organizationId: org.id },
    });
    assert.equal(projRes.statusCode, 201, projRes.body);
    const project = projRes.json().project;

    // Team Dev automatically inherits 'developer' access to the project!
    const teamProjAccess = await app.inject({
      method: "GET",
      url: `/v1/projects/${project.slug}`,
      headers: { authorization: `Bearer ${teamToken}` },
    });
    assert.equal(teamProjAccess.statusCode, 200, teamProjAccess.body);
    assert.equal(teamProjAccess.json().memberRole, "developer");
    assert.ok(teamProjAccess.json().overview.subsystems.database.state === "operational_verified");

    // Team Dev can create a table as developer, but CANNOT delete the project (owner only)
    const devCreateTable = await app.inject({
      method: "POST",
      url: `/v1/projects/${project.slug}/database/tables`,
      headers: { authorization: `Bearer ${teamToken}` },
      payload: {
        name: "entries",
        columns: [
          { name: "id", type: "uuid", primaryKey: true, defaultValue: "gen_random_uuid()" },
          { name: "amount", type: "numeric", nullable: false },
        ],
        enableRls: true,
      },
    });
    assert.equal(devCreateTable.statusCode, 201, devCreateTable.body);

    const devDeleteProj = await app.inject({
      method: "DELETE",
      url: `/v1/projects/${project.slug}`,
      headers: { authorization: `Bearer ${teamToken}` },
      payload: { confirmSlug: project.slug },
    });
    assert.equal(devDeleteProj.statusCode, 403);

    // Outsider has zero access to organization or project
    const outsiderProj = await app.inject({
      method: "GET",
      url: `/v1/projects/${project.slug}`,
      headers: { authorization: `Bearer ${outsiderToken}` },
    });
    assert.equal(outsiderProj.statusCode, 403);
  } finally {
    await app.close();
  }
});

test("Cross-project backup IDOR blocking, schema alteration, session revocation, SSRF guard, job retry, and error logs", async () => {
  const app = await buildApp();
  try {
    const opA = await app.inject({
      method: "POST",
      url: "/v1/platform/auth/register",
      payload: { email: `opa-${Date.now()}@marrybase.dev`, password: "StrongPassword123!" },
    });
    const tokenA = opA.json().accessToken as string;

    const opB = await app.inject({
      method: "POST",
      url: "/v1/platform/auth/register",
      payload: { email: `opb-${Date.now()}@marrybase.dev`, password: "StrongPassword123!" },
    });
    const tokenB = opB.json().accessToken as string;

    const projARes = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { name: "Tenant Alpha" },
    });
    const slugA = projARes.json().project.slug as string;
    const anonKeyA = projARes.json().apiKeys.anonKey as string;

    const projBRes = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { name: "Tenant Beta" },
    });
    const slugB = projBRes.json().project.slug as string;

    // 1. Cross-project backup IDOR protection
    const backupARes = await app.inject({
      method: "POST",
      url: `/v1/projects/${slugA}/backups`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { name: "alpha-secret-backup" },
    });
    assert.equal(backupARes.statusCode, 201);
    const backupAId = backupARes.json().backup.id as string;

    // Tenant B attempts to verify and restore Tenant A's backup via Tenant B's project route
    const crossVerify = await app.inject({
      method: "POST",
      url: `/v1/projects/${slugB}/backups/${backupAId}/verify`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    assert.ok([403, 404].includes(crossVerify.statusCode), `Expected 403/404, got ${crossVerify.statusCode}`);

    const crossRestore = await app.inject({
      method: "POST",
      url: `/v1/projects/${slugB}/backups/${backupAId}/restore`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    assert.ok([403, 404].includes(crossRestore.statusCode), `Expected 403/404, got ${crossRestore.statusCode}`);

    // 2. Database schema alteration, safe default validation & diagnostics
    await app.inject({
      method: "POST",
      url: `/v1/projects/${slugA}/database/tables`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        name: "customers",
        columns: [
          { name: "id", type: "uuid", primaryKey: true, defaultValue: "gen_random_uuid()" },
          { name: "email", type: "text", nullable: false },
        ],
        enableRls: true,
      },
    });

    // Unsafe SQL injection in column default MUST be rejected
    const badAlter = await app.inject({
      method: "PATCH",
      url: `/v1/projects/${slugA}/database/tables/customers`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        action: "add_column",
        column: { name: "pwned", type: "text", defaultValue: "(''); DROP TABLE customers; --" },
      },
    });
    assert.equal(badAlter.statusCode, 400);

    // Safe column addition, rename, and index creation succeed
    const goodAlter = await app.inject({
      method: "PATCH",
      url: `/v1/projects/${slugA}/database/tables/customers`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        action: "add_column",
        column: { name: "tier", type: "text", defaultValue: "'standard'" },
      },
    });
    assert.equal(goodAlter.statusCode, 200, goodAlter.body);

    const createIdx = await app.inject({
      method: "PATCH",
      url: `/v1/projects/${slugA}/database/tables/customers`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { action: "create_index", indexName: "idx_customers_tier", columns: ["tier"], unique: false },
    });
    assert.equal(createIdx.statusCode, 200, createIdx.body);

    const dbDiag = await app.inject({
      method: "GET",
      url: `/v1/projects/${slugA}/database/diagnostics`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    assert.equal(dbDiag.statusCode, 200);
    assert.equal(dbDiag.json().isolationVerified, true);

    // 3. Project Auth Sessions inspection & revocation
    const endUser = await app.inject({
      method: "POST",
      url: `/v1/projects/${slugA}/auth/signup`,
      headers: { apikey: anonKeyA },
      payload: { email: "buyer@alpha.dev", password: "BuyerPassword123!" },
    });
    assert.equal(endUser.statusCode, 201);
    const userRefresh = endUser.json().session.refresh_token as string;
    assert.ok(userRefresh, "Expected refresh_token from signup session");

    const sessionsList = await app.inject({
      method: "GET",
      url: `/v1/projects/${slugA}/auth/admin/sessions`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    assert.equal(sessionsList.statusCode, 200);
    assert.equal(sessionsList.json().sessions.length, 1);
    const sessionId = sessionsList.json().sessions[0].id as string;

    const revokeSess = await app.inject({
      method: "DELETE",
      url: `/v1/projects/${slugA}/auth/admin/sessions/${sessionId}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    assert.equal(revokeSess.statusCode, 200);

    const refreshAfterRevoke = await app.inject({
      method: "POST",
      url: `/v1/projects/${slugA}/auth/refresh`,
      headers: { apikey: anonKeyA },
      payload: { refresh_token: userRefresh },
    });
    assert.equal(refreshAfterRevoke.statusCode, 401);

    // 4. SSRF-blocked webhook job & manual job retry
    const jobRes = await app.inject({
      method: "POST",
      url: `/v1/projects/${slugA}/jobs`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        jobType: "webhook",
        maxAttempts: 1,
        payload: { url: "http://127.0.0.1:9999/internal-metadata" },
      },
    });
    assert.equal(jobRes.statusCode, 201, jobRes.body);
    const jobId = jobRes.json().job.id as string;

    await app.inject({
      method: "POST",
      url: `/v1/projects/${slugA}/jobs/process`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { limit: 5 },
    });

    const jobAfterFail = await app.inject({
      method: "GET",
      url: `/v1/projects/${slugA}/jobs/${jobId}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    assert.ok(["failed", "dead_letter"].includes(jobAfterFail.json().job.status));
    assert.match(jobAfterFail.json().job.last_error, /private|loopback|blocked/i);

    const retryRes = await app.inject({
      method: "POST",
      url: `/v1/projects/${slugA}/jobs/${jobId}/retry`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    assert.equal(retryRes.statusCode, 200, retryRes.body);
    assert.equal(retryRes.json().job.status, "queued");

    // 5. Structured project error logs capture failed requests
    const errLogsRes = await app.inject({
      method: "GET",
      url: `/v1/projects/${slugA}/logs/errors`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    assert.equal(errLogsRes.statusCode, 200);
    assert.ok(errLogsRes.json().logs.length >= 1, "Expected structured error logs to be recorded");
  } finally {
    await app.close();
  }
});

test("Persistent database durability across full process restart", async () => {
  const dbDir = resolve(process.cwd(), "data", `test-restart-${Date.now()}`);
  const tsxBin = resolve(process.cwd(), "node_modules", ".bin", "tsx");
  const env = {
    ...process.env,
    NODE_ENV: "development",
    LOG_LEVEL: "silent",
    DATABASE_URL: `pglite://${dbDir}`,
    WORKER_ENABLED: "false",
  };

  try {
    // Phase 1: Boot process 1, create operator, project, table & row, then shut down cleanly
    const script1 = `
      import { buildApp } from "./src/app.ts";
      import { closeDatabase } from "./src/db/pool.ts";
      (async () => {
        const app = await buildApp();
        const reg = await app.inject({
          method: "POST",
          url: "/v1/platform/auth/register",
          payload: { email: "persist@marrybase.dev", password: "StrongPassword123!", name: "Persist Admin" }
        });
        const token = reg.json().accessToken;
        const proj = await app.inject({
          method: "POST",
          url: "/v1/projects",
          headers: { authorization: "Bearer " + token },
          payload: { name: "Durable App", slug: "durable-app" }
        });
        const serviceKey = proj.json().apiKeys.serviceRoleKey;
        await app.inject({
          method: "POST",
          url: "/v1/projects/durable-app/database/tables",
          headers: { authorization: "Bearer " + token },
          payload: { name: "items", columns: [{ name: "id", type: "serial", primaryKey: true }, { name: "label", type: "text", nullable: false }], enableRls: false }
        });
        await app.inject({
          method: "POST",
          url: "/v1/projects/durable-app/rest/items",
          headers: { apikey: serviceKey },
          payload: { label: "survived-restart" }
        });
        await app.close();
        await closeDatabase();
        console.log("PHASE1_OK");
      })().catch((err) => { console.error(err); process.exit(1); });
    `;
    const run1 = await execFileAsync(tsxBin, ["-e", script1], { cwd: process.cwd(), env, timeout: 45_000 });
    assert.match(run1.stdout, /PHASE1_OK/);

    // Phase 2: Boot brand-new process 2 against the same disk directory and verify everything persisted
    const script2 = `
      import assert from "node:assert/strict";
      import { buildApp } from "./src/app.ts";
      import { closeDatabase } from "./src/db/pool.ts";
      (async () => {
        const app = await buildApp();
        const login = await app.inject({
          method: "POST",
          url: "/v1/platform/auth/login",
          payload: { email: "persist@marrybase.dev", password: "StrongPassword123!" }
        });
        assert.equal(login.statusCode, 200);
        const token = login.json().accessToken;
        const rows = await app.inject({
          method: "GET",
          url: "/v1/projects/durable-app/rest/items",
          headers: { authorization: "Bearer " + token }
        });
        assert.equal(rows.statusCode, 200);
        assert.equal(rows.json().data.length, 1);
        assert.equal(rows.json().data[0].label, "survived-restart");
        await app.close();
        await closeDatabase();
        console.log("PHASE2_OK");
      })().catch((err) => { console.error(err); process.exit(1); });
    `;
    const run2 = await execFileAsync(tsxBin, ["-e", script2], { cwd: process.cwd(), env, timeout: 45_000 });
    assert.match(run2.stdout, /PHASE2_OK/);
  } finally {
    await rm(dbDir, { recursive: true, force: true });
  }
});
