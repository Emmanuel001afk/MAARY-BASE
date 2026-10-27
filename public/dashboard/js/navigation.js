// Supabase-inspired Studio information architecture for MARI BASE.
// This module is deliberately data-driven: the second-level product menu,
// command palette, structure map, and tests read the same source of truth.

import { $, PROJECT_FREE_TABS, esc, icon, state } from "./core.js";

export const PRIMARY_SECTIONS = [
  {
    id: "workspace",
    label: "Workspace",
    items: [
      { tab: "overview", label: "Overview", icon: "home" },
      { tab: "organizations", label: "Workspaces & Org", icon: "users" },
      { tab: "connect", label: "Connect", icon: "phone" },
      { tab: "map", label: "Structure map", icon: "map" },
    ],
  },
  {
    id: "database",
    label: "Database",
    items: [
      { tab: "database", label: "Table Editor", icon: "database" },
      { tab: "sql", label: "SQL & Policies", icon: "terminal" },
      { tab: "migrations", label: "Migrations", icon: "layers" },
      { tab: "api", label: "API & Explorer", icon: "globe" },
    ],
  },
  {
    id: "products",
    label: "Products",
    items: [
      { tab: "auth", label: "Authentication", icon: "lock" },
      { tab: "storage", label: "Storage", icon: "storage" },
      { tab: "realtime", label: "Realtime", icon: "realtime" },
      { tab: "functions", label: "Functions & Jobs", icon: "function" },
    ],
  },
  {
    id: "operate",
    label: "Operate",
    items: [
      { tab: "logs", label: "Logs & Monitoring", icon: "activity" },
      { tab: "backups", label: "Backups & Settings", icon: "layers" },
      { tab: "security", label: "Security & Keys", icon: "shield" },
    ],
  },
  {
    id: "platform",
    label: "Platform",
    items: [
      { tab: "platform", label: "Platform Admin", icon: "settings" },
      { tab: "docs", label: "SDK, CLI & Docs", icon: "book" },
    ],
  },
];

const item = (key, label, tab, options = {}) => ({
  key,
  label,
  tab,
  icon: options.icon || "chevron",
  detail: options.detail || "",
  local: options.local || "",
  focus: options.focus || "",
  action: options.action || "",
  href: options.href || "",
  badge: options.badge || "",
});

export const PRODUCT_MENUS = {
  overview: {
    eyebrow: "Workspace / Home",
    title: "Project Overview",
    description: "Start with health, endpoints, and the next project task.",
    groups: [
      { label: "Start", items: [
        item("overview-home", "Overview", "overview", { icon: "home", detail: "Health and quick actions" }),
        item("overview-modules", "Live subsystems", "overview", { icon: "activity", focus: "overview-modules" }),
        item("overview-env", "Environments", "overview", { icon: "layers", focus: "environments-list" }),
      ] },
      { label: "Workspace", items: [
        item("overview-orgs", "Workspaces", "organizations", { icon: "users" }),
        item("overview-connect", "Connect", "connect", { icon: "phone" }),
        item("overview-map", "Structure map", "map", { icon: "map" }),
      ] },
      { label: "Operate", items: [
        item("overview-logs", "Logs & Monitoring", "logs", { icon: "activity" }),
        item("overview-platform", "Platform Admin", "platform", { icon: "settings" }),
      ] },
    ],
  },

  organizations: {
    eyebrow: "Workspace / Organization",
    title: "Workspaces",
    description: "Supabase's organization scope maps to inherited team RBAC.",
    groups: [
      { label: "Manage", items: [
        item("org-list", "Your workspaces", "organizations", { icon: "users", focus: "orgs-list" }),
        item("org-projects", "Workspace projects", "organizations", { icon: "layers", focus: "org-projects-list" }),
      ] },
      { label: "Configuration", items: [
        item("org-members", "Members & RBAC", "organizations", { icon: "shield", focus: "org-members-list" }),
        item("org-team", "Project team", "security", { icon: "users", local: "members" }),
        item("org-keys", "API keys", "security", { icon: "key", local: "keys" }),
      ] },
      { label: "Platform", items: [
        item("org-operators", "Platform operators", "platform", { icon: "settings" }),
        item("org-audit", "Audit trail", "logs", { icon: "file", local: "logs-audit" }),
      ] },
    ],
  },

  connect: {
    eyebrow: "Workspace / Connect",
    title: "Connect & Devices",
    description: "Phone-as-client, phone-as-server, verification, and troubleshooting.",
    groups: [
      { label: "Connection modes", items: [
        item("connect-client", "Phone as client", "connect", { icon: "phone", focus: "phone-client-card" }),
        item("connect-server", "Phone as server", "connect", { icon: "server", focus: "phone-server-card" }),
        item("connect-paths", "Connection URLs", "connect", { icon: "link", focus: "connection-paths" }),
      ] },
      { label: "Tools", items: [
        item("connect-commands", "Termux commands", "connect", { icon: "terminal", focus: "phone-commands" }),
        item("connect-verify", "Verify this instance", "connect", { icon: "activity", focus: "instance-check-result" }),
        item("connect-guide", "Open public guide", "connect", { icon: "external", href: "/guide/#phone-as-server" }),
      ] },
      { label: "Related", items: [
        item("connect-android", "Android companion", "backups", { icon: "sparkles", local: "android-companion" }),
        item("connect-api", "API endpoints", "api", { icon: "globe", local: "api-endpoints" }),
        item("connect-docs", "SDK & CLI docs", "docs", { icon: "book" }),
      ] },
    ],
  },

  map: {
    eyebrow: "Workspace / Reference",
    title: "Structure Map",
    description: "How Supabase concepts map onto real MARI BASE routes and data.",
    groups: [
      { label: "Map contents", items: [
        item("map-hierarchy-link", "Visual hierarchy", "map", { icon: "map", focus: "map-hierarchy" }),
        item("map-products-link", "Product menus", "map", { icon: "columns", focus: "map-products" }),
        item("map-services-link", "Service mapping", "map", { icon: "network", focus: "map-services" }),
        item("map-data-link", "Data mapping", "map", { icon: "database", focus: "map-data" }),
      ] },
      { label: "Open", items: [
        item("map-overview", "Project Overview", "overview", { icon: "home" }),
        item("map-connect", "Connect & Devices", "connect", { icon: "phone" }),
        item("map-guide", "Public atlas", "map", { icon: "external", href: "/guide/" }),
      ] },
    ],
  },

  database: {
    eyebrow: "Database / Table Editor",
    title: "Database",
    description: "Supabase Database Management, Access Control, and Platform groups.",
    groups: [
      { label: "Database Management", items: [
        item("db-tables", "Tables", "database", { icon: "database", focus: "tables-list", detail: "Schema and row browser" }),
        item("db-create", "New table", "database", { icon: "plus", focus: "create-table-disclosure" }),
        item("db-schema", "Schema inspector", "database", { icon: "columns", focus: "table-schema-inspector" }),
        item("db-sql", "SQL Editor", "sql", { icon: "terminal" }),
      ] },
      { label: "Access Control", items: [
        item("db-policies", "Policies", "sql", { icon: "shield", focus: "pol-table" }),
        item("db-roles", "Roles & isolation", "database", { icon: "lock", focus: "db-diagnostics-box" }),
        item("db-keys", "API keys", "security", { icon: "key", local: "keys" }),
      ] },
      { label: "Platform", items: [
        item("db-migrations", "Migrations", "migrations", { icon: "layers" }),
        item("db-backups", "Backups", "backups", { icon: "storage", local: "backups-main" }),
        item("db-settings", "Project settings", "backups", { icon: "settings", local: "project-settings" }),
        item("db-extensions", "Platform diagnostics", "platform", { icon: "activity" }),
      ] },
    ],
  },

  sql: {
    eyebrow: "Database / SQL Editor",
    title: "SQL & Policies",
    description: "Queries, saved snippets, role simulation, and native RLS policies.",
    groups: [
      { label: "Workspace", items: [
        item("sql-editor", "SQL workbench", "sql", { icon: "terminal", focus: "sql-editor-input" }),
        item("sql-queries", "Saved queries", "sql", { icon: "save", focus: "saved-queries-list" }),
      ] },
      { label: "Access Control", items: [
        item("sql-policies", "Active policies", "sql", { icon: "shield", focus: "rls-policies-list" }),
        item("sql-policy-create", "Create policy", "sql", { icon: "plus", focus: "pol-table" }),
      ] },
      { label: "Platform", items: [
        item("sql-tables", "Table Editor", "database", { icon: "database" }),
        item("sql-migrations", "Migrations", "migrations", { icon: "layers" }),
        item("sql-api", "API Explorer", "api", { icon: "globe", local: "api-explorer" }),
      ] },
    ],
  },

  migrations: {
    eyebrow: "Database / Migrations",
    title: "Schema Migrations",
    description: "Checksummed up/down migrations with transactional application.",
    groups: [
      { label: "Manage", items: [
        item("mig-apply", "Apply migration", "migrations", { icon: "plus", focus: "mig-version" }),
        item("mig-history", "Migration history", "migrations", { icon: "clock", focus: "migrations-list" }),
      ] },
      { label: "Related", items: [
        item("mig-db", "Table Editor", "database", { icon: "database" }),
        item("mig-sql", "SQL Editor", "sql", { icon: "terminal" }),
        item("mig-backup", "Backups", "backups", { icon: "storage", local: "backups-main" }),
      ] },
    ],
  },

  api: {
    eyebrow: "Products / Data API",
    title: "Data API",
    description: "PostgREST-style REST, RPC, and OpenAPI 3.1 for the active project.",
    groups: [
      { label: "Explore", items: [
        item("api-explorer", "Live Explorer", "api", { icon: "play", local: "api-explorer" }),
        item("api-endpoints", "Table & RPC endpoints", "api", { icon: "globe", local: "api-endpoints" }),
        item("api-openapi", "OpenAPI 3.1", "api", { icon: "file", local: "api-openapi" }),
      ] },
      { label: "Configuration", items: [
        item("api-keys", "API keys", "security", { icon: "key", local: "keys" }),
        item("api-auth", "Authentication", "auth", { icon: "lock", local: "auth-users" }),
        item("api-docs", "SDK & CLI", "docs", { icon: "book" }),
      ] },
    ],
  },

  auth: {
    eyebrow: "Products / Authentication",
    title: "Authentication",
    description: "Supabase Auth Manage and Configuration groups mapped to live tools.",
    groups: [
      { label: "Manage", items: [
        item("auth-users", "Users", "auth", { icon: "users", local: "auth-users" }),
        item("auth-tester", "Sign-in tester", "auth", { icon: "play", local: "auth-tester" }),
        item("auth-sessions", "Sessions", "auth", { icon: "clock", local: "auth-sessions" }),
      ] },
      { label: "Configuration", items: [
        item("auth-policies", "Auth policies", "auth", { icon: "shield", local: "auth-policies" }),
        item("auth-operator", "Operator security", "auth", { icon: "key", local: "auth-operator" }),
        item("auth-keys", "API keys", "security", { icon: "key", local: "keys" }),
      ] },
      { label: "Related", items: [
        item("auth-rls", "RLS policies", "sql", { icon: "lock", focus: "rls-policies-list" }),
        item("auth-audit", "Audit trail", "logs", { icon: "file", local: "logs-audit" }),
      ] },
    ],
  },

  storage: {
    eyebrow: "Products / Storage",
    title: "Object Storage",
    description: "Buckets, files, signed URLs, policies, and backend-enforced quotas.",
    groups: [
      { label: "Manage", items: [
        item("storage-buckets", "Buckets & files", "storage", { icon: "storage", local: "storage-buckets" }),
        item("storage-new", "New bucket", "storage", { icon: "plus", local: "storage-buckets", action: "focus-create-bucket" }),
      ] },
      { label: "Configuration", items: [
        item("storage-policies", "Policies", "storage", { icon: "shield", local: "storage-policies" }),
        item("storage-settings", "Settings", "storage", { icon: "settings", local: "storage-settings" }),
      ] },
      { label: "Related", items: [
        item("storage-api", "API Explorer", "api", { icon: "globe", local: "api-explorer" }),
        item("storage-logs", "Error logs", "logs", { icon: "activity", local: "logs-errors" }),
      ] },
    ],
  },

  realtime: {
    eyebrow: "Products / Realtime",
    title: "Realtime",
    description: "Inspector, publish, history, channels, and event replay.",
    groups: [
      { label: "Tools", items: [
        item("rt-inspector", "Inspector", "realtime", { icon: "realtime", local: "rt-inspector" }),
        item("rt-publish", "Publish", "realtime", { icon: "upload", local: "rt-publish" }),
        item("rt-history", "History", "realtime", { icon: "clock", local: "rt-history" }),
      ] },
      { label: "Configuration", items: [
        item("rt-keys", "API keys", "security", { icon: "key", local: "keys" }),
        item("rt-docs", "WebSocket protocol", "docs", { icon: "book", focus: "doc-curl-code" }),
      ] },
      { label: "Observe", items: [
        item("rt-logs", "Logs", "logs", { icon: "activity", local: "logs-errors" }),
      ] },
    ],
  },

  functions: {
    eyebrow: "Products / Functions",
    title: "Functions & Jobs",
    description: "Isolated handlers, secrets, durable jobs, and recurring schedules.",
    groups: [
      { label: "Manage", items: [
        item("fn-functions", "Functions", "functions", { icon: "function", local: "functions" }),
        item("fn-secrets", "Secrets", "functions", { icon: "lock", local: "secrets" }),
      ] },
      { label: "Jobs", items: [
        item("fn-jobs", "Queue", "functions", { icon: "clock", local: "jobs" }),
        item("fn-schedules", "Schedules", "functions", { icon: "layers", local: "schedules" }),
      ] },
      { label: "Observe", items: [
        item("fn-logs", "Execution logs", "logs", { icon: "activity", local: "logs-errors" }),
        item("fn-platform", "Worker diagnostics", "platform", { icon: "settings" }),
      ] },
    ],
  },

  logs: {
    eyebrow: "Operate / Observability",
    title: "Logs & Monitoring",
    description: "Truthful live probes, structured errors, quotas, and audit history.",
    groups: [
      { label: "Explore", items: [
        item("logs-health", "Health & diagnostics", "logs", { icon: "activity", local: "logs-health" }),
        item("logs-errors", "Structured errors", "logs", { icon: "alert", local: "logs-errors" }),
        item("logs-audit", "Audit trail", "logs", { icon: "file", local: "logs-audit" }),
      ] },
      { label: "Platform", items: [
        item("logs-instance", "Instance diagnostics", "platform", { icon: "settings" }),
        item("logs-function", "Function logs", "functions", { icon: "function", local: "functions" }),
        item("logs-metrics", "Metrics endpoint", "docs", { icon: "external", href: "/v1/metrics" }),
      ] },
    ],
  },

  backups: {
    eyebrow: "Operate / Platform",
    title: "Backups & Settings",
    description: "Verified snapshots, project settings, and the Android build pipeline.",
    groups: [
      { label: "Platform", items: [
        item("backup-main", "Snapshots & recovery", "backups", { icon: "storage", local: "backups-main" }),
        item("backup-migrations", "Migrations", "migrations", { icon: "layers" }),
      ] },
      { label: "Configuration", items: [
        item("backup-settings", "Project settings", "backups", { icon: "settings", local: "project-settings" }),
        item("backup-keys", "API keys", "security", { icon: "key", local: "keys" }),
      ] },
      { label: "Android", items: [
        item("backup-android", "Companion & APK", "backups", { icon: "sparkles", local: "android-companion" }),
        item("backup-connect", "Phone connection", "connect", { icon: "phone" }),
      ] },
    ],
  },

  security: {
    eyebrow: "Operate / Project Settings",
    title: "Security & Keys",
    description: "API keys, encrypted secrets, and direct project membership.",
    groups: [
      { label: "Configuration", items: [
        item("security-keys", "API Keys", "security", { icon: "key", local: "keys" }),
        item("security-secrets", "Encrypted Secrets", "security", { icon: "lock", local: "secrets", detail: "Vault equivalent" }),
        item("security-members", "Project Team", "security", { icon: "users", local: "members" }),
      ] },
      { label: "Related", items: [
        item("security-auth", "Authentication", "auth", { icon: "shield", local: "auth-users" }),
        item("security-logs", "Audit trail", "logs", { icon: "file", local: "logs-audit" }),
        item("security-settings", "General settings", "backups", { icon: "settings", local: "project-settings" }),
      ] },
    ],
  },

  platform: {
    eyebrow: "Platform / Instance",
    title: "Platform Admin",
    description: "Instance-wide runtime verification, operators, extensions, and recovery.",
    groups: [
      { label: "Instance", items: [
        item("platform-diagnostics", "Runtime diagnostics", "platform", { icon: "activity", focus: "platform-modules-matrix" }),
        item("platform-logs", "Logs", "logs", { icon: "file", local: "logs-errors" }),
      ] },
      { label: "Administration", items: [
        item("platform-operators", "Operators & extensions", "platform", { icon: "users", focus: "platform-superadmin-area" }),
        item("platform-backups", "Platform backups", "backups", { icon: "storage", local: "backups-main" }),
        item("platform-map", "Structure map", "map", { icon: "map" }),
      ] },
    ],
  },

  docs: {
    eyebrow: "Platform / Developer Guides",
    title: "SDK, CLI & Docs",
    description: "Project-aware snippets for every public client surface.",
    groups: [
      { label: "Client libraries", items: [
        item("docs-sdk", "TypeScript SDK", "docs", { icon: "book", focus: "doc-sdk-code" }),
        item("docs-cli", "CLI", "docs", { icon: "terminal", focus: "doc-cli-code" }),
      ] },
      { label: "Protocols", items: [
        item("docs-rest", "REST & WebSocket", "docs", { icon: "globe", focus: "doc-curl-code" }),
        item("docs-hosting", "Self-hosting", "docs", { icon: "server", focus: "doc-ops-code" }),
      ] },
      { label: "Devices", items: [
        item("docs-connect", "Phone server setup", "connect", { icon: "phone" }),
        item("docs-guide", "Public platform atlas", "docs", { icon: "external", href: "/guide/" }),
      ] },
    ],
  },
};

export const PHONE_SERVER_COMMANDS = Object.freeze({
  install: `pkg update && pkg upgrade -y
pkg install -y git nodejs-lts tmux curl
node --version   # must be v22+
git clone <your-repository-url> maary-base
cd maary-base
npm ci`,
  start: `cd ~/maary-base
npm run start:phone

# Equivalent manual launch:
HOST=0.0.0.0 PORT=4100 \\
DATABASE_URL=pglite://./data/postgres \\
AUTO_MIGRATE=true npm run dev`,
  verify: `curl -f http://127.0.0.1:4100/ready
curl -f http://127.0.0.1:4100/v1/platform
ip -4 addr show wlan0 | grep inet`,
});

export const SUPABASE_SERVICE_MAP = [
  { supabase: "Studio", mari: "Management Studio", location: "public/dashboard", status: "Implemented", detail: "Topbar, primary sidebar, context menu, local tabs, command palette." },
  { supabase: "Envoy / Kong gateway", mari: "Fastify gateway", location: "src/app.ts", status: "Implemented", detail: "HTTP, REST, RPC, auth, storage, realtime, and admin route registration." },
  { supabase: "Postgres", mari: "PostgreSQL / PGlite", location: "src/db/pool.ts", status: "Implemented", detail: "Control-plane tables plus per-project schemas and least-privilege roles." },
  { supabase: "GoTrue", mari: "Project Auth", location: "src/routes/project-auth.ts", status: "Implemented", detail: "Password users, sessions, refresh rotation, OAuth configuration, recovery." },
  { supabase: "PostgREST", mari: "Data API", location: "src/routes/data-api.ts", status: "Implemented", detail: "REST filters, order, pagination, select, embedding, RPC, OpenAPI." },
  { supabase: "Storage API", mari: "Object Storage", location: "src/routes/storage.ts", status: "Implemented", detail: "Public/private buckets, policies, signed URLs, multipart uploads." },
  { supabase: "Realtime", mari: "Realtime Broker", location: "src/services/realtime.service.ts", status: "Implemented", detail: "Authenticated WebSockets, channels, broadcast, presence, replay." },
  { supabase: "Edge Functions", mari: "Function Workers", location: "src/services/functions-jobs.service.ts", status: "Implemented", detail: "Versioned ESM handlers in isolated child workers plus job queue." },
  { supabase: "pg_meta", mari: "Database Diagnostics", location: "src/services/database.service.ts", status: "Implemented", detail: "Catalog metadata, roles, relations, sizes, RLS policy metadata." },
  { supabase: "pg_cron / queue", mari: "Jobs & Schedules", location: "platform_jobs / platform_schedules", status: "Implemented", detail: "Durable retries, webhooks, recurring schedules, supervisor." },
  { supabase: "GraphQL", mari: "No direct equivalent", location: "Use REST / RPC / SQL", status: "Not provided", detail: "MARI BASE intentionally exposes REST, RPC, and scoped SQL." },
  { supabase: "Billing / branches / SSO", mari: "Hosted-platform features", location: "Not part of self-hosted core", status: "Not provided", detail: "No dead menu links are created for unavailable hosted features." },
];

export function getProductMenu(tab) {
  return PRODUCT_MENUS[tab] || PRODUCT_MENUS.overview;
}

export function flattenProductMenu(tab) {
  return getProductMenu(tab).groups.flatMap((group) => group.items);
}

export function renderContextMenu(tab = state.activeTab, activeKey = null) {
  const container = $("context-menu");
  if (!container) return;
  const menu = getProductMenu(tab);
  const allItems = flattenProductMenu(tab);
  const fallback = allItems.find((entry) => !entry.href)?.key || "";
  const selected = activeKey || state.activeContextKey || fallback;
  state.activeContextKey = selected;
  const scope = PROJECT_FREE_TABS.has(tab)
    ? "Platform scope"
    : (state.activeProject?.name || "No project selected");

  const renderItem = (entry) => {
    const isActive = entry.key === selected;
    const data = [
      `data-context-key="${esc(entry.key)}"`,
      `data-context-tab="${esc(entry.tab)}"`,
      entry.local ? `data-context-local="${esc(entry.local)}"` : "",
      entry.focus ? `data-context-focus="${esc(entry.focus)}"` : "",
      entry.action ? `data-context-action="${esc(entry.action)}"` : "",
    ].filter(Boolean).join(" ");
    const inner = `${icon(entry.icon)}<span class="context-menu-label"><strong>${esc(entry.label)}</strong>${entry.detail ? `<small>${esc(entry.detail)}</small>` : ""}</span>${entry.badge ? `<span class="context-menu-badge">${esc(entry.badge)}</span>` : ""}`;
    if (entry.href) {
      return `<a class="context-menu-item" href="${esc(entry.href)}" ${data} aria-label="${esc(entry.label)}">${inner}${icon("external")}</a>`;
    }
    return `<button class="context-menu-item${isActive ? " active" : ""}" type="button" ${data} ${isActive ? 'aria-current="page"' : ""}>${inner}</button>`;
  };

  container.innerHTML = `
    <div class="context-menu-header">
      <span class="context-eyebrow">${esc(menu.eyebrow)}</span>
      <h2>${esc(menu.title)}</h2>
      <p>${esc(menu.description)}</p>
      <span class="context-scope">${esc(scope)}</span>
    </div>
    <div class="context-menu-scroll">
      ${menu.groups.map((group) => `
        <div class="context-menu-section">
          <span class="context-menu-section-label">${esc(group.label)}</span>
          <div class="context-menu-items">${group.items.map(renderItem).join("")}</div>
        </div>
      `).join("")}
    </div>`;
}
