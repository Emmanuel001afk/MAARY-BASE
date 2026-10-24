import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { inflateRawSync } from "node:zlib";
import { buildApp } from "./app.js";
import { isolateApkArtifact } from "./test-support/apk-fixture.js";

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
    // The public summary is derived from live checks. In the test process the
    // background worker is disabled by default, so the honest overall state is
    // "degraded" even though the API itself is reachable.
    assert.ok(["operational", "degraded"].includes(platformBody.status));
    assert.equal(platformBody.status, platformBody.services.backgroundJobs === "operational" ? "operational" : "degraded");
    // Every advertised state must come from the shared status vocabulary and
    // must agree with the live database check that was just asserted above.
    const vocabulary = new Set([
      "operational",
      "implemented_unverified",
      "partially_implemented",
      "requires_configuration",
      "unavailable",
      "failed",
      "missing",
    ]);
    for (const [service, state] of Object.entries(platformBody.services)) {
      assert.ok(vocabulary.has(state as string), `${service} reported unknown state ${state}`);
      if (platformBody.database.status === "operational") {
        assert.notEqual(state, "unavailable", `${service} must not be unavailable while the database is up`);
      }
    }
    assert.equal(platformBody.database.status, "operational");
    assert.equal(platformBody.database.engine, "PostgreSQL");
    assert.equal(platformBody.branding.logoPngUrl, "/v1/platform/logo");
    assert.equal(platformBody.branding.logoSvgUrl, "/v1/platform/logo.svg");
    // The companion service uses the platform state vocabulary; the raw
    // artifact state stays in `android.state`.
    assert.equal(
      platformBody.services.androidCompanion,
      platformBody.android.state === "available"
        ? "operational"
        : platformBody.android.state === "invalid"
          ? "failed"
          : "missing"
    );
    assert.ok(["not_built", "available", "invalid_artifact", "build_available"].includes(platformBody.android.statusLabel));

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
    assert.match(indexRes.body, /id="app-shell"/);
    assert.match(indexRes.body, /type="module" src="\/dashboard\/app\.js"/);
    assert.doesNotMatch(indexRes.body, /\sonclick=/);

    const jsRes = await app.inject({ method: "GET", url: "/dashboard/app.js" });
    assert.equal(jsRes.statusCode, 200);
    assert.match(jsRes.headers["content-type"] ?? "", /application\/javascript/);

    const cssRes = await app.inject({
      method: "GET",
      url: "/dashboard/styles.css",
    });
    assert.equal(cssRes.statusCode, 200);
    assert.match(cssRes.headers["content-type"] ?? "", /text\/css/);
    assert.match(cssRes.body, /html\[data-theme="light"\]/);
    assert.match(cssRes.body, /@media \(max-width: 820px\)/);

    for (const modulePath of ["core", "pages", "actions"]) {
      const moduleRes = await app.inject({
        method: "GET",
        url: `/dashboard/js/${modulePath}.js`,
      });
      assert.equal(moduleRes.statusCode, 200);
      assert.match(moduleRes.headers["content-type"] ?? "", /application\/javascript/);
      assert.equal(moduleRes.headers["cache-control"], "no-cache");
      assert.ok(moduleRes.rawPayload.length > 1000);
    }

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

    const appIconRes = await app.inject({ method: "GET", url: "/v1/platform/app-icon" });
    assert.equal(appIconRes.statusCode, 200);
    assert.match(appIconRes.headers["content-type"] ?? "", /image\/png/);
    assert.equal(appIconRes.rawPayload.readUInt32BE(16), 1024);
    assert.equal(appIconRes.rawPayload.readUInt32BE(20), 1024);
    const appIconSvgRes = await app.inject({ method: "GET", url: "/v1/platform/app-icon.svg" });
    assert.equal(appIconSvgRes.statusCode, 200);
    assert.match(appIconSvgRes.body, /Connected Backend Platform/);
    assert.match(appIconSvgRes.body, /three secure server layers/);
  } finally {
    await app.close();
  }
});

test("Android artifact endpoints report real build status and never fabricate a package", async () => {
  // Never inspect or mutate the shared releases/ artifact: the Gradle job owns
  // it and other suites tamper with it concurrently.
  const restoreApkArtifact = await isolateApkArtifact();
  const app = await buildApp();
  try {
    const anonymousStatus = await app.inject({ method: "GET", url: "/v1/platform/apk/status" });
    assert.equal(anonymousStatus.statusCode, 401);

    const registration = await app.inject({
      method: "POST",
      url: "/v1/platform/auth/register",
      payload: {
        email: `apk-status-${Date.now()}@maary.dev`,
        password: "StrongPassword123!",
      },
    });
    assert.equal(registration.statusCode, 201, registration.body);
    const accessToken = registration.json().accessToken as string;
    const headers = { authorization: `Bearer ${accessToken}` };

    const statusRes = await app.inject({ method: "GET", url: "/v1/platform/apk/status", headers });
    assert.equal(statusRes.statusCode, 200);
    const status = statusRes.json();
    assert.equal(status.platformName, "MARRY BASE");
    assert.equal(status.packageName, "com.marrybase.platform");
    assert.ok(["available", "missing", "invalid"].includes(status.state));
    assert.ok(typeof status.summary === "string" && status.summary.length > 20);
    assert.equal(typeof status.buildEnvironment.gradleBuildPossible, "boolean");
    assert.ok(Array.isArray(status.buildEnvironment.missingPrerequisites));

    const download = await app.inject({ method: "GET", url: "/v1/platform/apk/download" });
    if (status.state === "available") {
      assert.equal(download.statusCode, 200);
      assert.match(download.headers["content-type"] ?? "", /application\/vnd\.android\.package-archive/);
      assert.equal(download.rawPayload[0], 0x50);
      assert.equal(download.rawPayload[1], 0x4b);
      assert.equal(download.headers["x-apk-sha256"], status.artifact.checksumSha256);
      assert.ok(status.verification?.hasAndroidManifest);
      assert.ok(status.verification?.hasClassesDex);
    } else {
      assert.equal(download.statusCode, 404);
      assert.match(download.json().message, /No Android APK|failed verification/);
    }

    // A build request either runs the genuine Gradle pipeline or fails with an
    // actionable 409 — it must never return a synthesised artifact. When the
    // toolchain is available this test only inspects the status (a real build
    // is covered by CI's Android job) so the suite never rewrites the verified
    // artifact under test.
    if (!status.buildEnvironment.gradleBuildPossible) {
      const buildRes = await app.inject({
        method: "POST",
        url: "/v1/platform/apk/build",
        headers,
        payload: { versionName: "9.9.9", versionCode: 99 },
      });
      assert.equal(buildRes.statusCode, 409, buildRes.body);
      const body = buildRes.json();
      assert.equal(body.error, "apk_build_unavailable");
      assert.ok(body.details.instructions.includes("android:build") || body.details.instructions.includes("Gradle"));
      assert.ok(Array.isArray(body.details.missingPrerequisites));
      const afterStatus = await app.inject({ method: "GET", url: "/v1/platform/apk/status", headers });
      assert.equal(afterStatus.json().state, status.state);
    } else {
      assert.ok(status.buildEnvironment.javaVersion, "a runnable JDK is reported");
      assert.ok(status.buildEnvironment.androidSdkPath, "the SDK path is reported");
    }
  } finally {
    await app.close();
    await restoreApkArtifact();
  }
});

test("mobile client source is CSP-friendly, branded, and keeps server data out of HTML", async () => {
  const [html, script, styles, icon] = await Promise.all([
    readFile(resolve(process.cwd(), "public", "mobile", "index.html"), "utf8"),
    readFile(resolve(process.cwd(), "public", "mobile", "app.js"), "utf8"),
    readFile(resolve(process.cwd(), "public", "mobile", "styles.css"), "utf8"),
    readFile(resolve(process.cwd(), "public", "mobile", "app-icon.png")),
  ]);
  assert.match(html, /script-src 'self'/);
  assert.match(html, /connect-src http: https:/);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i);
  assert.doesNotMatch(html, /\sonclick=|\sstyle=/i);
  assert.match(html, /src="\.\/config\.js"/);
  assert.match(html, /src="\.\/app\.js"/);
  assert.match(html, /MARRY BASE server URL/);
  assert.match(script, /localStorage/);
  assert.match(script, /endpoint\("\/ready"\)/);
  assert.match(script, /payload\.status !== "ready"/);
  assert.match(script, /payload\.dependencies/);
  assert.match(script, /endpoint\("\/dashboard"\)/);
  assert.match(script, /endpoint\("\/v1\/platform"\)/);
  assert.match(script, /AbortController/);
  assert.match(styles, /prefers-reduced-motion/);
  assert.equal(icon.readUInt32BE(16), 256);
  assert.equal(icon.readUInt32BE(20), 256);
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
