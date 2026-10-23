import test from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "./app.js";

test("multi-project lifecycle, RBAC, environments, API keys, secrets, schema DDL, migrations, and isolation", async () => {
  const app = await buildApp();
  try {
    // 1. Register two platform operators (Owner and Viewer)
    const ownerReg = await app.inject({
      method: "POST",
      url: "/v1/platform/auth/register",
      payload: {
        email: `owner-${Date.now()}@maary.dev`,
        password: "OwnerPassword123!",
        name: "Owner User",
      },
    });
    assert.equal(ownerReg.statusCode, 201);
    const ownerToken = ownerReg.json().accessToken as string;

    const viewerReg = await app.inject({
      method: "POST",
      url: "/v1/platform/auth/register",
      payload: {
        email: `viewer-${Date.now()}@maary.dev`,
        password: "ViewerPassword123!",
        name: "Viewer User",
      },
    });
    assert.equal(viewerReg.statusCode, 201);
    const viewerUser = viewerReg.json().user;
    const viewerToken = viewerReg.json().accessToken as string;

    // 2. Create two isolated projects (Alpha and Beta)
    const slugA = `alpha-${Date.now()}`;
    const slugB = `beta-${Date.now()}`;

    const createARes = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {
        name: "Alpha Project",
        slug: slugA,
        description: "First isolated backend",
      },
    });
    assert.equal(createARes.statusCode, 201);
    const projAData = createARes.json();
    assert.equal(projAData.project.slug, slugA);
    assert.equal(projAData.environments.length, 3);
    assert.ok(projAData.apiKeys.anonKey.startsWith("mb_anon_"));
    assert.ok(projAData.apiKeys.serviceRoleKey.startsWith("mb_service_"));

    const createBRes = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {
        name: "Beta Project",
        slug: slugB,
      },
    });
    assert.equal(createBRes.statusCode, 201);
    const projBData = createBRes.json();

    // 3. Verify non-member Viewer cannot access Alpha Project
    const forbiddenInspect = await app.inject({
      method: "GET",
      url: `/v1/projects/${slugA}`,
      headers: { authorization: `Bearer ${viewerToken}` },
    });
    assert.equal(forbiddenInspect.statusCode, 403);

    // 4. Add Viewer as 'viewer' member on Alpha Project
    const addMemberRes = await app.inject({
      method: "POST",
      url: `/v1/projects/${slugA}/members`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {
        userId: viewerUser.id,
        role: "viewer",
      },
    });
    assert.equal(addMemberRes.statusCode, 201);

    // Viewer can now inspect Alpha Project
    const viewerInspect = await app.inject({
      method: "GET",
      url: `/v1/projects/${slugA}`,
      headers: { authorization: `Bearer ${viewerToken}` },
    });
    assert.equal(viewerInspect.statusCode, 200);
    assert.equal(viewerInspect.json().memberRole, "viewer");

    // Viewer cannot create tables on Alpha Project (requires developer/admin/owner)
    const viewerCreateTable = await app.inject({
      method: "POST",
      url: `/v1/projects/${slugA}/database/tables`,
      headers: { authorization: `Bearer ${viewerToken}` },
      payload: {
        name: "unauthorized_table",
        columns: [{ name: "id", type: "serial", primaryKey: true }],
      },
    });
    assert.equal(viewerCreateTable.statusCode, 403);

    // 5. Environments lifecycle
    const createEnvRes = await app.inject({
      method: "POST",
      url: `/v1/projects/${slugA}/environments`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { name: "QA Sandbox", slug: "qa-sandbox" },
    });
    assert.equal(createEnvRes.statusCode, 201);
    const qaEnvId = createEnvRes.json().environment.id as string;

    const delEnvRes = await app.inject({
      method: "DELETE",
      url: `/v1/projects/${slugA}/environments/${qaEnvId}`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(delEnvRes.statusCode, 200);

    // 6. Encrypted Secrets (AES-256-GCM)
    const setSecretRes = await app.inject({
      method: "POST",
      url: `/v1/projects/${slugA}/secrets`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {
        name: "STRIPE_SECRET_KEY",
        value: "sk_test_super_secret_value_999",
        description: "Payment key",
      },
    });
    assert.equal(setSecretRes.statusCode, 201);
    assert.equal(setSecretRes.json().secret.masked_value, "••••••••");
    assert.equal(setSecretRes.json().secret.decrypted_value, undefined);

    // Masked by default on list
    const maskedListRes = await app.inject({
      method: "GET",
      url: `/v1/projects/${slugA}/secrets`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(maskedListRes.statusCode, 200);
    assert.equal(maskedListRes.json().secrets[0].decrypted_value, undefined);

    // Viewer cannot reveal secrets even with ?reveal=true
    const viewerRevealRes = await app.inject({
      method: "GET",
      url: `/v1/projects/${slugA}/secrets?reveal=true`,
      headers: { authorization: `Bearer ${viewerToken}` },
    });
    assert.equal(viewerRevealRes.statusCode, 200);
    assert.equal(viewerRevealRes.json().secrets[0].decrypted_value, undefined);

    // Owner can reveal decrypted secret
    const ownerRevealRes = await app.inject({
      method: "GET",
      url: `/v1/projects/${slugA}/secrets?reveal=true`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(ownerRevealRes.statusCode, 200);
    assert.equal(
      ownerRevealRes.json().secrets[0].decrypted_value,
      "sk_test_super_secret_value_999"
    );

    // 7. API Key Scopes, Rotation & Revocation
    const customKeyRes = await app.inject({
      method: "POST",
      url: `/v1/projects/${slugA}/api-keys`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {
        name: "Read-Only DB Key",
        role: "custom",
        scopes: ["db:read"],
      },
    });
    assert.equal(customKeyRes.statusCode, 201);
    const readOnlyKey = customKeyRes.json().apiKey.raw_key as string;
    const readOnlyKeyId = customKeyRes.json().apiKey.id as string;

    // Rotate key
    const rotateRes = await app.inject({
      method: "POST",
      url: `/v1/projects/${slugA}/api-keys/${readOnlyKeyId}/rotate`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(rotateRes.statusCode, 200);
    const newRotatedKey = rotateRes.json().apiKey.raw_key as string;
    assert.notEqual(newRotatedKey, readOnlyKey);

    // Old rotated key is now rejected
    const oldKeyAttempt = await app.inject({
      method: "GET",
      url: `/v1/projects/${slugA}/openapi.json`,
      headers: { apikey: readOnlyKey },
    });
    assert.equal(oldKeyAttempt.statusCode, 401);

    // New rotated key works
    const newKeyAttempt = await app.inject({
      method: "GET",
      url: `/v1/projects/${slugA}/openapi.json`,
      headers: { apikey: newRotatedKey },
    });
    assert.equal(newKeyAttempt.statusCode, 200);

    // Cross-project API key usage (Alpha key against Beta project) is strictly forbidden
    const crossProjectKeyAttempt = await app.inject({
      method: "GET",
      url: `/v1/projects/${slugB}/openapi.json`,
      headers: { apikey: newRotatedKey },
    });
    assert.equal(crossProjectKeyAttempt.statusCode, 403);

    // 8. Database Schema Administration & Migrations
    const createTableRes = await app.inject({
      method: "POST",
      url: `/v1/projects/${slugA}/database/tables`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {
        name: "categories",
        enableRls: false,
        columns: [
          {
            name: "id",
            type: "uuid",
            primaryKey: true,
            defaultValue: "gen_random_uuid()",
          },
          { name: "title", type: "text", notNull: true, unique: true },
        ],
      },
    });
    assert.equal(createTableRes.statusCode, 201);
    assert.equal(createTableRes.json().table.name, "categories");

    // Alter table: add column + create index
    const addColRes = await app.inject({
      method: "PATCH",
      url: `/v1/projects/${slugA}/database/tables/categories`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {
        action: "add_column",
        column: { name: "priority", type: "integer", defaultValue: "0" },
      },
    });
    assert.equal(addColRes.statusCode, 200);
    assert.ok(
      addColRes
        .json()
        .table.columns.some((c: any) => c.name === "priority")
    );

    const addIdxRes = await app.inject({
      method: "PATCH",
      url: `/v1/projects/${slugA}/database/tables/categories`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {
        action: "create_index",
        indexName: "idx_categories_priority",
        columns: ["priority"],
      },
    });
    assert.equal(addIdxRes.statusCode, 200);
    assert.ok(
      addIdxRes
        .json()
        .table.indexes.some((i: any) => i.name === "idx_categories_priority")
    );

    // Apply project migration & rollback
    const applyMigRes = await app.inject({
      method: "POST",
      url: `/v1/projects/${slugA}/database/migrations`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {
        version: "20261023_01",
        name: "create_audit_notes",
        upSql: "CREATE TABLE audit_notes (id serial PRIMARY KEY, note text NOT NULL);",
        downSql: "DROP TABLE audit_notes;",
      },
    });
    assert.equal(applyMigRes.statusCode, 201);
    assert.equal(applyMigRes.json().migration.status, "applied");

    // Re-applying same version with different SQL checksum fails with 409
    const conflictMigRes = await app.inject({
      method: "POST",
      url: `/v1/projects/${slugA}/database/migrations`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {
        version: "20261023_01",
        name: "create_audit_notes",
        upSql: "CREATE TABLE audit_notes (id uuid PRIMARY KEY);",
      },
    });
    assert.equal(conflictMigRes.statusCode, 409);

    // Rollback migration
    const rollbackMigRes = await app.inject({
      method: "POST",
      url: `/v1/projects/${slugA}/database/migrations/20261023_01/rollback`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(rollbackMigRes.statusCode, 200);
    assert.equal(rollbackMigRes.json().migration.status, "rolled_back");

    // 9. SQL Safety & Cross-Project Isolation Checks
    // Attempting to query platform tables from project SQL editor is forbidden
    const platformTableSql = await app.inject({
      method: "POST",
      url: `/v1/projects/${slugA}/database/sql`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {
        sql: "SELECT * FROM public.platform_projects",
      },
    });
    assert.equal(platformTableSql.statusCode, 403);

    // Attempting to query Beta's schema from Alpha's SQL editor is forbidden
    const crossSchemaSql = await app.inject({
      method: "POST",
      url: `/v1/projects/${slugA}/database/sql`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {
        sql: `SELECT * FROM ${projBData.project.schema_name}.some_table`,
      },
    });
    assert.equal(crossSchemaSql.statusCode, 403);

    // Destructive SQL without allowDestructive=true is blocked
    const destructiveBlocked = await app.inject({
      method: "POST",
      url: `/v1/projects/${slugA}/database/sql`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {
        sql: "DROP TABLE categories",
        allowDestructive: false,
      },
    });
    assert.equal(destructiveBlocked.statusCode, 400);

    // 10. Safe Project Deletion Safeguard
    const badDeleteProj = await app.inject({
      method: "DELETE",
      url: `/v1/projects/${slugB}?confirmSlug=wrong-slug`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(badDeleteProj.statusCode, 400);

    const goodDeleteProj = await app.inject({
      method: "DELETE",
      url: `/v1/projects/${slugB}?confirmSlug=${slugB}`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(goodDeleteProj.statusCode, 200);
    assert.equal(goodDeleteProj.json().deleted, true);
  } finally {
    await app.close();
  }
});
