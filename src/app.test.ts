import test from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "./app.js";
test("health endpoint returns service health", async () => { const app = await buildApp(); try { const response = await app.inject({ method: "GET", url: "/health" }); assert.equal(response.statusCode, 200); assert.equal(response.json().status, "ok"); } finally { await app.close(); } });
test("unknown endpoint returns structured 404", async () => { const app = await buildApp(); try { const response = await app.inject({ method: "GET", url: "/missing" }); assert.equal(response.statusCode, 404); assert.equal(response.json().error, "not_found"); } finally { await app.close(); } });
