import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { JSDOM } from "jsdom";
import { buildApp } from "./app.js";

/**
 * End-to-end studio test: the real dashboard modules are executed inside a DOM
 * against a live Fastify instance. It verifies navigation, per-page rendering
 * and that each page talks to the correct backend endpoint (no mocked payloads).
 */
test("Management Studio renders every section against the live API", async () => {
  const app = await buildApp();
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("No server address");
  const base = `http://127.0.0.1:${address.port}`;

  const html = await readFile(resolve(process.cwd(), "public", "dashboard", "index.html"), "utf8");
  const dom = new JSDOM(html, { url: `${base}/dashboard#overview`, pretendToBeVisual: true });
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

  try {
    const core = await import(
      pathToFileURL(resolve(process.cwd(), "public", "dashboard", "js", "core.js")).href
    );
    const pages = await import(
      pathToFileURL(resolve(process.cwd(), "public", "dashboard", "js", "pages.js")).href
    );
    const actions = await import(
      pathToFileURL(resolve(process.cwd(), "public", "dashboard", "js", "actions.js")).href
    );

    // Operator + project through the public API, exactly as the studio does.
    const registration = await studioFetch("/v1/platform/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `studio-${Date.now()}@example.com`, password: "StrongPassword123!" }),
    });
    assert.equal(registration.status, 201);
    const session = (await registration.json()) as any;
    core.setSession(session);
    core.state.user = session.user;

    const projectResponse = await studioFetch("/v1/projects", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${session.accessToken}` },
      body: JSON.stringify({ name: "Studio Integration" }),
    });
    assert.equal(projectResponse.status, 201);
    const created = (await projectResponse.json()) as any;
    const slug = created.project.slug as string;

    const tableResponse = await studioFetch(`/v1/projects/${slug}/database/tables`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${session.accessToken}`,
      },
      body: JSON.stringify({
        name: "notes",
        columns: [
          { name: "id", type: "uuid", primaryKey: true, defaultValue: "gen_random_uuid()" },
          { name: "body", type: "text", notNull: true },
          { name: "created_at", type: "timestamptz", defaultValue: "now()" },
        ],
        enableRls: true,
      }),
    });
    assert.equal(tableResponse.status, 201, await tableResponse.text());

    const detailsResponse = await studioFetch(`/v1/projects/${slug}`, {
      headers: { authorization: `Bearer ${session.accessToken}` },
    });
    const details = (await detailsResponse.json()) as any;
    core.state.activeProject = details.project;
    core.state.projects = [details.project];

    // Navigation contract: every declared page has a sidebar entry.
    const navTabs = Array.from(window.document.querySelectorAll(".nav-item[data-tab]")).map(
      (element) => (element as HTMLElement).dataset.tab
    );
    for (const tab of Object.keys(pages.PAGE_META)) {
      assert.ok(navTabs.includes(tab), `Sidebar is missing a navigation entry for "${tab}"`);
    }
    assert.equal(navTabs.length, Object.keys(pages.PAGE_META).length);

    const expectations: Record<string, string[]> = {
      overview: ["Service status", "Project identity", "Next actions"],
      database: ["Schema tables", "Data browser", "notes"],
      sql: ["SQL editor", "Run query"],
      migrations: ["Apply migration", "Migration history"],
      access: ["Database roles", "RLS policies", "Connection details"],
      auth: ["Project users", "Authentication policy"],
      api: ["Endpoint catalogue", "API tester", "API keys"],
      storage: ["Buckets", "Upload object"],
      realtime: ["Live WebSocket stream", "Configured channels"],
      functions: ["Deploy function", "Deployed functions"],
      jobs: ["Job queue", "Recurring schedules"],
      logs: ["Unified log stream", "Diagnostic context"],
      backups: ["Backup history", "Recovery checklist"],
      settings: ["Project settings", "Environments", "Secrets", "Team"],
      platform: ["Service checks", "Deployment diagnostics", "Android companion"],
      docs: ["Connect an application", "CLI", "Integration checklist"],
    };

    for (const [tab, expected] of Object.entries(expectations)) {
      pages.renderPage(tab);
      await pages.loadPage(tab);
      const root = window.document.getElementById("page-root")!;
      const content = root.textContent || "";
      assert.ok(root.querySelector("h1"), `${tab}: page header did not render`);
      assert.ok(
        !content.includes("Unable to load this module"),
        `${tab}: loader failed → ${content.slice(0, 400)}`
      );
      for (const text of expected) {
        assert.ok(content.includes(text), `${tab}: expected to find "${text}"`);
      }
      const active = window.document.querySelector(".nav-item.active");
      assert.equal(active?.getAttribute("data-tab"), tab, `${tab}: nav highlight mismatch`);
      const body = root.innerHTML;
      assert.ok(!body.includes("[object Object]"), `${tab}: unescaped object rendered`);
      assert.ok(!body.includes("NaN"), `${tab}: numeric value rendered as NaN`);
    }

    // Real data must be present, not placeholders.
    pages.renderPage("database");
    await pages.loadPage("database");
    assert.equal(core.state.tables.length, 1);
    assert.equal(core.state.tables[0].name, "notes");
    await actions.handleAction("browse-table", { dataset: { table: "notes" } } as unknown as HTMLElement);
    assert.ok(window.document.getElementById("table-rows-container")?.textContent?.length);

    pages.renderPage("logs");
    await pages.loadPage("logs");
    assert.match(window.document.getElementById("log-counts")!.textContent || "", /event/);

    pages.renderPage("api");
    await pages.loadPage("api");
    assert.match(window.document.getElementById("api-base-url")!.textContent || "", /\/v1\/projects\//);

    // Empty state without a project.
    core.state.activeProject = null;
    pages.renderPage("overview");
    assert.match(window.document.getElementById("page-root")!.textContent || "", /Your backend starts here/);
  } finally {
    dom.window.close();
    await app.close();
  }
});
