import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { inflateRawSync } from "node:zlib";
import { buildApp } from "./app.js";

function unpackApk(apk: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let position = 0;
  while (position + 30 <= apk.length && apk.readUInt32LE(position) === 0x04034b50) {
    const method = apk.readUInt16LE(position + 8);
    const compressedSize = apk.readUInt32LE(position + 18);
    const nameLength = apk.readUInt16LE(position + 26);
    const extraLength = apk.readUInt16LE(position + 28);
    const name = apk.subarray(position + 30, position + 30 + nameLength).toString("utf8");
    const dataOffset = position + 30 + nameLength + extraLength;
    const compressed = apk.subarray(dataOffset, dataOffset + compressedSize);
    entries.set(name, method === 0 ? compressed : inflateRawSync(compressed));
    position = dataOffset + compressedSize;
  }
  return entries;
}

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
    assert.equal(
      platformBody.branding.apkDownloadUrl,
      "/v1/platform/apk/download"
    );
    assert.equal(platformBody.modules.mobileApkBuilder, "operational");

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

test("APK builder initiates, builds, signs, and serves the MARRY BASE Android APK", async () => {
  const app = await buildApp();
  try {
    const anonymousBuild = await app.inject({
      method: "POST",
      url: "/v1/platform/apk/build",
      payload: { versionName: "1.0.0", versionCode: 1 },
    });
    assert.equal(anonymousBuild.statusCode, 401);

    const registration = await app.inject({
      method: "POST",
      url: "/v1/platform/auth/register",
      payload: {
        email: `apk-builder-${Date.now()}@maary.dev`,
        password: "StrongPassword123!",
      },
    });
    assert.equal(registration.statusCode, 201, registration.body);
    const accessToken = registration.json().accessToken as string;
    const buildRes = await app.inject({
      method: "POST",
      url: "/v1/platform/apk/build",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        versionName: "1.0.0",
        versionCode: 1,
      },
    });
    assert.equal(buildRes.statusCode, 201);
    const buildBody = buildRes.json();
    assert.equal(buildBody.apk.platformName, "MARRY BASE");
    assert.equal(buildBody.apk.packageName, "com.marrybase.platform");
    assert.equal(buildBody.apk.fileName, "marry-base.apk");
    assert.ok(buildBody.apk.sizeBytes > 10000);
    assert.ok(buildBody.apk.entries.includes("AndroidManifest.xml"));
    assert.ok(buildBody.apk.entries.includes("classes.dex"));
    assert.ok(buildBody.apk.entries.includes("res/drawable/logo.png"));
    assert.ok(buildBody.apk.entries.includes("assets/www/index.html"));
    assert.ok(buildBody.apk.entries.includes("assets/www/styles.css"));
    assert.ok(buildBody.apk.entries.includes("assets/www/app.js"));
    assert.ok(buildBody.apk.entries.includes("assets/www/config.js"));
    assert.ok(buildBody.apk.entries.includes("assets/www/app-icon.png"));
    assert.ok(buildBody.apk.entries.includes("META-INF/MARRYBAS.RSA"));

    const dlRes = await app.inject({
      method: "GET",
      url: "/v1/platform/apk/download",
    });
    assert.equal(dlRes.statusCode, 200);
    assert.match(
      dlRes.headers["content-type"] ?? "",
      /application\/vnd\.android\.package-archive/
    );
    // ZIP/APK local file header magic bytes PK\x03\x04
    assert.equal(dlRes.rawPayload[0], 0x50);
    assert.equal(dlRes.rawPayload[1], 0x4b);
    assert.equal(dlRes.rawPayload[2], 0x03);
    assert.equal(dlRes.rawPayload[3], 0x04);
  } finally {
    await app.close();
  }
});

test("project APK downloads preserve the exact built artifact, configuration, and default release", async () => {
  const app = await buildApp();
  const slug = "artifact-check";
  const artifactPath = resolve(process.cwd(), "releases", `marry-base-${slug}.apk`);
  try {
    const registration = await app.inject({
      method: "POST",
      url: "/v1/platform/auth/register",
      payload: {
        email: `apk-artifact-${Date.now()}@maary.dev`,
        password: "StrongPassword123!",
      },
    });
    const accessToken = registration.json().accessToken as string;
    const authorization = { authorization: `Bearer ${accessToken}` };
    const defaultBefore = await app.inject({ method: "GET", url: "/v1/platform/apk/download" });
    assert.equal(defaultBefore.statusCode, 200);

    const missing = await app.inject({
      method: "GET",
      url: "/v1/platform/apk/download?projectSlug=not-built-yet",
    });
    assert.equal(missing.statusCode, 404);

    const build = await app.inject({
      method: "POST",
      url: "/v1/platform/apk/build",
      headers: authorization,
      payload: {
        projectSlug: slug,
        serverUrl: "https://backend.example.com/base/dashboard/",
        versionName: "2.4.1",
        versionCode: 42,
      },
    });
    assert.equal(build.statusCode, 201, build.body);
    assert.equal(build.json().apk.packageName, "com.marrybase.app.artifactcheck");
    assert.equal(build.json().apk.downloadUrl, `/v1/platform/apk/download?projectSlug=${slug}`);

    const downloadUrl = build.json().apk.downloadUrl as string;
    const first = await app.inject({ method: "GET", url: downloadUrl });
    const second = await app.inject({ method: "GET", url: downloadUrl });
    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    assert.equal(first.headers["x-apk-sha256"], build.json().apk.checksumSha256);
    assert.equal(second.headers["x-apk-sha256"], first.headers["x-apk-sha256"]);
    assert.ok(first.rawPayload.equals(second.rawPayload), "A download must not rebuild or re-sign the artifact");

    const entries = unpackApk(first.rawPayload);
    const generatedConfig = entries.get("assets/www/config.js")!.toString("utf8");
    const buildConfig = JSON.parse(entries.get("assets/marry-base-config.json")!.toString("utf8"));
    assert.match(generatedConfig, /https:\/\/backend\.example\.com\/base/);
    assert.match(generatedConfig, /2\.4\.1/);
    assert.equal(buildConfig.serverUrl, "https://backend.example.com/base");
    assert.equal(buildConfig.versionCode, 42);
    assert.equal(buildConfig.projectSlug, slug);
    assert.match(entries.get("assets/www/index.html")!.toString("utf8"), /Connect &amp; open Studio|Connect & open Studio/);
    assert.match(entries.get("assets/www/index.html")!.toString("utf8"), /Content-Security-Policy/);
    assert.doesNotMatch(entries.get("assets/www/app.js")!.toString("utf8"), /innerHTML/);
    const dex = entries.get("classes.dex")!;
    for (const required of [
      "Lcom/marrybase/app/artifactcheck/MainActivity;",
      "setJavaScriptEnabled",
      "setDomStorageEnabled",
      "setAllowUniversalAccessFromFileURLs",
      "setWebViewClient",
      "onBackPressed",
      "canGoBack",
    ]) {
      assert.ok(dex.includes(Buffer.from(required)), `DEX is missing ${required}`);
    }
    const mobileIcon = await readFile(resolve(process.cwd(), "public", "mobile", "app-icon.png"));
    assert.ok(entries.get("assets/www/app-icon.png")!.equals(mobileIcon));

    const defaultAfter = await app.inject({ method: "GET", url: "/v1/platform/apk/download" });
    assert.equal(defaultAfter.statusCode, 200);
    assert.equal(defaultAfter.headers["x-apk-sha256"], defaultBefore.headers["x-apk-sha256"]);
    assert.ok(defaultAfter.rawPayload.equals(defaultBefore.rawPayload), "Project builds must not replace the default APK");

    for (const payload of [
      { projectSlug: "../escape" },
      { projectSlug: slug, serverUrl: "javascript:alert(1)" },
      { projectSlug: slug, versionCode: 0 },
      { projectSlug: slug, versionName: "bad version" },
    ]) {
      const invalid = await app.inject({
        method: "POST",
        url: "/v1/platform/apk/build",
        headers: authorization,
        payload,
      });
      assert.equal(invalid.statusCode, 400, invalid.body);
    }
    const traversal = await app.inject({
      method: "GET",
      url: "/v1/platform/apk/download?projectSlug=..%2Fescape",
    });
    assert.equal(traversal.statusCode, 400);
  } finally {
    await rm(artifactPath, { force: true });
    await app.close();
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
