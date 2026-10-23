import test from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "./app.js";

test("health endpoint reports process health without claiming dependency readiness", async () => {
  const app = await buildApp();
  try {
    const response = await app.inject({ method: "GET", url: "/health" });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, "ok");
  } finally {
    await app.close();
  }
});

test("unknown endpoint returns structured 404", async () => {
  const app = await buildApp();
  try {
    const response = await app.inject({ method: "GET", url: "/missing" });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error, "not_found");
  } finally {
    await app.close();
  }
});

test("project control-plane endpoints reject anonymous access", async () => {
  const app = await buildApp();
  try {
    const response = await app.inject({ method: "GET", url: "/v1/projects" });
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error, "request_error");
  } finally {
    await app.close();
  }
});

test("registration validates input before touching persistence", async () => {
  const app = await buildApp();
  try {
    const response = await app.inject({ method: "POST", url: "/v1/auth/register", payload: { email: "invalid", password: "short", displayName: "" } });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().message, "Provide a valid email, a password of at least 12 characters, and a display name.");
  } finally {
    await app.close();
  }
});
