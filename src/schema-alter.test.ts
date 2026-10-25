import test from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "./app.js";

test("schema alterations: rename_table and alter_column with safety rails", async () => {
  const app = await buildApp();
  try {
    const reg = await app.inject({
      method: "POST",
      url: "/v1/platform/auth/register",
      payload: {
        email: `alter-${Date.now()}@maary.dev`,
        password: "AlterPassword123!",
        name: "Schema Alter Operator",
      },
    });
    assert.equal(reg.statusCode, 201);
    const token = reg.json().accessToken as string;

    const slug = `alter-demo-${Date.now()}`;
    const createProject = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Alter Demo", slug },
    });
    assert.equal(createProject.statusCode, 201);
    const base = `/v1/projects/${slug}`;

    const createTable = await app.inject({
      method: "POST",
      url: `${base}/database/tables`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: "articles",
        enableRls: true,
        columns: [
          { name: "id", type: "uuid", primaryKey: true, defaultValue: "gen_random_uuid()" },
          { name: "headline", type: "text", notNull: true },
          { name: "views", type: "integer", defaultValue: "0" },
        ],
      },
    });
    assert.equal(createTable.statusCode, 201);

    // --- alter_column: change type, default, and nullability ---
    const alterColumn = await app.inject({
      method: "PATCH",
      url: `${base}/database/tables/articles`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        action: "alter_column",
        columnName: "views",
        type: "bigint",
        defaultValue: "10",
        notNull: true,
      },
    });
    assert.equal(alterColumn.statusCode, 200);
    const viewsCol = alterColumn
      .json()
      .table.columns.find((c: { name: string }) => c.name === "views");
    assert.equal(viewsCol.dataType, "bigint");
    assert.equal(viewsCol.isNullable, false);
    assert.match(String(viewsCol.defaultValue), /10/);

    // Existing data still readable and insertable through the Data API
    const insertRow = await app.inject({
      method: "POST",
      url: `${base}/rest/articles`,
      headers: { authorization: `Bearer ${token}` },
      payload: { headline: "First release", views: 42 },
    });
    assert.equal(insertRow.statusCode, 201);

    // Empty alter_column body is rejected
    const emptyAlter = await app.inject({
      method: "PATCH",
      url: `${base}/database/tables/articles`,
      headers: { authorization: `Bearer ${token}` },
      payload: { action: "alter_column", columnName: "views" },
    });
    assert.equal(emptyAlter.statusCode, 400);

    // Unsafe column types are rejected
    const unsafeType = await app.inject({
      method: "PATCH",
      url: `${base}/database/tables/articles`,
      headers: { authorization: `Bearer ${token}` },
      payload: { action: "alter_column", columnName: "views", type: "text; DROP TABLE articles" },
    });
    assert.equal(unsafeType.statusCode, 400);

    // Unsafe defaults are rejected
    const unsafeDefault = await app.inject({
      method: "PATCH",
      url: `${base}/database/tables/articles`,
      headers: { authorization: `Bearer ${token}` },
      payload: { action: "alter_column", columnName: "views", defaultValue: "(SELECT 1)" },
    });
    assert.equal(unsafeDefault.statusCode, 400);

    // dropDefault + DROP NOT NULL round-trip
    const relaxColumn = await app.inject({
      method: "PATCH",
      url: `${base}/database/tables/articles`,
      headers: { authorization: `Bearer ${token}` },
      payload: { action: "alter_column", columnName: "views", dropDefault: true, notNull: false },
    });
    assert.equal(relaxColumn.statusCode, 200);
    const relaxed = relaxColumn
      .json()
      .table.columns.find((c: { name: string }) => c.name === "views");
    assert.equal(relaxed.isNullable, true);
    assert.equal(relaxed.defaultValue, null);

    // --- rename_table ---
    const conflictRename = await app.inject({
      method: "POST",
      url: `${base}/database/tables`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: "posts",
        columns: [{ name: "id", type: "uuid", primaryKey: true, defaultValue: "gen_random_uuid()" }],
      },
    });
    assert.equal(conflictRename.statusCode, 201);

    const clashRename = await app.inject({
      method: "PATCH",
      url: `${base}/database/tables/articles`,
      headers: { authorization: `Bearer ${token}` },
      payload: { action: "rename_table", toName: "posts" },
    });
    assert.equal(clashRename.statusCode, 409);

    const rename = await app.inject({
      method: "PATCH",
      url: `${base}/database/tables/articles`,
      headers: { authorization: `Bearer ${token}` },
      payload: { action: "rename_table", toName: "stories" },
    });
    assert.equal(rename.statusCode, 200);
    assert.equal(rename.json().table.name, "stories");

    // Data survived the rename and RLS triggers still fire through the Data API
    const readRenamed = await app.inject({
      method: "GET",
      url: `${base}/rest/stories?limit=5`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(readRenamed.statusCode, 200);
    assert.equal(readRenamed.json().data.length, 1);

    const oldTableGone = await app.inject({
      method: "GET",
      url: `${base}/database/tables/articles`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(oldTableGone.statusCode, 404);

    // Invalid identifiers are rejected
    const badRename = await app.inject({
      method: "PATCH",
      url: `${base}/database/tables/stories`,
      headers: { authorization: `Bearer ${token}` },
      payload: { action: "rename_table", toName: "not valid!!" },
    });
    assert.equal(badRename.statusCode, 400);

    // --- REST count=exact returns the filtered total for grid pagination ---
    for (let i = 0; i < 5; i += 1) {
      await app.inject({
        method: "POST",
        url: `${base}/rest/stories`,
        headers: { authorization: `Bearer ${token}` },
        payload: { headline: `Story ${i}` },
      });
    }
    const counted = await app.inject({
      method: "GET",
      url: `${base}/rest/stories?limit=2&count=exact`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(counted.statusCode, 200);
    assert.equal(counted.json().data.length, 2);
    assert.equal(counted.json().count, 6);

    // Audit trail records both new operations
    const audit = await app.inject({
      method: "GET",
      url: `${base}/audit?limit=100`,
      headers: { authorization: `Bearer ${token}` },
    });
    const actions = audit.json().events.map((e: { action: string }) => e.action);
    assert.ok(actions.includes("database.table.alter_column"));
    assert.ok(actions.includes("database.table.rename_table"));
  } finally {
    await app.close();
  }
});
