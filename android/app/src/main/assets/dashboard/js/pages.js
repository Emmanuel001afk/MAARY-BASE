import {
  $, PROJECT_FREE_TABS, api, badge, esc, formatBytes, formatDate, formatNumber, icon,
  moduleStatusBadge, quotaMeter, state, timeAgo, truncate,
} from "./core.js";

export const PAGE_META = {
  overview: {
    group: "Workspace", title: "Project Overview", icon: "home",
    description: "Real-time module verification, connection endpoints, environments, and resource metrics.",
    actions: `<button class="btn btn-secondary btn-sm" type="button" data-nav="api">${icon("globe")}<span>API Explorer</span></button><button class="btn btn-primary btn-sm" type="button" data-nav="database">${icon("database")}<span>Open Table Editor</span></button>`,
  },
  organizations: {
    group: "Workspace", title: "Workspaces & Organizations", icon: "users",
    description: "Manage multi-project workspaces, inherited team RBAC roles, and operational tiers.",
    actions: `<button class="btn btn-primary btn-sm" type="button" data-action="open-new-org">${icon("plus")}<span>New workspace</span></button>`,
  },
  database: {
    group: "Build", title: "Table Editor & Data Browser", icon: "database",
    description: "Design relational schemas visually or with JSON, alter columns and indexes, and browse/edit rows.",
    actions: `<button class="btn btn-secondary btn-sm" type="button" data-nav="sql">${icon("terminal")}<span>SQL Editor</span></button><button class="btn btn-primary btn-sm" type="button" data-action="focus-create-table">${icon("plus")}<span>New table</span></button>`,
  },
  sql: {
    group: "Build", title: "SQL Editor & Row-Level Security", icon: "terminal",
    description: "Run scoped PostgreSQL queries, build a shared saved-query library, simulate client roles and auth.uid(), and author RLS policies.",
    actions: `<button class="btn btn-secondary btn-sm" type="button" data-nav="migrations">${icon("layers")}<span>Migrations</span></button>`,
  },
  migrations: {
    group: "Build", title: "Schema Migrations", icon: "layers",
    description: "Track repeatable, SHA-256 checksummed schema changes with controlled down-SQL rollbacks.",
    actions: `<button class="btn btn-secondary btn-sm" type="button" data-nav="backups">${icon("storage")}<span>Backups</span></button>`,
  },
  api: {
    group: "Build", title: "API Reference & Live Explorer", icon: "globe",
    description: "Auto-generated table REST & RPC endpoints, interactive request runner, and OpenAPI 3.1 schema.",
    actions: `<button class="btn btn-secondary btn-sm" type="button" data-nav="docs">${icon("book")}<span>SDK &amp; CLI</span></button>`,
  },
  auth: {
    group: "Build", title: "Authentication & Users", icon: "lock",
    description: "End-user directory, active sessions, OAuth providers, password recovery flows, and operator security.",
    actions: `<button class="btn btn-secondary btn-sm" type="button" data-nav="security">${icon("key")}<span>API Keys</span></button>`,
  },
  storage: {
    group: "Build", title: "Object Storage", icon: "storage",
    description: "Manage public/private buckets, object metadata, signed URLs, quotas, and storage access policies.",
    actions: `<button class="btn btn-primary btn-sm" type="button" data-action="focus-create-bucket">${icon("plus")}<span>New bucket</span></button>`,
  },
  realtime: {
    group: "Build", title: "Realtime Inspector", icon: "realtime",
    description: "Stream PostgreSQL row changes, configure public/private topics, and publish WebSocket broadcasts.",
    actions: "",
  },
  functions: {
    group: "Build", title: "Server Functions & Jobs", icon: "function",
    description: "Deploy isolated Node handlers, configure function env vars, retry durable jobs, and schedule tasks.",
    actions: `<button class="btn btn-primary btn-sm" type="button" data-action="focus-deploy-function">${icon("plus")}<span>Deploy function</span></button>`,
  },
  logs: {
    group: "Operate & Admin", title: "Logs, Health & Diagnostics", icon: "activity",
    description: "Truthful module verification probes, structured error logs, function execution logs, and audit history.",
    actions: "",
  },
  backups: {
    group: "Operate & Admin", title: "Backups, Recovery & Project Settings", icon: "layers",
    description: "Create SHA-256 verified snapshots, run safeguarded restores, configure project quotas, and inspect Android builds.",
    actions: `<button class="btn btn-primary btn-sm" type="button" data-action="create-backup-focus">${icon("plus")}<span>Create snapshot</span></button>`,
  },
  security: {
    group: "Operate & Admin", title: "Security, API Keys & Team", icon: "shield",
    description: "Issue scoped anon/service_role keys, store AES-256-GCM encrypted secrets, and manage project RBAC.",
    actions: `<button class="btn btn-primary btn-sm" type="button" data-action="focus-create-key">${icon("key")}<span>Create API key</span></button>`,
  },
  platform: {
    group: "Operate & Admin", title: "Platform Administration", icon: "settings",
    description: "Instance-wide runtime health, operator RBAC, PostgreSQL extensions, and full-platform disaster recovery.",
    actions: "",
  },
  docs: {
    group: "Operate & Admin", title: "SDK, CLI & Developer Guides", icon: "book",
    description: "Copyable, project-configured TypeScript SDK, CLI, REST, Realtime, Functions, and Docker self-hosting guides.",
    actions: "",
  },
};

export const COMMAND_ITEMS = [
  { group: "Workspace", label: "Project Overview", detail: "Health probes, connection URLs, environments", icon: "home", tab: "overview", shortcut: "G O" },
  { group: "Workspace", label: "Workspaces & Organizations", detail: "Multi-project teams & RBAC", icon: "users", tab: "organizations", shortcut: "G W" },
  { group: "Build", label: "Table Editor", detail: "Visual columns, alter schema, row browser", icon: "database", tab: "database", shortcut: "G D" },
  { group: "Build", label: "SQL & RLS Policies", detail: "Query runner, saved-query library & Row-Level Security", icon: "terminal", tab: "sql", shortcut: "G S" },
  { group: "Build", label: "Schema Migrations", detail: "Checksummed up/down migrations", icon: "layers", tab: "migrations", shortcut: "G M" },
  { group: "Build", label: "API & Live Explorer", detail: "Interactive REST/RPC tester & OpenAPI", icon: "globe", tab: "api", shortcut: "G P" },
  { group: "Build", label: "Authentication & Users", detail: "Users, sessions, OAuth, recovery", icon: "lock", tab: "auth", shortcut: "G A" },
  { group: "Build", label: "Object Storage", detail: "Buckets, signed URLs, storage policies", icon: "storage", tab: "storage", shortcut: "G B" },
  { group: "Build", label: "Realtime Inspector", detail: "Live WebSocket stream & channels", icon: "realtime", tab: "realtime", shortcut: "G R" },
  { group: "Build", label: "Functions & Jobs", detail: "Isolated functions, retry queue, schedules", icon: "function", tab: "functions", shortcut: "G F" },
  { group: "Operate", label: "Logs & Monitoring", detail: "Module health matrix, error logs, audit", icon: "activity", tab: "logs", shortcut: "G L" },
  { group: "Operate", label: "Backups & Project Settings", detail: "Snapshots, restore, quotas, Android APK", icon: "layers", tab: "backups", shortcut: "G K" },
  { group: "Operate", label: "Security & API Keys", detail: "Keys, encrypted secrets, project team", icon: "shield", tab: "security", shortcut: "G K" },
  { group: "Operate", label: "Platform Administration", detail: "Instance runtime, operators, extensions", icon: "settings", tab: "platform", shortcut: "G I" },
  { group: "Operate", label: "SDK, CLI & Docs", detail: "TypeScript client, CLI & self-hosting", icon: "book", tab: "docs", shortcut: "G H" },
];

const DEFAULT_FUNCTION_CODE = `export default async function handler(req, ctx) {
  const { rows } = await ctx.db.query("SELECT now() AS server_time");
  return {
    ok: true,
    project: ctx.project.slug,
    invokedAt: rows[0]?.server_time,
    envKeys: Object.keys(ctx.env || {}),
    body: req.body ?? null,
  };
}`;

export function card(title, body, options = {}) {
  const subtitle = options.subtitle ? `<p>${esc(options.subtitle)}</p>` : "";
  const iconHtml = options.iconName ? `<span class="card-title-icon">${icon(options.iconName)}</span>` : "";
  const actions = options.actions ? `<div class="card-header-actions">${options.actions}</div>` : "";
  const bodyClass = options.flush ? "card-body flush" : "card-body";
  const extraClass = options.className ? ` ${options.className}` : "";
  return `<section class="card${extraClass}"><header class="card-header"><div class="card-title">${iconHtml}<div><h2>${esc(title)}</h2>${subtitle}</div></div>${actions}</header><div class="${bodyClass}">${body}</div></section>`;
}

export function emptyState(iconName, title, copy, actionHtml = "") {
  return `<div class="empty-state"><div class="empty-state-icon">${icon(iconName)}</div><h3>${esc(title)}</h3><p>${esc(copy)}</p>${actionHtml ? `<div class="empty-state-actions">${actionHtml}</div>` : ""}</div>`;
}

export function loadingState(label = "Loading workspace data…") {
  return `<div class="loading-box" role="status"><span class="spinner" aria-hidden="true"></span><span>${esc(label)}</span></div>`;
}

export function errorState(error, retryAction = "refresh-page") {
  return `<div class="error-box" role="alert"><div class="error-box-icon">${icon("alert")}</div><div><h3>Couldn’t load this section</h3><p>${esc(error?.message || "Check server connectivity and your permissions.")}</p></div><button class="btn btn-secondary btn-sm" type="button" data-action="${esc(retryAction)}">${icon("refresh")}<span>Retry</span></button></div>`;
}

export function table(headers, rowsHtml, options = {}) {
  const wrapClass = options.scroll ? "table-wrap grid-scroll" : "table-wrap";
  const headHtml = headers
    .map((header) => {
      if (header && typeof header === "object") {
        const sub = header.sub ? `<span class="col-type">${esc(header.sub)}</span>` : "";
        return `<th scope="col">${esc(header.label)}${sub}</th>`;
      }
      return `<th scope="col">${esc(header)}</th>`;
    })
    .join("");
  return `<div class="${wrapClass}"><table class="data-table"><thead><tr>${headHtml}</tr></thead><tbody>${rowsHtml}</tbody></table></div>`;
}

function formatCell(value) {
  if (value === null || value === undefined) return '<span class="null-pill">NULL</span>';
  if (typeof value === "boolean") return badge(value ? "active" : "disabled", value ? "success" : "neutral", String(value));
  if (typeof value === "object") return `<div class="json-cell">${esc(JSON.stringify(value))}</div>`;
  return `<span>${esc(value)}</span>`;
}

function pageHeader(tab) {
  const meta = PAGE_META[tab] || PAGE_META.overview;
  const project = state.activeProject;
  const scopeLabel = PROJECT_FREE_TABS.has(tab)
    ? `${meta.group} · Platform Scope`
    : `${meta.group}${project ? ` · ${project.name}` : ""}`;
  return `<header class="page-header"><div class="page-heading"><p class="eyebrow">${esc(scopeLabel)}</p><h1>${esc(meta.title)}</h1><p>${esc(meta.description)}</p></div><div class="page-actions">${meta.actions || ""}<button class="btn btn-ghost btn-sm" type="button" data-action="refresh-page">${icon("refresh")}<span>Refresh</span></button></div></header>`;
}

function endpointRow(label, url) {
  return `<div class="endpoint-item"><div><span class="endpoint-label">${esc(label)}</span><code class="mono">${esc(url)}</code></div><button class="icon-btn btn-sm" type="button" data-action="copy-text" data-copy="${esc(url)}" title="Copy URL" aria-label="Copy ${esc(label)}">${icon("copy")}</button></div>`;
}

function renderModuleCards(details = []) {
  if (!details.length) return emptyState("activity", "No module probes returned", "Refresh to run live verification checks.");
  return `<div class="module-matrix">${details.map((mod) => `<div class="module-card"><div class="module-card-top"><strong>${esc(mod.label || mod.module)}</strong>${moduleStatusBadge(mod.state)}</div><p>${esc(mod.summary || "Live verification check executed.")}</p><div class="module-card-foot"><span>${esc(mod.module)}</span><span>${mod.latencyMs !== undefined ? `${formatNumber(mod.latencyMs)} ms` : "live"}</span></div></div>`).join("")}</div>`;
}

export function renderVisualColumnsBuilder() {
  const container = $("visual-cols-list");
  if (!container) return;
  container.innerHTML = state.visualColumns.map((col, idx) => `<div class="field-row" style="grid-template-columns:1.3fr 1fr auto auto 1.2fr auto;align-items:center;margin-bottom:8px">
    <input class="mono" data-vcol-idx="${idx}" data-vcol-field="name" value="${esc(col.name)}" placeholder="column_name" aria-label="Column name">
    <select data-vcol-idx="${idx}" data-vcol-field="type" aria-label="Column type">
      ${["uuid", "text", "integer", "bigint", "boolean", "numeric", "jsonb", "timestamptz", "date", "serial"].map((t) => `<option value="${t}" ${col.type === t ? "selected" : ""}>${t}</option>`).join("")}
    </select>
    <label class="checkbox-field" title="Primary key"><input type="checkbox" data-vcol-idx="${idx}" data-vcol-field="primaryKey" ${col.primaryKey ? "checked" : ""}><span>PK</span></label>
    <label class="checkbox-field" title="Allow NULL"><input type="checkbox" data-vcol-idx="${idx}" data-vcol-field="nullable" ${col.nullable ? "checked" : ""}><span>NULL</span></label>
    <input class="mono" data-vcol-idx="${idx}" data-vcol-field="defaultValue" value="${esc(col.defaultValue || "")}" placeholder="default (optional)" aria-label="Default expression">
    <button class="icon-btn btn-sm" type="button" data-action="remove-visual-col" data-idx="${idx}" aria-label="Remove column">${icon("trash")}</button>
  </div>`).join("");
  const jsonBox = $("tbl-cols");
  if (jsonBox) {
    jsonBox.value = JSON.stringify(state.visualColumns.filter((c) => c.name.trim()).map((c) => ({
      name: c.name.trim(),
      type: c.type,
      primaryKey: Boolean(c.primaryKey),
      nullable: Boolean(c.nullable),
      ...(c.defaultValue?.trim() ? { defaultValue: c.defaultValue.trim() } : {}),
    })), null, 2);
  }
}

const templates = {
  overview: () => {
    const project = state.activeProject;
    const origin = window.location.origin;
    const wsOrigin = origin.replace(/^http/, "ws");
    const base = `${origin}/v1/projects/${project.slug}`;
    return `${pageHeader("overview")}
      <div id="overview-stats" class="stats-grid">${loadingState("Loading project metrics…")}</div>
      <div class="grid-2 section-gap">
        ${card("Connection Endpoints", `<div class="endpoint-list">${endpointRow("REST Data API", `${base}/rest`)}${endpointRow("RPC Functions API", `${base}/rpc`)}${endpointRow("Authentication API", `${base}/auth`)}${endpointRow("Storage Buckets API", `${base}/storage/buckets`)}${endpointRow("Realtime WebSocket", `${wsOrigin}/v1/projects/${project.slug}/realtime/ws`)}</div>`, { subtitle: "Project-isolated endpoints authenticated with scoped API keys or user Bearer JWTs.", iconName: "link" })}
        ${card("Isolation & Readiness", `<div id="overview-project-meta">${loadingState("Loading project metadata…")}</div><div class="divider"></div><div id="overview-checklist"></div>`, { subtitle: "PostgreSQL schema isolation and production checklist.", iconName: "sparkles" })}
      </div>
      <div class="section-gap">
        ${card("Live Subsystem Verification", `<div id="overview-modules">${loadingState("Probing project subsystems…")}</div>`, { subtitle: "Every status reflects a real backend health and configuration check — never hardcoded.", iconName: "activity" })}
      </div>
      <div class="grid-2 section-gap">
        ${card("Environments", `<div id="environments-list">${loadingState("Loading environments…")}</div><form id="create-env-form" class="inline-form top-gap"><input id="env-name-input" type="text" placeholder="staging" aria-label="Environment name" required><label class="checkbox-field"><input id="env-production" type="checkbox"><span>Production</span></label><button class="btn btn-secondary btn-sm" type="submit">Add environment</button></form>`, { subtitle: "Track deployment stages for this project.", iconName: "layers" })}
        ${card("Quick Actions", `<div class="quick-actions">
          <button class="quick-action" type="button" data-nav="database">${icon("database")}<div><strong>Design schema</strong><span>Create/alter tables, indexes &amp; browse rows</span></div></button>
          <button class="quick-action" type="button" data-nav="api">${icon("globe")}<div><strong>Test Data API</strong><span>Run live REST &amp; RPC requests in-browser</span></div></button>
          <button class="quick-action" type="button" data-nav="security">${icon("key")}<div><strong>Manage API keys</strong><span>Issue anon or service_role credentials</span></div></button>
          <button class="quick-action" type="button" data-nav="backups">${icon("layers")}<div><strong>Create snapshot</strong><span>Checksummed logical backup &amp; restore</span></div></button>
        </div>`, { subtitle: "Jump directly into core workflows.", iconName: "play" })}
      </div>`;
  },

  organizations: () => `${pageHeader("organizations")}
    <div class="grid-sidebar">
      <div class="stack">
        ${card("Your Workspaces", `<div id="orgs-list">${loadingState("Loading workspaces…")}</div>`, { subtitle: "Select a workspace to manage its members, settings, and assigned projects.", iconName: "users", flush: true })}
      </div>
      <div class="stack">
        ${card("Workspace Details & Settings", `<div id="org-detail-box">${loadingState("Loading workspace details…")}</div>`, { subtitle: "Organization-level metadata and danger zone.", iconName: "settings" })}
        ${card("Workspace Members & Inherited RBAC", `<form id="add-org-member-form" class="inline-form"><input id="org-member-email" type="email" placeholder="teammate@company.dev" required><select id="org-member-role" aria-label="Workspace role"><option value="developer">developer</option><option value="admin">admin</option><option value="viewer">viewer</option><option value="owner">owner</option></select><button class="btn btn-primary btn-sm" type="submit">Add / update member</button></form><div id="org-members-list" class="top-gap">${loadingState("Loading members…")}</div>`, { subtitle: "Workspace members automatically inherit access across projects in this organization.", iconName: "shield" })}
        ${card("Workspace Projects", `<div id="org-projects-list">${loadingState("Loading workspace projects…")}</div>`, { subtitle: "Projects currently isolated under this workspace.", iconName: "layers", flush: true })}
      </div>
    </div>`,

  database: () => `${pageHeader("database")}
    <div class="grid-sidebar">
      <div class="stack">
        ${card("Schema Tables", `<div class="list-toolbar"><input id="table-search" type="search" placeholder="Filter tables…" aria-label="Filter tables"></div><div id="tables-list">${loadingState("Loading tables…")}</div>`, { subtitle: state.activeProject.schema_name, iconName: "database", flush: true })}
        <details id="create-table-disclosure" class="disclosure card">
          <summary><span>${icon("plus")} Create new table</span><span class="subtle">Visual / JSON</span></summary>
          <form id="create-table-form" class="disclosure-body stack-form">
            <div class="field-row">
              <div class="field"><label for="tbl-name">Table name</label><input id="tbl-name" class="mono" type="text" placeholder="orders" pattern="[a-zA-Z_][a-zA-Z0-9_]*" required></div>
              <div class="field"><label for="tbl-rls">Row-Level Security</label><select id="tbl-rls"><option value="true">Enabled (recommended)</option><option value="false">Disabled</option></select></div>
            </div>
            <div class="field">
              <div class="label-row"><label>Visual column builder</label><button class="btn btn-ghost btn-sm" type="button" data-action="add-visual-col">${icon("plus")}Add column</button></div>
              <div id="visual-cols-list"></div>
            </div>
            <details class="disclosure">
              <summary><span>Advanced: Raw JSON column definitions</span><span class="subtle">Optional</span></summary>
              <div class="disclosure-body"><textarea id="tbl-cols" class="code-input" rows="6"></textarea></div>
            </details>
            <button class="btn btn-primary w-full" type="submit">Create table</button>
          </form>
        </details>
      </div>
      <div class="stack">
        <section class="card">
          <header class="card-header">
            <div class="card-title"><span class="card-title-icon">${icon("file")}</span><div><h2>Data Browser <span id="active-table-label" class="mono subtle"></span></h2><p id="active-table-details">Select a table to filter, sort, insert, edit, or delete rows.</p></div></div>
            <div class="card-header-actions">
              <button class="btn btn-secondary btn-sm" type="button" data-action="export-rows-csv">${icon("download")}<span>CSV</span></button>
              <button class="btn btn-secondary btn-sm" type="button" data-action="refresh-rows">${icon("refresh")}<span>Reload</span></button>
              <button class="btn btn-primary btn-sm" type="button" data-action="open-insert-row">${icon("plus")}<span>Insert row</span></button>
            </div>
          </header>
          <form id="row-filter-form" class="toolbar-inline">
            <div class="field"><label for="row-filter-input">Filter (e.g. <span class="mono">status=eq.active</span>)</label><input id="row-filter-input" class="mono" type="text" placeholder="column=eq.value"></div>
            <div class="field" style="max-width:170px"><label for="row-sort-col">Order by</label><input id="row-sort-col" class="mono" type="text" placeholder="created_at"></div>
            <div class="field" style="max-width:120px"><label for="row-sort-dir">Direction</label><select id="row-sort-dir"><option value="desc">DESC</option><option value="asc">ASC</option></select></div>
            <div class="field" style="max-width:105px"><label for="row-limit">Page size</label><select id="row-limit"><option value="25">25</option><option value="50">50</option><option value="100">100</option></select></div>
            <button class="btn btn-secondary btn-sm" type="submit">Apply</button>
            <button class="btn btn-ghost btn-sm" type="button" data-action="clear-row-filter">Clear</button>
          </form>
          <div id="table-rows-container" class="card-body flush">${loadingState("Loading table rows…")}</div>
          <div class="pagination-bar">
            <span id="row-pagination-label">Page 1</span>
            <div class="cell-actions">
              <button id="row-prev-btn" class="btn btn-secondary btn-sm" type="button" data-action="rows-prev-page" disabled>Previous</button>
              <button id="row-next-btn" class="btn btn-secondary btn-sm" type="button" data-action="rows-next-page" disabled>Next</button>
            </div>
          </div>
          <div class="card-divider-form">
            <details class="disclosure">
              <summary><span>${icon("terminal")} Advanced: insert raw JSON row</span><span class="subtle">Single object</span></summary>
              <div class="disclosure-body">
                <form id="insert-row-form" class="stack-form">
                  <div class="label-row"><label for="row-json-input">Row JSON payload</label><span class="field-hint">POST to the generated REST endpoint</span></div>
                  <div class="inline-code-submit">
                    <textarea id="row-json-input" class="code-input" rows="2" placeholder='{"title": "Launch MARRY BASE", "completed": false}' required></textarea>
                    <button class="btn btn-primary" type="submit">Insert row</button>
                  </div>
                </form>
              </div>
            </details>
          </div>
        </section>

        <div class="grid-2">
          ${card("Table Schema, Indexes & Relationships", `<div id="table-schema-inspector">${emptyState("database", "No table selected", "Select a table to inspect columns, primary/foreign keys, and indexes.")}</div>`, { subtitle: "Live catalog metadata from PostgreSQL.", iconName: "layers", flush: true })}
          ${card("Alter Table, Columns & Indexes", `<div class="stack-form">
            <form id="alter-rename-table-form" class="inline-form">
              <span class="field-hint" style="flex-basis:100%"><strong>Rename table</strong> <span id="alt-table-current" class="mono subtle"></span></span>
              <input id="alt-table-to" class="mono" type="text" placeholder="new_table_name" required>
              <button class="btn btn-secondary btn-sm" type="submit">Rename table</button>
            </form>
            <div class="divider"></div>
            <form id="alter-add-col-form" class="stack-form">
              <span class="field-hint"><strong>Add column</strong> (with optional FK reference)</span>
              <div class="field-row three">
                <input id="alt-col-name" class="mono" type="text" placeholder="user_id" required>
                <select id="alt-col-type"><option value="text">text</option><option value="uuid">uuid</option><option value="integer">integer</option><option value="bigint">bigint</option><option value="boolean">boolean</option><option value="numeric">numeric</option><option value="jsonb">jsonb</option><option value="timestamptz">timestamptz</option></select>
                <input id="alt-col-default" class="mono" type="text" placeholder="default expr">
              </div>
              <div class="field-row three">
                <input id="alt-fk-table" class="mono" type="text" placeholder="FK table (opt)">
                <input id="alt-fk-col" class="mono" type="text" placeholder="FK col (id)">
                <button class="btn btn-secondary btn-sm" type="submit">Add column</button>
              </div>
            </form>
            <div class="divider"></div>
            <form id="alter-column-form" class="stack-form">
              <span class="field-hint"><strong>Alter column</strong> (type, default &amp; nullability)</span>
              <div class="field-row three">
                <select id="alt2-col-name" aria-label="Column to alter"><option value="">Select column…</option></select>
                <select id="alt2-col-type" aria-label="New type"><option value="">Keep type</option><option value="text">text</option><option value="uuid">uuid</option><option value="integer">integer</option><option value="bigint">bigint</option><option value="boolean">boolean</option><option value="numeric">numeric</option><option value="jsonb">jsonb</option><option value="timestamptz">timestamptz</option><option value="date">date</option></select>
                <select id="alt2-col-nullable" aria-label="Nullability"><option value="">Keep nullability</option><option value="true">Require NOT NULL</option><option value="false">Allow NULL</option></select>
              </div>
              <div class="field-row three">
                <input id="alt2-col-default" class="mono" type="text" placeholder="new default (opt)">
                <label class="checkbox-field"><input id="alt2-col-drop-default" type="checkbox"><span>Drop default</span></label>
                <button class="btn btn-secondary btn-sm" type="submit">Alter column</button>
              </div>
            </form>
            <div class="divider"></div>
            <form id="alter-rename-col-form" class="inline-form">
              <input id="alt-rename-from" class="mono" type="text" placeholder="old_column" required>
              <input id="alt-rename-to" class="mono" type="text" placeholder="new_column" required>
              <button class="btn btn-secondary btn-sm" type="submit">Rename column</button>
            </form>
            <div class="divider"></div>
            <form id="alter-create-index-form" class="inline-form">
              <input id="alt-idx-name" class="mono" type="text" placeholder="idx_orders_created" required>
              <input id="alt-idx-cols" class="mono" type="text" placeholder="created_at, status" required>
              <label class="checkbox-field"><input id="alt-idx-unique" type="checkbox"><span>Unique</span></label>
              <button class="btn btn-secondary btn-sm" type="submit">Create index</button>
            </form>
          </div>`, { subtitle: "Safe DDL operations inside the active project schema.", iconName: "settings" })}
        </div>

        ${card("Database Roles, Isolation & Storage Diagnostics", `<div id="db-diagnostics-box">${loadingState("Checking role isolation and table sizes…")}</div>`, { subtitle: "Verifies least-privilege PostgreSQL role separation (NOBYPASSRLS, NOSUPERUSER) and relation sizes.", iconName: "shield" })}
      </div>
    </div>`,

  sql: () => `${pageHeader("sql")}
    <div class="grid-sidebar-reverse">
      <div class="stack">
        ${card("Saved Queries", `<div id="saved-queries-list">${loadingState("Loading saved queries…")}</div>`, {
          subtitle: "Server-stored SQL library shared with everyone who has access to this project.",
          iconName: "save",
          actions: `<button class="btn btn-secondary btn-sm" type="button" data-action="open-save-query">${icon("plus")}<span>Save current</span></button>`,
          flush: true,
        })}
        ${card("Query Shortcuts", `<div class="quick-actions">
          <button class="quick-action" type="button" data-action="sql-snippet" data-sql="SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() ORDER BY 1;">${icon("database")}<div><strong>List tables</strong><span>All relations in this project schema</span></div></button>
          <button class="quick-action" type="button" data-action="sql-snippet" data-sql="SELECT schemaname AS table_schema, tablename, policyname, cmd, roles, qual FROM pg_policies WHERE schemaname = current_schema() ORDER BY tablename;">${icon("shield")}<div><strong>Inspect policies</strong><span>pg_policies for the active schema</span></div></button>
          <button class="quick-action" type="button" data-action="sql-snippet" data-sql="SELECT relname AS relation, pg_size_pretty(pg_total_relation_size(quote_ident(current_schema()) || '.' || quote_ident(relname))) AS total_size FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC;">${icon("activity")}<div><strong>Table sizes</strong><span>Storage footprint per relation</span></div></button>
          <button class="quick-action" type="button" data-action="sql-snippet" data-sql="SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema() ORDER BY tablename, indexname;">${icon("layers")}<div><strong>List indexes</strong><span>Every index in the schema</span></div></button>
        </div>`, { subtitle: "Load a common introspection query into the workbench.", iconName: "sparkles" })}
      </div>
      <div class="stack">
        <section class="card">
          <header class="card-header">
            <div class="card-title"><span class="card-title-icon">${icon("terminal")}</span><div><h2>SQL Workbench</h2><p>Scoped to <code class="mono">${esc(state.activeProject.schema_name)}</code> with statement timeouts and destructive-query safeguards.</p></div></div>
            <div class="card-header-actions"><select id="sql-history" class="compact-select" aria-label="Recent SQL queries"><option value="">Recent queries…</option></select></div>
          </header>
          <form id="sql-form" class="card-body stack-form">
            <div class="editor-options">
              <div class="field"><label for="sql-role-select">Execution role</label><select id="sql-role-select"><option value="service_role">service_role (owner — bypasses RLS)</option><option value="authenticated">authenticated (enforces RLS)</option><option value="anon">anon (enforces RLS)</option></select></div>
              <div class="field"><label for="sql-user-id">Simulated auth.uid()</label><input id="sql-user-id" class="mono" type="text" placeholder="Optional UUID for RLS testing"></div>
              <div class="field"><label for="sql-destructive">Destructive DDL</label><select id="sql-destructive"><option value="false">Block DROP / TRUNCATE</option><option value="true">Allow destructive SQL</option></select></div>
            </div>
            <div class="field"><label for="sql-editor-input">SQL query</label><textarea id="sql-editor-input" class="code-input code-lg" rows="9" spellcheck="false">SELECT current_schema() AS project_schema, current_user AS db_role, now() AS executed_at;</textarea></div>
            <div class="editor-footer">
              <span class="subtle">Press <kbd>⌘</kbd> + <kbd>Enter</kbd> to run · <span id="sql-active-query-label">unsaved query</span></span>
              <div class="button-row"><button class="btn btn-ghost btn-sm" type="button" data-action="clear-sql">Clear</button><button class="btn btn-secondary btn-sm" type="button" data-action="open-save-query">${icon("save")}<span>Save query</span></button><button class="btn btn-primary" type="submit">${icon("play")}<span>Run query</span></button></div>
            </div>
          </form>
          <div id="sql-result-box" class="sql-results"></div>
        </section>
        <div class="grid-2">
          ${card("Create RLS Policy", `<form id="create-policy-form" class="stack-form">
            <div class="field-row"><div class="field"><label for="pol-table">Target table</label><select id="pol-table" required></select></div><div class="field"><label for="pol-cmd">Command</label><select id="pol-cmd"><option value="ALL">ALL</option><option value="SELECT">SELECT</option><option value="INSERT">INSERT</option><option value="UPDATE">UPDATE</option><option value="DELETE">DELETE</option></select></div></div>
            <div class="field"><label for="pol-name">Policy name</label><input id="pol-name" class="mono" type="text" placeholder="users_manage_own_rows" required></div>
            <div class="field"><label for="pol-using">USING expression</label><input id="pol-using" class="mono" type="text" value="auth.uid() = user_id"></div>
            <div class="field"><label for="pol-check">WITH CHECK expression</label><input id="pol-check" class="mono" type="text" placeholder="Optional — defaults to USING expression for writes"></div>
            <label class="checkbox-field"><input id="pol-enable-rls" type="checkbox" checked><span>Ensure FORCE ROW LEVEL SECURITY is enabled on target table</span></label>
            <button class="btn btn-primary" type="submit">Create RLS policy</button>
          </form>`, { subtitle: "Enforced natively by PostgreSQL under role_<slug>_rls.", iconName: "shield" })}
          ${card("Active RLS Policies", `<div id="rls-policies-list">${loadingState("Loading RLS policies…")}</div>`, { subtitle: "Policies currently active across project tables.", iconName: "lock", flush: true })}
        </div>
      </div>
    </div>`,

  migrations: () => `${pageHeader("migrations")}
    <div class="grid-sidebar-reverse">
      ${card("Apply Versioned Migration", `<form id="apply-migration-form" class="stack-form">
        <div class="field-row"><div class="field"><label for="mig-version">Version</label><input id="mig-version" class="mono" type="text" placeholder="20261024_001" required></div><div class="field"><label for="mig-name">Name</label><input id="mig-name" type="text" placeholder="create_invoices_table" required></div></div>
        <div class="field"><label for="mig-up">Up SQL</label><textarea id="mig-up" class="code-input" rows="6" placeholder="CREATE TABLE invoices (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), amount numeric NOT NULL);" required></textarea></div>
        <div class="field"><label for="mig-down">Down SQL (optional rollback)</label><textarea id="mig-down" class="code-input" rows="3" placeholder="DROP TABLE IF EXISTS invoices;"></textarea></div>
        <button class="btn btn-primary" type="submit">Apply migration</button>
      </form>`, { subtitle: "Runs atomically inside a transaction with SHA-256 checksum tracking.", iconName: "plus" })}
      ${card("Migration History", `<div id="migrations-list">${loadingState("Loading migrations…")}</div>`, { subtitle: "Ordered schema change log for this project.", iconName: "layers", flush: true })}
    </div>`,

  api: () => {
    const slug = state.activeProject.slug;
    const base = `${window.location.origin}/v1/projects/${slug}`;
    return `${pageHeader("api")}
      <div class="subnav-layout">
      <div class="local-tabs" role="tablist" aria-label="API sections">
        <button class="local-tab active" type="button" role="tab" aria-selected="true" data-local-tab="api-explorer">${icon("play")}Live Explorer</button>
        <button class="local-tab" type="button" role="tab" aria-selected="false" data-local-tab="api-endpoints">${icon("globe")}Table &amp; RPC Endpoints</button>
        <button class="local-tab" type="button" role="tab" aria-selected="false" data-local-tab="api-openapi">${icon("file")}OpenAPI 3.1</button>
      </div>
      <div class="subnav-content">

      <div id="local-api-explorer" class="local-panel">
        ${card("Interactive API & RPC Tester", `<form id="api-tester-form" class="stack-form">
          <div class="field-row" style="grid-template-columns:120px 1fr">
            <div class="field"><label for="api-test-method">Method</label><select id="api-test-method"><option value="GET">GET</option><option value="POST">POST</option><option value="PATCH">PATCH</option><option value="DELETE">DELETE</option></select></div>
            <div class="field"><label for="api-test-path">Project-relative path</label><input id="api-test-path" class="mono" type="text" value="/rest/" placeholder="/rest/todos?limit=10 or /rpc/my_func" required></div>
          </div>
          <div class="field-row">
            <div class="field"><label for="api-test-auth">Credential context</label><select id="api-test-auth"><option value="operator">Studio operator session</option><option value="anon">Project anon key (enforces RLS)</option><option value="service_role">Project service_role key (bypasses RLS)</option><option value="bearer">Custom user Bearer JWT</option></select></div>
            <div class="field"><label for="api-test-jwt">Custom Bearer JWT (if selected)</label><input id="api-test-jwt" class="mono" type="text" placeholder="eyJhbGciOi..."></div>
          </div>
          <div class="field"><label for="api-test-body">JSON request body (POST / PATCH)</label><textarea id="api-test-body" class="code-input" rows="4" placeholder='{"title": "From API Explorer"}'></textarea></div>
          <button class="btn btn-primary" type="submit">${icon("play")}<span>Send live request</span></button>
        </form>
        <div class="top-gap"><div class="label-row"><span class="field-hint" id="api-test-meta">Response output</span><button class="btn btn-ghost btn-sm" type="button" data-action="copy-target" data-target="api-test-output">${icon("copy")}Copy</button></div><pre id="api-test-output" class="code-block">Send a request above to inspect live status, latency, and JSON payload.</pre></div>`, { subtitle: `Base URL: ${base}`, iconName: "play" })}
      </div>

      <div id="local-api-endpoints" class="local-panel hidden">
        ${card("Auto-Generated Table & RPC Endpoints", `<div id="api-endpoints-catalog">${loadingState("Generating endpoint catalog from live schema…")}</div>`, { subtitle: "Click any table endpoint to load it into the Interactive API Tester.", iconName: "globe", flush: true })}
      </div>

      <div id="local-api-openapi" class="local-panel hidden">
        ${card("OpenAPI 3.1 Specification", `<div class="button-row" style="margin-bottom:10px"><button class="btn btn-secondary btn-sm" type="button" data-action="copy-target" data-target="openapi-preview">${icon("copy")}Copy JSON</button><button class="btn btn-secondary btn-sm" type="button" data-action="download-openapi">${icon("download")}Download</button><a id="openapi-link" class="btn btn-ghost btn-sm" href="${esc(`${base}/openapi.json`)}" target="_blank" rel="noopener">${icon("external")}Raw</a></div><pre id="openapi-preview" class="code-block code-scroll" style="max-height:520px">Loading OpenAPI 3.1 specification…</pre>`, { subtitle: "Machine-readable schema contract for codegen and API clients.", iconName: "file" })}
      </div>

      </div>
      </div>`;
  },

  auth: () => `${pageHeader("auth")}
    <div class="subnav-layout">
    <div class="local-tabs" role="tablist" aria-label="Authentication sections">
      <button class="local-tab active" type="button" role="tab" aria-selected="true" data-local-tab="auth-users">${icon("users")}Users</button>
      <button class="local-tab" type="button" role="tab" aria-selected="false" data-local-tab="auth-sessions">${icon("clock")}Active Sessions</button>
      <button class="local-tab" type="button" role="tab" aria-selected="false" data-local-tab="auth-policies">${icon("shield")}Policies &amp; OAuth</button>
      <button class="local-tab" type="button" role="tab" aria-selected="false" data-local-tab="auth-tester">${icon("play")}Auth Flow &amp; Recovery Tester</button>
      <button class="local-tab" type="button" role="tab" aria-selected="false" data-local-tab="auth-operator">${icon("key")}Operator Account</button>
    </div>
    <div class="subnav-content">

    <div id="local-auth-users" class="local-panel">
      <div class="grid-sidebar-reverse">
        ${card("Create Project User", `<form id="admin-create-user-form" class="stack-form">
          <div class="field"><label for="u-email">Email address</label><input id="u-email" type="email" placeholder="customer@app.example" required></div>
          <div class="field-row"><div class="field"><label for="u-pass">Initial password</label><input id="u-pass" type="password" minlength="8" placeholder="••••••••" required></div><div class="field"><label for="u-role">Role</label><input id="u-role" type="text" value="authenticated" required></div></div>
          <label class="checkbox-field"><input id="u-verified" type="checkbox" checked><span>Mark email as verified</span></label>
          <button class="btn btn-primary" type="submit">Create user</button>
        </form>`, { subtitle: "Provision end-user identities inside this project.", iconName: "plus" })}
        ${card("Project Users", `<div class="list-toolbar"><input id="auth-user-search" type="search" placeholder="Search users by email…" aria-label="Search users"></div><div id="project-users-list">${loadingState("Loading project users…")}</div>`, { subtitle: "Identities scoped exclusively to this project.", iconName: "users", flush: true })}
      </div>
    </div>

    <div id="local-auth-sessions" class="local-panel hidden">
      ${card("Issued Refresh-Token Sessions", `<div id="project-sessions-list">${loadingState("Loading sessions…")}</div>`, { subtitle: "Inspect active end-user sessions and revoke compromised tokens immediately.", iconName: "clock", flush: true })}
    </div>

    <div id="local-auth-policies" class="local-panel hidden">
      <div class="grid-2">
        ${card("Authentication Policy", `<form id="auth-config-form" class="stack-form">
          <div class="field-row"><div class="field"><label for="cfg-public-signup">Public sign-up</label><select id="cfg-public-signup"><option value="true">Allowed</option><option value="false">Invite / admin only</option></select></div><div class="field"><label for="cfg-email-verify">Require email verification</label><select id="cfg-email-verify"><option value="false">Optional</option><option value="true">Required before login</option></select></div></div>
          <div class="field-row three"><div class="field"><label for="cfg-pass-len">Min password</label><input id="cfg-pass-len" type="number" min="6" max="128" value="8"></div><div class="field"><label for="cfg-access-ttl">Access TTL (s)</label><input id="cfg-access-ttl" type="number" min="60" value="3600"></div><div class="field"><label for="cfg-refresh-ttl">Refresh TTL (s)</label><input id="cfg-refresh-ttl" type="number" min="300" value="2592000"></div></div>
          <button class="btn btn-primary" type="submit">Save auth policy</button>
        </form>`, { subtitle: "Controls signup rules, password length, and JWT lifetimes.", iconName: "lock" })}

        ${card("OAuth Identity Providers", `<form id="oauth-provider-form" class="stack-form">
          <div class="field-row"><div class="field"><label for="oauth-provider-name">Provider</label><select id="oauth-provider-name"><option value="github">GitHub</option><option value="google">Google</option><option value="gitlab">GitLab</option></select></div><div class="field"><label for="oauth-enabled">Status</label><select id="oauth-enabled"><option value="true">Enabled</option><option value="false">Disabled</option></select></div></div>
          <div class="field"><label for="oauth-client-id">Client ID</label><input id="oauth-client-id" class="mono" type="text" placeholder="Iv1.8a61f9b3a7aba766"></div>
          <div class="field-row"><div class="field"><label for="oauth-auth-url">Authorize URL (optional override)</label><input id="oauth-auth-url" class="mono" type="url" placeholder="https://github.com/login/oauth/authorize"></div><div class="field"><label for="oauth-scopes">Scopes (comma-separated)</label><input id="oauth-scopes" class="mono" type="text" value="read:user, user:email"></div></div>
          <button class="btn btn-primary" type="submit">Save OAuth provider</button>
        </form><div id="oauth-configured-list" class="top-gap"></div>`, { subtitle: "Configure external OAuth providers for /auth/oauth/:provider/authorize.", iconName: "globe" })}
      </div>
    </div>

    <div id="local-auth-tester" class="local-panel hidden">
      <div class="grid-2">
        ${card("Client Sign-Up & Sign-In Tester", `<form id="client-auth-test-form" class="stack-form">
          <div class="field-row"><div class="field"><label for="cat-mode">Flow</label><select id="cat-mode"><option value="signup">POST /auth/signup</option><option value="login">POST /auth/login</option></select></div><div class="field"><label for="cat-email">User email</label><input id="cat-email" type="email" placeholder="tester@app.example" required></div></div>
          <div class="field"><label for="cat-password">Password</label><input id="cat-password" type="password" placeholder="StrongPass123!" required></div>
          <button class="btn btn-primary" type="submit">Run auth flow</button>
        </form><pre id="cat-output" class="code-block top-gap">Test end-user signup or login using the project anon key.</pre>`, { subtitle: "Copy the returned access_token to test RLS in API Explorer.", iconName: "play" })}

        ${card("Password Recovery & Reset Tester", `<form id="client-recovery-form" class="stack-form">
          <div class="field"><label for="rec-email">Request recovery token for email</label><div class="inline-form"><input id="rec-email" type="email" placeholder="tester@app.example" required><button class="btn btn-secondary btn-sm" type="submit">Request recovery</button></div></div>
        </form>
        <div class="divider"></div>
        <form id="client-reset-form" class="stack-form">
          <div class="field"><label for="rec-token">Recovery token</label><input id="rec-token" class="mono" type="text" placeholder="Paste recovery token" required></div>
          <div class="field"><label for="rec-new-pass">New password</label><input id="rec-new-pass" type="password" minlength="8" placeholder="NewStrongPass123!" required></div>
          <button class="btn btn-primary btn-sm" type="submit">Complete password reset</button>
        </form><pre id="rec-output" class="code-block top-gap">Recovery response will appear here.</pre>`, { subtitle: "Exercises /auth/recover and /auth/reset-password end-to-end.", iconName: "key" })}
      </div>
    </div>

    <div id="local-auth-operator" class="local-panel hidden">
      <div class="grid-2">
        ${card("Studio Operator Profile", `<form id="operator-profile-form" class="stack-form">
          <div class="field"><label for="op-email">Operator email</label><input id="op-email" type="email" value="${esc(state.user?.email || "")}" disabled></div>
          <div class="field"><label for="op-name">Display name</label><input id="op-name" type="text" value="${esc(state.user?.name || "")}" placeholder="Platform Operator"></div>
          <button class="btn btn-primary" type="submit">Update profile</button>
        </form>`, { subtitle: `Account privilege: ${state.user?.is_superadmin ? "Superadmin" : "Standard Operator"}`, iconName: "users" })}
        ${card("Change Operator Password", `<form id="operator-password-form" class="stack-form">
          <div class="field"><label for="op-cur-pass">Current password</label><input id="op-cur-pass" type="password" required></div>
          <div class="field"><label for="op-new-pass">New password (10+ characters)</label><input id="op-new-pass" type="password" minlength="10" required></div>
          <button class="btn btn-primary" type="submit">Rotate operator password</button>
        </form>`, { subtitle: "Revokes other active Studio sessions for your account.", iconName: "shield" })}
      </div>
    </div>
    </div>
    </div>`,

  storage: () => `${pageHeader("storage")}
    <div class="subnav-layout">
    <div class="local-tabs" role="tablist" aria-label="Storage sections">
      <button class="local-tab active" type="button" role="tab" aria-selected="true" data-local-tab="storage-buckets">${icon("storage")}Buckets &amp; Objects</button>
      <button class="local-tab" type="button" role="tab" aria-selected="false" data-local-tab="storage-settings">${icon("settings")}Settings &amp; Signed URLs</button>
      <button class="local-tab" type="button" role="tab" aria-selected="false" data-local-tab="storage-policies">${icon("shield")}Access Policies</button>
    </div>
    <div class="subnav-content">

    <div id="local-storage-buckets" class="local-panel">
      <div class="grid-sidebar">
        <div class="stack">
          ${card("Buckets", `<div id="buckets-list">${loadingState("Loading buckets…")}</div>`, { subtitle: "Isolated object containers with quota & MIME enforcement.", iconName: "storage", flush: true })}
          <details id="create-bucket-disclosure" class="disclosure card">
            <summary><span>${icon("plus")} New bucket</span><span class="subtle">Container</span></summary>
            <form id="create-bucket-form" class="disclosure-body stack-form">
              <div class="field"><label for="bucket-name">Bucket name</label><input id="bucket-name" class="mono" type="text" placeholder="avatars" required></div>
              <div class="field-row"><div class="field"><label for="bucket-public">Access</label><select id="bucket-public"><option value="false">Private (signed URLs / policies)</option><option value="true">Public read</option></select></div><div class="field"><label for="bucket-limit">Max file size (MB)</label><input id="bucket-limit" type="number" min="1" value="25"></div></div>
              <div class="field"><label for="bucket-mimes">Allowed MIME types (comma-separated, optional)</label><input id="bucket-mimes" class="mono" type="text" placeholder="image/png, image/jpeg, application/pdf"></div>
              <button class="btn btn-primary w-full" type="submit">Create bucket</button>
            </form>
          </details>
        </div>
        <div class="stack">
          ${card("Upload Object", `<form id="upload-object-form" class="stack-form">
            <div class="field-row"><div class="field"><label for="obj-path">Object path</label><input id="obj-path" class="mono" type="text" placeholder="docs/welcome.txt" required></div><div class="field"><label for="obj-mime">Content-Type</label><input id="obj-mime" class="mono" type="text" value="text/plain"></div></div>
            <div class="field"><label for="obj-file">Binary / file upload</label><label class="file-drop" for="obj-file">${icon("upload")}<div><strong>Choose a local file</strong><span id="obj-file-label">Or enter text content below</span></div><input id="obj-file" type="file"></label></div>
            <div class="field"><label for="obj-content">Or UTF-8 text content</label><textarea id="obj-content" class="code-input" rows="2" placeholder="Hello from MARRY BASE Storage"></textarea></div>
            <div class="editor-footer"><span class="subtle" id="active-bucket-label">Select a bucket first</span><button class="btn btn-primary" type="submit">${icon("upload")}<span>Upload</span></button></div>
          </form>`, { subtitle: "Stores SHA-256 checksums and custom metadata.", iconName: "upload" })}

          ${card("Stored Objects", `<div class="list-toolbar"><input id="object-prefix" type="search" placeholder="Filter by path prefix…" aria-label="Filter objects"></div><div id="bucket-objects-list">${loadingState("Loading objects…")}</div><div id="object-metadata-box"></div>`, { subtitle: "Inspect SHA-256 metadata, download via signed URL, or delete.", iconName: "file", flush: true })}
        </div>
      </div>
    </div>

    <div id="local-storage-settings" class="local-panel hidden">
      <div class="grid-2">
        ${card("Bucket Settings", `<form id="update-bucket-form" class="stack-form">
          <div class="field-row three">
            <div class="field"><label for="bset-public">Visibility</label><select id="bset-public"><option value="false">Private</option><option value="true">Public</option></select></div>
            <div class="field"><label for="bset-limit">Max file (MB)</label><input id="bset-limit" type="number" min="1" value="25"></div>
            <div class="field"><label for="bset-quota">Bucket quota (MB)</label><input id="bset-quota" type="number" min="0" placeholder="0 = default"></div>
          </div>
          <div class="field"><label for="bset-mimes">Allowed MIME types</label><input id="bset-mimes" class="mono" type="text" placeholder="Leave blank for any MIME"></div>
          <button class="btn btn-secondary btn-sm" type="submit">Save bucket settings</button>
        </form>`, { subtitle: "Configure visibility and limits for the active bucket.", iconName: "settings" })}
        ${card("Signed URLs", `<form id="sign-object-form" class="stack-form">
          <span class="field-hint"><strong>Generate Signed URL</strong> (private download or client upload)</span>
          <div class="field-row three">
            <input id="sign-path" class="mono" type="text" placeholder="docs/welcome.txt" required>
            <select id="sign-op"><option value="download">download</option><option value="upload">upload</option></select>
            <input id="sign-ttl" type="number" min="10" max="604800" value="600" title="TTL seconds">
          </div>
          <button class="btn btn-secondary btn-sm" type="submit">Create signed URL</button>
        </form>
        <div id="signed-url-result" class="top-gap"></div>`, { subtitle: "Time-limited HMAC URLs for private objects and direct client uploads.", iconName: "link" })}
      </div>
    </div>

    <div id="local-storage-policies" class="local-panel hidden">
      ${card("Bucket Access Policies", `<form id="create-storage-policy-form" class="inline-form">
        <input id="spol-name" class="mono" type="text" placeholder="allow_user_avatars" required>
        <select id="spol-op"><option value="ALL">ALL</option><option value="SELECT">SELECT</option><option value="INSERT">INSERT</option><option value="UPDATE">UPDATE</option><option value="DELETE">DELETE</option></select>
        <input id="spol-roles" class="mono" type="text" value="authenticated" placeholder="authenticated, anon">
        <input id="spol-prefix" class="mono" type="text" placeholder="path prefix (opt)">
        <label class="checkbox-field"><input id="spol-owner" type="checkbox"><span>Owner only</span></label>
        <button class="btn btn-primary btn-sm" type="submit">Add policy</button>
      </form><div id="storage-policies-list" class="top-gap">${loadingState("Loading bucket policies…")}</div>`, { subtitle: "Backend-enforced access control rules for non-service_role requests on the active bucket.", iconName: "shield" })}
    </div>

    </div>
    </div>`,

  realtime: () => `${pageHeader("realtime")}
    <div id="realtime-status-cards" class="stats-grid stats-3">${loadingState("Loading realtime broker status…")}</div>
    <div class="subnav-layout">
    <div class="local-tabs" role="tablist" aria-label="Realtime sections">
      <button class="local-tab active" type="button" role="tab" aria-selected="true" data-local-tab="rt-inspector">${icon("realtime")}Live Inspector</button>
      <button class="local-tab" type="button" role="tab" aria-selected="false" data-local-tab="rt-publish">${icon("play")}Broadcast &amp; Channels</button>
      <button class="local-tab" type="button" role="tab" aria-selected="false" data-local-tab="rt-history">${icon("clock")}Event History</button>
    </div>
    <div class="subnav-content">

    <div id="local-rt-inspector" class="local-panel">
      ${card("Live WebSocket Inspector", `<div id="rt-connection-banner" class="connection-banner" role="status"><span class="status-dot"></span><span>Disconnected. Choose a topic and connect to stream live events.</span></div>
        <form id="rt-connect-form" class="inline-form top-gap"><input id="rt-topic" class="mono" type="text" value="db:*" aria-label="Realtime topic" required><button class="btn btn-primary btn-sm" type="submit">Connect &amp; subscribe</button><button class="btn btn-secondary btn-sm" type="button" data-action="rt-disconnect">Disconnect</button></form>
        <div class="log-box-wrap top-gap"><div class="label-row"><span class="field-hint">Live WebSocket frames</span><button class="btn btn-ghost btn-sm" type="button" data-action="clear-realtime-log">Clear</button></div><pre id="rt-stream-log" class="code-block log-stream">Waiting for a realtime connection…</pre></div>`, { subtitle: "Authenticates with a scoped project API key over native WebSocket.", iconName: "realtime" })}
    </div>

    <div id="local-rt-publish" class="local-panel hidden">
      <div class="grid-2">
        ${card("Publish Broadcast Event", `<form id="rt-broadcast-form" class="stack-form">
          <div class="field-row"><div class="field"><label for="rt-broadcast-topic">Topic</label><input id="rt-broadcast-topic" class="mono" type="text" value="room:lobby" required></div><div class="field"><label for="rt-event">Event name</label><input id="rt-event" class="mono" type="text" value="announcement" required></div></div>
          <div class="field"><label for="rt-payload">JSON payload</label><textarea id="rt-payload" class="code-input" rows="3">{"message": "Deployment ready"}</textarea></div>
          <button class="btn btn-primary" type="submit">Publish broadcast</button>
        </form>`, { subtitle: "Delivers to connected WebSocket subscribers and persists in event log.", iconName: "play" })}
        ${card("Configure Channel", `<form id="rt-channel-form" class="inline-form"><input id="rt-chan-topic" class="mono" type="text" placeholder="room:orders" required><label class="checkbox-field"><input id="rt-chan-private" type="checkbox"><span>Private channel</span></label><button class="btn btn-secondary btn-sm" type="submit">Save channel</button></form><div id="rt-channels-list" class="top-gap">${loadingState("Loading channels…")}</div>`, { subtitle: "Register public or private realtime topics.", iconName: "layers" })}
      </div>
    </div>

    <div id="local-rt-history" class="local-panel hidden">
      ${card("Persisted Event History", `<div id="rt-events-table">${loadingState("Loading persisted events…")}</div>`, { subtitle: "Recent PostgreSQL trigger changes and HTTP/WebSocket broadcasts.", iconName: "clock", flush: true })}
    </div>

    </div>
    </div>`,

  functions: () => `${pageHeader("functions")}
    <div class="subnav-layout">
    <div class="local-tabs" role="tablist" aria-label="Compute modules">
      <button class="local-tab active" type="button" role="tab" aria-selected="true" data-local-tab="functions">${icon("function")}Server Functions</button>
      <button class="local-tab" type="button" role="tab" aria-selected="false" data-local-tab="jobs">${icon("clock")}Background Jobs</button>
      <button class="local-tab" type="button" role="tab" aria-selected="false" data-local-tab="schedules">${icon("refresh")}Recurring Schedules</button>
    </div>
    <div class="subnav-content">

    <div id="local-functions" class="local-panel">
      <div class="grid-2">
        ${card("Deploy Isolated Function", `<form id="deploy-fn-form" class="stack-form">
          <div class="field-row"><div class="field"><label for="fn-slug">Function slug</label><input id="fn-slug" class="mono" type="text" placeholder="hello-world" required></div><div class="field"><label for="fn-name">Display name</label><input id="fn-name" type="text" placeholder="Hello World"></div></div>
          <div class="field-row"><div class="field"><label for="fn-jwt">JWT verification</label><select id="fn-jwt"><option value="false">Public / API key</option><option value="true">Require valid JWT</option></select></div><div class="field"><label for="fn-timeout">Timeout (ms)</label><input id="fn-timeout" type="number" min="500" max="60000" value="10000"></div></div>
          <div class="field"><label for="fn-env">Environment variables (JSON object)</label><textarea id="fn-env" class="code-input" rows="2" spellcheck="false">{"APP_STAGE": "production"}</textarea></div>
          <div class="field"><label for="fn-code">Handler source (ESM)</label><textarea id="fn-code" class="code-input code-lg" rows="8" spellcheck="false" required>${esc(DEFAULT_FUNCTION_CODE)}</textarea></div>
          <div class="button-row"><button class="btn btn-primary" type="submit">Deploy new version</button><button class="btn btn-ghost btn-sm" type="button" data-action="reset-function-form">Reset</button></div>
        </form>`, { subtitle: "Runs in a permission-restricted child worker with scoped ctx.db and encrypted secrets.", iconName: "function" })}

        <div class="stack">
          ${card("Deployed Functions", `<div id="functions-list">${loadingState("Loading functions…")}</div>`, { subtitle: "Versioned serverless endpoints.", iconName: "layers", flush: true })}
          ${card("Invoke Function & Inspect Logs", `<form id="invoke-fn-form" class="stack-form">
            <div class="field"><label for="fn-invoke-slug">Target function</label><select id="fn-invoke-slug"></select></div>
            <div class="field"><label for="fn-payload">Request body (JSON)</label><textarea id="fn-payload" class="code-input" rows="2">{"ping": true}</textarea></div>
            <div class="button-row"><button class="btn btn-primary btn-sm" type="submit">${icon("play")}Invoke now</button><button class="btn btn-secondary btn-sm" type="button" data-action="load-fn-logs">${icon("activity")}Load execution logs</button></div>
          </form><pre id="fn-invoke-output" class="code-block top-gap">Select a deployed function and invoke it to inspect output and duration.</pre><div id="fn-logs-list" class="top-gap"></div>`, { subtitle: "Live execution response and captured stdout/error logs.", iconName: "play" })}
        </div>
      </div>
    </div>

    <div id="local-jobs" class="local-panel hidden">
      <div class="grid-sidebar-reverse">
        ${card("Enqueue Durable Job", `<form id="create-job-form" class="stack-form">
          <div class="field-row"><div class="field"><label for="job-type">Job type</label><select id="job-type"><option value="function">function (invoke deployed handler)</option><option value="webhook">webhook (outbound HTTP POST)</option><option value="sql_maintenance">sql_maintenance (ANALYZE schema)</option></select></div><div class="field"><label for="job-queue">Queue</label><input id="job-queue" class="mono" type="text" value="default" required></div></div>
          <div class="field"><label for="job-delay">Initial delay (seconds)</label><input id="job-delay" type="number" min="0" value="0"></div>
          <div class="field"><label for="job-payload">Payload JSON (e.g. {"functionSlug":"hello-world"} or {"url":"https://..."})</label><textarea id="job-payload" class="code-input" rows="4">{"functionSlug": "hello-world", "body": {"source": "queue"}}</textarea></div>
          <div class="button-row"><button class="btn btn-primary" type="submit">Enqueue job</button><button class="btn btn-secondary" type="button" data-action="process-jobs">Process due jobs</button></div>
        </form>`, { subtitle: "Backed by PostgreSQL FOR UPDATE SKIP LOCKED with exponential backoff & SSRF-guarded webhooks.", iconName: "clock" })}
        ${card("Job Queue", `<div class="list-toolbar"><select id="job-status-filter" aria-label="Filter jobs by status"><option value="">All statuses</option><option value="queued">Queued</option><option value="running">Running</option><option value="completed">Completed</option><option value="failed">Failed</option><option value="dead_letter">Dead letter</option><option value="cancelled">Cancelled</option></select></div><div id="jobs-list">${loadingState("Loading jobs…")}</div>`, { subtitle: "Retry failed/cancelled jobs or cancel pending work.", iconName: "layers", flush: true })}
      </div>
    </div>

    <div id="local-schedules" class="local-panel hidden">
      <div class="grid-sidebar-reverse">
        ${card("Create Recurring Schedule", `<form id="create-schedule-form" class="stack-form">
          <div class="field"><label for="schedule-name">Schedule name</label><input id="schedule-name" type="text" placeholder="hourly-cleanup" required></div>
          <div class="field-row"><div class="field"><label for="schedule-type">Job type</label><select id="schedule-type"><option value="function">Function invocation</option><option value="sql_maintenance">Schema ANALYZE</option></select></div><div class="field"><label for="schedule-interval">Interval (seconds)</label><input id="schedule-interval" type="number" min="10" value="3600"></div></div>
          <div class="field"><label for="schedule-target">Target function slug</label><input id="schedule-target" class="mono" type="text" placeholder="hello-world"></div>
          <div class="field"><label for="schedule-payload">Payload JSON</label><textarea id="schedule-payload" class="code-input" rows="3">{}</textarea></div>
          <button class="btn btn-primary" type="submit">Save schedule</button>
        </form>`, { subtitle: "Automatically enqueues durable jobs on schedule.", iconName: "plus" })}
        ${card("Configured Schedules", `<div id="schedules-list">${loadingState("Loading schedules…")}</div>`, { subtitle: "Active recurring tasks for this project.", iconName: "clock", flush: true })}
      </div>
    </div>
    </div>
    </div>`,

  logs: () => `${pageHeader("logs")}
    <div class="subnav-layout">
    <div class="local-tabs" role="tablist" aria-label="Logs and monitoring sections">
      <button class="local-tab active" type="button" role="tab" aria-selected="true" data-local-tab="logs-health">${icon("activity")}Health &amp; Quotas</button>
      <button class="local-tab" type="button" role="tab" aria-selected="false" data-local-tab="logs-errors">${icon("alert")}Error Logs</button>
      <button class="local-tab" type="button" role="tab" aria-selected="false" data-local-tab="logs-audit">${icon("shield")}Audit Trail</button>
    </div>
    <div class="subnav-content">

    <div id="local-logs-health" class="local-panel">
      <div class="grid-2">
        ${card("Truthful Subsystem Health Matrix", `<div id="logs-module-matrix">${loadingState("Running live verification probes…")}</div>`, { subtitle: "Distinguishes operational_verified, requires_configuration, unavailable, and failed states.", iconName: "activity" })}
        ${card("Resource Quotas & Live Consumption", `<div id="logs-quota-meters">${loadingState("Measuring database, storage, and worker usage…")}</div>`, { subtitle: "Real PostgreSQL relation sizes, bucket bytes, functions, and job counts against project quotas.", iconName: "database" })}
      </div>
    </div>

    <div id="local-logs-errors" class="local-panel hidden">
      ${card("Structured Error & Warning Logs", `<div class="list-toolbar" style="display:flex;gap:8px"><select id="err-source-filter" aria-label="Error source"><option value="">All sources</option><option value="api">API</option><option value="database">Database</option><option value="auth">Auth</option><option value="storage">Storage</option><option value="function">Function</option><option value="job">Background Job</option></select><input id="err-search-filter" type="search" placeholder="Search error message or path…"></div><div id="error-logs-list">${loadingState("Loading error logs…")}</div>`, { subtitle: "Captured 4xx/5xx API errors, database failures, and worker exceptions.", iconName: "alert", flush: true })}
    </div>

    <div id="local-logs-audit" class="local-panel hidden">
      ${card("Project Security & Operational Audit Trail", `<div class="list-toolbar"><input id="audit-action-filter" type="search" placeholder="Filter by action (e.g. database.table_created)…" aria-label="Filter audit events"></div><div id="audit-events-list">${loadingState("Loading audit events…")}</div>`, { subtitle: "Immutable record of schema changes, key rotations, user admin, and restores.", iconName: "shield", flush: true })}
    </div>

    </div>
    </div>`,

  backups: () => `${pageHeader("backups")}
    <div class="subnav-layout">
    <div class="local-tabs" role="tablist" aria-label="Backups and project settings">
      <button class="local-tab active" type="button" role="tab" aria-selected="true" data-local-tab="backups-main">${icon("storage")}Snapshots &amp; Recovery</button>
      <button class="local-tab" type="button" role="tab" aria-selected="false" data-local-tab="project-settings">${icon("settings")}Project Settings &amp; Quotas</button>
      <button class="local-tab" type="button" role="tab" aria-selected="false" data-local-tab="android-companion">${icon("sparkles")}Android Companion &amp; APK</button>
    </div>
    <div class="subnav-content">

    <div id="local-backups-main" class="local-panel">
      <div class="grid-sidebar-reverse">
        ${card("Create Logical Snapshot", `<form id="create-backup-form" class="stack-form">
          <div class="field"><label for="backup-name-input">Snapshot label</label><input id="backup-name-input" type="text" placeholder="pre-release-2026-10-24"></div>
          <p class="subtle">Captures project schema DDL, table rows, RLS policies, auth identities, storage metadata, functions, and schedules with a verified SHA-256 digest.</p>
          <button class="btn btn-primary" type="submit">Create snapshot</button>
        </form>`, { subtitle: "Project-isolated disaster recovery archive.", iconName: "plus" })}
        ${card("Available Snapshots", `<div id="backups-list">${loadingState("Loading snapshots…")}</div>`, { subtitle: "Verify SHA-256 integrity at any time or run a safeguarded point-in-time restore.", iconName: "storage", flush: true })}
      </div>
    </div>

    <div id="local-project-settings" class="local-panel hidden">
      <div class="grid-2">
        ${card("Project Configuration & Quotas", `<form id="project-settings-form" class="stack-form">
          <div class="field-row"><div class="field"><label for="settings-name">Project name</label><input id="settings-name" type="text" required></div><div class="field"><label for="settings-status">Lifecycle status</label><select id="settings-status"><option value="active">Active</option><option value="suspended">Suspended</option><option value="archived">Archived</option></select></div></div>
          <div class="field"><label for="settings-org">Assigned Workspace / Organization</label><select id="settings-org"><option value="">Personal / Unassigned</option></select></div>
          <div class="field"><label for="settings-description">Description</label><textarea id="settings-description" rows="2"></textarea></div>
          <div class="field-row three">
            <div class="field"><label for="settings-db-quota">DB quota (MB)</label><input id="settings-db-quota" type="number" min="10" value="500"></div>
            <div class="field"><label for="settings-storage-quota">Storage quota (MB)</label><input id="settings-storage-quota" type="number" min="10" value="1024"></div>
            <div class="field"><label for="settings-max-fns">Max functions</label><input id="settings-max-fns" type="number" min="1" value="50"></div>
          </div>
          <button class="btn btn-primary" type="submit">Save project settings</button>
        </form>`, { subtitle: "Project-scoped configuration (distinct from instance-wide Platform Admin).", iconName: "settings" })}

        ${card("Danger Zone", `<div class="danger-zone"><p>Permanently drops PostgreSQL schema <code class="mono">${esc(state.activeProject.schema_name)}</code>, least-privilege roles, project users, buckets, API keys, and functions.</p><button class="btn btn-danger" type="button" data-action="delete-project">${icon("trash")}<span>Delete project permanently</span></button></div>`, { subtitle: "Irreversible destructive action — create a verified backup first.", iconName: "alert", className: "danger-card" })}
      </div>
    </div>

    <div id="local-android-companion" class="local-panel hidden">
      <div class="grid-2">
        ${card("Android Companion & Build Pipeline Status", `<div id="apk-status-box">${loadingState("Inspecting compiled APK artifact and Gradle toolchain…")}</div>`, { subtitle: "Genuine Android Gradle pipeline (android/) + apksigner verification.", iconName: "sparkles" })}
        ${card("Trigger Local Gradle Build", `<form id="build-apk-form" class="stack-form">
          <div class="field"><label for="apk-server-url">Default MARRY BASE URL</label><input id="apk-server-url" class="mono" type="url" value="${esc(window.location.origin)}" required></div>
          <div class="field-row"><div class="field"><label for="apk-version-name">Version name</label><input id="apk-version-name" class="mono" type="text" value="1.2.0" required></div><div class="field"><label for="apk-version-code">Version code</label><input id="apk-version-code" type="number" min="1" value="3" required></div></div>
          <button class="btn btn-primary" type="submit">Compile APK with Gradle</button>
        </form><div id="apk-build-result" class="top-gap"></div>`, { subtitle: "Requires JDK 17 + Android SDK + Gradle on the host, or builds automatically in GitHub Actions CI.", iconName: "download" })}
      </div>
    </div>
    </div>
    </div>`,

  security: () => `${pageHeader("security")}
    <div class="subnav-layout">
    <div class="local-tabs" role="tablist" aria-label="Security sections">
      <button class="local-tab active" type="button" role="tab" aria-selected="true" data-local-tab="keys">${icon("key")}API Keys</button>
      <button class="local-tab" type="button" role="tab" aria-selected="false" data-local-tab="secrets">${icon("lock")}Encrypted Secrets</button>
      <button class="local-tab" type="button" role="tab" aria-selected="false" data-local-tab="members">${icon("users")}Project Team &amp; RBAC</button>
    </div>
    <div class="subnav-content">

    <div id="local-keys" class="local-panel">
      <div class="grid-sidebar-reverse">
        ${card("Create Scoped API Key", `<form id="create-key-form" class="stack-form">
          <div class="field"><label for="key-name">Key label</label><input id="key-name" type="text" placeholder="Web frontend" required></div>
          <div class="field"><label for="key-role">Privilege role</label><select id="key-role"><option value="anon">anon — enforces PostgreSQL RLS</option><option value="service_role">service_role — server-only, bypasses RLS</option></select></div>
          <div class="field"><label for="key-scopes">Allowed scopes</label><input id="key-scopes" class="mono" type="text" value="rest:read, rest:write, auth:public, storage:read, realtime:subscribe"></div>
          <button class="btn btn-primary" type="submit">Generate key</button>
        </form>`, { subtitle: "Raw key material is shown once at creation or rotation.", iconName: "key" })}
        ${card("Issued API Keys", `<div id="api-keys-list">${loadingState("Loading API keys…")}</div>`, { subtitle: "Rotate immediately if a credential is exposed.", iconName: "shield", flush: true })}
      </div>
    </div>

    <div id="local-secrets" class="local-panel hidden">
      <div class="grid-sidebar-reverse">
        ${card("Store Encrypted Secret", `<form id="create-secret-form" class="stack-form">
          <div class="field"><label for="sec-name">Secret name</label><input id="sec-name" class="mono" type="text" placeholder="STRIPE_SECRET_KEY" pattern="[A-Z][A-Z0-9_]*" required></div>
          <div class="field"><label for="sec-val">Secret value</label><input id="sec-val" type="password" placeholder="sk_live_…" required></div>
          <div class="field"><label for="sec-description">Description</label><input id="sec-description" type="text" placeholder="Injected into server functions via ctx.secrets"></div>
          <button class="btn btn-primary" type="submit">Encrypt &amp; save</button>
        </form>`, { subtitle: "Encrypted at rest using AES-256-GCM.", iconName: "lock" })}
        ${card("Stored Secrets", `<div id="secrets-list">${loadingState("Loading secrets…")}</div>`, { subtitle: "Values stay masked until explicitly revealed.", iconName: "eye", actions: `<button class="btn btn-secondary btn-sm" type="button" data-action="toggle-secrets">${icon("eye")}<span id="secret-toggle-label">Reveal values</span></button>`, flush: true })}
      </div>
    </div>

    <div id="local-members" class="local-panel hidden">
      <div class="grid-sidebar-reverse">
        ${card("Grant Direct Project Access", `<form id="add-member-form" class="stack-form">
          <div class="field"><label for="member-email">Operator email</label><input id="member-email" type="email" placeholder="teammate@company.dev" required></div>
          <div class="field"><label for="member-role">Project role</label><select id="member-role"><option value="developer">Developer — schema, SQL, storage, functions</option><option value="admin">Admin — keys, secrets, members, settings</option><option value="viewer">Viewer — read-only inspection</option></select></div>
          <button class="btn btn-primary" type="submit">Save project member</button>
        </form>`, { subtitle: "Operators in the project's parent Workspace also inherit access automatically.", iconName: "users" })}
        ${card("Direct Project Members", `<div id="members-list">${loadingState("Loading members…")}</div>`, { subtitle: "Role-based control-plane access for this project.", iconName: "shield", flush: true })}
      </div>
    </div>
    </div>
    </div>`,

  platform: () => `${pageHeader("platform")}
    <div id="platform-diag-stats" class="stats-grid">${loadingState("Loading instance runtime diagnostics…")}</div>
    <div class="section-gap">
      ${card("Instance Module Verification", `<div id="platform-modules-matrix">${loadingState("Evaluating platform subsystems…")}</div>`, { subtitle: "Live readiness probes across control plane, database, workers, storage, and Android builder.", iconName: "activity" })}
    </div>
    <div id="platform-superadmin-area" class="section-gap">${loadingState("Checking operator privileges…")}</div>`,

  docs: () => {
    const slug = state.activeProject?.slug || "your-project-slug";
    const origin = window.location.origin;
    const wsOrigin = origin.replace(/^http/, "ws");
    const sdkCode = `import { createMarryBaseClient } from "marry-base/sdk";

const mb = createMarryBaseClient(
  "${origin}",
  process.env.MARRY_BASE_ANON_KEY!,
  { projectRef: "${slug}" }
);

// 1. End-user authentication (automatically sets Bearer token on client)
const { data: session, error: authErr } = await mb.auth.signUp({
  email: "ada@company.dev",
  password: "StrongPassword123!",
});

// 2. Query & insert rows (enforces PostgreSQL RLS!)
const { data: rows } = await mb.from("todos").select("*").eq("completed", false).limit(20);
await mb.from("todos").insert({ title: "Ship self-hosted backend", user_id: session?.user.id });

// 3. Private storage upload & signed download URL
await mb.storage.from("avatars").upload("ada/profile.txt", "Hello world", { mimeType: "text/plain" });
const { data: signed } = await mb.storage.from("avatars").createSignedUrl("ada/profile.txt", 600);

// 4. Invoke isolated server function
const { data: fnOut } = await mb.functions.invoke("hello-world", { body: { greeting: "from SDK" } });`;

    const cliCode = `# Inspect platform readiness & migration status
npm run cli -- status
npm run cli -- db status

# Manage projects & inspect diagnostics
npm run cli -- projects list
npm run cli -- projects inspect ${slug}

# Run scoped SQL or apply a checksummed migration
npm run cli -- sql ${slug} "SELECT count(*) FROM todos;"
npm run cli -- migrations apply ${slug} 20261024_01 init "CREATE TABLE IF NOT EXISTS notes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), body text);"

# Create & verify a SHA-256 project snapshot
npm run cli -- backup create ${slug}
npm run cli -- backup list ${slug}

# Inspect Android APK artifact & Gradle toolchain status
npm run cli -- apk status`;

    const curlCode = `# Query REST table with PostgREST-compatible filters
curl -s "${origin}/v1/projects/${slug}/rest/todos?completed=eq.false&order=created_at.desc&limit=10" \\
  -H "apikey: $MARRY_BASE_ANON_KEY" \\
  -H "Authorization: Bearer $USER_ACCESS_TOKEN"

# Subscribe to live database changes over WebSocket
# URL: ${wsOrigin}/v1/projects/${slug}/realtime/ws?apikey=$MARRY_BASE_ANON_KEY
# Send JSON frame: {"type":"subscribe","topic":"db:*"}`;

    const composeCode = `# Production self-hosting with Docker Compose + PostgreSQL 16
cp .env.example .env
# Set JWT_SECRET, MASTER_ENCRYPTION_KEY (32+ chars), POSTGRES_PASSWORD, and PLATFORM_BOOTSTRAP_TOKEN
docker compose up -d --build
curl -f http://localhost:4000/ready`;

    return `${pageHeader("docs")}
      <div class="grid-2">
        ${card("TypeScript / JavaScript SDK (@marry-base/sdk)", `<div class="label-row"><span class="field-hint">Pre-configured for project <code class="mono">${esc(slug)}</code></span><button class="btn btn-secondary btn-sm" type="button" data-action="copy-target" data-target="doc-sdk-code">${icon("copy")}Copy snippet</button></div><pre id="doc-sdk-code" class="code-block top-gap">${esc(sdkCode)}</pre>`, { subtitle: "Typed client for Auth, PostgREST-style Data API, Storage, Realtime, and Functions.", iconName: "book" })}
        ${card("MARRY BASE CLI (marry-base)", `<div class="label-row"><span class="field-hint">Control-plane automation &amp; CI/CD</span><button class="btn btn-secondary btn-sm" type="button" data-action="copy-target" data-target="doc-cli-code">${icon("copy")}Copy commands</button></div><pre id="doc-cli-code" class="code-block top-gap">${esc(cliCode)}</pre>`, { subtitle: "Manage migrations, SQL queries, logical backups, and APK verification from terminal.", iconName: "terminal" })}
      </div>
      <div class="grid-2 section-gap">
        ${card("Direct HTTP REST & WebSocket Protocol", `<div class="label-row"><span class="field-hint">Language-agnostic wire protocol</span><button class="btn btn-secondary btn-sm" type="button" data-action="copy-target" data-target="doc-curl-code">${icon("copy")}Copy examples</button></div><pre id="doc-curl-code" class="code-block top-gap">${esc(curlCode)}</pre>`, { subtitle: "Use from Swift, Kotlin/Android, Python, Go, Rust, or curl.", iconName: "globe" })}
        ${card("Self-Hosting & Production Operations", `<div class="label-row"><span class="field-hint">Docker Compose + PostgreSQL 16 vs embedded PGlite</span><button class="btn btn-secondary btn-sm" type="button" data-action="copy-target" data-target="doc-ops-code">${icon("copy")}Copy guide</button></div><pre id="doc-ops-code" class="code-block top-gap">${esc(composeCode)}</pre><p class="subtle top-gap"><strong>PostgreSQL vs PGlite:</strong> Embedded PGlite is ideal for local evaluation and automated tests; use external PostgreSQL 16+ (<code class="mono">DATABASE_URL</code>) for multi-user production concurrency, WAL backups, and native role isolation.</p>`, { subtitle: "Zero vendor lock-in — run the entire stack on any Linux host or container orchestrator.", iconName: "settings" })}
      </div>`;
  },
};

export function renderPageSkeleton(tab = state.activeTab) {
  if (!PROJECT_FREE_TABS.has(tab) && !state.activeProject) return;
  const render = templates[tab] || templates.overview;
  $("page-root").innerHTML = render();
  if (tab === "database") renderVisualColumnsBuilder();
}

function isCurrent(tab, version, slug) {
  if (state.activeTab !== tab || state.requestVersion !== version) return false;
  if (PROJECT_FREE_TABS.has(tab)) return true;
  return state.activeProject?.slug === slug;
}

async function loadOverview(version, slug) {
  const base = `/v1/projects/${encodeURIComponent(slug)}`;
  const [projectRes, tablesResponse, usersResponse] = await Promise.all([
    api(base),
    api(`${base}/database/tables`),
    api(`${base}/auth/admin/users?limit=1`),
  ]);
  if (!isCurrent("overview", version, slug)) return;
  state.tables = tablesResponse.tables || [];
  const project = projectRes.project || state.activeProject;
  state.activeProject = project;
  const overview = projectRes.overview;
  const counts = overview?.counts || {};
  const totalTables = counts.tables ?? state.tables.length;
  const totalUsers = counts.users ?? usersResponse.total ?? 0;
  const totalBuckets = counts.buckets ?? 0;
  const totalFunctions = counts.functions ?? 0;
  const pendingJobs = counts.queuedJobs ?? 0;
  const failedJobs = counts.failedJobs ?? 0;

  const stats = [
    ["Tables", totalTables, "database", `${state.tables.filter((t) => t.rlsEnabled).length}/${totalTables} with RLS`, ""],
    ["App Users", totalUsers, "users", "Project-scoped identities", "info"],
    ["Buckets", totalBuckets, "storage", formatBytes(projectRes.usage?.storageUsedBytes || 0), "gold"],
    ["Functions", totalFunctions, "function", "Isolated ESM workers", "purple"],
    ["Job Queue", pendingJobs, "clock", failedJobs > 0 ? `${failedJobs} failed job(s)` : "All workers healthy", failedJobs > 0 ? "danger" : "info"],
  ];
  $("overview-stats").innerHTML = stats.map(([label, value, iconName, detail, tone]) => `<div class="stat-card"><div class="stat-top"><span>${esc(label)}</span><span class="stat-icon ${esc(tone)}">${icon(iconName)}</span></div><div class="stat-value">${formatNumber(value)}</div><div class="stat-detail">${esc(detail)}</div></div>`).join("");

  $("overview-project-meta").innerHTML = `<dl class="definition-list">
    <div class="definition-row"><dt>Project slug</dt><dd><span class="code-inline">${esc(project.slug)}</span></dd></div>
    <div class="definition-row"><dt>PostgreSQL schema</dt><dd><span class="code-inline">${esc(project.schema_name)}</span></dd></div>
    <div class="definition-row"><dt>Execution roles</dt><dd><span class="code-inline">${esc(project.db_role_name)}</span> · <span class="code-inline">${esc(`${project.db_role_name}_rls`)}</span></dd></div>
    <div class="definition-row"><dt>Your access role</dt><dd>${badge(projectRes.memberRole || "owner", "purple")}</dd></div>
    <div class="definition-row"><dt>Status</dt><dd>${badge(project.status || "active")}</dd></div>
  </dl>`;

  const rlsAllEnabled = totalTables > 0 && state.tables.every((t) => t.rlsEnabled);
  const steps = [
    [totalTables > 0, "Create your first relational table", "database", "Open Table Editor"],
    [rlsAllEnabled, "Enable Row-Level Security across all tables", "sql", "Configure RLS"],
    [totalUsers > 0, "Create or register an application user", "auth", "Open Auth"],
    [totalBuckets > 0 || totalFunctions > 0, "Configure storage buckets or server functions", "storage", "Open Storage"],
  ];
  $("overview-checklist").innerHTML = `<div class="checklist">${steps.map(([done, text, nav, cta]) => `<div class="checklist-item ${done ? "done" : ""}"><span class="check-indicator">${done ? icon("check") : ""}</span><span>${esc(text)}</span>${done ? "" : `<button class="text-btn" type="button" data-nav="${esc(nav)}">${esc(cta)}</button>`}</div>`).join("")}</div>`;

  const moduleEntries = overview?.subsystems
    ? Object.entries(overview.subsystems).map(([key, val]) => ({
        module: key,
        label: key.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase()),
        state: val.state,
        summary: val.detail,
      }))
    : [];
  $("overview-modules").innerHTML = renderModuleCards(moduleEntries);

  const envs = projectRes.environments || [];
  $("environments-list").innerHTML = envs.length ? `<div class="list">${envs.map((env) => `<div class="list-row"><div class="list-main"><span class="resource-icon">${icon("layers")}</span><div class="list-text"><strong>${esc(env.name)}</strong><small>${esc(env.slug)} · Created ${esc(formatDate(env.created_at, false))}</small></div></div><div class="list-actions">${badge(env.is_production ? "production" : "non-prod", env.is_production ? "gold" : "info")}${!env.is_production ? `<button class="icon-btn btn-sm" type="button" data-action="delete-environment" data-id="${esc(env.id)}" data-name="${esc(env.name)}" aria-label="Delete ${esc(env.name)}">${icon("trash")}</button>` : ""}</div></div>`).join("")}</div>` : emptyState("layers", "No environments", "Add staging or preview environments.");
}

async function loadOrganizations(version) {
  const orgsRes = await api("/v1/organizations");
  if (!isCurrent("organizations", version, null)) return;
  state.organizations = orgsRes.organizations || [];
  const activeSlug = state.activeOrgSlug && state.organizations.some((o) => o.slug === state.activeOrgSlug)
    ? state.activeOrgSlug
    : state.organizations[0]?.slug || "";

  const listEl = $("orgs-list");
  if (!state.organizations.length) {
    listEl.innerHTML = emptyState("users", "No workspaces yet", "Create an organization to share projects and role-based access with your team.", `<button class="btn btn-primary btn-sm" type="button" data-action="open-new-org">${icon("plus")}Create workspace</button>`);
    $("org-detail-box").innerHTML = `<p class="subtle">Create or join a workspace to configure team settings.</p>`;
    $("org-members-list").innerHTML = emptyState("shield", "No workspace selected", "Select a workspace on the left.");
    $("org-projects-list").innerHTML = emptyState("layers", "No workspace selected", "Select a workspace on the left.");
    return;
  }

  listEl.innerHTML = `<div class="resource-list">${state.organizations.map((org) => `<div class="resource-item ${org.slug === activeSlug ? "active" : ""}"><div class="list-main"><span class="resource-icon">${icon("users")}</span><div class="list-text"><button class="resource-link" type="button" data-action="select-org-detail" data-slug="${esc(org.slug)}">${esc(org.name)}</button><small>${esc(org.slug)} · ${formatNumber(org.project_count)} projects · ${formatNumber(org.member_count)} members</small></div></div><div class="list-actions">${badge(org.member_role || "member", org.member_role === "owner" ? "purple" : "info")}</div></div>`).join("")}</div>`;

  const detail = await api(`/v1/organizations/${encodeURIComponent(activeSlug)}`);
  if (!isCurrent("organizations", version, null)) return;
  state.selectedOrgDetail = detail.organization;

  $("org-detail-box").innerHTML = `<form id="update-org-form" class="stack-form">
    <input id="uorg-slug" type="hidden" value="${esc(detail.organization.slug)}">
    <div class="field-row"><div class="field"><label for="uorg-name">Workspace name</label><input id="uorg-name" type="text" value="${esc(detail.organization.name)}" required></div><div class="field"><label for="uorg-tier">Tier</label><select id="uorg-tier"><option value="self-hosted" ${detail.organization.billing_tier === "self-hosted" ? "selected" : ""}>self-hosted</option><option value="team" ${detail.organization.billing_tier === "team" ? "selected" : ""}>team</option><option value="enterprise" ${detail.organization.billing_tier === "enterprise" ? "selected" : ""}>enterprise</option></select></div></div>
    <div class="field"><label for="uorg-desc">Description</label><input id="uorg-desc" type="text" value="${esc(detail.organization.description || "")}"></div>
    <div class="button-row"><button class="btn btn-primary btn-sm" type="submit">Save workspace</button>${detail.memberRole === "owner" || state.user?.is_superadmin ? `<button class="btn btn-danger-ghost btn-sm" type="button" data-action="delete-org" data-slug="${esc(detail.organization.slug)}" data-name="${esc(detail.organization.name)}">Delete workspace</button>` : ""}</div>
  </form>`;

  const members = detail.members || [];
  $("org-members-list").innerHTML = members.length ? table(["Operator", "Role", "Joined", ""], members.map((m) => `<tr><td><div class="cell-primary"><span class="avatar">${esc((m.name || m.email || "U").slice(0, 1).toUpperCase())}</span><div><strong>${esc(m.name || m.email)}</strong><span class="cell-secondary">${esc(m.email)}</span></div></div></td><td>${badge(m.role, m.role === "owner" ? "purple" : "info")}</td><td>${esc(formatDate(m.created_at, false))}</td><td><div class="cell-actions">${m.user_id !== state.user?.id ? `<button class="icon-btn btn-sm" type="button" data-action="remove-org-member" data-org="${esc(detail.organization.slug)}" data-user="${esc(m.user_id)}" data-email="${esc(m.email)}">${icon("trash")}</button>` : `<span class="subtle">You</span>`}</div></td></tr>`).join("")) : emptyState("users", "No members", "Invite operators above.");

  const projects = detail.projects || [];
  $("org-projects-list").innerHTML = projects.length ? table(["Project", "Schema", "Status", "Created", ""], projects.map((p) => `<tr><td><strong>${esc(p.name)}</strong><span class="cell-secondary mono">${esc(p.slug)}</span></td><td><span class="code-inline">${esc(p.schema_name)}</span></td><td>${badge(p.status)}</td><td>${esc(formatDate(p.created_at, false))}</td><td><button class="btn btn-secondary btn-sm" type="button" data-action="switch-project" data-slug="${esc(p.slug)}">Open</button></td></tr>`).join("")) : emptyState("layers", "No projects in this workspace", "Assign an existing project in Project Settings or create a new project.");
}

export function renderTablesList() {
  const container = $("tables-list");
  if (!container) return;
  const query = ($("table-search")?.value || "").trim().toLowerCase();
  const tables = state.tables.filter((item) => item.name.toLowerCase().includes(query));
  if (!tables.length) {
    container.innerHTML = emptyState("database", query ? "No matching tables" : "Schema is empty", query ? "Try a different filter." : "Create your first table below.");
    return;
  }
  container.innerHTML = `<div class="resource-list">${tables.map((item) => `<div class="resource-item ${state.activeTable === item.name ? "active" : ""}"><div class="list-main"><span class="resource-icon">${icon("database")}</span><div class="list-text"><button class="resource-link" type="button" data-action="browse-table" data-table="${esc(item.name)}">${esc(item.name)}</button><small>${formatNumber(item.rowCount)} rows · ${item.columns.length} cols</small></div></div><div class="list-actions"><button class="icon-btn btn-sm" type="button" data-action="toggle-table-rls" data-table="${esc(item.name)}" data-enabled="${item.rlsEnabled}" title="${item.rlsEnabled ? "Disable" : "Enable"} RLS">${icon(item.rlsEnabled ? "lock" : "unlock")}</button><button class="icon-btn btn-sm" type="button" data-action="drop-table" data-table="${esc(item.name)}" title="Drop table">${icon("trash")}</button></div></div>`).join("")}</div>`;
}

function renderTableSchemaInspector(tableInfo) {
  const box = $("table-schema-inspector");
  if (!box) return;
  if (!tableInfo) {
    box.innerHTML = emptyState("database", "No table selected", "Choose a table to inspect columns, constraints, and indexes.");
    return;
  }
  const colsHtml = table(["Column", "Type", "Constraints", "Default", ""], (tableInfo.columns || []).map((col) => {
    const fk = (tableInfo.foreignKeys || []).find((f) => f.column === col.name);
    const flags = [
      col.isPrimaryKey ? badge("PK", "purple") : "",
      !col.isNullable ? badge("NOT NULL", "info") : "",
      fk ? badge(`FK → ${fk.referencedTable}.${fk.referencedColumn}`, "gold") : "",
    ].filter(Boolean).join(" ");
    return `<tr><td><strong class="mono">${esc(col.name)}</strong></td><td><span class="code-inline">${esc(col.dataType)}</span></td><td>${flags || '<span class="subtle">nullable</span>'}</td><td class="mono">${esc(col.defaultValue ?? "—")}</td><td>${!col.isPrimaryKey ? `<button class="icon-btn btn-sm" type="button" data-action="drop-column" data-table="${esc(tableInfo.name)}" data-column="${esc(col.name)}" title="Drop column">${icon("trash")}</button>` : ""}</td></tr>`;
  }).join(""));

  const indexes = tableInfo.indexes || [];
  const idxHtml = indexes.length ? `<div style="padding:12px 16px;border-top:1px solid var(--border)"><span class="field-hint">Indexes (${indexes.length})</span><div class="list top-gap">${indexes.map((idx) => `<div class="list-row"><div class="list-main"><div class="list-text"><strong class="mono">${esc(idx.name)}</strong><small class="mono">${esc(idx.definition)}</small></div></div>${!idx.name.endsWith("_pkey") ? `<button class="icon-btn btn-sm" type="button" data-action="drop-index" data-table="${esc(tableInfo.name)}" data-index="${esc(idx.name)}" title="Drop index">${icon("trash")}</button>` : badge("primary", "purple")}</div>`).join("")}</div></div>` : "";
  box.innerHTML = `${colsHtml}${idxHtml}`;
}

async function loadDatabase(version, slug) {
  const base = `/v1/projects/${encodeURIComponent(slug)}`;
  const [tablesRes, diagRes] = await Promise.all([
    api(`${base}/database/tables`),
    api(`${base}/database/diagnostics`),
  ]);
  if (!isCurrent("database", version, slug)) return;
  state.tables = tablesRes.tables || [];
  if (!state.tables.some((item) => item.name === state.activeTable)) state.activeTable = state.tables[0]?.name || null;
  renderTablesList();

  if ($("db-diagnostics-box")) {
    $("db-diagnostics-box").innerHTML = `<div class="grid-2">
      <dl class="definition-list">
        <div class="definition-row"><dt>Engine</dt><dd>${esc(truncate(diagRes.postgresVersion, 48))} (${esc(diagRes.poolStats?.mode || "postgres")})</dd></div>
        <div class="definition-row"><dt>Role isolation</dt><dd>${diagRes.isolationVerified ? badge("Verified least-privilege", "success") : badge("Check roles", "warning")}</dd></div>
        <div class="definition-row"><dt>Owner / RLS roles</dt><dd><span class="code-inline">${esc(diagRes.ownerRole)}</span> · <span class="code-inline">${esc(diagRes.rlsRole)}</span></dd></div>
        <div class="definition-row"><dt>Statement timeout</dt><dd>${formatNumber(diagRes.statementTimeoutMs)} ms · Max ${formatNumber(diagRes.maxRowsPerQuery)} rows</dd></div>
      </dl>
      <div>${(diagRes.tableStats || []).length ? table(["Relation", "Size", "RLS"], diagRes.tableStats.map((t) => `<tr><td class="mono">${esc(t.name)}</td><td>${esc(formatBytes(t.totalBytes))}</td><td>${badge(t.rlsEnabled ? (t.rlsForced ? "forced" : "enabled") : "disabled", t.rlsEnabled ? "success" : "warning")}</td></tr>`).join("")) : `<p class="subtle">No user relations created yet.</p>`}</div>
    </div>`;
  }

  if (state.activeTable) {
    await browseTable(state.activeTable, version);
  } else {
    renderTableSchemaInspector(null);
    $("active-table-label").textContent = "";
    $("active-table-details").textContent = "Create a table to begin inserting rows.";
    $("table-rows-container").innerHTML = emptyState("database", "No tables yet", "Use the Visual Column Builder on the left to create your first table.");
  }
}

export async function browseTable(tableName, knownVersion = null) {
  if (!tableName || !state.activeProject) return;
  const slug = state.activeProject.slug;
  const version = knownVersion ?? state.requestVersion;
  if (state.activeTable !== tableName) {
    state.rowBrowser.offset = 0;
  }
  state.activeTable = tableName;
  const tableInfo = state.tables.find((item) => item.name === tableName);
  renderTablesList();
  renderTableSchemaInspector(tableInfo);

  if ($("active-table-label")) $("active-table-label").textContent = `· ${tableName}`;
  if ($("table-rows-container")) $("table-rows-container").innerHTML = loadingState("Loading rows…");
  if ($("alt-table-current")) $("alt-table-current").textContent = `(current: ${tableName})`;
  const altColSelect = $("alt2-col-name");
  if (altColSelect && tableInfo) {
    const previous = altColSelect.value;
    altColSelect.innerHTML = `<option value="">Select column…</option>${(tableInfo.columns || []).map((col) => `<option value="${esc(col.name)}">${esc(col.name)} — ${esc(col.dataType)}</option>`).join("")}`;
    if ([...altColSelect.options].some((opt) => opt.value === previous)) altColSelect.value = previous;
  }

  const rb = state.rowBrowser;
  const params = new URLSearchParams();
  params.set("limit", String(rb.limit));
  params.set("offset", String(rb.offset));
  params.set("count", "exact");
  if (rb.orderBy) params.set("order", `${rb.orderBy}.${rb.orderDir || "desc"}`);
  if (rb.filter) {
    for (const part of rb.filter.split("&")) {
      const eqIdx = part.indexOf("=");
      if (eqIdx > 0) params.set(part.slice(0, eqIdx).trim(), part.slice(eqIdx + 1).trim());
    }
  }

  try {
    const response = await api(`/v1/projects/${encodeURIComponent(slug)}/rest/${encodeURIComponent(tableName)}?${params.toString()}`);
    if (state.activeProject?.slug !== slug || state.activeTable !== tableName || state.requestVersion !== version) return;
    const rows = response.data || [];
    rb.rows = rows;
    rb.total = typeof response.count === "number" ? response.count : null;
    const pkCol = tableInfo?.columns?.find((c) => c.isPrimaryKey)?.name || (rows[0] && "id" in rows[0] ? "id" : null);

    if ($("active-table-details")) {
      $("active-table-details").textContent = tableInfo
        ? `${tableInfo.columns.length} columns · ${tableInfo.rlsEnabled ? "RLS enabled" : "RLS disabled"}${rb.total !== null ? ` · ${formatNumber(rb.total)} row(s) total` : ""}`
        : `Showing ${rows.length} row(s)`;
    }
    const pageNum = Math.floor(rb.offset / rb.limit) + 1;
    const rangeLabel = rows.length ? `Rows ${rb.offset + 1}–${rb.offset + rows.length}${rb.total !== null ? ` of ${formatNumber(rb.total)}` : ""}` : "No rows";
    if ($("row-pagination-label")) $("row-pagination-label").textContent = `Page ${pageNum} · ${rangeLabel}`;
    if ($("row-prev-btn")) $("row-prev-btn").disabled = rb.offset <= 0;
    if ($("row-next-btn")) $("row-next-btn").disabled = rb.total !== null ? rb.offset + rows.length >= rb.total : rows.length < rb.limit;

    if (!rows.length) {
      $("table-rows-container").innerHTML = emptyState("file", rb.filter ? "No matching rows" : "This table is empty", rb.filter ? "Adjust or clear the filter query above." : "Insert a JSON row below or send a POST request from the API Explorer.");
      return;
    }
    const columns = [...new Set([...(tableInfo?.columns?.map((c) => c.name) || []), ...rows.flatMap((row) => Object.keys(row))])];
    const columnMeta = new Map((tableInfo?.columns || []).map((col) => [col.name, col]));
    const headers = columns.map((column) => {
      const meta = columnMeta.get(column);
      return meta ? { label: column, sub: meta.dataType || meta.udtName || "" } : column;
    });
    const body = rows.map((row, idx) => `<tr>${columns.map((column) => `<td>${formatCell(row[column])}</td>`).join("")}<td><div class="cell-actions"><button class="icon-btn btn-sm" type="button" data-action="copy-row-json" data-idx="${idx}" title="Copy row as JSON" aria-label="Copy row ${idx} as JSON">${icon("copy")}</button>${pkCol && row[pkCol] !== undefined ? `<button class="btn btn-secondary btn-sm" type="button" data-action="open-edit-row" data-idx="${idx}" data-pk-col="${esc(pkCol)}">Edit</button><button class="icon-btn btn-sm" type="button" data-action="delete-row" data-pk-col="${esc(pkCol)}" data-pk-val="${esc(row[pkCol])}" title="Delete row" aria-label="Delete row">${icon("trash")}</button>` : ""}</div></td></tr>`).join("");
    $("table-rows-container").innerHTML = table([...headers, ""], body, { scroll: true });
  } catch (error) {
    if ($("table-rows-container")) $("table-rows-container").innerHTML = errorState(error, "refresh-rows");
  }
}

function renderPolicies() {
  const container = $("rls-policies-list");
  if (!container) return;
  const policies = state.tables.flatMap((item) => (item.policies || []).map((policy) => ({ ...policy, tableName: policy.tableName || item.name })));
  container.innerHTML = policies.length ? table(["Table", "Policy", "Command", "Expression", ""], policies.map((policy) => `<tr><td><strong>${esc(policy.tableName)}</strong></td><td><span class="code-inline">${esc(policy.policyName)}</span></td><td>${badge(policy.command, "info")}</td><td><div class="json-cell">${esc(policy.usingExpression || policy.checkExpression || "—")}</div></td><td><div class="cell-actions"><button class="icon-btn btn-sm" type="button" data-action="delete-policy" data-table="${esc(policy.tableName)}" data-policy="${esc(policy.policyName)}">${icon("trash")}</button></div></td></tr>`).join("")) : emptyState("shield", "No RLS policies", "Create a policy on the left to govern row access.");
  const select = $("pol-table");
  if (select) {
    const current = select.value;
    select.innerHTML = `<option value="">Select a table</option>${state.tables.map((item) => `<option value="${esc(item.name)}">${esc(item.name)}</option>`).join("")}`;
    select.value = current || state.tables[0]?.name || "";
  }
}

async function loadSql(version, slug) {
  const base = `/v1/projects/${encodeURIComponent(slug)}`;
  const [response, queriesResponse] = await Promise.all([
    api(`${base}/database/tables`),
    api(`${base}/database/queries`),
  ]);
  if (!isCurrent("sql", version, slug)) return;
  state.tables = response.tables || [];
  state.savedQueries = queriesResponse.queries || [];
  if (state.activeSavedQueryId && !state.savedQueries.some((q) => q.id === state.activeSavedQueryId)) {
    state.activeSavedQueryId = null;
  }
  renderPolicies();
  renderSavedQueries();
  updateSavedQueryLabel();
}

async function loadMigrations(version, slug) {
  const response = await api(`/v1/projects/${encodeURIComponent(slug)}/database/migrations`);
  if (!isCurrent("migrations", version, slug)) return;
  const migrations = response.migrations || [];
  $("migrations-list").innerHTML = migrations.length ? table(["Version", "Migration", "Status", "Applied", ""], migrations.map((migration) => `<tr><td><span class="code-inline">${esc(migration.version)}</span></td><td><strong>${esc(migration.name)}</strong><span class="cell-secondary mono" title="${esc(migration.checksum)}">SHA ${esc(truncate(migration.checksum, 14))}</span></td><td>${badge(migration.status)}</td><td>${esc(formatDate(migration.applied_at || migration.created_at))}</td><td><div class="cell-actions">${migration.status === "applied" && migration.down_sql ? `<button class="btn btn-secondary btn-sm" type="button" data-action="rollback-migration" data-version="${esc(migration.version)}" data-name="${esc(migration.name)}">Rollback</button>` : ""}</div></td></tr>`).join("")) : emptyState("layers", "No migrations yet", "Apply a versioned SQL migration on the left.");
}

async function loadApiExplorer(version, slug) {
  const base = `/v1/projects/${encodeURIComponent(slug)}`;
  const [tablesRes, openapi] = await Promise.all([
    api(`${base}/database/tables`),
    api(`${base}/openapi.json`),
  ]);
  if (!isCurrent("api", version, slug)) return;
  state.tables = tablesRes.tables || [];
  window.__maaryOpenApi = openapi;
  if ($("openapi-preview")) $("openapi-preview").textContent = JSON.stringify(openapi, null, 2);

  if (state.tables.length && $("api-test-path") && $("api-test-path").value === "/rest/") {
    $("api-test-path").value = `/rest/${state.tables[0].name}?limit=20`;
  }

  $("api-endpoints-catalog").innerHTML = state.tables.length
    ? table(["Table", "RLS", "Generated REST Endpoints", "Try"], state.tables.map((t) => `<tr><td><strong class="mono">${esc(t.name)}</strong><span class="cell-secondary">${t.columns.length} cols</span></td><td>${badge(t.rlsEnabled ? "RLS on" : "RLS off", t.rlsEnabled ? "success" : "warning")}</td><td class="mono">/rest/${esc(t.name)}</td><td><div class="cell-actions"><button class="btn btn-secondary btn-sm" type="button" data-action="prefill-api-test" data-method="GET" data-path="/rest/${esc(t.name)}?limit=20">GET</button><button class="btn btn-ghost btn-sm" type="button" data-action="prefill-api-test" data-method="POST" data-path="/rest/${esc(t.name)}">POST</button></div></td></tr>`).join(""))
    : emptyState("database", "No tables to expose yet", "Create a table in the Table Editor and its REST & OpenAPI routes appear automatically.");
}

async function loadAuth(version, slug) {
  const base = `/v1/projects/${encodeURIComponent(slug)}`;
  const search = encodeURIComponent($("auth-user-search")?.value?.trim() || "");
  const [usersResponse, configResponse, sessionsResponse] = await Promise.all([
    api(`${base}/auth/admin/users?limit=100${search ? `&search=${search}` : ""}`),
    api(`${base}/auth/config`),
    api(`${base}/auth/admin/sessions?limit=100`),
  ]);
  if (!isCurrent("auth", version, slug)) return;

  const users = usersResponse.users || [];
  $("project-users-list").innerHTML = users.length ? table(["User", "Role", "Verification", "Status", "Last sign in", ""], users.map((user) => `<tr><td><div class="cell-primary"><span class="avatar">${esc((user.email || "U").slice(0, 1).toUpperCase())}</span><div><strong>${esc(user.email)}</strong><span class="cell-secondary mono">${esc(user.id)}</span></div></div></td><td><select data-change-action="change-user-role" data-user="${esc(user.id)}" style="min-width:130px"><option value="authenticated" ${user.role === "authenticated" ? "selected" : ""}>authenticated</option><option value="admin" ${user.role === "admin" ? "selected" : ""}>admin</option>${!["authenticated", "admin"].includes(user.role) ? `<option value="${esc(user.role)}" selected>${esc(user.role)}</option>` : ""}</select></td><td>${user.email_verified ? badge("verified", "success") : `<button class="btn btn-ghost btn-sm" type="button" data-action="verify-user" data-user="${esc(user.id)}">Mark verified</button>`}</td><td>${badge(user.status)}</td><td title="${esc(formatDate(user.last_sign_in_at))}">${esc(timeAgo(user.last_sign_in_at))}</td><td><div class="cell-actions"><button class="btn btn-secondary btn-sm" type="button" data-action="toggle-user-status" data-user="${esc(user.id)}" data-email="${esc(user.email)}" data-status="${esc(user.status)}">${user.status === "active" ? "Suspend" : "Activate"}</button><button class="icon-btn btn-sm" type="button" data-action="delete-user" data-user="${esc(user.id)}" data-email="${esc(user.email)}">${icon("trash")}</button></div></td></tr>`).join("")) : emptyState("users", search ? "No matching users" : "No project users", "Create a user on the left or run the Sign-Up tester.");

  const sessions = sessionsResponse.sessions || [];
  $("project-sessions-list").innerHTML = sessions.length ? table(["User", "Session ID", "IP / User-Agent", "Expires", "Status", ""], sessions.map((s) => `<tr><td><strong>${esc(s.email)}</strong></td><td class="mono">${esc(truncate(s.id, 16))}</td><td>${esc(s.ip_address || "—")}<span class="cell-secondary">${esc(truncate(s.user_agent || "", 36))}</span></td><td>${esc(formatDate(s.expires_at))}</td><td>${badge(s.is_revoked ? "revoked" : "active")}</td><td>${!s.is_revoked ? `<button class="btn btn-secondary btn-sm" type="button" data-action="revoke-project-session" data-id="${esc(s.id)}">Revoke</button>` : ""}</td></tr>`).join("")) : emptyState("clock", "No sessions issued yet", "Sign in a project user to inspect refresh-token sessions.");

  const cfg = configResponse.config;
  window.__maaryAuthConfig = cfg;
  if (cfg) {
    $("cfg-public-signup").value = String(cfg.allow_public_signup);
    $("cfg-email-verify").value = String(cfg.require_email_verification);
    $("cfg-pass-len").value = cfg.password_min_length;
    $("cfg-access-ttl").value = cfg.access_token_ttl_seconds;
    $("cfg-refresh-ttl").value = cfg.refresh_token_ttl_seconds;
    const providers = cfg.oauth_providers || {};
    const pEntries = Object.entries(providers);
    $("oauth-configured-list").innerHTML = pEntries.length
      ? table(["Provider", "Client ID", "Status"], pEntries.map(([name, p]) => `<tr><td><strong>${esc(name)}</strong></td><td class="mono">${esc(p.clientId || "—")}</td><td>${badge(p.enabled ? "enabled" : "disabled")}</td></tr>`).join(""))
      : `<p class="subtle">No external OAuth providers configured yet.</p>`;
  }
}

function renderBuckets() {
  const container = $("buckets-list");
  if (!container) return;
  if (!state.buckets.length) {
    container.innerHTML = emptyState("storage", "No buckets yet", "Create a private or public bucket below.");
    return;
  }
  container.innerHTML = `<div class="resource-list">${state.buckets.map((bucket) => `<div class="resource-item ${state.activeBucket === bucket.name ? "active" : ""}"><div class="list-main"><span class="resource-icon">${icon(bucket.public ? "unlock" : "lock")}</span><div class="list-text"><button class="resource-link" type="button" data-action="open-bucket" data-bucket="${esc(bucket.name)}">${esc(bucket.name)}</button><small>${formatNumber(bucket.object_count)} objects · ${formatBytes(bucket.used_bytes)}</small></div></div><div class="list-actions">${badge(bucket.public ? "public" : "private", bucket.public ? "warning" : "success")}<button class="icon-btn btn-sm" type="button" data-action="delete-bucket" data-bucket="${esc(bucket.name)}" aria-label="Delete ${esc(bucket.name)}">${icon("trash")}</button></div></div>`).join("")}</div>`;
}

async function loadStorage(version, slug) {
  const response = await api(`/v1/projects/${encodeURIComponent(slug)}/storage/buckets`);
  if (!isCurrent("storage", version, slug)) return;
  state.buckets = response.buckets || [];
  if (!state.buckets.some((bucket) => bucket.name === state.activeBucket)) state.activeBucket = state.buckets[0]?.name || null;
  renderBuckets();
  if (state.activeBucket) await openBucket(state.activeBucket, version);
  else {
    $("active-bucket-label").textContent = "Select a bucket first";
    $("bucket-objects-list").innerHTML = emptyState("storage", "No bucket selected", "Create a bucket on the left before uploading objects.");
    $("storage-policies-list").innerHTML = emptyState("shield", "No bucket selected", "Select a bucket to configure access policies.");
  }
}

export async function openBucket(bucketName, knownVersion = null) {
  if (!bucketName || !state.activeProject) return;
  const slug = state.activeProject.slug;
  const version = knownVersion ?? state.requestVersion;
  state.activeBucket = bucketName;
  if ($("active-bucket-label")) $("active-bucket-label").textContent = `Active bucket: ${bucketName}`;
  if ($("bucket-objects-list")) $("bucket-objects-list").innerHTML = loadingState("Loading objects…");
  renderBuckets();

  const bucketInfo = state.buckets.find((b) => b.name === bucketName);
  if (bucketInfo && $("bset-public")) {
    $("bset-public").value = String(Boolean(bucketInfo.public));
    $("bset-limit").value = bucketInfo.file_size_limit_bytes ? Math.max(1, Math.round(Number(bucketInfo.file_size_limit_bytes) / (1024 * 1024))) : 25;
    $("bset-quota").value = bucketInfo.quota_bytes ? Math.round(Number(bucketInfo.quota_bytes) / (1024 * 1024)) : 0;
    $("bset-mimes").value = Array.isArray(bucketInfo.allowed_mime_types) ? bucketInfo.allowed_mime_types.join(", ") : "";
  }

  try {
    const prefix = encodeURIComponent($("object-prefix")?.value?.trim() || "");
    const base = `/v1/projects/${encodeURIComponent(slug)}/storage/buckets/${encodeURIComponent(bucketName)}`;
    const [objectsRes, policiesRes] = await Promise.all([
      api(`${base}/objects?limit=200${prefix ? `&prefix=${prefix}` : ""}`),
      api(`${base}/policies`),
    ]);
    if (state.activeProject?.slug !== slug || state.activeBucket !== bucketName || state.requestVersion !== version) return;

    const objects = objectsRes.objects || [];
    $("bucket-objects-list").innerHTML = objects.length ? table(["Path", "MIME", "Size", "Updated", ""], objects.map((object) => `<tr><td><div class="cell-primary">${icon("file")}<div><strong>${esc(object.path)}</strong><span class="cell-secondary mono" title="${esc(object.checksum_sha256)}">SHA ${esc(truncate(object.checksum_sha256, 12))}</span></div></div></td><td>${esc(object.mime_type)}</td><td>${esc(formatBytes(object.size_bytes))}</td><td>${esc(timeAgo(object.updated_at))}</td><td><div class="cell-actions"><button class="btn btn-ghost btn-sm" type="button" data-action="inspect-object" data-bucket="${esc(bucketName)}" data-path="${esc(object.path)}">Metadata</button><button class="btn btn-secondary btn-sm" type="button" data-action="download-object" data-bucket="${esc(bucketName)}" data-path="${esc(object.path)}">${icon("download")}Download</button><button class="icon-btn btn-sm" type="button" data-action="delete-object" data-bucket="${esc(bucketName)}" data-path="${esc(object.path)}">${icon("trash")}</button></div></td></tr>`).join("")) : emptyState("file", "No objects in bucket", "Upload a file or text payload above.");

    const policies = policiesRes.policies || [];
    $("storage-policies-list").innerHTML = policies.length ? table(["Policy", "Operation", "Roles", "Prefix / Owner", ""], policies.map((p) => `<tr><td><strong class="mono">${esc(p.name)}</strong></td><td>${badge(p.operation, "info")}</td><td>${esc((p.roles || []).join(", "))}</td><td class="mono">${esc(p.path_prefix || "*")}${p.allow_owner_only ? " · owner-only" : ""}</td><td><button class="icon-btn btn-sm" type="button" data-action="delete-storage-policy" data-bucket="${esc(bucketName)}" data-id="${esc(p.id)}">${icon("trash")}</button></td></tr>`).join("")) : `<p class="subtle">No custom bucket policies configured — private buckets require signed URLs or service_role unless policies grant access.</p>`;
  } catch (error) {
    if ($("bucket-objects-list")) $("bucket-objects-list").innerHTML = errorState(error, "refresh-page");
  }
}

async function loadFunctions(version, slug) {
  const base = `/v1/projects/${encodeURIComponent(slug)}`;
  const statusFilter = encodeURIComponent($("job-status-filter")?.value || "");
  const [functionsResponse, jobsResponse, schedulesResponse] = await Promise.all([
    api(`${base}/functions`),
    api(`${base}/jobs?limit=100${statusFilter ? `&status=${statusFilter}` : ""}`),
    api(`${base}/schedules`),
  ]);
  if (!isCurrent("functions", version, slug)) return;
  state.functions = functionsResponse.functions || [];
  const functions = state.functions;
  $("functions-list").innerHTML = functions.length ? table(["Function", "Version", "Auth", "Timeout", ""], functions.map((fn) => `<tr><td><div class="cell-primary"><span class="resource-icon">${icon("function")}</span><div><strong>${esc(fn.name || fn.slug)}</strong><span class="cell-secondary mono">${esc(fn.slug)}</span></div></div></td><td>v${formatNumber(fn.version)}</td><td>${badge(fn.verify_jwt ? "JWT required" : "public", fn.verify_jwt ? "success" : "warning")}</td><td>${formatNumber(fn.timeout_ms)} ms</td><td><div class="cell-actions"><button class="btn btn-secondary btn-sm" type="button" data-action="edit-function" data-slug="${esc(fn.slug)}">Edit</button><button class="icon-btn btn-sm" type="button" data-action="delete-function" data-slug="${esc(fn.slug)}">${icon("trash")}</button></div></td></tr>`).join("")) : emptyState("function", "No functions deployed", "Deploy the starter handler on the left.");
  const select = $("fn-invoke-slug");
  if (select) {
    select.innerHTML = functions.length ? functions.map((fn) => `<option value="${esc(fn.slug)}">${esc(fn.slug)} · v${formatNumber(fn.version)}</option>`).join("") : `<option value="">Deploy a function first</option>`;
  }
  const jobs = jobsResponse.jobs || [];
  $("jobs-list").innerHTML = jobs.length ? table(["Job", "Queue", "Status", "Attempts", "Scheduled", ""], jobs.map((job) => `<tr><td><strong>${esc(job.job_type)}</strong><span class="cell-secondary mono">${esc(truncate(job.id, 16))}</span>${job.last_error ? `<span class="cell-secondary text-danger">${esc(truncate(job.last_error, 90))}</span>` : ""}</td><td>${esc(job.queue_name)}</td><td>${badge(job.status)}</td><td>${formatNumber(job.attempts)} / ${formatNumber(job.max_attempts)}</td><td title="${esc(formatDate(job.run_at))}">${esc(timeAgo(job.run_at))}</td><td><div class="cell-actions">${["failed", "dead_letter", "cancelled"].includes(job.status) ? `<button class="btn btn-secondary btn-sm" type="button" data-action="retry-job" data-id="${esc(job.id)}">Retry</button>` : ""}${["queued", "failed"].includes(job.status) ? `<button class="btn btn-ghost btn-sm" type="button" data-action="cancel-job" data-id="${esc(job.id)}">Cancel</button>` : ""}</div></td></tr>`).join("")) : emptyState("clock", "No jobs found", "Enqueue a background job on the left.");
  const schedules = schedulesResponse.schedules || [];
  $("schedules-list").innerHTML = schedules.length ? table(["Schedule", "Type", "Interval", "Next run", "Status", ""], schedules.map((schedule) => `<tr><td><strong>${esc(schedule.name)}</strong><span class="cell-secondary mono">${esc(schedule.function_slug || schedule.target_slug || "schema maintenance")}</span></td><td>${esc(schedule.job_type)}</td><td>Every ${formatNumber(schedule.interval_seconds)}s</td><td>${esc(timeAgo(schedule.next_run_at))}</td><td>${badge(schedule.enabled ? "enabled" : "disabled")}</td><td><div class="cell-actions"><button class="icon-btn btn-sm" type="button" data-action="delete-schedule" data-id="${esc(schedule.id)}" data-name="${esc(schedule.name)}">${icon("trash")}</button></div></td></tr>`).join("")) : emptyState("clock", "No recurring schedules", "Create a recurring schedule on the left.");
}

async function loadRealtime(version, slug) {
  const base = `/v1/projects/${encodeURIComponent(slug)}`;
  const [status, eventsResponse, channelsResponse] = await Promise.all([
    api(`${base}/realtime/status`),
    api(`${base}/realtime/events?limit=50`),
    api(`${base}/realtime/channels`),
  ]);
  if (!isCurrent("realtime", version, slug)) return;
  const stats = [
    ["Connected Clients", status.connectedClients ?? status.connected_clients ?? 0, "realtime", "Active WebSocket sockets", ""],
    ["Topic Subscriptions", status.subscriptions ?? 0, "link", "Subscribed channel listeners", "info"],
    ["Delivery Mode", "At-least-once", "check", "Replayable within retention window", "gold"],
  ];
  $("realtime-status-cards").innerHTML = `<div class="stats-grid" style="grid-template-columns:repeat(3,minmax(0,1fr))">${stats.map(([label, value, iconName, detail, tone]) => `<div class="stat-card"><div class="stat-top"><span>${esc(label)}</span><span class="stat-icon ${esc(tone)}">${icon(iconName)}</span></div><div class="stat-value">${esc(value)}</div><div class="stat-detail">${esc(detail)}</div></div>`).join("")}</div>`;
  const events = eventsResponse.events || [];
  $("rt-events-table").innerHTML = events.length ? table(["Event", "Topic", "Detail", "Time"], events.map((event) => `<tr><td><strong>${esc(event.operation || event.event_type)}</strong></td><td><span class="code-inline">${esc(event.channel_topic)}</span></td><td class="mono">${esc(truncate(JSON.stringify(event.payload || {}), 70))}</td><td title="${esc(formatDate(event.created_at))}">${esc(timeAgo(event.created_at))}</td></tr>`).join("")) : emptyState("realtime", "No persisted events yet", "Insert/update rows or publish a broadcast above.");
  const channels = channelsResponse.channels || [];
  $("rt-channels-list").innerHTML = channels.length ? `<div class="list">${channels.map((channel) => `<div class="list-row"><div class="list-main"><span class="resource-icon">${icon("realtime")}</span><div class="list-text"><strong class="mono">${esc(channel.topic)}</strong><small>${channel.is_private ? "Private channel" : "Public channel"}</small></div></div>${badge(channel.is_private ? "private" : "public", channel.is_private ? "warning" : "success")}</div>`).join("")}</div>` : `<p class="subtle">No explicit channels registered yet — ad-hoc topics work automatically.</p>`;
}

async function loadLogs(version, slug) {
  const base = `/v1/projects/${encodeURIComponent(slug)}`;
  const errSource = encodeURIComponent($("err-source-filter")?.value || "");
  const errSearch = encodeURIComponent($("err-search-filter")?.value?.trim() || "");
  const auditFilter = encodeURIComponent($("audit-action-filter")?.value?.trim() || "");

  const [diag, errRes, auditRes] = await Promise.all([
    api(`${base}/diagnostics`),
    api(`${base}/logs/errors?limit=100${errSource ? `&source=${errSource}` : ""}${errSearch ? `&search=${errSearch}` : ""}`),
    api(`${base}/audit?limit=100${auditFilter ? `&action=${auditFilter}` : ""}`),
  ]);
  if (!isCurrent("logs", version, slug)) return;

  const subsystems = diag.overview?.subsystems
    ? Object.entries(diag.overview.subsystems).map(([k, v]) => ({
        module: k,
        label: k.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase()),
        state: v.state,
        summary: v.detail,
      }))
    : [];
  $("logs-module-matrix").innerHTML = renderModuleCards(subsystems);

  const q = diag.quotas || state.activeProject.quotas || {};
  const u = diag.usage || {};
  $("logs-quota-meters").innerHTML = [
    quotaMeter("PostgreSQL Schema Size", u.databaseSizeBytes || 0, (q.dbQuotaMb || 500) * 1024 * 1024, formatBytes),
    quotaMeter("Object Storage Used", u.storageUsedBytes || 0, (q.storageQuotaMb || 1024) * 1024 * 1024, formatBytes),
    quotaMeter("Deployed Server Functions", diag.overview?.counts?.functions || 0, q.maxFunctions || 50, formatNumber),
    quotaMeter("Background Jobs (Total)", (diag.overview?.counts?.queuedJobs || 0) + (diag.overview?.counts?.failedJobs || 0), q.maxJobsPerMonth || 100000, formatNumber),
  ].join("");

  const errLogs = errRes.logs || [];
  $("error-logs-list").innerHTML = errLogs.length ? table(["Time", "Source", "Status", "Message"], errLogs.map((l) => `<tr><td>${esc(timeAgo(l.created_at))}</td><td>${badge(l.source, l.severity === "error" || l.severity === "critical" ? "danger" : "warning")}</td><td class="mono">${esc(l.status_code || l.error_code || "—")}</td><td><strong>${esc(truncate(l.message, 84))}</strong>${l.request_path ? `<span class="cell-secondary mono">${esc(l.request_method || "")} ${esc(l.request_path)}</span>` : ""}</td></tr>`).join("")) : emptyState("check", "Zero error logs recorded", "No API, database, storage, or worker errors matched your filter.");

  const events = auditRes.events || [];
  $("audit-events-list").innerHTML = events.length ? table(["Time", "Action", "Actor", "Resource"], events.map((event) => `<tr><td>${esc(formatDate(event.created_at))}</td><td><span class="code-inline">${esc(event.action)}</span></td><td>${esc(event.actor_type)}<span class="cell-secondary mono">${esc(truncate(event.actor_id || "system", 16))}</span></td><td>${esc(event.resource_type || "—")}<span class="cell-secondary mono">${esc(truncate(event.resource_id || "", 16))}</span></td></tr>`).join("")) : emptyState("shield", "No audit events", "Control-plane mutations will appear here.");
}

async function loadBackupsAndSettings(version, slug) {
  const base = `/v1/projects/${encodeURIComponent(slug)}`;
  const [backupsResponse, apkStatus, orgsRes] = await Promise.all([
    api(`${base}/backups`),
    api(`/v1/platform/apk/status?projectSlug=${encodeURIComponent(slug)}`),
    api("/v1/organizations"),
  ]);
  if (!isCurrent("backups", version, slug)) return;
  state.organizations = orgsRes.organizations || [];

  const backups = backupsResponse.backups || [];
  $("backups-list").innerHTML = backups.length ? table(["Snapshot", "Size", "SHA-256", "Created", "Status", ""], backups.map((backup) => `<tr><td><strong>${esc(backup.name)}</strong><span class="cell-secondary mono">${esc(backup.id)}</span></td><td>${esc(formatBytes(backup.size_bytes))}</td><td><span class="code-inline" title="${esc(backup.checksum_sha256)}">${esc(truncate(backup.checksum_sha256, 12))}</span></td><td>${esc(formatDate(backup.created_at))}</td><td>${badge(backup.status)}</td><td><div class="cell-actions"><button class="btn btn-secondary btn-sm" type="button" data-action="verify-backup" data-id="${esc(backup.id)}">Verify</button><button class="btn btn-danger-ghost btn-sm" type="button" data-action="restore-backup" data-id="${esc(backup.id)}" data-name="${esc(backup.name)}">Restore</button></div></td></tr>`).join("")) : emptyState("storage", "No snapshots yet", "Create a logical snapshot before major schema changes.");

  const project = state.activeProject;
  $("settings-name").value = project.name || "";
  $("settings-description").value = project.description || "";
  $("settings-status").value = project.status || "active";
  $("settings-db-quota").value = project.quotas?.dbQuotaMb ?? 500;
  $("settings-storage-quota").value = project.quotas?.storageQuotaMb ?? 1024;
  $("settings-max-fns").value = project.quotas?.maxFunctions ?? 50;
  const orgSelect = $("settings-org");
  if (orgSelect) {
    orgSelect.innerHTML = `<option value="">Personal / Unassigned</option>${state.organizations.map((o) => `<option value="${esc(o.id)}">${esc(o.name)} (${esc(o.slug)})</option>`).join("")}`;
    orgSelect.value = project.organization_id || "";
  }

  const art = apkStatus.artifact;
  const tc = apkStatus.toolchain || {};
  $("apk-status-box").innerHTML = `<div class="stack">
    <div class="module-card"><div class="module-card-top"><strong>Android Builder Module</strong>${moduleStatusBadge(apkStatus.status)}</div><p>${esc(apkStatus.summary)}</p></div>
    <dl class="definition-list">
      <div class="definition-row"><dt>Gradle / JDK</dt><dd>${tc.gradleAvailable && tc.javaAvailable ? badge("Installed", "success") : badge("Not on this host", "warning")}</dd></div>
      <div class="definition-row"><dt>Android SDK</dt><dd>${tc.androidSdkAvailable ? badge("Configured", "success") : badge("Build via GitHub Actions CI", "info")}</dd></div>
      <div class="definition-row"><dt>Verified APK</dt><dd>${apkStatus.downloadAvailable && art ? `${badge("Verified APK ready", "success")} <span class="mono">${esc(formatBytes(art.sizeBytes))}</span>` : badge("No local APK artifact", "neutral")}</dd></div>
    </dl>
    <div class="button-row">
      <a class="btn btn-secondary btn-sm" href="/mobile/" target="_blank" rel="noopener">${icon("external")}Open Mobile Web Companion</a>
      ${apkStatus.downloadAvailable && apkStatus.downloadUrl ? `<a class="btn btn-primary btn-sm" href="${esc(apkStatus.downloadUrl)}">${icon("download")}Download Verified APK</a>` : ""}
    </div>
  </div>`;
}

async function loadSecurity(version, slug) {
  const base = `/v1/projects/${encodeURIComponent(slug)}`;
  const [keysResponse, secretsResponse, membersResponse] = await Promise.all([
    api(`${base}/api-keys`),
    api(`${base}/secrets?reveal=${state.revealSecrets}`),
    api(`${base}/members`),
  ]);
  if (!isCurrent("security", version, slug)) return;
  const keys = keysResponse.apiKeys || [];
  $("api-keys-list").innerHTML = keys.length ? table(["Name", "Role", "Prefix", "Scopes", "Status", "Last used", ""], keys.map((key) => `<tr><td><strong>${esc(key.name)}</strong><span class="cell-secondary">${esc(formatDate(key.created_at, false))}</span></td><td>${badge(key.role, key.role === "service_role" ? "danger" : "info")}</td><td><span class="code-inline">${esc(key.key_prefix)}…</span></td><td><span class="cell-truncate" title="${esc((key.scopes || []).join(", "))}">${esc((key.scopes || []).join(", ") || "—")}</span></td><td>${badge(key.revoked_at ? "revoked" : "active")}</td><td>${esc(timeAgo(key.last_used_at))}</td><td><div class="cell-actions">${!key.revoked_at ? `<button class="btn btn-secondary btn-sm" type="button" data-action="rotate-key" data-id="${esc(key.id)}" data-name="${esc(key.name)}">Rotate</button><button class="icon-btn btn-sm" type="button" data-action="revoke-key" data-id="${esc(key.id)}" data-name="${esc(key.name)}">${icon("trash")}</button>` : ""}</div></td></tr>`).join("")) : emptyState("key", "No API keys", "Generate a scoped key on the left.");
  const secrets = secretsResponse.secrets || [];
  $("secrets-list").innerHTML = secrets.length ? table(["Name", "Value", "Version", "Updated", ""], secrets.map((secret) => `<tr><td><strong class="mono">${esc(secret.name)}</strong><span class="cell-secondary">${esc(secret.description || "No description")}</span></td><td><span class="code-inline secret-value">${esc(secret.decrypted_value ?? secret.masked_value)}</span></td><td>v${formatNumber(secret.version)}</td><td>${esc(timeAgo(secret.updated_at))}</td><td><div class="cell-actions">${state.revealSecrets && secret.decrypted_value ? `<button class="icon-btn btn-sm" type="button" data-action="copy-text" data-copy="${esc(secret.decrypted_value)}">${icon("copy")}</button>` : ""}<button class="icon-btn btn-sm" type="button" data-action="delete-secret" data-id="${esc(secret.id)}" data-name="${esc(secret.name)}">${icon("trash")}</button></div></td></tr>`).join("")) : emptyState("lock", "No secrets stored", "Add AES-256-GCM encrypted credentials on the left.");
  if ($("secret-toggle-label")) $("secret-toggle-label").textContent = state.revealSecrets ? "Hide values" : "Reveal values";
  const members = membersResponse.members || [];
  $("members-list").innerHTML = members.length ? table(["Member", "Role", "Joined", ""], members.map((member) => `<tr><td><div class="cell-primary"><span class="avatar">${esc((member.name || member.email || "U").slice(0, 1).toUpperCase())}</span><div><strong>${esc(member.name || member.email)}</strong><span class="cell-secondary">${esc(member.email)}</span></div></div></td><td>${badge(member.role, member.role === "owner" ? "purple" : "info")}</td><td>${esc(formatDate(member.created_at, false))}</td><td><div class="cell-actions">${member.user_id !== state.user?.id ? `<button class="icon-btn btn-sm" type="button" data-action="remove-member" data-user="${esc(member.user_id)}" data-email="${esc(member.email)}">${icon("trash")}</button>` : `<span class="subtle">You</span>`}</div></td></tr>`).join("")) : emptyState("users", "No direct members", "Add an operator on the left or manage team inheritance in Workspaces.");
}

async function loadPlatformAdmin(version) {
  const diag = await api("/v1/platform/diagnostics");
  if (!isCurrent("platform", version, null)) return;

  const stats = [
    ["Database Mode", diag.database?.mode || "postgres", "database", `${diag.database?.migrations?.applied?.length || 0} migrations applied`, ""],
    ["Process Memory", formatBytes(diag.memory?.rssBytes || 0), "activity", `Heap ${formatBytes(diag.memory?.heapUsedBytes || 0)} · Node ${diag.nodeVersion}`, "info"],
    ["Worker Supervisor", diag.worker?.running ? "Running" : "Stopped", "clock", `Poll ${diag.worker?.pollIntervalMs || 0}ms`, diag.worker?.running ? "gold" : "warning"],
    ["Storage Backend", diag.storage?.backend || "local", "storage", `Max upload ${formatBytes(diag.storage?.maxUploadBytes || 0)}`, "purple"],
    ["Instance Uptime", `${formatNumber(diag.uptimeSeconds || 0)}s`, "check", `Env: ${diag.environment}`, ""],
  ];
  $("platform-diag-stats").innerHTML = stats.map(([label, value, iconName, detail, tone]) => `<div class="stat-card"><div class="stat-top"><span>${esc(label)}</span><span class="stat-icon ${esc(tone)}">${icon(iconName)}</span></div><div class="stat-value">${esc(value)}</div><div class="stat-detail">${esc(detail)}</div></div>`).join("");
  $("platform-modules-matrix").innerHTML = renderModuleCards(diag.moduleDetails || []);

  const area = $("platform-superadmin-area");
  if (!state.user?.is_superadmin) {
    area.innerHTML = card("Operator Role Boundary", `<div class="notice">${icon("shield")}<p>You are signed in as a <strong>Standard Platform Operator</strong> (<code class="mono">${esc(state.user?.email)}</code>). Instance-wide operator management, PostgreSQL extensions, global audit logs, and full-cluster disaster-recovery restores require <strong>Superadmin</strong> privileges.</p></div>`, { subtitle: "Least-privilege separation between Project Administration and Platform Superadmin.", iconName: "lock" });
    return;
  }

  const [usersRes, extRes, backupsRes, auditRes] = await Promise.all([
    api("/v1/platform/users"),
    api("/v1/platform/extensions"),
    api("/v1/platform/backups"),
    api("/v1/platform/audit?limit=40"),
  ]);
  if (!isCurrent("platform", version, null)) return;

  const operators = usersRes.users || [];
  const extensions = extRes.extensions || [];
  const backups = backupsRes.backups || [];
  const audits = auditRes.events || [];

  area.innerHTML = `<div class="stack">
    <div class="grid-sidebar-reverse">
      ${card("Create Platform Operator", `<form id="admin-create-operator-form" class="stack-form">
        <div class="field"><label for="pop-email">Operator email</label><input id="pop-email" type="email" placeholder="ops@company.dev" required></div>
        <div class="field-row"><div class="field"><label for="pop-name">Full name</label><input id="pop-name" type="text" placeholder="Chidi Nwosu"></div><div class="field"><label for="pop-pass">Initial password</label><input id="pop-pass" type="password" minlength="10" required></div></div>
        <label class="checkbox-field"><input id="pop-super" type="checkbox"><span>Grant instance-wide Superadmin privileges</span></label>
        <button class="btn btn-primary" type="submit">Create operator</button>
      </form>`, { subtitle: "Superadmin-only operator provisioning.", iconName: "plus" })}

      ${card("Platform Operators", table(["Operator", "Privilege", "Status", "Last login", ""], operators.map((op) => `<tr><td><strong>${esc(op.name || op.email)}</strong><span class="cell-secondary">${esc(op.email)}</span></td><td>${badge(op.is_superadmin ? "superadmin" : "operator", op.is_superadmin ? "purple" : "info")}</td><td>${badge(op.status)}</td><td>${esc(timeAgo(op.last_login_at))}</td><td><div class="cell-actions">${op.id !== state.user?.id ? `<button class="btn btn-ghost btn-sm" type="button" data-action="toggle-operator-superadmin" data-id="${esc(op.id)}" data-super="${op.is_superadmin}">${op.is_superadmin ? "Demote" : "Make superadmin"}</button><button class="btn btn-secondary btn-sm" type="button" data-action="toggle-operator-status" data-id="${esc(op.id)}" data-status="${esc(op.status)}">${op.status === "active" ? "Suspend" : "Activate"}</button>` : `<span class="subtle">You</span>`}</div></td></tr>`).join("")), { subtitle: "Manage control-plane accounts and superadmin access.", iconName: "users", flush: true })}
    </div>

    <div class="grid-2">
      ${card("PostgreSQL Extensions", `<form id="enable-ext-form" class="inline-form"><input id="ext-name-input" class="mono" type="text" placeholder="pgcrypto or uuid-ossp" required><button class="btn btn-primary btn-sm" type="submit">Enable extension</button></form><div class="top-gap">${extensions.length ? table(["Extension", "Installed", "Default"], extensions.slice(0, 12).map((e) => `<tr><td class="mono"><strong>${esc(e.name)}</strong></td><td>${e.installed_version ? badge(e.installed_version, "success") : '<span class="subtle">not installed</span>'}</td><td class="mono">${esc(e.default_version || "—")}</td></tr>`).join("")) : `<p class="subtle">No extensions reported.</p>`}</div>`, { subtitle: "Instance-wide PostgreSQL extension catalog.", iconName: "database" })}

      ${card("Instance-Wide Disaster Recovery", `<form id="create-platform-backup-form" class="inline-form"><input id="pbackup-name" type="text" placeholder="full-cluster-snapshot"><button class="btn btn-primary btn-sm" type="submit">Create full backup</button></form><div class="top-gap">${backups.length ? table(["Snapshot", "Scope", "Size", "Created", ""], backups.slice(0, 10).map((b) => `<tr><td><strong>${esc(b.name)}</strong></td><td>${badge(b.project_id ? "project" : "full-platform", b.project_id ? "info" : "purple")}</td><td>${esc(formatBytes(b.size_bytes))}</td><td>${esc(timeAgo(b.created_at))}</td><td><button class="btn btn-secondary btn-sm" type="button" data-action="verify-platform-backup" data-id="${esc(b.id)}">Verify</button></td></tr>`).join("")) : `<p class="subtle">No platform snapshots created yet.</p>`}</div>`, { subtitle: "Full control-plane + multi-project snapshots.", iconName: "storage" })}
    </div>

    ${card("Global Platform Audit Log", audits.length ? table(["Timestamp", "Action", "Actor", "Project / Resource"], audits.map((e) => `<tr><td>${esc(formatDate(e.created_at))}</td><td><span class="code-inline">${esc(e.action)}</span></td><td class="mono">${esc(truncate(e.actor_id || e.actor_type, 18))}</td><td class="mono">${esc(e.resource_type || "platform")} ${esc(truncate(e.resource_id || "", 16))}</td></tr>`).join("")) : emptyState("shield", "No global audit events", "Platform events appear here."), { subtitle: "Cross-workspace security audit log visible only to Superadmins.", iconName: "shield", flush: true })}
  </div>`;
}

async function loadDocs() {
  // Static project-customized documentation rendered directly in template
}

const loaders = {
  overview: loadOverview,
  organizations: loadOrganizations,
  database: loadDatabase,
  sql: loadSql,
  migrations: loadMigrations,
  api: loadApiExplorer,
  auth: loadAuth,
  storage: loadStorage,
  functions: loadFunctions,
  realtime: loadRealtime,
  logs: loadLogs,
  backups: loadBackupsAndSettings,
  security: loadSecurity,
  platform: loadPlatformAdmin,
  docs: loadDocs,
};

export async function loadPage(tab = state.activeTab) {
  if (!PAGE_META[tab]) return;
  if (!PROJECT_FREE_TABS.has(tab) && !state.activeProject) return;
  const slug = state.activeProject?.slug || null;
  const version = ++state.requestVersion;
  try {
    await loaders[tab](version, slug);
  } catch (error) {
    if (!isCurrent(tab, version, slug)) return;
    console.error(error);
    $("page-root").innerHTML = `${pageHeader(tab)}${card("Unable to load this module", errorState(error), { iconName: "alert" })}`;
  }
}

export function renderSqlResult(result) {
  const container = $("sql-result-box");
  if (!container) return;
  state.lastSqlResult = result;
  const rows = result.rows || [];
  const body = rows.length ? table(Object.keys(rows[0]), rows.map((row) => `<tr>${Object.keys(rows[0]).map((column) => `<td>${formatCell(row[column])}</td>`).join("")}</tr>`).join(""), { scroll: true }) : emptyState("check", "Statement completed", "The SQL query succeeded and returned 0 rows.");
  const exportActions = rows.length
    ? `<span class="grow"></span><button class="btn btn-ghost btn-sm" type="button" data-action="copy-sql-result">${icon("copy")}Copy JSON</button><button class="btn btn-ghost btn-sm" type="button" data-action="export-sql-csv">${icon("download")}Export CSV</button>`
    : "";
  container.innerHTML = `<div class="result-meta">${badge("success", "success", "Success")}<span>${formatNumber(result.rowCount ?? rows.length)} row(s)</span><span>${formatNumber(result.durationMs)} ms</span>${exportActions}</div>${body}`;
}

export function renderSavedQueries() {
  const container = $("saved-queries-list");
  if (!container) return;
  const queries = state.savedQueries || [];
  if (!queries.length) {
    container.innerHTML = emptyState("save", "No saved queries yet", "Write a query in the workbench and save it to share with your team.");
    return;
  }
  container.innerHTML = `<div class="resource-list">${queries.map((query) => `<div class="saved-query-item ${state.activeSavedQueryId === query.id ? "active" : ""}"><div class="list-main"><span class="resource-icon">${icon(query.favorite ? "star" : "save")}</span><div class="list-text"><button class="resource-link" type="button" data-action="load-saved-query" data-id="${esc(query.id)}" title="${esc(query.description || query.name)}">${esc(query.name)}</button><small>${esc(truncate(query.sql.replace(/\s+/g, " "), 52))}${query.run_count > 0 ? ` · run ${formatNumber(query.run_count)}×` : ""}</small></div></div><div class="list-actions"><button class="icon-btn btn-sm" type="button" data-action="edit-saved-query" data-id="${esc(query.id)}" title="Edit saved query">${icon("terminal")}</button><button class="icon-btn btn-sm" type="button" data-action="delete-saved-query" data-id="${esc(query.id)}" data-name="${esc(query.name)}" title="Delete saved query">${icon("trash")}</button></div></div>`).join("")}</div>`;
}

function columnInputHtml(col, value, idPrefix) {
  const name = esc(col.name);
  const type = String(col.dataType || col.udtName || "text").toLowerCase();
  const inputId = `${idPrefix}-${col.name}`;
  const isBool = type === "boolean" || type === "bool";
  const isJson = type.includes("json");
  const isNumeric = ["integer", "bigint", "smallint", "numeric", "real", "double precision", "serial", "bigserial", "int", "int4", "int8", "float8"].includes(type);
  const isTimestamp = type.includes("timestamp");
  const serialized = value === null || value === undefined
    ? ""
    : typeof value === "object" ? JSON.stringify(value) : String(value);

  let control;
  if (isBool) {
    control = `<select id="${esc(inputId)}" data-col="${name}" data-kind="boolean"><option value="" ${value === null || value === undefined ? "selected" : ""}>NULL / default</option><option value="true" ${value === true || value === "true" ? "selected" : ""}>true</option><option value="false" ${value === false || value === "false" ? "selected" : ""}>false</option></select>`;
  } else if (isJson) {
    control = `<textarea id="${esc(inputId)}" class="code-input" rows="2" data-col="${name}" data-kind="json" placeholder='{"key": "value"}'>${esc(serialized)}</textarea>`;
  } else if (isNumeric) {
    control = `<input id="${esc(inputId)}" type="text" inputmode="decimal" data-col="${name}" data-kind="number" value="${esc(serialized)}" placeholder="number">`;
  } else if (isTimestamp) {
    control = `<input id="${esc(inputId)}" type="text" class="mono" data-col="${name}" data-kind="text" value="${esc(serialized)}" placeholder="2026-01-01T12:00:00Z or now()">`;
  } else {
    control = `<input id="${esc(inputId)}" type="text" data-col="${name}" data-kind="text" value="${esc(serialized)}" placeholder="${esc(type)}">`;
  }
  const constraints = [
    col.isPrimaryKey ? "PK" : "",
    col.isNullable === false ? "NOT NULL" : "",
  ].filter(Boolean).join(" · ");
  return `<div class="col-label"><strong>${name}</strong><small>${esc(type)}${constraints ? ` · ${esc(constraints)}` : ""}</small></div><div class="col-input">${control}</div>`;
}

export function buildColumnFormFields(columns, row = null, idPrefix = "col") {
  if (!Array.isArray(columns) || !columns.length) {
    return `<p class="subtle">No column metadata available — use the raw JSON insert instead.</p>`;
  }
  return columns.map((col) => columnInputHtml(col, row ? row[col.name] : null, idPrefix)).join("");
}

export function collectColumnFormPayload(container) {
  const payload = {};
  container.querySelectorAll("[data-col]").forEach((input) => {
    const column = input.dataset.col;
    const kind = input.dataset.kind;
    const raw = String(input.value ?? "").trim();
    if (raw === "") return; // leave to column defaults / NULL
    if (kind === "boolean") {
      payload[column] = raw === "true";
    } else if (kind === "json") {
      try { payload[column] = JSON.parse(raw); } catch { throw new Error(`Column "${column}" is not valid JSON.`); }
    } else if (kind === "number") {
      const num = Number(raw);
      payload[column] = Number.isFinite(num) ? num : raw;
    } else {
      payload[column] = raw;
    }
  });
  return payload;
}

export function updateSavedQueryLabel() {
  const label = $("sql-active-query-label");
  if (!label) return;
  const active = state.savedQueries.find((query) => query.id === state.activeSavedQueryId);
  label.textContent = active ? `editing saved query · ${active.name}` : "unsaved query";
}

export function updateRealtimeUi(status, message = "") {
  state.wsStatus = status;
  const banner = $("rt-connection-banner");
  if (banner) {
    banner.classList.toggle("connected", status === "connected");
    banner.innerHTML = `${icon(status === "connected" ? "check" : status === "error" ? "alert" : "realtime")}<span>${esc(message || (status === "connected" ? "Connected and subscribed." : "Disconnected."))}</span>`;
  }
  $("realtime-nav-dot")?.classList.toggle("hidden", status !== "connected");
}

export function appendRealtimeLog(message) {
  const log = $("rt-stream-log");
  if (!log) return;
  if (log.textContent === "Waiting for a realtime connection…") log.textContent = "";
  const line = `[${new Date().toLocaleTimeString()}] ${typeof message === "string" ? message : JSON.stringify(message)}\n`;
  log.textContent = `${log.textContent}${line}`.slice(-80_000);
  log.scrollTop = log.scrollHeight;
}
