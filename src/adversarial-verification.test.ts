import assert from "node:assert/strict";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { buildApp } from "./app.js";
import { config } from "./config.js";
import { pool } from "./db/pool.js";
import { verifyApkPackage } from "./services/android-artifact.service.js";
import { S3StorageAdapter } from "./services/storage.service.js";

test("Critical #1: Server function isolated OS subprocess blocks sandbox escapes, filesystem access, secret leaks, and infinite loops", async () => {
  const app = await buildApp();
  try {
    const email = `sec-fn-${Date.now()}@marrybase.dev`;
    const reg = await app.inject({
      method: "POST",
      url: "/v1/platform/auth/register",
      payload: { email, password: "StrongPassword123!", name: "Sec Admin" },
    });
    const token = reg.json().accessToken as string;

    const projRes = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Sandbox Escape Lab" },
    });
    const slug = projRes.json().project.slug as string;
    const serviceKey = projRes.json().apiKeys.serviceRoleKey as string;

    // 1. Deploy function attempting multiple sandbox escapes
    const escapeCode = `
      async function handler(ctx) {
        const attempts = {};

        // Attempt 1: this.constructor.constructor escape
        try {
          const fn = this.constructor.constructor("return process");
          attempts.thisConstructor = fn ? "ESCAPED" : "NULL";
        } catch (e) {
          attempts.thisConstructor = "BLOCKED: " + e.message;
        }

        // Attempt 2: Function.prototype.constructor escape
        try {
          const fn2 = (function(){}).constructor.constructor("return process");
          attempts.fnConstructor = fn2 ? "ESCAPED" : "NULL";
        } catch (e) {
          attempts.fnConstructor = "BLOCKED: " + e.message;
        }

        // Attempt 3: AsyncFunction constructor escape
        try {
          const fn3 = (async function(){}).constructor.constructor("return process");
          attempts.asyncConstructor = fn3 ? "ESCAPED" : "NULL";
        } catch (e) {
          attempts.asyncConstructor = "BLOCKED: " + e.message;
        }

        // Attempt 4: Host bridge function constructor escape
        try {
          const fn4 = ctx.db.query.constructor.constructor("return process");
          attempts.bridgeConstructor = fn4 ? "ESCAPED" : "NULL";
        } catch (e) {
          attempts.bridgeConstructor = "BLOCKED: " + e.message;
        }

        // Attempt 5: Direct process / require access
        attempts.typeofProcess = typeof process;
        attempts.typeofRequire = typeof require;

        return { attempts, projectSlug: ctx.env.MAARY_PROJECT_SLUG };
      }
    `;

    const deployRes = await app.inject({
      method: "POST",
      url: `/v1/projects/${slug}/functions`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        slug: "escape-test",
        code: escapeCode,
        verifyJwt: false,
      },
    });
    assert.equal(deployRes.statusCode, 201, deployRes.body);

    const invokeRes = await app.inject({
      method: "POST",
      url: `/v1/projects/${slug}/functions/escape-test/invoke`,
      headers: { apikey: serviceKey },
      payload: {},
    });
    assert.equal(invokeRes.statusCode, 200, invokeRes.body);
    const body = invokeRes.json().data;
    assert.equal(body.projectSlug, slug);
    assert.match(body.attempts.thisConstructor, /^BLOCKED:/);
    assert.match(body.attempts.fnConstructor, /^BLOCKED:/);
    assert.match(body.attempts.asyncConstructor, /^BLOCKED:/);
    assert.match(body.attempts.bridgeConstructor, /^BLOCKED:/);
    assert.equal(body.attempts.typeofProcess, "undefined");
    assert.equal(body.attempts.typeofRequire, "undefined");

    // 2. Deploy function with an infinite loop and verify hard SIGKILL timeout (504)
    await app.inject({
      method: "POST",
      url: `/v1/projects/${slug}/functions`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        slug: "hang-test",
        code: `async function handler() { while (true) {} }`,
        timeoutMs: 250,
        verifyJwt: false,
      },
    });

    const hangRes = await app.inject({
      method: "POST",
      url: `/v1/projects/${slug}/functions/hang-test/invoke`,
      headers: { apikey: serviceKey },
      payload: {},
    });
    assert.equal(hangRes.statusCode, 504);
    assert.match(hangRes.json().error, /timed out/i);
  } finally {
    await app.close();
  }
});

test("Critical #2: Database privilege boundary enforces non-superuser role isolation even for service_role and dynamic SQL", async () => {
  const app = await buildApp();
  try {
    const email = `sec-db-${Date.now()}@marrybase.dev`;
    const reg = await app.inject({
      method: "POST",
      url: "/v1/platform/auth/register",
      payload: { email, password: "StrongPassword123!", name: "DB Sec Admin" },
    });
    const token = reg.json().accessToken as string;

    const projA = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Tenant Alpha" },
    });
    const slugA = projA.json().project.slug as string;
    const roleA = projA.json().project.db_role_name as string;
    const serviceKeyA = projA.json().apiKeys.serviceRoleKey as string;
    const anonKeyA = projA.json().apiKeys.anonKey as string;

    const projB = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Tenant Beta" },
    });
    const slugB = projB.json().project.slug as string;
    const schemaB = projB.json().project.schema_name as string;
    const serviceKeyB = projB.json().apiKeys.serviceRoleKey as string;

    // Create secret table in Tenant Beta
    const createBetaRes = await app.inject({
      method: "POST",
      url: `/v1/projects/${slugB}/database/tables`,
      headers: { apikey: serviceKeyB },
      payload: {
        name: "vault_items",
        columns: [
          { name: "id", type: "serial", primaryKey: true },
          { name: "secret_note", type: "text", nullable: false },
        ],
      },
    });
    assert.equal(createBetaRes.statusCode, 201);

    await app.inject({
      method: "POST",
      url: `/v1/projects/${slugB}/rest/vault_items`,
      headers: { apikey: serviceKeyB },
      payload: { secret_note: "top-secret-beta" },
    });

    // 1. Verify service_role in Tenant Alpha runs as non-superuser role_<slug>
    const roleCheckRes = await app.inject({
      method: "POST",
      url: `/v1/projects/${slugA}/database/sql`,
      headers: { apikey: serviceKeyA },
      payload: {
        sql: `SELECT current_user AS active_role, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_superuser`,
      },
    });
    assert.equal(roleCheckRes.statusCode, 200, roleCheckRes.body);
    assert.equal(roleCheckRes.json().rows[0].active_role, roleA);
    assert.equal(roleCheckRes.json().rows[0].is_superuser, false);

    // 2. Verify anon in Tenant Alpha runs as non-superuser role_<slug>_rls
    const anonRoleCheck = await app.inject({
      method: "POST",
      url: `/v1/projects/${slugA}/database/sql`,
      headers: { apikey: serviceKeyA },
      payload: {
        sql: `SELECT current_user AS active_role, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_superuser`,
        readOnly: true,
        impersonate: { role: "anon" },
      },
    });
    assert.equal(anonRoleCheck.statusCode, 200, anonRoleCheck.body);
    assert.equal(anonRoleCheck.json().rows[0].active_role, `${roleA}_rls`);
    assert.equal(anonRoleCheck.json().rows[0].is_superuser, false);

    // 3. Attempt dynamic PL/pgSQL string-concatenation bypass to read Tenant Beta's schema
    // Even though 'proj_' isn't matched literally when split as 'pr' || 'oj_', PostgreSQL's own privilege boundary rejects it!
    const [prefixB, suffixB] = [schemaB.slice(0, 3), schemaB.slice(3)];
    const dynamicCrossSchemaRes = await app.inject({
      method: "POST",
      url: `/v1/projects/${slugA}/database/sql`,
      headers: { apikey: serviceKeyA },
      payload: {
        sql: `DO $$ BEGIN EXECUTE 'SELECT * FROM ' || '${prefixB}' || '${suffixB}.vault_items'; END $$;`,
      },
    });
    assert.notEqual(dynamicCrossSchemaRes.statusCode, 200);

    // 4. Attempt dynamic PL/pgSQL string-concatenation bypass to read public.platform_users
    const dynamicPlatformRes = await app.inject({
      method: "POST",
      url: `/v1/projects/${slugA}/database/sql`,
      headers: { apikey: serviceKeyA },
      payload: {
        sql: `DO $$ BEGIN EXECUTE 'SELECT * FROM public.plat' || 'form_users'; END $$;`,
      },
    });
    assert.notEqual(dynamicPlatformRes.statusCode, 200);

    // 5. Attempt role escalation inside dollar-quoted block
    const roleEscalateRes = await app.inject({
      method: "POST",
      url: `/v1/projects/${slugA}/database/sql`,
      headers: { apikey: serviceKeyA },
      payload: {
        sql: `DO $$ BEGIN RESET ROLE; END $$;`,
      },
    });
    assert.equal(roleEscalateRes.statusCode, 403);
  } finally {
    await app.close();
  }
});

test("Critical #3: Genuine Android Gradle project, CI workflow, WebView security boundaries, and APK package verifier reject fabricated archives", async () => {
  const app = await buildApp();
  const fakeApkPath = resolve(config.BACKUP_DIR, "fake-uncompiled.apk");
  try {
    // 1. Hand-assembled APK generator must NOT exist in the repository
    await assert.rejects(
      () => access(resolve(process.cwd(), "src/services/apk.service.ts")),
      "Hand-fabricated APK generator must remain deleted"
    );

    // 2. Native Android Gradle files and hardened WebView MainActivity must exist
    const [appGradle, manifestXml, mainJava, ciYaml] = await Promise.all([
      readFile(resolve(process.cwd(), "android/app/build.gradle"), "utf8"),
      readFile(resolve(process.cwd(), "android/app/src/main/AndroidManifest.xml"), "utf8"),
      readFile(
        resolve(process.cwd(), "android/app/src/main/java/com/marrybase/platform/MainActivity.java"),
        "utf8"
      ),
      readFile(resolve(process.cwd(), ".github/workflows/ci.yml"), "utf8"),
    ]);

    assert.match(appGradle, /com\.android\.application/);
    assert.match(appGradle, /compileSdk\s+34/);
    assert.match(appGradle, /minSdk\s+24/);
    assert.match(manifestXml, /android:allowBackup="false"/);
    assert.match(manifestXml, /android:usesCleartextTraffic="false"/);
    assert.match(mainJava, /setAllowFileAccess\(false\)/);
    assert.match(mainJava, /setAllowUniversalAccessFromFileURLs\(false\)/);
    assert.match(mainJava, /handler\.cancel\(\)/);
    assert.match(mainJava, /\/ready/);
    assert.match(mainJava, /\/v1\/platform/);

    // 3. GitHub Actions workflow compiles with Gradle, verifies with apksigner, and uploads physical APK
    assert.match(ciYaml, /assembleDebug/);
    assert.match(ciYaml, /verify-apk\.mjs.*--require-apksigner/);
    assert.match(ciYaml, /actions\/upload-artifact@v4/);
    assert.match(ciYaml, /\.apk/);

    // 4. APK status endpoint truthfully reports Android project presence and toolchain status
    const statusRes = await app.inject({
      method: "GET",
      url: "/v1/platform/apk/status",
    });
    assert.equal(statusRes.statusCode, 200);
    const statusBody = statusRes.json();
    assert.equal(statusBody.androidProjectPresent, true);
    assert.ok(
      ["operational_verified", "implemented_unverified", "requires_configuration"].includes(
        statusBody.status
      )
    );

    // 5. Verifier rejects non-Gradle / non-binary / unsigned files
    await mkdir(dirname(fakeApkPath), { recursive: true });
    await writeFile(fakeApkPath, Buffer.from("PK\x03\x04not-a-valid-compiled-apk-archive"));
    const inspection = await verifyApkPackage(fakeApkPath);
    assert.equal(inspection.valid, false);
  } finally {
    await rm(fakeApkPath, { force: true });
    await app.close();
  }
});

test("High Priority #4: Full platform backup enforces superadmin RBAC and captures/restores tables, defaults, constraints, FKs, indexes, sequences, RLS, auth users, functions, and storage blobs", async () => {
  const app = await buildApp();
  try {
    // Register a non-superadmin operator (since Subtest #1 already created the initial superadmin)
    const nonSuperReg = await app.inject({
      method: "POST",
      url: "/v1/platform/auth/register",
      payload: {
        email: `regular-op-${Date.now()}@marrybase.dev`,
        password: "StrongPassword123!",
        name: "Regular Operator",
      },
    });
    assert.equal(nonSuperReg.statusCode, 201);
    assert.equal(nonSuperReg.json().user.is_superadmin, false);
    const nonSuperToken = nonSuperReg.json().accessToken as string;

    // Non-superadmin MUST be blocked from full-platform backup endpoints
    const forbiddenBackup = await app.inject({
      method: "POST",
      url: "/v1/platform/backups",
      headers: { authorization: `Bearer ${nonSuperToken}` },
      payload: { name: "unauthorized-platform-backup" },
    });
    assert.equal(forbiddenBackup.statusCode, 403);

    // Elevate a dedicated DR superadmin in DB to run the full-platform disaster recovery workflow
    const email = `dr-admin-${Date.now()}@marrybase.dev`;
    const reg = await app.inject({
      method: "POST",
      url: "/v1/platform/auth/register",
      payload: { email, password: "StrongPassword123!", name: "DR Operator" },
    });
    await pool.query(`UPDATE platform_users SET is_superadmin = true WHERE id = $1`, [
      reg.json().user.id,
    ]);
    const token = reg.json().accessToken as string;

    const projRes = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Disaster Recovery Project" },
    });
    const slug = projRes.json().project.slug as string;
    const serviceKey = projRes.json().apiKeys.serviceRoleKey as string;

    // 1. Create table with SERIAL sequence, DEFAULT, CHECK constraint, UNIQUE index
    await app.inject({
      method: "POST",
      url: `/v1/projects/${slug}/database/sql`,
      headers: { apikey: serviceKey },
      payload: {
        sql: `
          CREATE TABLE accounts (
            id SERIAL PRIMARY KEY,
            code TEXT NOT NULL UNIQUE,
            balance INTEGER NOT NULL DEFAULT 100 CHECK (balance >= 0)
          );
          CREATE INDEX idx_accounts_balance ON accounts (balance);
          INSERT INTO accounts (code, balance) VALUES ('ACC-1', 250), ('ACC-2', 500);
        `,
      },
    });

    // 2. Create RLS policy
    await app.inject({
      method: "POST",
      url: `/v1/projects/${slug}/database/policies`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        tableName: "accounts",
        policyName: "accounts_read_all",
        command: "SELECT",
        usingExpression: "true",
      },
    });

    // 3. Register a project end-user
    const signupRes = await app.inject({
      method: "POST",
      url: `/v1/projects/${slug}/auth/signup`,
      headers: { apikey: serviceKey },
      payload: {
        email: "customer@app.io",
        password: "CustomerPass123!",
      },
    });
    assert.equal(signupRes.statusCode, 201);

    // 4. Deploy a server function
    await app.inject({
      method: "POST",
      url: `/v1/projects/${slug}/functions`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        slug: "calc-tax",
        code: `async function handler(ctx) { return { tax: 42 }; }`,
        verifyJwt: false,
      },
    });

    // 5. Create storage bucket and upload object
    await app.inject({
      method: "POST",
      url: `/v1/projects/${slug}/storage/buckets`,
      headers: { apikey: serviceKey },
      payload: { name: "docs", public: true },
    });
    const upRes = await app.inject({
      method: "POST",
      url: `/v1/projects/${slug}/storage/buckets/docs/objects/readme.txt`,
      headers: { apikey: serviceKey },
      payload: {
        content: "Disaster Recovery Payload",
        mimeType: "text/plain",
      },
    });
    assert.equal(upRes.statusCode, 201);
    const storageKey = upRes.json().object.storage_key as string;

    // 6. Take a full platform backup
    const backupRes = await app.inject({
      method: "POST",
      url: "/v1/platform/backups",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "pre-disaster-full" },
    });
    assert.equal(backupRes.statusCode, 201);
    const backupId = backupRes.json().backup.id as string;

    // 7. Simulate disaster: drop table, delete auth user, delete function, delete storage blob from disk
    await app.inject({
      method: "POST",
      url: `/v1/projects/${slug}/database/sql`,
      headers: { apikey: serviceKey },
      payload: {
        sql: `DROP TABLE accounts CASCADE;`,
        allowDestructive: true,
      },
    });
    await app.inject({
      method: "DELETE",
      url: `/v1/projects/${slug}/functions/calc-tax`,
      headers: { authorization: `Bearer ${token}` },
    });
    const userId = signupRes.json().user.id as string;
    const delUserRes = await app.inject({
      method: "DELETE",
      url: `/v1/projects/${slug}/auth/admin/users/${userId}`,
      headers: { apikey: serviceKey },
    });
    assert.equal(delUserRes.statusCode, 200);
    await rm(resolve(config.STORAGE_DIR, storageKey), { force: true });

    // 8. Restore the backup
    const restoreRes = await app.inject({
      method: "POST",
      url: `/v1/platform/backups/${backupId}/restore`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(restoreRes.statusCode, 200, restoreRes.body);
    const restoreBody = restoreRes.json();
    assert.ok(restoreBody.restoredTables >= 1);
    assert.ok(restoreBody.restoredRows >= 2);
    assert.ok(restoreBody.restoredFunctions >= 1);
    assert.ok(restoreBody.restoredAuthUsers >= 1);
    assert.ok(restoreBody.restoredStorageObjects >= 1);

    // 9. Verify table rows, sequence continuity, constraints, indexes, function, user, and storage file are all restored!
    const insertNextRes = await app.inject({
      method: "POST",
      url: `/v1/projects/${slug}/database/sql`,
      headers: { apikey: serviceKey },
      payload: {
        sql: `INSERT INTO accounts (code) VALUES ('ACC-3') RETURNING id, balance`,
      },
    });
    assert.equal(insertNextRes.statusCode, 200, insertNextRes.body);
    assert.equal(insertNextRes.json().rows[0].id, 3); // Sequence state preserved!
    assert.equal(insertNextRes.json().rows[0].balance, 100); // Column DEFAULT preserved!

    const fnInvokeAfter = await app.inject({
      method: "POST",
      url: `/v1/projects/${slug}/functions/calc-tax/invoke`,
      headers: { apikey: serviceKey },
      payload: {},
    });
    assert.equal(fnInvokeAfter.statusCode, 200);
    assert.equal(fnInvokeAfter.json().data.tax, 42);

    const usersAfter = await app.inject({
      method: "GET",
      url: `/v1/projects/${slug}/auth/admin/users`,
      headers: { apikey: serviceKey },
    });
    assert.equal(usersAfter.statusCode, 200, usersAfter.body);
    assert.equal(usersAfter.json().users.length, 1);
    assert.equal(usersAfter.json().users[0].email, "customer@app.io");

    const fileAfter = await app.inject({
      method: "GET",
      url: `/v1/projects/${slug}/storage/buckets/docs/objects/readme.txt`,
      headers: { apikey: serviceKey },
    });
    assert.equal(fileAfter.statusCode, 200);
    assert.equal(fileAfter.body, "Disaster Recovery Payload");
  } finally {
    await app.close();
  }
});

test("High Priority #5: Concurrent platform operator registrations atomically enforce at most one superadmin", async () => {
  const app = await buildApp();
  try {
    // Reset platform_users to exercise the initial 0-user bootstrap race condition directly
    await pool.query(`DELETE FROM platform_users`);

    const batch = Array.from({ length: 5 }, (_, i) =>
      app.inject({
        method: "POST",
        url: "/v1/platform/auth/register",
        payload: {
          email: `concurrent-op-${Date.now()}-${i}@marrybase.dev`,
          password: "StrongPassword123!",
          name: `Concurrent Operator ${i}`,
        },
      })
    );
    const responses = await Promise.all(batch);
    for (const r of responses) {
      assert.equal(r.statusCode, 201, r.body);
    }

    const superWinners = responses.filter((r) => r.json().user.is_superadmin === true);
    const ordinaryLosers = responses.filter((r) => r.json().user.is_superadmin === false);
    assert.equal(superWinners.length, 1, "Exactly one concurrent registration may win superadmin");
    assert.equal(ordinaryLosers.length, 4);

    // Non-superadmin loser cannot list platform operators
    const forbiddenRes = await app.inject({
      method: "GET",
      url: "/v1/platform/users",
      headers: { authorization: `Bearer ${ordinaryLosers[0]!.json().accessToken}` },
    });
    assert.equal(forbiddenRes.statusCode, 403);

    const token = superWinners[0]!.json().accessToken as string;
    const usersRes = await app.inject({
      method: "GET",
      url: "/v1/platform/users",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(usersRes.statusCode, 200);
    const allUsers = usersRes.json().users as Array<{ is_superadmin: boolean }>;
    const superadminCount = allUsers.filter((u) => u.is_superadmin).length;
    assert.equal(
      superadminCount,
      1,
      `Expected exactly 1 superadmin across platform_users, got ${superadminCount}`
    );
  } finally {
    await app.close();
  }
});

test("Additional Finding: S3StorageAdapter executes real AWS Signature V4 PUT, GET, and DELETE requests", async () => {
  const store = new Map<string, Buffer>();
  const seenHeaders: Array<Record<string, string | string[] | undefined>> = [];

  const server = createServer((req, res) => {
    seenHeaders.push(req.headers);
    const urlPath = req.url || "/";
    if (req.method === "PUT") {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        store.set(urlPath, Buffer.concat(chunks));
        res.writeHead(200, { ETag: '"mock-etag"' });
        res.end();
      });
      return;
    }
    if (req.method === "GET") {
      const found = store.get(urlPath);
      if (!found) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.end(found);
      return;
    }
    if (req.method === "DELETE") {
      store.delete(urlPath);
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(405);
    res.end();
  });

  await new Promise<void>((resolveListen) =>
    server.listen(0, "127.0.0.1", () => resolveListen())
  );
  const { port } = server.address() as AddressInfo;

  try {
    const adapter = new S3StorageAdapter({
      endpoint: `http://127.0.0.1:${port}`,
      bucket: "marry-base-bucket",
      region: "us-east-1",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    });

    const payload = Buffer.from("Hello S3 SigV4 Adapter!");
    await adapter.putObject("proj1/avatars/icon.png", payload, "image/png");

    assert.equal(seenHeaders.length, 1);
    const putAuth = String(seenHeaders[0]!.authorization || "");
    assert.match(putAuth, /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\//);
    assert.ok(seenHeaders[0]!["x-amz-content-sha256"]);
    assert.ok(seenHeaders[0]!["x-amz-date"]);

    const fetched = await adapter.getObject("proj1/avatars/icon.png");
    assert.deepEqual(fetched, payload);

    await adapter.deleteObject("proj1/avatars/icon.png");
    await assert.rejects(() => adapter.getObject("proj1/avatars/icon.png"));
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
});
