import test from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "./app.js";

test("saved SQL queries: CRUD, RBAC, run statistics, and project isolation", async () => {
  const app = await buildApp();
  try {
    // 1. Register an owner operator and a viewer operator
    const ownerReg = await app.inject({
      method: "POST",
      url: "/v1/platform/auth/register",
      payload: {
        email: `sq-owner-${Date.now()}@maary.dev`,
        password: "OwnerPassword123!",
        name: "Saved Query Owner",
      },
    });
    assert.equal(ownerReg.statusCode, 201);
    const ownerToken = ownerReg.json().accessToken as string;

    const viewerReg = await app.inject({
      method: "POST",
      url: "/v1/platform/auth/register",
      payload: {
        email: `sq-viewer-${Date.now()}@maary.dev`,
        password: "ViewerPassword123!",
        name: "Saved Query Viewer",
      },
    });
    assert.equal(viewerReg.statusCode, 201);
    const viewerUser = viewerReg.json().user;
    const viewerToken = viewerReg.json().accessToken as string;

    // 2. Create two isolated projects
    const slugA = `sq-alpha-${Date.now()}`;
    const slugB = `sq-beta-${Date.now()}`;
    for (const [slug, name] of [
      [slugA, "Saved Queries Alpha"],
      [slugB, "Saved Queries Beta"],
    ] as const) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/projects",
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: { name, slug },
      });
      assert.equal(res.statusCode, 201);
    }

    // 3. Unauthenticated access is rejected
    const anonList = await app.inject({
      method: "GET",
      url: `/v1/projects/${slugA}/database/queries`,
    });
    assert.equal(anonList.statusCode, 401);

    // 4. Empty library initially
    const emptyList = await app.inject({
      method: "GET",
      url: `/v1/projects/${slugA}/database/queries`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(emptyList.statusCode, 200);
    assert.deepEqual(emptyList.json().queries, []);

    // 5. Create a saved query
    const createRes = await app.inject({
      method: "POST",
      url: `/v1/projects/${slugA}/database/queries`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {
        name: "active-users-count",
        description: "Counts active project users",
        sql: "SELECT count(*) AS total FROM users WHERE status = 'active';",
      },
    });
    assert.equal(createRes.statusCode, 201);
    const created = createRes.json().query;
    assert.equal(created.name, "active-users-count");
    assert.equal(created.favorite, false);
    assert.equal(created.run_count, 0);
    assert.equal(created.last_run_at, null);

    // 6. Duplicate names conflict within the same project
    const duplicateRes = await app.inject({
      method: "POST",
      url: `/v1/projects/${slugA}/database/queries`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { name: "active-users-count", sql: "SELECT 1;" },
    });
    assert.equal(duplicateRes.statusCode, 409);

    // 7. Validation errors
    const missingSqlRes = await app.inject({
      method: "POST",
      url: `/v1/projects/${slugA}/database/queries`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { name: "no-sql" },
    });
    assert.equal(missingSqlRes.statusCode, 400);

    const badNameRes = await app.inject({
      method: "POST",
      url: `/v1/projects/${slugA}/database/queries`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { name: "invalid name!!", sql: "SELECT 1;" },
    });
    assert.equal(badNameRes.statusCode, 400);

    // 8. Update name, sql, and favorite flag
    const patchRes = await app.inject({
      method: "PATCH",
      url: `/v1/projects/${slugA}/database/queries/${created.id}`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {
        name: "active-users-report",
        sql: "SELECT count(*) AS total FROM users;",
        favorite: true,
      },
    });
    assert.equal(patchRes.statusCode, 200);
    const patched = patchRes.json().query;
    assert.equal(patched.name, "active-users-report");
    assert.equal(patched.favorite, true);
    assert.match(patched.sql, /SELECT count/);

    // 9. Running SQL through the workbench with savedQueryId records run stats
    const runRes = await app.inject({
      method: "POST",
      url: `/v1/projects/${slugA}/database/sql`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { sql: "SELECT 1 AS one;", savedQueryId: patched.id },
    });
    assert.equal(runRes.statusCode, 200);

    const afterRun = await app.inject({
      method: "GET",
      url: `/v1/projects/${slugA}/database/queries`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    const ranQuery = afterRun.json().queries.find(
      (q: { id: string }) => q.id === patched.id
    );
    assert.equal(ranQuery.run_count, 1);
    assert.ok(ranQuery.last_run_at);

    // 10. Viewer members can read the library but not mutate it
    const addViewer = await app.inject({
      method: "POST",
      url: `/v1/projects/${slugA}/members`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { userId: viewerUser.id, role: "viewer" },
    });
    assert.equal(addViewer.statusCode, 201);

    const viewerList = await app.inject({
      method: "GET",
      url: `/v1/projects/${slugA}/database/queries`,
      headers: { authorization: `Bearer ${viewerToken}` },
    });
    assert.equal(viewerList.statusCode, 200);
    assert.equal(viewerList.json().queries.length, 1);

    const viewerCreate = await app.inject({
      method: "POST",
      url: `/v1/projects/${slugA}/database/queries`,
      headers: { authorization: `Bearer ${viewerToken}` },
      payload: { name: "viewer-query", sql: "SELECT 1;" },
    });
    assert.equal(viewerCreate.statusCode, 403);

    const viewerDelete = await app.inject({
      method: "DELETE",
      url: `/v1/projects/${slugA}/database/queries/${patched.id}`,
      headers: { authorization: `Bearer ${viewerToken}` },
    });
    assert.equal(viewerDelete.statusCode, 403);

    // 11. Saved queries never leak across project boundaries
    const crossList = await app.inject({
      method: "GET",
      url: `/v1/projects/${slugB}/database/queries`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(crossList.statusCode, 200);
    assert.deepEqual(crossList.json().queries, []);

    const crossPatch = await app.inject({
      method: "PATCH",
      url: `/v1/projects/${slugB}/database/queries/${patched.id}`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { name: "hijacked" },
    });
    assert.equal(crossPatch.statusCode, 404);

    const crossDelete = await app.inject({
      method: "DELETE",
      url: `/v1/projects/${slugB}/database/queries/${patched.id}`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(crossDelete.statusCode, 404);

    // 12. Owner can delete; the library is empty again
    const deleteRes = await app.inject({
      method: "DELETE",
      url: `/v1/projects/${slugA}/database/queries/${patched.id}`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(deleteRes.statusCode, 200);
    assert.equal(deleteRes.json().deleted.name, "active-users-report");

    const finalList = await app.inject({
      method: "GET",
      url: `/v1/projects/${slugA}/database/queries`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    assert.deepEqual(finalList.json().queries, []);

    // 13. Saved query mutations are recorded in the project audit trail
    const auditRes = await app.inject({
      method: "GET",
      url: `/v1/projects/${slugA}/audit?limit=100`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(auditRes.statusCode, 200);
    const actions = auditRes
      .json()
      .events.map((event: { action: string }) => event.action);
    assert.ok(actions.includes("database.saved_query.created"));
    assert.ok(actions.includes("database.saved_query.updated"));
    assert.ok(actions.includes("database.saved_query.deleted"));
  } finally {
    await app.close();
  }
});
