import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const root = process.cwd();
const read = (relativePath: string) => readFileSync(resolve(root, relativePath), "utf8");

function importWorkspaceModule(relativePath: string): Promise<any> {
  return import(pathToFileURL(resolve(root, relativePath)).href);
}

function listFiles(relativeDir: string, prefix = ""): string[] {
  const absoluteDir = resolve(root, relativeDir, prefix);
  return readdirSync(absoluteDir, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory()
      ? listFiles(relativeDir, relativePath)
      : [relativePath];
  });
}

test("Studio navigation model covers all pages and maps to real controls", async () => {
  const navigation: any = await importWorkspaceModule("public/dashboard/js/navigation.js");
  const pages: any = await importWorkspaceModule("public/dashboard/js/pages.js");
  const pageKeys = Object.keys(pages.PAGE_META);
  const pagesSource = read("public/dashboard/js/pages.js");
  const actionsSource = read("public/dashboard/js/actions.js");
  const markupSources = [
    read("public/dashboard/index.html"),
    pagesSource,
    actionsSource,
    read("public/dashboard/js/navigation.js"),
  ].join("\n");

  assert.deepEqual(Object.keys(navigation.PRODUCT_MENUS).sort(), pageKeys.sort());
  assert.equal(navigation.PRIMARY_SECTIONS.length, 5);
  assert.ok(pageKeys.includes("connect"));
  assert.ok(pageKeys.includes("map"));
  assert.ok(navigation.SUPABASE_SERVICE_MAP.length >= 10);
  assert.match(navigation.PHONE_SERVER_COMMANDS.start, /npm run start:phone/);

  for (const section of navigation.PRIMARY_SECTIONS) {
    assert.ok(section.items.length >= 2, `${section.id} should contain navigation items`);
    for (const entry of section.items) {
      assert.ok(pages.PAGE_META[entry.tab], `${section.id} points to missing tab ${entry.tab}`);
    }
  }

  for (const [tab, menu] of Object.entries<any>(navigation.PRODUCT_MENUS)) {
    assert.ok(pages.PAGE_META[tab], `context menu ${tab} has no page`);
    assert.ok(menu.groups.length >= 2, `${tab} menu needs grouped sections`);
    for (const entry of menu.groups.flatMap((group: any) => group.items)) {
      assert.ok(pages.PAGE_META[entry.tab], `${tab}/${entry.key} points to missing tab ${entry.tab}`);
      if (entry.local) {
        assert.ok(
          pagesSource.includes(`data-local-tab="${entry.local}"`),
          `${tab}/${entry.key} points to missing local tab ${entry.local}`
        );
      }
      if (entry.focus) {
        const byAttribute = markupSources.includes(`id="${entry.focus}"`);
        const byCardOption = markupSources.includes(`id: "${entry.focus}"`);
        assert.ok(byAttribute || byCardOption, `${tab}/${entry.key} points to missing focus ${entry.focus}`);
      }
      if (entry.action) {
        assert.ok(
          actionsSource.includes(`case "${entry.action}"`),
          `${tab}/${entry.key} points to missing action ${entry.action}`
        );
      }
      if (entry.href) assert.match(entry.href, /^\/(guide|v1)/);
    }
  }

  for (const item of pages.COMMAND_ITEMS) {
    assert.ok(pages.PAGE_META[item.tab], `command palette points to missing tab ${item.tab}`);
  }
});

test("Studio markup and styles expose the four-level structure", () => {
  const html = read("public/dashboard/index.html");
  const styles = read("public/dashboard/styles.css");
  const core = read("public/dashboard/js/core.js");
  const app = read("public/dashboard/app.js");

  for (const selector of [
    'class="topbar"',
    'id="sidebar"',
    'id="context-menu"',
    'id="main-content"',
    'data-tab="connect"',
    'data-tab="map"',
    'data-nav-section="database"',
    'data-nav-section="products"',
    'href="/guide/"',
    'symbol id="i-phone"',
    'symbol id="i-map"',
    'symbol id="i-server"',
    'symbol id="i-network"',
  ]) {
    assert.ok(html.includes(selector), `dashboard HTML is missing ${selector}`);
  }
  assert.match(styles, /--context-sidebar:/);
  assert.match(styles, /\.context-menu-item/);
  assert.match(styles, /@media \(max-width: 960px\)/);
  assert.match(core, /"connect", "map"/);
  assert.match(core, /activeContextKey/);
  assert.match(app, /renderContextMenu\(target/);
  assert.match(app, /handleContextNavigation/);
  assert.match(app, /data-context-tab/);
});

test("Connect and structure-map pages contain real runbooks and mapping data", () => {
  const pages = read("public/dashboard/js/pages.js");
  for (const marker of [
    'connect: () =>',
    'map: () =>',
    'id: "phone-commands"',
    'id: "connection-paths"',
    'id="instance-check-result"',
    'id: "map-hierarchy"',
    'id: "map-products"',
    'id: "map-services"',
    'id: "map-data"',
    'id="map-gaps"',
    'PHONE_SERVER_COMMANDS.install',
    'SUPABASE_SERVICE_MAP.map',
    'loadStaticPage',
  ]) {
    assert.ok(pages.includes(marker), `pages.js is missing ${marker}`);
  }
  const actions = read("public/dashboard/js/actions.js");
  assert.match(actions, /case "check-instance"/);
  assert.match(actions, /api\("\/ready"/);
  assert.match(actions, /api\("\/v1\/platform"/);
});

test("public guide, docs, and static routes explain the platform and phone server", () => {
  const guide = read("public/guide/index.html");
  const guideCss = read("public/guide/guide.css");
  const routes = read("src/routes/dashboard.ts");
  const mapping = read("docs/SUPABASE_STRUCTURE_MAPPING.md");
  const phoneDocs = read("docs/PHONE_AS_SERVER.md");
  const readme = read("README.md");

  for (const anchor of [
    'id="navigation"',
    'id="menus"',
    'id="mapping"',
    'id="data"',
    'id="phone-as-server"',
    'id="connections"',
    'id="troubleshooting"',
    'id="sources"',
  ]) {
    assert.ok(guide.includes(anchor), `guide is missing ${anchor}`);
  }
  assert.match(guide, /npm run start:phone/);
  assert.match(guide, /http:\/\/10\.0\.2\.2:4100/);
  assert.match(guide, /HOST=0\.0\.0\.0/);
  assert.match(guide, /https:\/\/api\.example\.com/);
  assert.match(guide, /9391f60ec973113d69f5fa7a09a4860e50f56a50/);
  assert.match(guideCss, /\.atlas-shell/);
  assert.match(routes, /"\/guide\/"/);
  assert.match(routes, /"\/guide\/guide\.css"/);
  assert.match(routes, /"\/dashboard\/js\/navigation\.js"/);
  assert.match(mapping, /NavigationBar\.utils\.tsx/);
  assert.match(mapping, /DatabaseMenu\.utils\.tsx/);
  assert.match(mapping, /proj_<project-slug>/);
  assert.match(phoneDocs, /Phone as a client/);
  assert.match(phoneDocs, /Phone as the actual server/);
  assert.match(phoneDocs, /termux-wake-lock/);
  assert.match(phoneDocs, /Do not expose `http:\/\/<phone-ip>:4100` with a raw router port-forward/);
  assert.match(readme, /Studio Structure & Phone-as-Server Connection/);
  assert.match(readme, /SUPABASE_STRUCTURE_MAPPING\.md/);
  assert.match(readme, /PHONE_AS_SERVER\.md/);
});

test("phone server launcher, mobile client, and Android companion stay in sync", () => {
  const packageJson = JSON.parse(read("package.json"));
  const script = read("scripts/phone-server.sh");
  const mobile = read("public/mobile/index.html");
  const android = read("android/app/src/main/java/com/marrybase/platform/MainActivity.java");
  const verifier = read("scripts/verify-apk.mjs");
  const app = read("src/app.ts");

  assert.equal(packageJson.scripts["start:phone"], "bash scripts/phone-server.sh");
  assert.match(app, /"upgrade-insecure-requests":/);
  assert.match(app, /NODE_ENV === "production" \? \[\] : null/);
  assert.match(packageJson.scripts["check:studio"], /navigation\.js/);
  assert.match(script, /NODE_MAJOR.*22/);
  assert.match(script, /HOST="\$\{HOST:-0\.0\.0\.0\}"/);
  assert.match(script, /DATABASE_URL="\$\{DATABASE_URL:-pglite:\/\/\.\/data\/postgres\}"/);
  assert.match(script, /npx tsx src\/server\.ts/);
  assert.match(mobile, /Phone as server/);
  assert.match(mobile, /\/guide\/#phone-as-server/);
  assert.match(android, /Phone as server/);
  assert.match(android, /npm run start:phone/);
  assert.match(verifier, /assets\/dashboard\/js\/navigation\.js/);
  assert.match(verifier, /id="context-menu"/);
});

test("every Studio template and context menu renders with a minimal DOM", async () => {
  const navigation: any = await importWorkspaceModule("public/dashboard/js/navigation.js");
  const pages: any = await importWorkspaceModule("public/dashboard/js/pages.js");
  const core: any = await importWorkspaceModule("public/dashboard/js/core.js");
  const globalAny = globalThis as any;
  const previousWindow = globalAny.window;
  const previousDocument = globalAny.document;
  const pageRoot = { innerHTML: "" };
  const contextMenu = { innerHTML: "" };

  globalAny.window = { location: { origin: "http://127.0.0.1:4100" } };
  globalAny.document = {
    getElementById(id: string) {
      if (id === "page-root") return pageRoot;
      if (id === "context-menu") return contextMenu;
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };
  core.state.activeProject = { slug: "demo", name: "Demo", schema_name: "proj_demo" };

  try {
    for (const tab of Object.keys(pages.PAGE_META)) {
      pages.renderPageSkeleton(tab);
      assert.ok(pageRoot.innerHTML.length > 200, `${tab} template rendered no content`);
      navigation.renderContextMenu(tab);
      assert.match(contextMenu.innerHTML, /context-menu-section/);
      assert.match(contextMenu.innerHTML, /data-context-tab=/);
    }
    pages.renderPageSkeleton("connect");
    assert.match(pageRoot.innerHTML, /npm run start:phone/);
    assert.match(pageRoot.innerHTML, /id="connection-paths"/);
    pages.renderPageSkeleton("map");
    assert.match(pageRoot.innerHTML, /id="map-services"/);
    assert.match(pageRoot.innerHTML, /Supabase service/);
  } finally {
    if (previousWindow === undefined) delete globalAny.window;
    else globalAny.window = previousWindow;
    if (previousDocument === undefined) delete globalAny.document;
    else globalAny.document = previousDocument;
    core.state.activeProject = null;
  }
});

test("bundled Android Studio assets exactly match the served dashboard", () => {
  const served = listFiles("public/dashboard").sort();
  const bundled = listFiles("android/app/src/main/assets/dashboard").sort();
  assert.deepEqual(bundled, served);
  for (const relativePath of served) {
    assert.equal(
      read(`android/app/src/main/assets/dashboard/${relativePath}`),
      read(`public/dashboard/${relativePath}`),
      `Android asset drift: ${relativePath}`
    );
  }
});
