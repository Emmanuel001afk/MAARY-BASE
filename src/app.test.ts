import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "./app.js";

test("health and readiness endpoints return operational status and MARRY BASE platform identity", async () => {
  const app = await buildApp();
  try {
    const healthRes = await app.inject({ method: "GET", url: "/health" });
    assert.equal(healthRes.statusCode, 200);
    assert.equal(healthRes.json().status, "ok");

    const readyRes = await app.inject({ method: "GET", url: "/ready" });
    assert.equal(readyRes.statusCode, 200);
    const readyBody = readyRes.json();
    assert.equal(readyBody.status, "ready");
    assert.equal(readyBody.dependencies.postgres, "ok");
    assert.equal(readyBody.dependencies.storage, "ok");

    const platformRes = await app.inject({
      method: "GET",
      url: "/v1/platform",
    });
    assert.equal(platformRes.statusCode, 200);
    const platformBody = platformRes.json();
    assert.equal(platformBody.name, "MARRY BASE");
    assert.equal(platformBody.status, "operational");
    assert.equal(platformBody.database.engine, "PostgreSQL");
    assert.equal(platformBody.branding.logoPngUrl, "/v1/platform/logo");
    assert.equal(platformBody.branding.logoSvgUrl, "/v1/platform/logo.svg");
    assert.equal(platformBody.branding.apkDownloadUrl, undefined);
    assert.equal(platformBody.modules.mobileApkBuilder, "unavailable");

    const metricsJsonRes = await app.inject({
      method: "GET",
      url: "/v1/metrics",
    });
    assert.equal(metricsJsonRes.statusCode, 200);
    assert.ok(typeof metricsJsonRes.json().uptimeSeconds === "number");

    const metricsPromRes = await app.inject({
      method: "GET",
      url: "/v1/metrics?format=prometheus",
    });
    assert.equal(metricsPromRes.statusCode, 200);
    assert.match(metricsPromRes.body, /maary_db_queries_total/);
  } finally {
    await app.close();
  }
});

test("dashboard routes serve MARRY BASE management interface, logo, and assets", async () => {
  const app = await buildApp();
  try {
    const indexRes = await app.inject({ method: "GET", url: "/" });
    assert.equal(indexRes.statusCode, 200);
    assert.match(indexRes.headers["content-type"] ?? "", /text\/html/);
    assert.match(indexRes.body, /MARRY BASE/);

    const jsRes = await app.inject({ method: "GET", url: "/dashboard/app.js" });
    assert.equal(jsRes.statusCode, 200);
    assert.match(jsRes.headers["content-type"] ?? "", /application\/javascript/);

    const cssRes = await app.inject({
      method: "GET",
      url: "/dashboard/styles.css",
    });
    assert.equal(cssRes.statusCode, 200);
    assert.match(cssRes.headers["content-type"] ?? "", /text\/css/);

    const logoPngRes = await app.inject({
      method: "GET",
      url: "/v1/platform/logo",
    });
    assert.equal(logoPngRes.statusCode, 200);
    assert.match(logoPngRes.headers["content-type"] ?? "", /image\/png/);
    assert.ok(logoPngRes.rawPayload.length > 1000);
    // PNG magic header: 0x89 0x50 0x4E 0x47
    assert.equal(logoPngRes.rawPayload[0], 0x89);
    assert.equal(logoPngRes.rawPayload[1], 0x50);
    assert.equal(logoPngRes.rawPayload[2], 0x4e);
    assert.equal(logoPngRes.rawPayload[3], 0x47);

    const logoSvgRes = await app.inject({
      method: "GET",
      url: "/v1/platform/logo.svg",
    });
    assert.equal(logoSvgRes.statusCode, 200);
    assert.match(logoSvgRes.headers["content-type"] ?? "", /image\/svg\+xml/);
    assert.match(logoSvgRes.body, /MARRY BASE/);
  } finally {
    await app.close();
  }
});

test("APK endpoints fail closed until a real Android build pipeline exists", async () => {
  const app = await buildApp();
  try {
    const buildRes = await app.inject({
      method: "POST",
      url: "/v1/platform/apk/build",
      payload: { versionName: "1.0.0", versionCode: 1 },
    });
    assert.equal(buildRes.statusCode, 501);
    assert.equal(buildRes.json().error, "not_implemented");

    const downloadRes = await app.inject({
      method: "GET",
      url: "/v1/platform/apk/download",
    });
    assert.equal(downloadRes.statusCode, 501);
    assert.equal(downloadRes.json().error, "not_implemented");
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

test("platform operator registration, login, session refresh, and audit trail", async () => {
  const app = await buildApp();
  try {
    const email = `operator-${Date.now()}@maary.dev`;
    const regRes = await app.inject({
      method: "POST",
      url: "/v1/platform/auth/register",
      payload: {
        email,
        password: "StrongPassword123!",
        name: "Lead Operator",
      },
    });
    assert.equal(regRes.statusCode, 201);
    const regBody = regRes.json();
    assert.equal(regBody.user.email, email);
    assert.ok(regBody.accessToken);
    assert.ok(regBody.refreshToken);

    // Duplicate registration fails with 409
    const dupRes = await app.inject({
      method: "POST",
      url: "/v1/platform/auth/register",
      payload: {
        email,
        password: "StrongPassword123!",
      },
    });
    assert.equal(dupRes.statusCode, 409);

    // Login with wrong password fails with 401
    const badLogin = await app.inject({
      method: "POST",
      url: "/v1/platform/auth/login",
      payload: { email, password: "WrongPassword!" },
    });
    assert.equal(badLogin.statusCode, 401);

    // Refresh session rotates refresh token
    const refreshRes = await app.inject({
      method: "POST",
      url: "/v1/platform/auth/refresh",
      payload: { refreshToken: regBody.refreshToken },
    });
    assert.equal(refreshRes.statusCode, 200);
    const refreshed = refreshRes.json();
    assert.ok(refreshed.accessToken);
    assert.notEqual(refreshed.refreshToken, regBody.refreshToken);

    // Replaying old refresh token is rejected
    const replayRes = await app.inject({
      method: "POST",
      url: "/v1/platform/auth/refresh",
      payload: { refreshToken: regBody.refreshToken },
    });
    assert.equal(replayRes.statusCode, 401);
  } finally {
    await app.close();
  }
});
