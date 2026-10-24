import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { JSDOM } from "jsdom";
import { buildApp } from "./app.js";

/**
 * Workflow-level studio test. Where studio.test.ts proves that each section
 * renders against the live API, this suite drives the real form and action
 * handlers in a DOM: creating a table, inserting a row, running SQL, adding an
 * RLS policy, uploading an object, deploying and invoking a function,
 * enqueueing a job, and creating, verifying and restoring a backup.
 */

type App = Awaited<ReturnType<typeof buildApp>>;

async function bootStudio() {
  const app: App = await buildApp();
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("No server address");
  const base = `http://127.0.0.1:${address.port}`;

  let dom: JSDOM | null = null;
  try {
  const html = await readFile(resolve(process.cwd(), "public", "dashboard", "index.html"), "utf8");
  dom = new JSDOM(html, { url: `${base}/dashboard#overview`, pretendToBeVisual: true });
  const { window } = dom;
  const nativeFetch = globalThis.fetch;
  const studioFetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    nativeFetch(typeof input === "string" ? new URL(input, base).href : input, init)) as typeof fetch;

  const globals: Record<string, unknown> = {
    window,
    document: window.document,
    navigator: window.navigator,
    localStorage: window.localStorage,
    CustomEvent: window.CustomEvent,
    HTMLElement: window.HTMLElement,
    HTMLFormElement: window.HTMLFormElement,
    FormData: window.FormData,
    Blob: window.Blob,
    AbortController: window.AbortController,
    fetch: studioFetch,
    WebSocket: window.WebSocket,
    performance: globalThis.performance,
  };
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }

  // jsdom does not implement <dialog> modality. Auto-confirming keeps the real
  // confirmAction() code path (including typed confirmation) under test.
  (window as any).HTMLDialogElement.prototype.showModal = function showModal(this: any) {
    this.open = true;
    window.setTimeout(() => {
      this.returnValue = "confirm";
      this.dispatchEvent(new window.Event("close"));
    }, 0);
  };
  (window as any).HTMLDialogElement.prototype.close = function close(this: any) {
    this.open = false;
  };
  (window as any).HTMLElement.prototype.scrollIntoView = function scrollIntoView() {};

  const core = await import(
    pathToFileURL(resolve(process.cwd(), "public", "dashboard", "js", "core.js")).href
  );
  const pages = await import(
    pathToFileURL(resolve(process.cwd(), "public", "dashboard", "js", "pages.js")).href
  );
  const actions = await import(
    pathToFileURL(resolve(process.cwd(), "public", "dashboard", "js", "actions.js")).href
  );

  const registration = await studioFetch("/v1/platform/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: `workflows-${Date.now()}@example.com`,
      password: "StrongPassword123!",
    }),
  });
  const registrationBody = await registration.text();
  assert.equal(registration.status, 201, registrationBody);
  const session = JSON.parse(registrationBody) as any;
  core.setSession(session);
  core.state.user = session.user;

  return { app, dom, window, base, core, pages, actions, session, studioFetch };
  } catch (error) {
    dom?.window.close();
    await app.close();
    throw error;
  }
}

function fill(window: any, id: string, value: string) {
  const element = window.document.getElementById(id);
  assert.ok(element, `#${id} is missing`);
  element.value = value;
  return element;
}

async function apiJson(
  base: string,
  token: string,
  path: string,
  init: RequestInit = {}
): Promise<any> {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Keep the raw body.
  }
  assert.ok(response.ok, `${path} → ${response.status}: ${text.slice(0, 300)}`);
  return body;
}

test("Studio controls execute real workflows against the server", async () => {
  const harness = await bootStudio();
  const { app, dom, window, base, core, pages, actions, session, studioFetch } = harness;
  const token = session.accessToken as string;

  try {
    // 1. Project creation through the modal form.
    let createdSlug = "";
    window.addEventListener("maary:project-created", (event: any) => {
      createdSlug = event.detail.slug;
    });
    pages.renderPage("overview");
    fill(window, "proj-name", "Workflow Project");
    fill(window, "proj-slug", "workflow-project");
    fill(window, "proj-desc", "Created by the studio workflow test");
    await actions.handleSubmit(window.document.getElementById("create-project-form"));
    assert.equal(createdSlug, "workflow-project");

    const details = await apiJson(base, token, `/v1/projects/${createdSlug}`);
    core.state.activeProject = details.project;
    core.state.projects = [details.project];
    core.state.memberRole = "owner";

    // 2. Table creation through the real form (JSON column definitions).
    pages.renderPage("database");
    await pages.loadPage("database");
    fill(window, "tbl-name", "items");
    fill(
      window,
      "tbl-cols",
      JSON.stringify([
        { name: "id", type: "uuid", primaryKey: true, defaultValue: "gen_random_uuid()" },
        { name: "title", type: "text", notNull: true },
        { name: "done", type: "boolean", defaultValue: "false" },
      ])
    );
    fill(window, "tbl-rls", "true");
    await actions.handleSubmit(window.document.getElementById("create-table-form"));
    const tables = await apiJson(base, token, `/v1/projects/${createdSlug}/database/tables`);
    assert.ok(tables.tables.some((table: any) => table.name === "items"));
    assert.ok(window.document.getElementById("tables-list")!.textContent!.includes("items"));

    // 3. Row insert through the data browser.
    core.state.activeTable = "items";
    pages.renderPage("database");
    await pages.loadPage("database");
    fill(window, "row-json-input", JSON.stringify({ title: "Ship it" }));
    await actions.handleSubmit(window.document.getElementById("insert-row-form"));
    const rows = await apiJson(base, token, `/v1/projects/${createdSlug}/rest/items?limit=10`);
    assert.equal(rows.data.length, 1);
    assert.equal(rows.data[0].title, "Ship it");
    assert.ok(window.document.getElementById("table-rows-container")!.textContent!.includes("Ship it"));

    // 3b. Filter, sort and edit rows through the browser controls.
    fill(window, "row-filter-column", "title");
    fill(window, "row-filter-value", "Ship it");
    await actions.handleAction("apply-row-query", window.document.createElement("button"));
    assert.match(
      window.document.getElementById("table-rows-container")!.textContent || "",
      /Ship it/
    );
    fill(window, "row-filter-value", "");
    fill(window, "row-filter-column", "");
    await actions.handleAction("apply-row-query", window.document.createElement("button"));
    assert.match(window.document.getElementById("row-pagination")!.textContent || "", /Showing 1–1 of 1/);

    const originalRow = rows.data[0];
    await actions.handleAction("edit-row", {
      dataset: {
        table: "items",
        filter: `id=eq.${originalRow.id}`,
        row: JSON.stringify(originalRow),
      },
    } as unknown as HTMLElement);
    assert.match((window.document.getElementById("row-edit-json") as HTMLTextAreaElement).value || "", new RegExp(originalRow.id));
    fill(
      window,
      "row-edit-json",
      JSON.stringify({ ...originalRow, done: true, title: "Ship it" })
    );
    await actions.handleSubmit(window.document.getElementById("row-edit-form"));
    const edited = await apiJson(base, token, `/v1/projects/${createdSlug}/rest/items?limit=10`);
    assert.equal(edited.data[0].done, true);
    assert.equal(edited.data[0].title, "Ship it");

    // 3c. Alter the schema (add a column) through the form.
    fill(window, "alter-table-name", "items");
    fill(window, "alter-operation", "add_column");
    fill(window, "alter-column", "priority");
    fill(window, "alter-type", "integer");
    await actions.handleSubmit(window.document.getElementById("alter-table-form"));
    const altered = await apiJson(base, token, `/v1/projects/${createdSlug}/database/tables`);
    const alteredTable = altered.tables.find((table: any) => table.name === "items");
    assert.ok(
      alteredTable.columns.some((column: any) => column.name === "priority"),
      JSON.stringify(alteredTable.columns)
    );

    // 3d. Deleting a row requires confirmation and removes only that row.
    const temporary = await apiJson(base, token, `/v1/projects/${createdSlug}/rest/items`, {
      method: "POST",
      body: JSON.stringify({ title: "temporary row" }),
    });
    const temporaryId = temporary.data[0].id;
    await actions.handleAction("delete-row", {
      dataset: { table: "items", filter: `id=eq.${temporaryId}` },
    } as unknown as HTMLElement);
    const remaining = await apiJson(base, token, `/v1/projects/${createdSlug}/rest/items?limit=10`);
    assert.equal(remaining.data.length, 1);
    assert.equal(remaining.data[0].title, "Ship it");

    // 4. SQL editor executes and renders a result set.
    pages.renderPage("sql");
    await pages.loadPage("sql");
    fill(window, "sql-editor-input", "SELECT count(*)::int AS total FROM items;");
    fill(window, "sql-role-select", "service_role");
    fill(window, "sql-destructive", "false");
    await actions.handleSubmit(window.document.getElementById("sql-form"));
    const sqlOutput = window.document.getElementById("sql-result-box")!.textContent || "";
    assert.match(sqlOutput, /total/);
    assert.match(sqlOutput, /1/);

    // 5. RLS policy creation from the access page.
    pages.renderPage("access");
    await pages.loadPage("access");
    fill(window, "pol-table", "items");
    fill(window, "pol-name", "items_read");
    fill(window, "pol-cmd", "SELECT");
    fill(window, "pol-using", "true");
    await actions.handleSubmit(window.document.getElementById("create-policy-form"));
    const policies = await apiJson(base, token, `/v1/projects/${createdSlug}/database/tables`);
    const items = policies.tables.find((table: any) => table.name === "items");
    assert.ok(items.rlsEnabled, "RLS should be enabled on items");
    assert.ok(
      (items.policies || []).some((policy: any) => policy.policyName === "items_read"),
      JSON.stringify(items.policies)
    );

    // 6. Storage bucket + text upload, then confirm the object is listed.
    pages.renderPage("storage");
    await pages.loadPage("storage");
    fill(window, "bucket-name", "assets");
    fill(window, "bucket-public", "false");
    fill(window, "bucket-limit", "2");
    await actions.handleSubmit(window.document.getElementById("create-bucket-form"));
    const buckets = await apiJson(base, token, `/v1/projects/${createdSlug}/storage/buckets`);
    assert.ok(buckets.buckets.some((bucket: any) => bucket.name === "assets"));
    core.state.activeBucket = "assets";
    fill(window, "obj-path", "notes/hello.txt");
    fill(window, "obj-content", "hello from the studio");
    fill(window, "obj-mime", "text/plain");
    await actions.handleSubmit(window.document.getElementById("upload-object-form"));
    const objects = await apiJson(
      base,
      token,
      `/v1/projects/${createdSlug}/storage/buckets/assets/objects`
    );
    assert.ok(JSON.stringify(objects).includes("notes/hello.txt"));

    // 7. Function deploy + invoke, using the documented ctx.req.body contract.
    pages.renderPage("functions");
    await pages.loadPage("functions");
    fill(window, "fn-slug", "echo");
    fill(window, "fn-name", "Echo");
    fill(window, "fn-jwt", "false");
    fill(window, "fn-timeout", "5000");
    fill(
      window,
      "fn-code",
      "async function handler(ctx) { return { statusCode: 200, body: { received: ctx.req.body, role: ctx.auth.role } }; }"
    );
    await actions.handleSubmit(window.document.getElementById("deploy-fn-form"));
    await pages.loadPage("functions");
    fill(window, "fn-invoke-slug", "echo");
    fill(window, "fn-payload", JSON.stringify({ name: "Ada" }));
    await actions.handleSubmit(window.document.getElementById("invoke-fn-form"));
    const invocationText = window.document.getElementById("fn-invoke-output")!.textContent || "";
    assert.match(invocationText, /Ada/);
    assert.match(invocationText, /received/);

    // 8. Enqueue a background job, then process due work from the studio.
    pages.renderPage("jobs");
    await pages.loadPage("jobs");
    fill(window, "job-type", "function");
    fill(window, "job-queue", "default");
    fill(window, "job-delay", "0");
    fill(window, "job-payload", JSON.stringify({ functionSlug: "echo", body: { from: "job" } }));
    await actions.handleSubmit(window.document.getElementById("create-job-form"));
    await actions.handleAction("process-jobs", window.document.createElement("button"));
    const jobs = await apiJson(base, token, `/v1/projects/${createdSlug}/jobs`);
    assert.ok(Array.isArray(jobs.jobs) && jobs.jobs.length >= 1);
    assert.equal(jobs.jobs[0].job_type, "function");

    // 9. Migration through the form, verified via migration history.
    pages.renderPage("migrations");
    await pages.loadPage("migrations");
    fill(window, "mig-version", "100");
    fill(window, "mig-name", "add_tags");
    fill(window, "mig-up", "CREATE TABLE IF NOT EXISTS tags (id serial primary key, label text not null);");
    fill(window, "mig-down", "DROP TABLE IF EXISTS tags;");
    await actions.handleSubmit(window.document.getElementById("apply-migration-form"));
    const migrations = await apiJson(base, token, `/v1/projects/${createdSlug}/database/migrations`);
    assert.ok(JSON.stringify(migrations).includes("add_tags"));

    // 10. Backup → verify → mutate → restore.
    pages.renderPage("backups");
    await pages.loadPage("backups");
    fill(window, "backup-name-input", "workflow snapshot");
    await actions.handleSubmit(window.document.getElementById("create-backup-form"));
    const backups = await apiJson(base, token, `/v1/projects/${createdSlug}/backups`);
    assert.ok(backups.backups.length >= 1, JSON.stringify(backups).slice(0, 300));
    const backup = backups.backups[0];
    const verify = await apiJson(
      base,
      token,
      `/v1/projects/${createdSlug}/backups/${backup.id}/verify`,
      { method: "POST" }
    );
    assert.equal(verify.valid, true);

    // The destructive-statement safeguard must block an unfiltered delete when
    // the operator has not explicitly opted in.
    const blockedDelete = await fetch(`${base}/v1/projects/${createdSlug}/database/sql`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ sql: "DELETE FROM items;", allowDestructive: false }),
    });
    assert.equal(blockedDelete.status, 400, await blockedDelete.text());
    await apiJson(base, token, `/v1/projects/${createdSlug}/database/sql`, {
      method: "POST",
      body: JSON.stringify({ sql: "DELETE FROM items;", allowDestructive: true }),
    });
    await actions.handleAction("restore-backup", {
      dataset: { id: backup.id, name: backup.name || "workflow snapshot" },
    } as unknown as HTMLElement);
    const restored = await apiJson(base, token, `/v1/projects/${createdSlug}/rest/items?limit=10`);
    assert.equal(restored.data.length, 1);
    assert.equal(restored.data[0].title, "Ship it");

    // 11. API key creation and live API tester hitting the project REST API.
    pages.renderPage("api");
    await pages.loadPage("api");
    fill(window, "key-name", "CI client");
    fill(window, "key-role", "anon");
    fill(window, "key-scopes", "db:read");
    await actions.handleSubmit(window.document.getElementById("create-key-form"));
    const keys = await apiJson(base, token, `/v1/projects/${createdSlug}/api-keys?reveal=true`);
    assert.ok(keys.apiKeys.some((key: any) => key.name === "CI client"));
    fill(window, "api-test-method", "GET");
    fill(window, "api-test-path", "/rest/items?limit=1");
    fill(window, "api-test-body", "");
    await actions.handleSubmit(window.document.getElementById("api-test-form"));
    assert.match(window.document.getElementById("api-test-meta")!.textContent || "", /HTTP 200/);
    assert.match(window.document.getElementById("api-test-result")!.textContent || "", /Ship it/);

    // 12. Project settings, secret, environment and application user forms.
    pages.renderPage("settings");
    await pages.loadPage("settings");
    fill(window, "settings-name", "Renamed Workflow Project");
    fill(window, "settings-description", "Updated by the workflow test");
    fill(window, "settings-status", "active");
    await actions.handleSubmit(window.document.getElementById("project-settings-form"));
    const environmentName = `qa-${Date.now()}`;
    fill(window, "env-name-input", environmentName);
    await actions.handleSubmit(window.document.getElementById("create-env-form"));
    fill(window, "sec-name", "SERVICE_TOKEN");
    fill(window, "sec-val", "super-secret-value");
    fill(window, "sec-description", "For the workflow test");
    await actions.handleSubmit(window.document.getElementById("create-secret-form"));
    const settings = await apiJson(base, token, `/v1/projects/${createdSlug}`);
    assert.ok(settings.environments.some((env: any) => env.name === environmentName), JSON.stringify(settings.environments));
    const secretList = await apiJson(base, token, `/v1/projects/${createdSlug}/secrets`);
    assert.ok(JSON.stringify(secretList).includes("SERVICE_TOKEN"));

    pages.renderPage("auth");
    await pages.loadPage("auth");
    fill(window, "u-email", `app-user-${Date.now()}@example.com`);
    fill(window, "u-pass", "AnotherStrongPass123!");
    fill(window, "u-role", "authenticated");
    await actions.handleSubmit(window.document.getElementById("admin-create-user-form"));
    const users = await apiJson(base, token, `/v1/projects/${createdSlug}/auth/admin/users`);
    assert.ok(users.users.length >= 1);

    // 12b. OAuth provider configuration from the auth page, verified against
    // the real authorize endpoint.
    fill(window, "oauth-provider", "github");
    fill(window, "oauth-client-id", "studio-test-client");
    fill(window, "oauth-scopes", "read:user,user:email");
    await actions.handleSubmit(window.document.getElementById("oauth-provider-form"));
    const authConfig = await apiJson(base, token, `/v1/projects/${createdSlug}/auth/config`);
    assert.equal(authConfig.config.oauth_providers.github.clientId, "studio-test-client");
    assert.equal(authConfig.config.oauth_providers.github.enabled, true);
    assert.ok(window.document.getElementById("oauth-providers-list")!.textContent!.includes("github"));

    const authorize = await studioFetch(
      `/v1/projects/${createdSlug}/auth/oauth/github/authorize?redirect_uri=${encodeURIComponent(`${base}/callback`)}`
    );
    const authorizeBody = await authorize.text();
    assert.equal(authorize.status, 200, authorizeBody);
    const authorization = JSON.parse(authorizeBody) as any;
    assert.match(authorization.authorizationUrl, /^https:\/\/github\.com\/login\/oauth\/authorize/);
    assert.match(authorization.authorizationUrl, /client_id=studio-test-client/);
    assert.ok(authorization.state);

    await actions.handleAction("disable-oauth-provider", {
      dataset: { provider: "github" },
    } as unknown as HTMLElement);
    const disabledConfig = await apiJson(base, token, `/v1/projects/${createdSlug}/auth/config`);
    assert.equal(disabledConfig.config.oauth_providers.github.enabled, false);

    // 13. Logs page reflects the captured audit/function/storage events.
    pages.renderPage("logs");
    await pages.loadPage("logs");
    const logText = window.document.getElementById("logs-list")!.textContent || "";
    assert.match(logText, /backup|function|storage|audit/i);

    // 14. Platform page shows the honest Android state and rejects a build
    //     request without the toolchain instead of fabricating an APK.
    pages.renderPage("platform");
    await pages.loadPage("platform");
    const apkPanel = window.document.getElementById("apk-status")!.textContent || "";
    assert.match(apkPanel, /APK|Android/i);
    const apkStatus = await apiJson(base, token, "/v1/platform/apk/status");
    assert.ok(["available", "missing", "invalid"].includes(apkStatus.state));
    if (!apkStatus.buildEnvironment.gradleBuildPossible) {
      fill(window, "apk-version-name", "1.1.0");
      fill(window, "apk-version-code", "2");
      await assert.rejects(
        () => actions.handleSubmit(window.document.getElementById("apk-build-form")),
        (error: any) => error.code === "apk_build_unavailable"
      );
      assert.match(
        window.document.getElementById("apk-build-output")!.textContent || "",
        /cannot run a Gradle build/
      );
    }

    // 15. The studio's session-aware fetch still works after all mutations.
    const me = await studioFetch("/v1/platform/auth/me", {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(me.status, 200);
  } finally {
    dom.window.close();
    await app.close();
  }
});
