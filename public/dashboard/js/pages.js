import {
  $, api, badge, emptyState, errorState, esc, formatBytes, formatCell, formatDate,
  formatNumber, icon, loadingState, state, timeAgo, truncate,
} from "./core.js";

export const PAGE_META = {
  overview: { title: "Project overview", description: "Live service state, usage, and the next actions for this project.", icon: "overview" },
  database: { title: "Tables & rows", description: "Design the schema, inspect real data, and control table-level access.", icon: "database" },
  sql: { title: "SQL editor", description: "Run SQL inside the project schema with role-scoped safety controls.", icon: "code" },
  migrations: { title: "Migrations", description: "Version schema changes with checksums and a rollback path.", icon: "layers" },
  access: { title: "Roles & RLS", description: "Database roles, grants, connection details, and Row-Level Security policies.", icon: "shield" },
  auth: { title: "Authentication", description: "Application users, identity policy, tokens, and account administration.", icon: "users" },
  api: { title: "API", description: "Generated endpoints, credentials, request examples, and a live API tester.", icon: "link" },
  storage: { title: "Storage", description: "Buckets, object browser, quotas, and signed download links.", icon: "storage" },
  realtime: { title: "Realtime", description: "Channels, subscriptions, persisted change events, and a live socket inspector.", icon: "realtime" },
  functions: { title: "Functions", description: "Deploy versioned server functions, invoke them, and read captured logs.", icon: "function" },
  jobs: { title: "Jobs & schedules", description: "Durable background queue, retries, dead letters, and recurring schedules.", icon: "clock" },
  logs: { title: "Logs & diagnostics", description: "Unified audit, function, job, realtime, storage, and backup events with filters.", icon: "terminal" },
  backups: { title: "Backups & recovery", description: "Create, verify, and restore snapshots, with migration status alongside.", icon: "download" },
  settings: { title: "Project settings", description: "General configuration, environments, secrets, team access, and deletion.", icon: "settings" },
  platform: { title: "Platform administration", description: "Deployment diagnostics, service health, operators, Android builds, and the global audit trail.", icon: "overview" },
  docs: { title: "SDK, CLI & integration", description: "Connect an application to this project using the real endpoints and commands.", icon: "terminal" },
};

const SERVICE_TONE = {
  operational: "success",
  implemented_unverified: "info",
  partially_implemented: "warning",
  requires_configuration: "warning",
  unavailable: "danger",
  failed: "danger",
};

function serviceBadge(serviceState) {
  return badge(serviceState, SERVICE_TONE[serviceState] || "info");
}

function pageHeader(tab, actions = "") {
  const meta = PAGE_META[tab];
  return `<header class="page-header"><div class="page-heading"><div class="breadcrumbs"><span>${esc(state.activeProject?.name || "MARRY BASE")}</span>${icon("chevron")}<span>${esc(meta.title)}</span></div><h1>${esc(meta.title)}</h1><p>${esc(meta.description)}</p></div><div class="page-actions">${actions}<button class="btn btn-secondary" data-action="refresh-page" title="Refresh this view">${icon("refresh")}<span>Refresh</span></button></div></header>`;
}

function table(headers, rows, emptyMessage = "No records found.") {
  return `<div class="table-scroll"><table class="data-table"><thead><tr>${headers.map((header) => `<th>${esc(header)}</th>`).join("")}</tr></thead><tbody>${rows || `<tr><td colspan="${headers.length}" class="table-empty">${esc(emptyMessage)}</td></tr>`}</tbody></table></div>`;
}

function card(title, body, { iconName = "layers", actions = "", flush = false, description = "", className = "" } = {}) {
  return `<section class="card ${esc(className)}"><div class="card-header"><div class="card-title">${icon(iconName)}<div><h2>${esc(title)}</h2>${description ? `<p>${esc(description)}</p>` : ""}</div></div>${actions ? `<div class="card-header-actions">${actions}</div>` : ""}</div><div class="card-body ${flush ? "flush" : ""}">${body}</div></section>`;
}

function statCard(label, value, iconName, detail, tone = "") {
  return `<div class="stat-card"><div class="stat-top"><span>${esc(label)}</span><span class="stat-icon ${esc(tone)}">${icon(iconName)}</span></div><div class="stat-value">${value ?? 0}</div><div class="stat-detail">${esc(detail)}</div></div>`;
}

function copyButton(target, label = "Copy") {
  return `<button class="btn btn-sm btn-secondary" data-action="copy-target" data-target="${esc(target)}">${icon("copy")}${esc(label)}</button>`;
}

function noProject() {
  return `<header class="page-header"><div class="page-heading"><div class="breadcrumbs"><span>MARRY BASE</span></div><h1>Your backend starts here</h1><p>Create a project to provision an isolated PostgreSQL schema, data APIs, authentication, storage, and operations.</p></div></header>${card("Welcome to MARRY BASE", emptyState("layers", "Create your first project", "Each project gets its own schema, database roles, API credentials, authentication configuration, storage buckets, and audit trail.", `<button class="btn btn-primary" data-action="new-project">${icon("plus")}Create project</button>`), { iconName: "overview" })}`;
}

// ---------------------------------------------------------------- templates

function overviewTemplate() {
  return `<div id="overview-content">${loadingState("Reading project diagnostics…")}</div>`;
}

function databaseTemplate() {
  return `
    <details class="disclosure" id="create-table-disclosure">
      <summary>${icon("plus")}Create a new table</summary>
      <div class="disclosure-body"><form id="create-table-form" class="form-stack">
        <div class="field-row align-end"><div class="field"><label for="tbl-name">Table name</label><input id="tbl-name" placeholder="todos" pattern="[A-Za-z_][A-Za-z0-9_]*" required /><small>PostgreSQL identifier, e.g. profiles or task_items.</small></div><div class="field"><label for="tbl-rls">Row-level security</label><select id="tbl-rls"><option value="true">Enable and force RLS</option><option value="false">Leave disabled for now</option></select><small>Recommended for application-facing tables.</small></div></div>
        <div class="field"><div class="label-row"><label for="tbl-cols">Column definitions</label><span class="subtle">JSON array</span></div><textarea id="tbl-cols" class="code-input" spellcheck="false">[
  { "name": "id", "type": "uuid", "primaryKey": true, "defaultValue": "gen_random_uuid()" },
  { "name": "title", "type": "text", "notNull": true },
  { "name": "completed", "type": "boolean", "defaultValue": "false" },
  { "name": "created_at", "type": "timestamptz", "defaultValue": "now()" }
]</textarea></div>
        <div class="form-actions"><button type="submit" class="btn btn-primary">${icon("plus")}Create table</button></div>
      </form></div>
    </details>
    <details class="disclosure" id="alter-table-disclosure">
      <summary>${icon("settings")}Alter the selected table</summary>
      <div class="disclosure-body"><form id="alter-table-form" class="form-stack">
        <p class="muted">Applies to the table selected in the data browser. Changes are executed as parameter-free DDL inside the project schema.</p>
        <div class="field-row"><div class="field"><label for="alter-operation">Operation</label><select id="alter-operation"><option value="add_column">Add column</option><option value="drop_column">Drop column</option><option value="rename_column">Rename column</option><option value="create_index">Create index</option><option value="drop_index">Drop index</option></select></div><div class="field"><label for="alter-table-name">Table</label><input id="alter-table-name" placeholder="Selected table name" required /></div></div>
        <div class="field-row"><div class="field"><label for="alter-column">Column or index</label><input id="alter-column" placeholder="column_name" /></div><div class="field"><label for="alter-new-name">New name / index name</label><input id="alter-new-name" placeholder="optional" /></div><div class="field"><label for="alter-type">Type (add column)</label><input id="alter-type" placeholder="text" /></div></div>
        <label class="checkbox-label"><input id="alter-unique" type="checkbox" />Unique index</label>
        <button class="btn btn-secondary btn-sm" type="submit">${icon("check")}Apply schema change</button>
      </form></div>
    </details>
    <div class="grid-sidebar-reverse section-gap">
      ${card("Schema tables", `<div class="search-input">${icon("search")}<input id="table-search" placeholder="Filter tables…" aria-label="Filter tables" /></div><div id="tables-list" class="section-gap">${loadingState()}</div>`, { iconName: "database", description: "Tables in the isolated project schema" })}
      <section class="card"><div class="card-header"><div class="card-title">${icon("file")}<div><h2>Data browser <span id="active-table-label" class="subtle"></span></h2><p id="active-table-details">Select a table to inspect its rows.</p></div></div><div class="card-header-actions"><button class="btn btn-secondary btn-sm" data-action="refresh-rows">${icon("refresh")}Refresh</button></div></div>
        <div id="table-schema" class="card-body flush"></div>
        <div class="card-body">
          <div class="editor-toolbar row-toolbar">
            <div class="field"><label for="row-filter-column">Filter column</label><select id="row-filter-column"><option value="">No filter</option></select></div>
            <div class="field"><label for="row-filter-value">Equals</label><input id="row-filter-value" placeholder="Value" /></div>
            <div class="field"><label for="row-order-column">Sort column</label><select id="row-order-column"><option value="">Default</option></select></div>
            <div class="field"><label for="row-order-direction">Direction</label><select id="row-order-direction"><option value="desc">Descending</option><option value="asc">Ascending</option></select></div>
            <div class="field"><label for="row-limit">Limit</label><select id="row-limit"><option>25</option><option selected>50</option><option>100</option><option>250</option></select></div>
            <div class="button-group"><button class="btn btn-secondary btn-sm" data-action="apply-row-query">${icon("filter")}Apply</button></div>
          </div>
          <details class="disclosure"><summary>${icon("plus")}Add a row</summary><div class="disclosure-body"><form id="insert-row-form" class="form-stack"><div class="field"><label for="row-json-input">Row JSON</label><textarea id="row-json-input" class="code-input" style="min-height:74px" placeholder='{"title":"Ship MARRY BASE"}' spellcheck="false"></textarea><small>Insert through the generated REST API using your operator privileges.</small></div><div class="form-actions"><button class="btn btn-primary btn-sm" type="submit">${icon("plus")}Insert row</button></div></form></div></details>
        </div>
        <div id="table-rows-container" class="card-body flush">${emptyState("table", "No table selected", "Choose a table from the schema list to browse its data.")}</div>
        <div class="card-body row-pagination" id="row-pagination"></div></section>
    </div>`;
}

function sqlTemplate() {
  return `<div class="stack">
    ${card("SQL editor", `<form id="sql-form"><div class="editor-toolbar"><div class="editor-options"><div class="field"><label for="sql-role-select">Execution role</label><select id="sql-role-select"><option value="service_role">service_role · bypass RLS</option><option value="authenticated">authenticated · enforce RLS</option><option value="anon">anon · enforce RLS</option></select></div><div class="field"><label for="sql-user-id">Impersonated user UUID</label><input id="sql-user-id" placeholder="Optional auth.uid() value" /></div><div class="field"><label for="sql-destructive">Destructive statements</label><select id="sql-destructive"><option value="false">Safeguard on</option><option value="true">Allow DROP / TRUNCATE</option></select></div></div><div class="field"><label for="sql-history">Query history</label><select id="sql-history"><option value="">Recent queries…</option></select></div></div><div class="field"><textarea id="sql-editor-input" class="code-input code-editor" spellcheck="false" aria-label="SQL query">SELECT current_schema(), auth.role() AS current_role, auth.uid() AS current_uid;</textarea></div><div class="editor-footer"><span class="editor-hint"><kbd>⌘</kbd> / <kbd>Ctrl</kbd> + <kbd>Enter</kbd> to run · queries execute inside your project schema</span><div class="button-group"><button type="button" class="btn btn-ghost" data-action="clear-sql">Clear</button><button type="submit" id="btn-run-sql" class="btn btn-primary">${icon("play")}Run query</button></div></div></form><div id="sql-result-box" class="sql-result"></div>`, { iconName: "terminal", description: "Execution is restricted to the project schema; control-plane tables are blocked." })}
    <div class="notice">${icon("shield")}<p>RLS policies and database roles now live on the <button class="link-button" data-nav="access">Roles &amp; RLS</button> page. Use <strong>service_role</strong> only for trusted maintenance queries.</p></div>
  </div>`;
}

function migrationsTemplate() {
  return `<div class="grid-sidebar-reverse">
    ${card("Apply migration", `<form id="apply-migration-form" class="form-stack"><div class="field-row"><div class="field"><label for="mig-version">Version</label><input id="mig-version" placeholder="001" required /></div><div class="field"><label for="mig-name">Name</label><input id="mig-name" placeholder="create_profiles" required /></div></div><div class="field"><label for="mig-up">Up SQL</label><textarea id="mig-up" class="code-input" required spellcheck="false">CREATE TABLE IF NOT EXISTS profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bio text,
  created_at timestamptz NOT NULL DEFAULT now()
);</textarea></div><div class="field"><label for="mig-down">Down SQL <span class="subtle">(rollback)</span></label><textarea id="mig-down" class="code-input" style="min-height:80px" spellcheck="false">DROP TABLE IF EXISTS profiles;</textarea></div><div class="notice">${icon("info")}<p>A migration is recorded with a SHA-256 checksum. Applied SQL cannot be edited; create a new migration for subsequent changes.</p></div><button class="btn btn-primary" type="submit">${icon("play")}Apply migration</button></form>`, { iconName: "upload" })}
    ${card("Migration history", `<div id="migrations-list">${loadingState()}</div>`, { iconName: "clock", flush: true, description: "Newest versions appear first" })}
  </div>`;
}

function accessTemplate() {
  return `<div class="stack">
    <div id="access-summary">${loadingState("Inspecting database roles…")}</div>
    <div class="grid-sidebar">
      ${card("RLS policies", `<div id="rls-policies-list">${loadingState()}</div>`, { iconName: "lock", flush: true, description: "Native PostgreSQL policies enforced by the database" })}
      ${card("Create policy", `<form id="create-policy-form" class="form-stack"><div class="field"><label for="pol-table">Table</label><select id="pol-table" required><option value="">Select a table</option></select></div><div class="field-row"><div class="field"><label for="pol-name">Policy name</label><input id="pol-name" placeholder="users_own_rows" required /></div><div class="field"><label for="pol-cmd">Command</label><select id="pol-cmd"><option>ALL</option><option>SELECT</option><option>INSERT</option><option>UPDATE</option><option>DELETE</option></select></div></div><div class="field"><label for="pol-using">USING expression</label><textarea id="pol-using" class="code-input" style="min-height:70px" placeholder="user_id = auth.uid()" spellcheck="false"></textarea></div><div class="field"><label for="pol-check">WITH CHECK expression <span class="subtle">(optional)</span></label><textarea id="pol-check" class="code-input" style="min-height:70px" placeholder="user_id = auth.uid()" spellcheck="false"></textarea></div><label class="checkbox-label"><input id="pol-enable-rls" type="checkbox" checked />Enable RLS on the selected table</label><button class="btn btn-primary" type="submit">${icon("plus")}Create policy</button></form>`, { iconName: "shield" })}
    </div>
    ${card("Connection & database capabilities", `<div id="connection-info">${loadingState()}</div>`, { iconName: "database", description: "Derived from the running server; passwords are never returned" })}
  </div>`;
}

function authTemplate() {
  return `<div class="stack">
    <div class="grid-2">
      ${card("Add project user", `<form id="admin-create-user-form" class="form-stack"><div class="field-row"><div class="field"><label for="u-email">Email address</label><input id="u-email" type="email" placeholder="user@app.io" required /></div><div class="field"><label for="u-pass">Temporary password</label><input id="u-pass" type="password" minlength="8" placeholder="At least 8 characters" required /></div></div><div class="field-row align-end"><div class="field"><label for="u-role">Application role</label><input id="u-role" value="authenticated" required /></div><label class="checkbox-label"><input id="u-verified" type="checkbox" checked />Mark email as verified</label></div><div class="form-actions"><button class="btn btn-primary" type="submit">${icon("plus")}Create user</button></div></form>`, { iconName: "users" })}
      ${card("Authentication policy", `<form id="auth-config-form" class="form-stack"><div class="field-row"><div class="field"><label for="cfg-public-signup">Public sign-up</label><select id="cfg-public-signup"><option value="true">Enabled</option><option value="false">Admin / invite only</option></select></div><div class="field"><label for="cfg-email-verify">Email verification</label><select id="cfg-email-verify"><option value="false">Not required</option><option value="true">Required before login</option></select></div></div><div class="field-row three"><div class="field"><label for="cfg-pass-len">Min. password</label><input id="cfg-pass-len" type="number" min="6" max="128" value="8" required /></div><div class="field"><label for="cfg-access-ttl">Access TTL (sec)</label><input id="cfg-access-ttl" type="number" min="60" value="3600" required /></div><div class="field"><label for="cfg-refresh-ttl">Refresh TTL (sec)</label><input id="cfg-refresh-ttl" type="number" min="300" value="2592000" required /></div></div><div class="form-actions"><button class="btn btn-primary" type="submit">${icon("check")}Save policy</button></div></form>`, { iconName: "settings" })}
    </div>
    ${card("Project users", `<div id="project-users-list">${loadingState()}</div>`, { iconName: "users", flush: true, actions: `<div class="search-input">${icon("search")}<input id="auth-user-search" placeholder="Search email…" aria-label="Search users" /></div>` })}
    ${card("Token & identity configuration", `<div class="definition-list"><div class="definition-row"><dt>Access token</dt><dd>JWT signed with the platform key · <span class="mono">HS256</span></dd></div><div class="definition-row"><dt>Refresh tokens</dt><dd>Opaque, rotated on use, with reuse detection (<span class="mono">token_family_id</span>)</dd></div><div class="definition-row"><dt>Password hashing</dt><dd>scrypt with per-user salt</dd></div><div class="definition-row"><dt>OAuth linking</dt><dd><span class="mono">/v1/projects/:ref/auth/oauth/:provider</span> → callback identity linking</dd></div><div class="definition-row"><dt>Session endpoints</dt><dd><span class="mono">login · refresh · logout · user · recover · reset-password · verify</span></dd></div></div><div class="notice section-gap">${icon("info")}<p>Credentials for server-to-server access are managed as scoped API keys on the <button class="link-button" data-nav="api">API</button> page.</p></div>`, { iconName: "key" })}
    ${card("OAuth identity providers", `<div id="oauth-providers-list">${loadingState()}</div><form id="oauth-provider-form" class="form-stack section-gap"><div class="field-row"><div class="field"><label for="oauth-provider">Provider</label><select id="oauth-provider"><option value="github">GitHub</option><option value="google">Google</option><option value="gitlab">GitLab</option><option value="azure">Microsoft Entra ID</option><option value="custom">Custom OIDC</option></select></div><div class="field"><label for="oauth-client-id">Client ID</label><input id="oauth-client-id" placeholder="client_id" required /></div></div><div class="field-row"><div class="field"><label for="oauth-authorize-url">Authorize URL <span class="subtle">(custom)</span></label><input id="oauth-authorize-url" placeholder="https://idp.example.com/authorize" /></div><div class="field"><label for="oauth-token-url">Token URL <span class="subtle">(custom)</span></label><input id="oauth-token-url" placeholder="https://idp.example.com/token" /></div></div><div class="field"><label for="oauth-scopes">Scopes <span class="subtle">(comma separated)</span></label><input id="oauth-scopes" placeholder="openid,email,profile" /></div><label class="checkbox-label"><input id="oauth-enabled" type="checkbox" checked />Provider enabled for this project</label><div class="form-actions"><button class="btn btn-secondary" type="submit">${icon("key")}Save provider</button></div><small>Client secrets are not stored by the studio. Provider configuration is recorded with the project auth policy and is required before <span class="mono">/auth/oauth/:provider/authorize</span> will respond.</small></form>`, { iconName: "lock", description: "OAuth/OIDC providers that application users can link" })}
  </div>`;
}

function apiTemplate() {
  return `<div class="stack">
    <div class="grid-sidebar-reverse">
      ${card("Endpoint catalogue", `<div id="api-endpoints-summary" class="subtle">Loading generated endpoints…</div><div class="code-wrap section-gap">${copyButton("api-base-url")}<pre id="api-base-url" class="code-block"></pre></div><div id="api-catalogue" class="section-gap">${loadingState()}</div><div id="api-notes" class="section-gap"></div>`, { iconName: "link", description: "Generated from the live schema and deployed RPC functions" })}
      <div class="stack">
        ${card("API tester", `<form id="api-test-form" class="form-stack"><div class="field-row"><div class="field"><label for="api-test-method">Method</label><select id="api-test-method"><option>GET</option><option>POST</option><option>PATCH</option><option>DELETE</option></select></div><div class="field"><label for="api-test-key">Credential</label><select id="api-test-key"><option value="">No key (platform session)</option></select></div></div><div class="field"><label for="api-test-path">Path or URL</label><input id="api-test-path" value="/rest/" placeholder="/rest/todos?limit=5" required /><small>Relative paths are prefixed with this project’s API base URL.</small></div><div class="field"><label for="api-test-body">JSON body <span class="subtle">(write methods)</span></label><textarea id="api-test-body" class="code-input" style="min-height:80px" spellcheck="false">{}</textarea></div><button class="btn btn-primary" type="submit">${icon("play")}Send request</button></form><div class="section-gap"><div class="result-meta" id="api-test-meta"></div><pre id="api-test-result" class="code-block">Responses appear here.</pre></div>`, { iconName: "terminal", description: "Calls leave the studio and hit your running server" })}
        ${card("OpenAPI 3.1", `<p class="muted">Machine-readable description of every generated table and RPC endpoint.</p><div class="button-group section-gap"><a class="btn btn-secondary btn-sm" id="openapi-link" href="#" target="_blank" rel="noopener">${icon("external")}Open specification</a><button class="btn btn-secondary btn-sm" data-action="download-openapi">${icon("download")}Download JSON</button></div>`, { iconName: "code" })}
      </div>
    </div>
    ${card("API keys", `<form id="create-key-form" class="form-stack"><div class="field-row three"><div class="field"><label for="key-name">Key name</label><input id="key-name" placeholder="Web client" required /></div><div class="field"><label for="key-role">Role</label><select id="key-role"><option value="anon">anon · public client</option><option value="custom">custom · scoped</option><option value="service_role">service_role · secret</option></select></div><div class="field"><label for="key-scopes">Scopes <span class="subtle">(custom role)</span></label><input id="key-scopes" value="db:read,db:write,storage:read,realtime:subscribe" /></div></div><div class="notice">${icon("key")}<p>The full key is shown once after creation. <strong>service_role</strong> keys bypass Row-Level Security and must never ship to a browser or mobile app.</p></div><div class="form-actions"><button class="btn btn-primary" type="submit">${icon("key")}Generate key</button></div></form><div id="api-keys-list" class="section-gap">${loadingState()}</div>`, { iconName: "lock", description: "Scoped credentials for this project only" })}
  </div>`;
}

function storageTemplate() {
  return `<div class="stack">
    <details class="disclosure" id="create-bucket-disclosure"><summary>${icon("plus")}Create a storage bucket</summary><div class="disclosure-body"><form id="create-bucket-form" class="form-stack"><div class="field-row three align-end"><div class="field"><label for="bucket-name">Bucket name</label><input id="bucket-name" placeholder="avatars" required /></div><div class="field"><label for="bucket-public">Visibility</label><select id="bucket-public"><option value="false">Private</option><option value="true">Public read</option></select></div><div class="field"><label for="bucket-limit">File size limit (MB)</label><input id="bucket-limit" type="number" min="1" value="50" /></div></div><div class="form-actions"><button class="btn btn-primary" type="submit">${icon("plus")}Create bucket</button></div></form></div></details>
    <div class="grid-sidebar-reverse">
      ${card("Buckets", `<div id="storage-summary" class="subtle section-gap"></div><div id="buckets-list">${loadingState()}</div>`, { iconName: "storage", description: "Usage and access at a glance" })}
      <div class="stack">
        ${card("Upload object", `<form id="upload-object-form" class="form-stack"><div class="field-row"><div class="field"><label for="obj-path">Object path</label><input id="obj-path" placeholder="docs/readme.txt" required /></div><div class="field"><label for="obj-mime">MIME type <span class="subtle">(text uploads)</span></label><input id="obj-mime" value="text/plain" /></div></div><label class="dropzone" for="obj-file">${icon("upload")}<strong>Choose a file or drop it here</strong><small id="obj-file-label">Any file type allowed by the selected bucket</small><input id="obj-file" type="file" /></label><div class="field"><label for="obj-content">Or upload text content</label><textarea id="obj-content" class="code-input" style="min-height:80px" placeholder="Text is used when no file is selected."></textarea></div><div class="form-actions"><span id="active-bucket-label" class="subtle">Select a bucket first</span><button class="btn btn-primary" type="submit">${icon("upload")}Upload object</button></div></form>`, { iconName: "upload" })}
        ${card("Objects", `<div id="bucket-objects-list">${emptyState("storage", "No bucket selected", "Create or select a bucket to browse objects.")}</div>`, { iconName: "file", flush: true, actions: `<div class="search-input">${icon("search")}<input id="object-prefix" placeholder="Filter by path…" aria-label="Filter object paths" /></div>` })}
      </div>
    </div>
  </div>`;
}

function realtimeTemplate() {
  return `<div class="stack">
    <div id="realtime-status-cards"><div class="stats-grid">${loadingState("Reading realtime status…")}</div></div>
    <div class="grid-sidebar">
      <div class="stack">
        ${card("Live WebSocket stream", `<div id="rt-connection-banner" class="status-banner">${icon("realtime")}<span>Disconnected. Choose a topic and connect to begin streaming.</span></div><form id="rt-connect-form" class="form-stack"><div class="field-row align-end"><div class="field"><label for="rt-topic">Channel topic</label><input id="rt-topic" value="db:*" required /><small>Use <span class="mono">db:*</span> for database changes or <span class="mono">room:lobby</span> for broadcasts.</small></div><div class="button-group"><button class="btn btn-primary" type="submit">${icon("realtime")}Connect</button><button class="btn btn-secondary" type="button" data-action="rt-disconnect">Disconnect</button></div></div></form><div class="label-row section-gap"><span class="field-label">Live messages</span><button class="btn btn-ghost btn-sm" data-action="clear-realtime-log">Clear log</button></div><pre id="rt-stream-log" class="code-block event-log">Waiting for a realtime connection…</pre>`, { iconName: "realtime" })}
        ${card("Send broadcast", `<form id="rt-broadcast-form" class="form-stack"><div class="field-row"><div class="field"><label for="rt-broadcast-topic">Topic</label><input id="rt-broadcast-topic" value="room:lobby" required /></div><div class="field"><label for="rt-event">Event name</label><input id="rt-event" value="ping" required /></div></div><div class="field"><label for="rt-payload">Payload</label><textarea id="rt-payload" class="code-input" style="min-height:70px" spellcheck="false">{"message":"Hello from MARRY BASE"}</textarea></div><button class="btn btn-primary" type="submit">${icon("upload")}Publish broadcast</button></form>`, { iconName: "upload" })}
      </div>
      <div class="stack">
        ${card("Configured channels", `<div id="rt-channels-list">${loadingState()}</div>`, { iconName: "link" })}
        ${card("Recent persisted events", `<div id="rt-events-table">${loadingState()}</div>`, { iconName: "clock", flush: true })}
      </div>
    </div>
    ${card("Connection details", `<div class="definition-list"><div class="definition-row"><dt>WebSocket URL</dt><dd><span class="code-inline" id="rt-endpoint">—</span></dd></div><div class="definition-row"><dt>Authentication</dt><dd>Project API key in the query string, or a project JWT where required</dd></div><div class="definition-row"><dt>Topics</dt><dd><span class="mono">db:&lt;table&gt;</span>, <span class="mono">db:*</span>, <span class="mono">room:*</span>, presence topics</dd></div><div class="definition-row"><dt>Delivery</dt><dd>Persisted events replayed after reconnect with <span class="mono">lastEventId</span></dd></div></div>`, { iconName: "link" })}
  </div>`;
}

function functionsTemplate() {
  return `<div class="grid-sidebar-reverse">
    ${card("Deploy function", `<form id="deploy-fn-form" class="form-stack"><div class="field-row"><div class="field"><label for="fn-slug">Function slug</label><input id="fn-slug" placeholder="hello-world" required /></div><div class="field"><label for="fn-name">Display name</label><input id="fn-name" placeholder="Hello world" /></div></div><div class="field-row"><div class="field"><label for="fn-jwt">Invocation access</label><select id="fn-jwt"><option value="true">Require JWT</option><option value="false">Public endpoint</option></select></div><div class="field"><label for="fn-timeout">Timeout (ms)</label><input id="fn-timeout" type="number" min="100" max="60000" value="5000" required /></div></div><div class="field"><label for="fn-code">Handler code</label><textarea id="fn-code" class="code-input code-editor" spellcheck="false">async function handler(ctx) {
  console.log("Invoked by role:", ctx.auth.role);
  const result = await ctx.db.query("SELECT current_schema() AS schema");
  return {
    statusCode: 200,
    body: {
      message: "Hello from MARRY BASE!",
      schema: result.rows[0]?.schema,
      input: ctx.req.body
    }
  };
}</textarea><small>Deploying an existing slug creates a new version. Code runs in a node:vm sandbox with a hard timeout.</small></div><div class="form-actions"><button type="button" class="btn btn-ghost" data-action="reset-function-form">Reset</button><button class="btn btn-primary" type="submit">${icon("upload")}Deploy function</button></div></form>`, { iconName: "code" })}
    <div class="stack">
      ${card("Deployed functions", `<div id="functions-list">${loadingState()}</div>`, { iconName: "function", flush: true })}
      ${card("Invoke & inspect", `<form id="invoke-fn-form" class="form-stack"><div class="field"><label for="fn-invoke-slug">Function</label><select id="fn-invoke-slug"><option value="">Deploy a function first</option></select></div><div class="field"><label for="fn-payload">Request body</label><textarea id="fn-payload" class="code-input" style="min-height:80px" spellcheck="false">{"event":"studio_test"}</textarea></div><button class="btn btn-primary" type="submit">${icon("play")}Invoke function</button></form><div class="field section-gap"><span class="field-label">Response & captured logs</span><pre id="fn-invoke-output" class="code-block">Invocation output will appear here.</pre></div>`, { iconName: "terminal" })}
    </div>
    ${card("Recent invocation logs", `<div id="function-logs-list">${loadingState()}</div>`, { iconName: "file", flush: true, actions: `<button class="btn btn-ghost btn-sm" data-nav="logs" data-local-target="">All logs${icon("chevron")}</button>` })}
  </div>`;
}

function jobsTemplate() {
  return `<div class="stack">
    ${card("Enqueue background job", `<form id="create-job-form" class="form-stack"><div class="field-row three"><div class="field"><label for="job-type">Job type</label><select id="job-type"><option value="function">Function</option><option value="sql_maintenance">SQL maintenance</option><option value="webhook">Webhook</option><option value="storage_cleanup">Storage cleanup</option></select></div><div class="field"><label for="job-queue">Queue</label><input id="job-queue" value="default" required /></div><div class="field"><label for="job-delay">Delay (seconds)</label><input id="job-delay" type="number" min="0" value="0" /></div></div><div class="field"><label for="job-payload">Payload</label><textarea id="job-payload" class="code-input" style="min-height:70px" spellcheck="false">{"functionSlug":"hello-world"}</textarea></div><div class="form-actions"><button class="btn btn-primary" type="submit">${icon("plus")}Enqueue job</button></div></form>`, { iconName: "plus" })}
    ${card("Job queue", `<div id="jobs-list">${loadingState()}</div>`, { iconName: "clock", flush: true, actions: `<select id="job-status-filter" aria-label="Filter job status" style="width:140px"><option value="">All statuses</option><option>queued</option><option>running</option><option>completed</option><option>failed</option><option>dead_letter</option><option>cancelled</option></select><button class="btn btn-secondary btn-sm" data-action="process-jobs">${icon("play")}Process due</button>` })}
    <div class="grid-sidebar-reverse">
      ${card("Create schedule", `<form id="create-schedule-form" class="form-stack"><div class="field"><label for="schedule-name">Schedule name</label><input id="schedule-name" placeholder="Nightly cleanup" required /></div><div class="field-row"><div class="field"><label for="schedule-type">Job type</label><select id="schedule-type"><option value="function">Function</option><option value="sql_maintenance">SQL maintenance</option><option value="webhook">Webhook</option><option value="storage_cleanup">Storage cleanup</option></select></div><div class="field"><label for="schedule-interval">Interval (seconds)</label><input id="schedule-interval" type="number" min="1" value="3600" required /></div></div><div class="field"><label for="schedule-target">Target function slug <span class="subtle">(function jobs)</span></label><input id="schedule-target" placeholder="hello-world" /></div><div class="field"><label for="schedule-payload">Payload</label><textarea id="schedule-payload" class="code-input" style="min-height:70px" spellcheck="false">{}</textarea></div><button class="btn btn-primary" type="submit">${icon("plus")}Create schedule</button></form>`, { iconName: "clock" })}
      ${card("Recurring schedules", `<div id="schedules-list">${loadingState()}</div>`, { iconName: "refresh", flush: true })}
    </div>
  </div>`;
}

function logsTemplate() {
  return `<div class="stack">
    ${card("Unified log stream", `<div class="editor-toolbar"><div class="editor-options"><div class="field"><label for="log-source">Source</label><select id="log-source"><option value="all">All sources</option><option value="audit">Audit trail</option><option value="function">Functions</option><option value="job">Jobs</option><option value="realtime">Realtime</option><option value="backup">Backups</option><option value="storage">Storage</option></select></div><div class="field"><label for="log-level">Level</label><select id="log-level"><option value="all">All levels</option><option value="info">Info</option><option value="warn">Warning</option><option value="error">Error</option></select></div><div class="field"><label for="log-limit">Limit</label><select id="log-limit"><option>50</option><option selected>100</option><option>200</option><option>500</option></select></div></div><button class="btn btn-secondary btn-sm" data-action="refresh-page">${icon("refresh")}Reload</button></div><div id="log-counts" class="section-gap subtle"></div><div id="logs-list" class="section-gap">${loadingState()}</div>`, { iconName: "terminal", description: "Events are recorded by the server, not fabricated by this page" })}
    ${card("Diagnostic context", `<div id="logs-context">${loadingState()}</div>`, { iconName: "info" })}
  </div>`;
}

function backupsTemplate() {
  return `<div class="stack">
    <div class="notice">${icon("alert")}<p>Restoring replaces the current project schema and related records with the snapshot. Create a fresh backup first, and verify the snapshot before restoring.</p></div>
    ${card("Create project snapshot", `<form id="create-backup-form" class="field-row align-end"><div class="field"><label for="backup-name-input">Snapshot name</label><input id="backup-name-input" placeholder="Pre-migration snapshot" /></div><button class="btn btn-primary" type="submit">${icon("plus")}Create backup</button></form><div class="notice section-gap">${icon("info")}<p>Logical backups capture tables, constraints, RLS policies, auth users, functions, and stored objects. Each backup is checksummed with SHA-256 and stored in the server's backup directory.</p></div>`, { iconName: "storage" })}
    ${card("Backup history", `<div id="backups-list">${loadingState()}</div>`, { iconName: "clock", flush: true })}
    <div class="grid-sidebar-reverse">
      ${card("Migration status", `<div id="backup-migrations">${loadingState()}</div>`, { iconName: "layers", flush: true, description: "Project schema migrations recorded by the control plane" })}
      ${card("Recovery checklist", `<div class="checklist"><div class="checklist-item"><span class="checklist-mark">${icon("check")}</span><span>Create a snapshot after schema changes</span></div><div class="checklist-item"><span class="checklist-mark">${icon("check")}</span><span>Run integrity verification on each snapshot</span></div><div class="checklist-item"><span class="checklist-mark">${icon("check")}</span><span>Restore into a test project before relying on it in production</span></div></div><p class="muted section-gap">Operator-level (platform-wide) backups are managed under <button class="link-button" data-nav="platform">Platform administration</button>.</p>`, { iconName: "shield" })}
    </div>
  </div>`;
}

function settingsTemplate() {
  return `<div class="segmented local-tabs" role="tablist" aria-label="Project settings sections"><button class="active" data-local-tab="general" role="tab">General</button><button data-local-tab="environments" role="tab">Environments</button><button data-local-tab="secrets" role="tab">Secrets</button><button data-local-tab="team" role="tab">Team</button><button data-local-tab="danger" role="tab">Danger zone</button></div>
    <div id="local-general" class="local-panel stack">
      <div class="grid-2">
        ${card("Project settings", `<form id="project-settings-form" class="form-stack"><div class="field"><label for="settings-name">Project name</label><input id="settings-name" required minlength="2" /></div><div class="field"><label for="settings-description">Description</label><textarea id="settings-description" rows="3"></textarea></div><div class="field"><label for="settings-status">Status</label><select id="settings-status"><option value="active">Active</option><option value="suspended">Suspended</option><option value="archived">Archived</option></select></div><div class="form-actions"><button class="btn btn-primary" type="submit">${icon("check")}Save changes</button></div></form>`, { iconName: "settings" })}
        ${card("Project identity", `<dl class="definition-list" id="settings-identity">${loadingState()}</dl>`, { iconName: "layers", description: "Read-only values assigned at provisioning" })}
      </div>
      ${card("Environment variables reference", `<p class="muted">These are the values an application needs to reach this project. Server-side secrets live under the Secrets tab.</p><div class="code-block section-gap" id="settings-env-example">Loading…</div>`, { iconName: "code" })}
    </div>
    <div id="local-environments" class="local-panel hidden stack">
      ${card("Environments", `<div id="environments-list">${loadingState()}</div><form id="create-env-form" class="form-stack section-gap"><div class="field"><label for="env-name-input">New environment</label><input id="env-name-input" placeholder="qa-testing" required /></div><label class="checkbox-label"><input id="env-production" type="checkbox" />Production environment</label><button class="btn btn-secondary btn-sm" type="submit">${icon("plus")}Add environment</button></form>`, { iconName: "layers", description: "Named configuration contexts for this project" })}
    </div>
    <div id="local-secrets" class="local-panel hidden stack">
      ${card("Encrypt a secret", `<form id="create-secret-form" class="form-stack"><div class="field-row"><div class="field"><label for="sec-name">Environment variable name</label><input id="sec-name" placeholder="STRIPE_WEBHOOK_SECRET" pattern="[A-Za-z_][A-Za-z0-9_]*" required /></div><div class="field"><label for="sec-val">Secret value</label><input id="sec-val" type="password" placeholder="whsec_…" required /></div></div><div class="field"><label for="sec-description">Description <span class="subtle">(optional)</span></label><input id="sec-description" placeholder="Used by the billing webhook function" /></div><div class="form-actions"><button class="btn btn-primary" type="submit">${icon("lock")}Encrypt & save</button></div></form>`, { iconName: "lock", description: "AES-256-GCM encryption at rest" })}
      ${card("Project secrets", `<div id="secrets-list">${loadingState()}</div>`, { iconName: "shield", flush: true, actions: `<button class="btn btn-secondary btn-sm" data-action="toggle-secrets">${icon("eye")}<span id="secret-toggle-label">Reveal values</span></button>` })}
    </div>
    <div id="local-team" class="local-panel hidden stack">
      ${card("Add or update a team member", `<form id="add-member-form" class="form-stack"><div class="field-row align-end"><div class="field"><label for="member-email">Platform user email</label><input id="member-email" type="email" placeholder="teammate@company.com" required /><small>The person must already have a MARRY BASE operator account.</small></div><div class="field"><label for="member-role">Project role</label><select id="member-role"><option value="viewer">Viewer · read only</option><option value="developer">Developer · build and deploy</option><option value="admin">Admin · manage project</option><option value="owner">Owner · full control</option></select></div></div><div class="form-actions"><button class="btn btn-primary" type="submit">${icon("plus")}Add member</button></div></form>`, { iconName: "users" })}
      ${card("Project team", `<div id="members-list">${loadingState()}</div>`, { iconName: "users", flush: true, description: "Role-based access to this control plane" })}
    </div>
    <div id="local-danger" class="local-panel hidden stack">
      ${card("Delete this project", `<div class="list-row"><div class="list-text"><strong>Delete ${esc(state.activeProject?.name || "this project")}</strong><small>Permanently removes the schema, data, users, functions, API keys, buckets, and audit records.</small></div><button class="btn btn-danger-ghost" data-action="delete-project">${icon("trash")}Delete project</button></div>`, { iconName: "alert", className: "danger-zone" })}
    </div>`;
}

function platformTemplate() {
  return `<div class="stack">
    <div id="platform-service-cards"><div class="stats-grid">${loadingState("Checking every platform service…")}</div></div>
    <div class="grid-sidebar">
      <div class="stack">
        ${card("Service checks", `<div id="platform-services">${loadingState()}</div>`, { iconName: "shield", flush: true, description: "Every state is derived from a live probe, not a static label" })}
        ${card("Operator accounts", `<div id="platform-users-list">${loadingState()}</div>`, { iconName: "users", flush: true })}
      </div>
      <div class="stack">
        ${card("Deployment diagnostics", `<dl class="definition-list" id="platform-version">${loadingState()}</dl>`, { iconName: "info" })}
        ${card("Android companion", `<div id="apk-status">${loadingState()}</div><form id="apk-build-form" class="form-stack section-gap"><div class="field-row"><div class="field"><label for="apk-version-name">Version name</label><input id="apk-version-name" value="1.1.0" required /></div><div class="field"><label for="apk-version-code">Version code</label><input id="apk-version-code" type="number" min="1" value="2" required /></div></div><div class="form-actions"><a class="btn btn-secondary" href="/v1/platform/apk/download" data-apk-download>${icon("download")}Download APK</a><button class="btn btn-primary" type="submit">${icon("play")}Build with Gradle</button></div></form><div id="apk-build-output" class="section-gap"></div>`, { iconName: "download", description: "Built by the real Gradle pipeline; reported honestly when unavailable" })}
      </div>
    </div>
    ${card("Platform audit trail", `<div id="platform-audit-list">${loadingState()}</div>`, { iconName: "terminal", flush: true, description: "Security-relevant events across every project" })}
    ${card("Platform backups", `<div id="platform-backups-list">${loadingState()}</div>`, { iconName: "storage", flush: true })}
  </div>`;
}

function docsTemplate() {
  return `<div class="stack">
    <div class="grid-sidebar-reverse">
      ${card("Connect an application", `<div class="field"><span class="field-label">Project API base URL</span><div class="code-wrap"><button class="btn btn-sm copy-code" data-action="copy-target" data-target="docs-base-url">${icon("copy")}Copy</button><pre id="docs-base-url" class="code-block">Loading…</pre></div></div><div class="field section-gap"><span class="field-label">TypeScript SDK</span><div class="code-wrap"><button class="btn btn-sm copy-code" data-action="copy-target" data-target="docs-sdk">${icon("copy")}Copy</button><pre id="docs-sdk" class="code-block">Loading…</pre></div></div><div class="field section-gap"><span class="field-label">cURL</span><div class="code-wrap"><button class="btn btn-sm copy-code" data-action="copy-target" data-target="docs-curl">${icon("copy")}Copy</button><pre id="docs-curl" class="code-block">Loading…</pre></div></div>`, { iconName: "code" })}
      <div class="stack">
        ${card("CLI", `<p class="muted">The CLI ships in this repository and runs against the same database.</p><pre class="code-block section-gap">npm run cli -- status
npm run cli -- keys list ${esc(state.activeProject?.slug || "<project>")}
npm run cli -- functions invoke ${esc(state.activeProject?.slug || "<project>")} hello-world '{"name":"Ada"}'
npm run cli -- backup create ${esc(state.activeProject?.slug || "<project>")}
npm run cli -- apk status</pre>`, { iconName: "terminal" })}
        ${card("Client packages", `<dl class="definition-list"><div class="definition-row"><dt>TypeScript SDK</dt><dd><span class="code-inline">src/sdk/index.ts</span> → <span class="mono">createMaaryClient(baseUrl, apiKey, { projectRef })</span></dd></div><div class="definition-row"><dt>REST</dt><dd><span class="mono">/v1/projects/:ref/rest/:table</span></dd></div><div class="definition-row"><dt>RPC</dt><dd><span class="mono">/v1/projects/:ref/rpc/:fn</span></dd></div><div class="definition-row"><dt>Realtime</dt><dd><span class="mono">/v1/projects/:ref/realtime/ws</span></dd></div><div class="definition-row"><dt>Storage</dt><dd><span class="mono">/v1/projects/:ref/storage/…</span></dd></div></dl><div class="notice section-gap">${icon("info")}<p>The SDK in this repository is TypeScript source (<span class="mono">src/sdk/index.ts</span>); it is not published to npm. Import it from the repository or copy it into your project.</p></div>`, { iconName: "link" })}
      </div>
    </div>
    ${card("Integration checklist", `<div class="checklist"><div class="checklist-item"><span class="checklist-mark">${icon("check")}</span><span>Create an <strong>anon</strong> key for browser/mobile clients and a <strong>service_role</strong> key for servers</span></div><div class="checklist-item"><span class="checklist-mark">${icon("check")}</span><span>Enable RLS and write policies for every application table</span></div><div class="checklist-item"><span class="checklist-mark">${icon("check")}</span><span>Use the project auth endpoints for end-user sign-in; keep operator credentials separate</span></div><div class="checklist-item"><span class="checklist-mark">${icon("check")}</span><span>Test each endpoint with the API tester before shipping; provide HTTPS in production</span></div></div>`, { iconName: "check" })}
    ${card("Android companion", `<p class="muted">The Android app owns server configuration and readiness checks; the Management Studio is served by your instance. Build the APK from source with the Gradle pipeline:</p><pre class="code-block section-gap">cd android && ./gradlew :app:assembleDebug
# or, from the repository root on a machine with JDK 17 + Android SDK:
npm run android:build</pre><p class="muted section-gap">CI publishes the same artifact as a workflow artifact. The API reports <span class="mono">not_built</span> until an artifact exists.</p>`, { iconName: "download" })}
  </div>`;
}

const templates = {
  overview: overviewTemplate, database: databaseTemplate, sql: sqlTemplate,
  migrations: migrationsTemplate, access: accessTemplate, auth: authTemplate,
  api: apiTemplate, storage: storageTemplate, realtime: realtimeTemplate,
  functions: functionsTemplate, jobs: jobsTemplate, logs: logsTemplate,
  backups: backupsTemplate, settings: settingsTemplate, platform: platformTemplate,
  docs: docsTemplate,
};

export function renderPage(tab) {
  const safeTab = PAGE_META[tab] ? tab : "overview";
  state.activeTab = safeTab;
  document.querySelectorAll(".nav-item[data-tab]").forEach((button) => {
    const active = button.dataset.tab === safeTab;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current");
  });
  document.title = `${PAGE_META[safeTab].title} · ${state.activeProject?.name || "MARRY BASE"}`;
  const root = $("page-root");
  if (!state.activeProject) {
    root.innerHTML = noProject();
    return;
  }
  const primaryActions = {
    database: `<button class="btn btn-primary" data-action="focus-create-table">${icon("plus")}New table</button>`,
    storage: `<button class="btn btn-primary" data-action="focus-create-bucket">${icon("plus")}New bucket</button>`,
    functions: `<button class="btn btn-primary" data-action="focus-deploy-function">${icon("plus")}Deploy function</button>`,
    jobs: `<button class="btn btn-primary" data-action="focus-create-job">${icon("plus")}Enqueue job</button>`,
    api: `<button class="btn btn-primary" data-action="focus-create-key">${icon("key")}New API key</button>`,
    backups: `<button class="btn btn-primary" data-action="create-backup-focus">${icon("plus")}New backup</button>`,
  };
  root.innerHTML = `${pageHeader(safeTab, primaryActions[safeTab] || "")}${templates[safeTab]()}`;
}

function isCurrent(tab, version, slug) {
  return state.activeTab === tab && state.requestVersion === version && state.activeProject?.slug === slug;
}

// ---------------------------------------------------------------- overview

async function loadOverview(version, slug) {
  const base = `/v1/projects/${encodeURIComponent(slug)}`;
  const [details, status, audit] = await Promise.all([
    api(base), api(`${base}/status`), api(`${base}/audit?limit=6`),
  ]);
  if (!isCurrent("overview", version, slug)) return;
  state.projectDetails = details;
  state.activeProject = details.project;
  state.memberRole = details.memberRole;
  const usage = details.usage || {};
  const project = details.project;
  const environments = details.environments || [];
  const services = status.services || [];
  const needsAttention = services.filter((service) => ["requires_configuration", "partially_implemented", "unavailable", "failed"].includes(service.state));
  const stats = [
    statCard("Tables", formatNumber(usage.tableCount), "database", "PostgreSQL tables", ""),
    statCard("Auth users", formatNumber(usage.userCount), "users", "Project identities", "info"),
    statCard("Storage", formatBytes(usage.storageBytes), "storage", `${formatNumber(usage.storageObjects)} objects`, "gold"),
    statCard("Functions", formatNumber(usage.functionCount), "function", "Deployed handlers", "purple"),
    statCard("Queued jobs", formatNumber(usage.queuedJobs), "clock", "Queued or running", "gold"),
  ].join("");
  const serviceRows = services.map((service) => `<tr><td><strong>${esc(service.name)}</strong><span class="cell-secondary">${esc(service.verifiedBy)}</span></td><td>${serviceBadge(service.state)}</td><td class="cell-wrap">${esc(service.summary)}${service.action ? `<span class="cell-secondary">Next: ${esc(service.action)}</span>` : ""}</td></tr>`).join("");
  const environmentRows = environments.map((environment) => `<div class="list-row"><div class="list-main"><span class="resource-icon">${icon(environment.is_production ? "shield" : "layers")}</span><div class="list-text"><strong>${esc(environment.name)}</strong><small class="mono">${esc(environment.slug)}</small></div></div><div class="list-actions">${badge(environment.is_production ? "production" : "non-prod")}${environments.length > 1 ? `<button class="icon-btn btn-sm" data-action="delete-environment" data-id="${esc(environment.id)}" data-name="${esc(environment.name)}" aria-label="Delete ${esc(environment.name)}">${icon("trash")}</button>` : ""}</div></div>`).join("");
  const auditRows = (audit.events || []).map((event) => `<tr><td><div class="activity-action"><strong>${esc(event.action)}</strong><span class="cell-secondary">${esc(event.actor_type)}</span></div></td><td>${esc(event.resource_type || "—")}</td><td title="${esc(formatDate(event.created_at))}">${esc(timeAgo(event.created_at))}</td></tr>`).join("");
  $("overview-content").innerHTML = `
    ${needsAttention.length ? `<div class="notice warning">${icon("alert")}<p><strong>${needsAttention.length} service(s) need attention.</strong> ${esc(needsAttention.map((service) => `${service.name}: ${service.state.replaceAll("_", " ")}`).join(" · "))}</p></div>` : `<div class="notice success">${icon("check")}<p><strong>All inspected services are operational.</strong> Every state below comes from a live check of this project.</p></div>`}
    <div class="stats-grid">${stats}</div>
    <div class="grid-sidebar">
      <div class="stack">
        ${card("Service status", table(["Service", "State", "Detail"], serviceRows, "No service checks returned."), { iconName: "shield", flush: true, description: `${status.overall.replaceAll("_", " ")} · generated ${timeAgo(status.generatedAt)}` })}
        <div class="grid-2">
          ${card("Project identity", `<dl class="definition-list"><div class="definition-row"><dt>Description</dt><dd>${esc(project.description || "No description yet.")}</dd></div><div class="definition-row"><dt>Project slug</dt><dd><span class="code-inline">${esc(project.slug)}</span></dd></div><div class="definition-row"><dt>PostgreSQL schema</dt><dd><span class="code-inline">${esc(project.schema_name)}</span></dd></div><div class="definition-row"><dt>Database role</dt><dd><span class="code-inline">${esc(project.db_role_name)}</span></dd></div><div class="definition-row"><dt>Status</dt><dd>${badge(project.status)}</dd></div></dl>`, { iconName: "layers", actions: `<button class="icon-btn btn-sm" data-action="copy-text" data-copy="${esc(project.slug)}" aria-label="Copy project slug">${icon("copy")}</button>` })}
          ${card("Recent project activity", table(["Action", "Resource", "When"], auditRows, "No audit events recorded yet."), { iconName: "clock", flush: true, actions: `<button class="btn btn-ghost btn-sm" data-nav="logs">View all${icon("chevron")}</button>` })}
        </div>
      </div>
      <div class="stack">
        ${card("Next actions", `<div class="quick-actions">${needsAttention.slice(0, 4).map((service) => `<button class="quick-action" data-nav="${esc(navForService(service.id))}">${icon(service.id === "database" ? "database" : service.id === "auth" ? "users" : service.id === "storage" ? "storage" : service.id === "functions" ? "function" : "alert")}<span><strong>${esc(service.name)}</strong><small>${esc(service.action || "Review configuration")}</small></span></button>`).join("") || `<p class="muted">Nothing is blocked. Continue building below.</p>`}</div><div class="quick-actions section-gap"><button class="quick-action" data-nav="database">${icon("database")}<span><strong>Build schema</strong><small>Tables, rows, and RLS</small></span></button><button class="quick-action" data-nav="api">${icon("link")}<span><strong>Connect an app</strong><small>Endpoints and keys</small></span></button><button class="quick-action" data-nav="functions">${icon("function")}<span><strong>Add logic</strong><small>Functions and jobs</small></span></button><button class="quick-action" data-nav="logs">${icon("terminal")}<span><strong>Inspect logs</strong><small>Audit and diagnostics</small></span></button></div>`, { iconName: "check" })}
        ${card("Environments", `<div class="list">${environmentRows || emptyState("layers", "No environments", "Create an environment to get started.")}</div><div class="section-gap"><button class="btn btn-secondary btn-sm" data-nav="settings" data-local-target="environments">${icon("settings")}Manage environments</button></div>`, { iconName: "layers" })}
        ${card("API endpoint", `<p class="muted">Base URL for this project’s generated APIs</p><div class="code-wrap section-gap">${copyButton("project-endpoint")}<pre id="project-endpoint" class="code-block"></pre></div><button class="btn btn-secondary btn-sm section-gap" data-nav="api">${icon("link")}Open API workspace</button>`, { iconName: "link" })}
      </div>
    </div>`;
  const endpoint = `${window.location.origin}/v1/projects/${project.slug}`;
  $("project-endpoint").textContent = endpoint;
  $("sidebar-project-name").textContent = project.name;
}

function navForService(id) {
  return ({ database: "database", rls: "access", auth: "auth", api: "api", storage: "storage", functions: "functions", jobs: "jobs", realtime: "realtime", backups: "backups" })[id] || "settings";
}

// ---------------------------------------------------------------- database

export function renderTablesList() {
  const container = $("tables-list");
  if (!container) return;
  const query = ($("table-search")?.value || "").trim().toLowerCase();
  const tables = state.tables.filter((item) => item.name.toLowerCase().includes(query));
  if (!tables.length) {
    container.innerHTML = emptyState("database", query ? "No matching tables" : "Your schema is empty", query ? "Try a different table name." : "Create your first table to start storing application data.");
    return;
  }
  container.innerHTML = `<div class="resource-list">${tables.map((item) => `<div class="resource-item ${state.activeTable === item.name ? "active" : ""}"><div class="list-main"><span class="resource-icon">${icon("database")}</span><div class="list-text"><button class="resource-link" data-action="browse-table" data-table="${esc(item.name)}">${esc(item.name)}</button><small>${formatNumber(item.rowCount)} rows · ${item.columns.length} columns${(item.foreignKeys || []).length ? ` · ${item.foreignKeys.length} FK` : ""}</small></div></div><div class="list-actions">${badge(item.rlsEnabled ? "RLS" : "no RLS", item.rlsEnabled ? "success" : "warning")}<button class="icon-btn btn-sm" data-action="toggle-table-rls" data-table="${esc(item.name)}" data-enabled="${item.rlsEnabled}" title="${item.rlsEnabled ? "Disable" : "Enable"} RLS" aria-label="${item.rlsEnabled ? "Disable" : "Enable"} RLS for ${esc(item.name)}">${icon(item.rlsEnabled ? "lock" : "unlock")}</button><button class="icon-btn btn-sm" data-action="drop-table" data-table="${esc(item.name)}" title="Drop table" aria-label="Drop ${esc(item.name)}">${icon("trash")}</button></div></div>`).join("")}</div>`;
}

async function loadDatabase(version, slug) {
  const response = await api(`/v1/projects/${encodeURIComponent(slug)}/database/tables`);
  if (!isCurrent("database", version, slug)) return;
  state.tables = response.tables || [];
  if (!state.tables.some((item) => item.name === state.activeTable)) state.activeTable = state.tables[0]?.name || null;
  renderTablesList();
  if (state.activeTable) await browseTable(state.activeTable, version);
  else {
    $("active-table-label").textContent = "";
    $("active-table-details").textContent = "Create a table to begin inserting rows.";
    $("table-rows-container").innerHTML = emptyState("table", "No table selected", "Create a table, then browse and edit its rows here.");
  }
}

function rowFilterParams() {
  const params = new URLSearchParams();
  const limit = Number(($("row-limit")?.value || "0")) || 50;
  params.set("limit", String(limit));
  params.set("offset", String(state.rowOffset));
  const orderColumn = $("row-order-column")?.value || "";
  if (orderColumn) params.set("order", `${orderColumn}.${$("row-order-direction")?.value || "asc"}`);
  const filterColumn = $("row-filter-column")?.value || "";
  const filterValue = $("row-filter-value")?.value;
  if (filterColumn && filterValue !== undefined && filterValue !== "") {
    params.set(filterColumn, `eq.${filterValue}`);
  }
  return params;
}

function renderTableSchema(tableMeta) {
  const container = $("table-schema");
  if (!container) return;
  if (!tableMeta) {
    container.innerHTML = "";
    return;
  }
  const columns = tableMeta.columns || [];
  const indexes = tableMeta.indexes || [];
  const foreignKeys = tableMeta.foreignKeys || [];
  const policies = tableMeta.policies || [];
  container.innerHTML = `<div class="schema-grid">
    <div class="schema-block">
      <h3>${icon("table")}Columns</h3>
      <div class="table-scroll"><table class="data-table compact"><thead><tr><th>Name</th><th>Type</th><th>Null</th><th>Default</th></tr></thead><tbody>${columns.map((column) => `<tr><td><span class="mono">${esc(column.name)}</span>${column.isPrimaryKey ? ` ${badge("PK", "purple")}` : ""}</td><td>${esc(column.dataType || column.udtName || "—")}</td><td>${column.isNullable ? "yes" : "no"}</td><td><span class="mono">${esc(truncate(column.defaultValue ?? "—", 40))}</span></td></tr>`).join("") || `<tr><td colspan="4" class="table-empty">No columns reported.</td></tr>`}</tbody></table></div>
    </div>
    <div class="schema-block">
      <h3>${icon("layers")}Indexes &amp; relationships</h3>
      <ul class="schema-list">${indexes.map((index) => `<li><span class="mono">${esc(index.name)}</span><small>${esc(truncate(index.definition || "", 90))}${index.isUnique ? " · unique" : ""}</small></li>`).join("")}${foreignKeys.map((fk) => `<li><span class="mono">${esc(fk.columnName)} → ${esc(fk.foreignTableName)}.${esc(fk.foreignColumnName)}</span><small>relationship · on delete ${esc(fk.onDelete || "no action")}</small></li>`).join("")}${!indexes.length && !foreignKeys.length ? `<li class="subtle">No secondary indexes or foreign keys.</li>` : ""}</ul>
      <h3>${icon("shield")}Policies</h3>
      <ul class="schema-list">${policies.map((policy) => `<li><span class="mono">${esc(policy.policyName)}</span><small>${esc(policy.command)}${policy.permissive === false ? " · restrictive" : ""} · ${esc((policy.roles || []).join(", ") || "PUBLIC")}</small></li>`).join("") || `<li class="subtle">No RLS policies on this table.</li>`}</ul>
    </div>
  </div>`;
}

function populateRowControls(tableMeta) {
  const filter = $("row-filter-column");
  const order = $("row-order-column");
  if (!filter || !order) return;
  const columns = (tableMeta?.columns || []).map((column) => column.name);
  const previousFilter = filter.value;
  const previousOrder = order.value;
  filter.innerHTML = `<option value="">No filter</option>${columns.map((name) => `<option value="${esc(name)}">${esc(name)}</option>`).join("")}`;
  order.innerHTML = `<option value="">Default</option>${columns.map((name) => `<option value="${esc(name)}">${esc(name)}</option>`).join("")}`;
  if (columns.includes(previousFilter)) filter.value = previousFilter;
  if (columns.includes(previousOrder)) order.value = previousOrder;
  const limit = $("row-limit");
  if (limit) limit.value = limit.value || "50";
}

export async function browseTable(name, knownVersion = null) {
  if (!name || !state.activeProject) return;
  const slug = state.activeProject.slug;
  const version = knownVersion ?? state.requestVersion;
  const changedTable = state.activeTable !== name;
  state.activeTable = name;
  if (changedTable) state.rowOffset = 0;
  renderTablesList();
  const container = $("table-rows-container");
  if (container) container.innerHTML = loadingState(`Loading rows from ${name}…`);
  const tableMeta = state.tables.find((item) => item.name === name);
  if ($("active-table-label")) $("active-table-label").textContent = `· ${name}`;
  if ($("active-table-details")) {
    const parts = tableMeta ? [
      `${formatNumber(tableMeta.rowCount)} rows`,
      `${tableMeta.columns.length} columns`,
      tableMeta.rlsEnabled ? "RLS enforced" : "RLS disabled",
      `${(tableMeta.indexes || []).length} indexes`,
    ] : [];
    $("active-table-details").textContent = parts.join(" · ");
  }
  if ($("alter-table-name")) $("alter-table-name").value = name;
  renderTableSchema(tableMeta);
  populateRowControls(tableMeta);
  try {
    const query = rowFilterParams().toString();
    const response = await api(`/v1/projects/${encodeURIComponent(slug)}/rest/${encodeURIComponent(name)}?${query}`);
    if (!isCurrent("database", version, slug) || state.activeTable !== name) return;
    const rows = response.data || response.rows || [];
    const primaryKey = (tableMeta?.primaryKeys || [])[0] || (tableMeta?.columns || []).find((column) => column.isPrimaryKey)?.name || null;
    const rowActions = (row) => {
      if (!primaryKey || row[primaryKey] === undefined || row[primaryKey] === null) return "";
      const filter = `${primaryKey}=eq.${row[primaryKey]}`;
      return `<div class="cell-actions"><button class="icon-btn btn-sm" data-action="edit-row" data-table="${esc(name)}" data-filter="${esc(filter)}" data-row="${esc(JSON.stringify(row))}" aria-label="Edit row">${icon("settings")}</button><button class="icon-btn btn-sm" data-action="delete-row" data-table="${esc(name)}" data-filter="${esc(filter)}" aria-label="Delete row">${icon("trash")}</button></div>`;
    };
    if (container) {
      if (rows.length) {
        const columns = Object.keys(rows[0]);
        container.innerHTML = table([...columns, ""], rows.map((row) => `<tr>${columns.map((column) => `<td>${formatCell(row[column])}</td>`).join("")}<td>${rowActions(row)}</td></tr>`).join(""));
      } else {
        container.innerHTML = emptyState("table", "No matching rows", state.rowOffset > 0 ? "Go back a page or clear the filter." : "Insert a row above or through the REST API.");
      }
    }
    const total = Number(tableMeta?.rowCount ?? rows.length);
    const shownFrom = rows.length ? state.rowOffset + 1 : 0;
    const shownTo = state.rowOffset + rows.length;
    if ($("row-pagination")) {
      $("row-pagination").innerHTML = `<div class="button-group"><button class="btn btn-secondary btn-sm" data-action="rows-prev" ${state.rowOffset === 0 ? "disabled" : ""}>${icon("chevron")}Previous</button><button class="btn btn-secondary btn-sm" data-action="rows-next" ${shownTo >= total ? "disabled" : ""}>Next${icon("chevron")}</button></div><span class="subtle">Showing ${shownFrom}–${shownTo} of ${formatNumber(total)} row(s)${primaryKey ? ` · primary key ${esc(primaryKey)}` : ""}</span>`;
    }
  } catch (error) {
    if (container) container.innerHTML = errorState(error);
  }
}

async function loadSql(version, slug) {
  const response = await api(`/v1/projects/${encodeURIComponent(slug)}/database/tables`);
  if (!isCurrent("sql", version, slug)) return;
  state.tables = response.tables || [];
}

// ---------------------------------------------------------------- migrations

async function loadMigrations(version, slug) {
  const response = await api(`/v1/projects/${encodeURIComponent(slug)}/database/migrations`);
  if (!isCurrent("migrations", version, slug)) return;
  const migrations = response.migrations || [];
  $("migrations-list").innerHTML = migrations.length ? table(["Version", "Migration", "Status", "Applied", ""], migrations.map((migration) => `<tr><td><span class="code-inline">${esc(migration.version)}</span></td><td><strong>${esc(migration.name)}</strong><span class="cell-secondary mono" title="${esc(migration.checksum)}">${esc(truncate(migration.checksum, 14))}</span></td><td>${badge(migration.status)}</td><td>${esc(formatDate(migration.applied_at || migration.created_at))}</td><td><div class="cell-actions">${migration.status === "applied" && migration.down_sql ? `<button class="btn btn-secondary btn-sm" data-action="rollback-migration" data-version="${esc(migration.version)}" data-name="${esc(migration.name)}">Rollback</button>` : ""}</div></td></tr>`).join("")) : emptyState("layers", "No migrations yet", "Apply a versioned migration to build a repeatable schema history.");
}

// ---------------------------------------------------------------- access

function renderPolicies() {
  const container = $("rls-policies-list");
  if (!container) return;
  const policies = state.tables.flatMap((item) => (item.policies || []).map((policy) => ({ ...policy, tableName: policy.tableName || item.name })));
  container.innerHTML = policies.length ? table(["Table", "Policy", "Command", "Expression", ""], policies.map((policy) => `<tr><td><strong>${esc(policy.tableName)}</strong></td><td><span class="code-inline">${esc(policy.policyName)}</span></td><td>${badge(policy.command, "info")}</td><td><div class="json-cell">${esc(policy.usingExpression || policy.checkExpression || "—")}</div></td><td><div class="cell-actions"><button class="icon-btn btn-sm" data-action="delete-policy" data-table="${esc(policy.tableName)}" data-policy="${esc(policy.policyName)}" aria-label="Delete policy ${esc(policy.policyName)}">${icon("trash")}</button></div></td></tr>`).join("")) : emptyState("shield", "No RLS policies", "Create a policy to define who can read or modify each row.");
  const select = $("pol-table");
  if (select) {
    const current = select.value;
    select.innerHTML = `<option value="">Select a table</option>${state.tables.map((item) => `<option value="${esc(item.name)}">${esc(item.name)}</option>`).join("")}`;
    select.value = current;
  }
}

async function loadAccess(version, slug) {
  const base = `/v1/projects/${encodeURIComponent(slug)}`;
  const [tablesResponse, roles, connection] = await Promise.all([
    api(`${base}/database/tables`), api(`${base}/database/roles`), api(`${base}/database/connection`),
  ]);
  if (!isCurrent("access", version, slug)) return;
  state.tables = tablesResponse.tables || [];
  renderPolicies();
  const roleRows = (roles.roles || []).map((role) => `<tr><td><div class="cell-primary"><span class="resource-icon">${icon("key")}</span><div><strong class="mono">${esc(role.name)}</strong><span class="cell-secondary">${esc(role.purpose)}</span></div></div></td><td>${role.isSuperuser ? badge("superuser", "danger") : role.bypassRls ? badge("bypasses RLS", "warning") : badge("RLS enforced", "success")}</td><td>${role.canLogin ? "login" : "nologin"}${role.isCurrent ? " · current" : ""}</td><td>${role.grants.length ? esc(role.grants.slice(0, 3).map((grant) => `${grant.table}: ${grant.privileges.join("/")}`).join(", ")) + (role.grants.length > 3 ? ` +${role.grants.length - 3}` : "") : "—"}</td></tr>`).join("");
  const missing = roles.tablesWithoutRls || [];
  $("access-summary").innerHTML = `
    ${missing.length ? `<div class="notice warning">${icon("alert")}<p><strong>${missing.length} table(s) have RLS disabled:</strong> ${esc(missing.join(", "))}. API traffic using anon/authenticated keys may read or write more than intended.</p></div>` : `<div class="notice success">${icon("check")}<p>Every project table has Row-Level Security enabled.</p></div>`}
    <div class="grid-2">
      ${card("Database roles", table(["Role", "Boundary", "Login", "Grants"], roleRows, "No project roles found yet."), { iconName: "key", flush: true, description: `Schema ${roles.schemaName} · current connection user: ${roles.currentUser}` })}
      ${card("Connection details", `<dl class="definition-list">
        <div class="definition-row"><dt>Engine</dt><dd>${esc(connection.engine)}</dd></div>
        <div class="definition-row"><dt>Mode</dt><dd>${esc(connection.mode)}</dd></div>
        ${connection.host ? `<div class="definition-row"><dt>Host / port</dt><dd><span class="mono">${esc(connection.host)}:${connection.port}</span></dd></div>` : ""}
        ${connection.database ? `<div class="definition-row"><dt>Database</dt><dd><span class="mono">${esc(connection.database)}</span></dd></div>` : ""}
        ${connection.username ? `<div class="definition-row"><dt>Login role</dt><dd><span class="mono">${esc(connection.username)}</span></dd></div>` : ""}
        ${connection.dataDirectory ? `<div class="definition-row"><dt>Data directory</dt><dd><span class="mono">${esc(connection.dataDirectory)}</span></dd></div>` : ""}
        <div class="definition-row"><dt>Schema</dt><dd><span class="code-inline">${esc(connection.schemaName)}</span></dd></div>
        <div class="definition-row"><dt>Statement timeout</dt><dd>${formatNumber(connection.statementTimeoutMs)} ms</dd></div>
        <div class="definition-row"><dt>Row cap per query</dt><dd>${formatNumber(connection.maxQueryRows)}</dd></div>
        <div class="definition-row"><dt>Extensions</dt><dd>${esc((connection.capabilities?.extensions || []).join(", ") || "none")}</dd></div>
      </dl><div id="connection-notes" class="section-gap">${(connection.notes || []).map((note) => `<div class="notice">${icon("info")}<p>${esc(note)}</p></div>`).join("")}</div>`, { iconName: "database" })}
    </div>`;
}

// ---------------------------------------------------------------- auth

function renderOAuthProviders(providers) {
  const container = $("oauth-providers-list");
  if (!container) return;
  const entries = Object.entries(providers || {});
  container.innerHTML = entries.length
    ? table(["Provider", "Client ID", "Scopes", "State", ""], entries.map(([name, provider]) => `<tr><td><strong>${esc(name)}</strong></td><td><span class="code-inline">${esc(provider.clientId || "—")}</span></td><td>${esc((provider.scopes || []).join(", ") || "—")}</td><td>${badge(provider.enabled ? "enabled" : "disabled", provider.enabled ? "success" : "info")}</td><td><div class="cell-actions"><button class="btn btn-secondary btn-sm" data-action="disable-oauth-provider" data-provider="${esc(name)}" ${provider.enabled ? "" : "disabled"}>Disable</button></div></td></tr>`).join(""))
    : emptyState("lock", "No OAuth providers", "Configure a provider above so application users can link an external identity.");
}

async function loadAuth(version, slug) {
  const search = encodeURIComponent($("auth-user-search")?.value?.trim() || "");
  const [usersResponse, configResponse] = await Promise.all([
    api(`/v1/projects/${encodeURIComponent(slug)}/auth/admin/users?limit=100${search ? `&search=${search}` : ""}`),
    api(`/v1/projects/${encodeURIComponent(slug)}/auth/config`),
  ]);
  if (!isCurrent("auth", version, slug)) return;
  const users = usersResponse.users || [];
  $("project-users-list").innerHTML = users.length ? table(["User", "Role", "Verification", "Status", "Last sign in", ""], users.map((user) => `<tr><td><div class="cell-primary"><span class="avatar">${esc((user.email || "U").slice(0, 1).toUpperCase())}</span><div><strong>${esc(user.email)}</strong><span class="cell-secondary mono">${esc(user.id)}</span></div></div></td><td><select data-change-action="change-user-role" data-user="${esc(user.id)}" aria-label="Role for ${esc(user.email)}" style="min-width:130px"><option value="authenticated" ${user.role === "authenticated" ? "selected" : ""}>authenticated</option><option value="admin" ${user.role === "admin" ? "selected" : ""}>admin</option><option value="custom" ${!["authenticated", "admin"].includes(user.role) ? "selected" : ""}>${esc(user.role)}</option></select></td><td>${user.email_verified ? badge("verified", "success") : `<button class="btn btn-ghost btn-sm" data-action="verify-user" data-user="${esc(user.id)}">Mark verified</button>`}</td><td>${badge(user.status)}</td><td title="${esc(formatDate(user.last_sign_in_at))}">${esc(timeAgo(user.last_sign_in_at))}</td><td><div class="cell-actions"><button class="btn btn-secondary btn-sm" data-action="toggle-user-status" data-user="${esc(user.id)}" data-email="${esc(user.email)}" data-status="${esc(user.status)}">${user.status === "active" ? "Suspend" : "Activate"}</button><button class="icon-btn btn-sm" data-action="delete-user" data-user="${esc(user.id)}" data-email="${esc(user.email)}" aria-label="Delete ${esc(user.email)}">${icon("trash")}</button></div></td></tr>`).join("")) : emptyState("users", search ? "No matching users" : "No project users", search ? "Try a different email search." : "Create a user above or enable public sign-up.");
  const config = configResponse.config;
  state.authConfig = config || null;
  renderOAuthProviders(config?.oauth_providers || {});
  if (config) {
    $("cfg-public-signup").value = String(config.allow_public_signup);
    $("cfg-email-verify").value = String(config.require_email_verification);
    $("cfg-pass-len").value = config.password_min_length;
    $("cfg-access-ttl").value = config.access_token_ttl_seconds;
    $("cfg-refresh-ttl").value = config.refresh_token_ttl_seconds;
  }
}

// ---------------------------------------------------------------- api

function renderApiKeys(keys) {
  $("api-keys-list").innerHTML = keys.length ? table(["Name", "Role", "Key prefix", "Scopes", "Status", "Last used", ""], keys.map((key) => `<tr><td><strong>${esc(key.name)}</strong><span class="cell-secondary">${esc(formatDate(key.created_at, false))}</span></td><td>${badge(key.role, key.role === "service_role" ? "danger" : "info")}</td><td><span class="code-inline">${esc(key.key_prefix)}…</span></td><td><span class="cell-truncate" title="${esc((key.scopes || []).join(", "))}">${esc((key.scopes || []).join(", ") || "—")}</span></td><td>${badge(key.revoked_at ? "revoked" : "active")}</td><td>${esc(timeAgo(key.last_used_at))}</td><td><div class="cell-actions">${!key.revoked_at ? `<button class="btn btn-secondary btn-sm" data-action="rotate-key" data-id="${esc(key.id)}" data-name="${esc(key.name)}">Rotate</button><button class="icon-btn btn-sm" data-action="revoke-key" data-id="${esc(key.id)}" data-name="${esc(key.name)}" aria-label="Revoke ${esc(key.name)}">${icon("trash")}</button>` : ""}</div></td></tr>`).join("")) : emptyState("key", "No API keys", "Generate a scoped key to connect an application or backend worker.");
}

function renderApiCatalogue(catalogue) {
  const endpoints = catalogue.endpoints || [];
  $("api-base-url").textContent = `${catalogue.baseUrl}/v1/projects/${catalogue.projectRef}`;
  $("api-endpoints-summary").innerHTML = `<strong>${formatNumber(endpoints.length)} endpoint(s)</strong> across ${formatNumber(new Set(endpoints.map((endpoint) => endpoint.group)).size)} group(s) · schema <span class="mono">${esc(catalogue.schemaName)}</span>`;
  const groups = new Map();
  for (const endpoint of endpoints) {
    if (!groups.has(endpoint.group)) groups.set(endpoint.group, []);
    groups.get(endpoint.group).push(endpoint);
  }
  $("api-catalogue").innerHTML = Array.from(groups.entries()).map(([group, list]) => `<details class="disclosure api-group"><summary>${icon("link")}${esc(group)} <span class="subtle">${list.length} endpoint(s)</span></summary><div class="disclosure-body">${list.map((endpoint) => `<div class="endpoint-row"><div class="endpoint-head"><span class="method method-${endpoint.method.toLowerCase()}">${esc(endpoint.method)}</span><code>${esc(endpoint.path)}</code><span class="subtle">${esc(endpoint.auth)}</span></div><p class="muted">${esc(endpoint.description)}</p><div class="code-wrap"><button class="btn btn-sm copy-code" data-action="copy-text" data-copy="${esc(endpoint.example)}">${icon("copy")}Copy</button><pre class="code-block">${esc(endpoint.example)}</pre></div></div>`).join("")}</div></details>`).join("") || emptyState("link", "No endpoints yet", "Create a table or deploy an RPC function to generate endpoints.");
  $("api-notes").innerHTML = (catalogue.notes || []).map((note) => `<div class="notice">${icon("info")}<p>${esc(note)}</p></div>`).join("");
  $("openapi-link").href = `/v1/projects/${catalogue.projectRef}/openapi.json`;
}

async function loadApi(version, slug) {
  const base = `/v1/projects/${encodeURIComponent(slug)}`;
  const [keysResponse, catalogue, openapi] = await Promise.all([
    api(`${base}/api-keys?reveal=true`), api(`${base}/api/endpoints`), api(`${base}/openapi.json`),
  ]);
  if (!isCurrent("api", version, slug)) return;
  const keys = keysResponse.apiKeys || [];
  state.apiKeys = keys;
  renderApiKeys(keys);
  renderApiCatalogue(catalogue);
  window.__maaryOpenApi = openapi;
  const select = $("api-test-key");
  const active = keys.filter((key) => !key.revoked_at && key.raw_key);
  select.innerHTML = `<option value="">No key (platform session)</option>${active.map((key) => `<option value="${esc(key.raw_key)}">${esc(key.name)} · ${esc(key.role)}</option>`).join("")}`;
}

// ---------------------------------------------------------------- storage

function renderBuckets() {
  const container = $("buckets-list");
  if (!container) return;
  const totalBytes = state.buckets.reduce((sum, bucket) => sum + Number(bucket.used_bytes || 0), 0);
  const totalObjects = state.buckets.reduce((sum, bucket) => sum + Number(bucket.object_count || 0), 0);
  if ($("storage-summary")) $("storage-summary").textContent = `${state.buckets.length} bucket(s) · ${formatNumber(totalObjects)} object(s) · ${formatBytes(totalBytes)} used`;
  if (!state.buckets.length) {
    container.innerHTML = emptyState("storage", "No buckets yet", "Create a private or public bucket to start uploading objects.");
    return;
  }
  container.innerHTML = `<div class="resource-list">${state.buckets.map((bucket) => `<div class="resource-item ${state.activeBucket === bucket.name ? "active" : ""}"><div class="list-main"><span class="resource-icon">${icon(bucket.public ? "unlock" : "lock")}</span><div class="list-text"><button class="resource-link" data-action="open-bucket" data-bucket="${esc(bucket.name)}">${esc(bucket.name)}</button><small>${formatNumber(bucket.object_count)} objects · ${formatBytes(bucket.used_bytes)}${bucket.file_size_limit_bytes ? ` · limit ${formatBytes(bucket.file_size_limit_bytes)}` : ""}</small></div></div><div class="list-actions">${badge(bucket.public ? "public" : "private", bucket.public ? "warning" : "success")}<button class="icon-btn btn-sm" data-action="toggle-bucket-visibility" data-bucket="${esc(bucket.name)}" data-public="${bucket.public}" title="Toggle visibility" aria-label="Toggle ${esc(bucket.name)} visibility">${icon("refresh")}</button><button class="icon-btn btn-sm" data-action="delete-bucket" data-bucket="${esc(bucket.name)}" aria-label="Delete ${esc(bucket.name)}">${icon("trash")}</button></div></div>`).join("")}</div>`;
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
    $("bucket-objects-list").innerHTML = emptyState("storage", "No bucket selected", "Create a bucket before uploading objects.");
  }
}

export async function openBucket(bucketName, knownVersion = null) {
  if (!bucketName || !state.activeProject) return;
  const slug = state.activeProject.slug;
  const version = knownVersion ?? state.requestVersion;
  state.activeBucket = bucketName;
  if ($("active-bucket-label")) $("active-bucket-label").textContent = `Uploading to ${bucketName}`;
  if ($("bucket-objects-list")) $("bucket-objects-list").innerHTML = loadingState("Loading objects…");
  renderBuckets();
  try {
    const prefix = encodeURIComponent($("object-prefix")?.value?.trim() || "");
    const response = await api(`/v1/projects/${encodeURIComponent(slug)}/storage/buckets/${encodeURIComponent(bucketName)}/objects?limit=200${prefix ? `&prefix=${prefix}` : ""}`);
    if (state.activeProject?.slug !== slug || state.activeBucket !== bucketName || state.requestVersion !== version) return;
    const objects = response.objects || [];
    $("bucket-objects-list").innerHTML = objects.length ? table(["Path", "Type", "Size", "Updated", ""], objects.map((object) => `<tr><td><div class="cell-primary">${icon("file")}<div><strong>${esc(object.path)}</strong><span class="cell-secondary mono" title="${esc(object.checksum_sha256)}">SHA ${esc(truncate(object.checksum_sha256, 12))}</span></div></div></td><td>${esc(object.mime_type)}</td><td>${esc(formatBytes(object.size_bytes))}</td><td title="${esc(formatDate(object.updated_at))}">${esc(timeAgo(object.updated_at))}</td><td><div class="cell-actions"><button class="btn btn-secondary btn-sm" data-action="download-object" data-bucket="${esc(bucketName)}" data-path="${esc(object.path)}">${icon("download")}Download</button><button class="icon-btn btn-sm" data-action="delete-object" data-bucket="${esc(bucketName)}" data-path="${esc(object.path)}" aria-label="Delete ${esc(object.path)}">${icon("trash")}</button></div></td></tr>`).join("")) : emptyState("file", "No objects found", "Upload a file or text object, or change the path filter.");
  } catch (error) {
    if ($("bucket-objects-list")) $("bucket-objects-list").innerHTML = errorState(error, "refresh-page");
  }
}

// ---------------------------------------------------------------- realtime

async function loadRealtime(version, slug) {
  const base = `/v1/projects/${encodeURIComponent(slug)}`;
  const [status, eventsResponse, channelsResponse] = await Promise.all([
    api(`${base}/realtime/status`), api(`${base}/realtime/events?limit=50`), api(`${base}/realtime/channels`),
  ]);
  if (!isCurrent("realtime", version, slug)) return;
  const stats = [
    ["Connections", status.connectedClients ?? status.connected_clients ?? 0, "realtime", "Active WebSocket clients", ""],
    ["Subscriptions", status.subscriptions ?? 0, "link", "Active topic subscriptions", "info"],
    ["Channels", (channelsResponse.channels || []).length, "layers", "Persisted channel records", "gold"],
  ];
  $("realtime-status-cards").innerHTML = `<div class="stats-grid" style="grid-template-columns:repeat(3,minmax(0,1fr))">${stats.map(([label, value, iconName, detail, tone]) => `<div class="stat-card"><div class="stat-top"><span>${esc(label)}</span><span class="stat-icon ${esc(tone)}">${icon(iconName)}</span></div><div class="stat-value">${esc(value)}</div><div class="stat-detail">${esc(detail)}</div></div>`).join("")}</div>`;
  state.realtimeEndpoint = `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/v1/projects/${slug}/realtime/ws?apikey=<PROJECT_API_KEY>`;
  if ($("rt-endpoint")) $("rt-endpoint").textContent = state.realtimeEndpoint;
  const events = eventsResponse.events || [];
  $("rt-events-table").innerHTML = events.length ? table(["Event", "Topic", "Time"], events.map((event) => `<tr><td><strong>${esc(event.operation || event.event_type)}</strong><span class="cell-secondary">${esc(event.table_name || event.payload?.event || "broadcast")}</span></td><td><span class="code-inline">${esc(event.channel_topic)}</span></td><td title="${esc(formatDate(event.created_at))}">${esc(timeAgo(event.created_at))}</td></tr>`).join("")) : emptyState("realtime", "No persisted events", "Database changes and broadcasts will be recorded here.");
  const channels = channelsResponse.channels || [];
  $("rt-channels-list").innerHTML = channels.length ? `<div class="list">${channels.map((channel) => `<div class="list-row"><div class="list-main"><span class="resource-icon">${icon("realtime")}</span><div class="list-text"><strong>${esc(channel.topic)}</strong><small>${channel.is_private ? "Private channel" : "Public channel"}</small></div></div>${badge(channel.is_private ? "private" : "public", channel.is_private ? "warning" : "success")}</div>`).join("")}</div>` : emptyState("realtime", "No configured channels", "Subscribe to a topic to create an ad-hoc realtime channel.");
}

// ---------------------------------------------------------------- functions

async function loadFunctions(version, slug) {
  const base = `/v1/projects/${encodeURIComponent(slug)}`;
  const [functionsResponse, logsResponse] = await Promise.all([
    api(`${base}/functions`), api(`${base}/functions-logs?limit=15`),
  ]);
  if (!isCurrent("functions", version, slug)) return;
  state.functions = functionsResponse.functions || [];
  const functions = state.functions;
  $("functions-list").innerHTML = functions.length ? table(["Function", "Version", "Access", "Timeout", ""], functions.map((fn) => `<tr><td><div class="cell-primary"><span class="resource-icon">${icon("function")}</span><div><strong>${esc(fn.name || fn.slug)}</strong><span class="cell-secondary mono">${esc(fn.slug)}</span></div></div></td><td>v${formatNumber(fn.version)}</td><td>${badge(fn.verify_jwt ? "JWT required" : "public", fn.verify_jwt ? "success" : "warning")}</td><td>${formatNumber(fn.timeout_ms)} ms</td><td><div class="cell-actions"><button class="btn btn-secondary btn-sm" data-action="edit-function" data-slug="${esc(fn.slug)}">Edit</button><button class="icon-btn btn-sm" data-action="delete-function" data-slug="${esc(fn.slug)}" aria-label="Delete ${esc(fn.slug)}">${icon("trash")}</button></div></td></tr>`).join("")) : emptyState("function", "No functions deployed", "Deploy the example handler or replace it with your own business logic.");
  const select = $("fn-invoke-slug");
  if (select) select.innerHTML = functions.length ? functions.map((fn) => `<option value="${esc(fn.slug)}">${esc(fn.slug)} · v${formatNumber(fn.version)}</option>`).join("") : `<option value="">Deploy a function first</option>`;
  const logs = logsResponse.logs || logsResponse.functionLogs || [];
  $("function-logs-list").innerHTML = logs.length ? table(["Function", "Status", "Duration", "When"], logs.map((log) => `<tr><td><strong>${esc(log.function_slug)}</strong>${log.error_message ? `<span class="cell-secondary text-danger">${esc(truncate(log.error_message, 80))}</span>` : ""}</td><td>${badge(`HTTP ${log.status_code}`, log.status_code >= 500 ? "danger" : log.status_code >= 400 ? "warning" : "success")}</td><td>${formatNumber(log.duration_ms)} ms</td><td title="${esc(formatDate(log.created_at))}">${esc(timeAgo(log.created_at))}</td></tr>`).join("")) : emptyState("file", "No invocations yet", "Invoke a function to create the first log entry.");
}

// ---------------------------------------------------------------- jobs

async function loadJobs(version, slug) {
  const base = `/v1/projects/${encodeURIComponent(slug)}`;
  const statusFilter = encodeURIComponent($("job-status-filter")?.value || "");
  const [jobsResponse, schedulesResponse] = await Promise.all([
    api(`${base}/jobs?limit=100${statusFilter ? `&status=${statusFilter}` : ""}`), api(`${base}/schedules`),
  ]);
  if (!isCurrent("jobs", version, slug)) return;
  const jobs = jobsResponse.jobs || [];
  $("jobs-list").innerHTML = jobs.length ? table(["Job", "Queue", "Status", "Attempts", "Run at", ""], jobs.map((job) => `<tr><td><strong>${esc(job.job_type)}</strong><span class="cell-secondary mono">${esc(job.id)}</span>${job.last_error ? `<span class="cell-secondary text-danger">${esc(truncate(job.last_error, 80))}</span>` : ""}</td><td>${esc(job.queue_name)}</td><td>${badge(job.status)}</td><td>${formatNumber(job.attempts)} / ${formatNumber(job.max_attempts)}</td><td title="${esc(formatDate(job.run_at))}">${esc(timeAgo(job.run_at))}</td><td><div class="cell-actions">${["queued", "failed"].includes(job.status) ? `<button class="btn btn-secondary btn-sm" data-action="cancel-job" data-id="${esc(job.id)}">Cancel</button>` : ""}</div></td></tr>`).join("")) : emptyState("clock", "No jobs found", "Enqueue a job or adjust the status filter.");
  const schedules = schedulesResponse.schedules || [];
  $("schedules-list").innerHTML = schedules.length ? table(["Schedule", "Type", "Interval", "Next run", "Status", ""], schedules.map((schedule) => `<tr><td><strong>${esc(schedule.name)}</strong><span class="cell-secondary">${esc(schedule.target_slug || "No function target")}</span></td><td>${esc(schedule.job_type)}</td><td>Every ${formatNumber(schedule.interval_seconds)}s</td><td title="${esc(formatDate(schedule.next_run_at))}">${esc(timeAgo(schedule.next_run_at))}</td><td>${badge(schedule.enabled ? "enabled" : "disabled")}</td><td><div class="cell-actions"><button class="icon-btn btn-sm" data-action="delete-schedule" data-id="${esc(schedule.id)}" data-name="${esc(schedule.name)}" aria-label="Delete ${esc(schedule.name)}">${icon("trash")}</button></div></td></tr>`).join("")) : emptyState("clock", "No schedules", "Create a recurring schedule to automate function or maintenance jobs.");
}

// ---------------------------------------------------------------- logs

async function loadLogs(version, slug) {
  const base = `/v1/projects/${encodeURIComponent(slug)}`;
  const source = $("log-source")?.value || "all";
  const level = $("log-level")?.value || "all";
  const limit = $("log-limit")?.value || "100";
  const [logs, status] = await Promise.all([
    api(`${base}/logs?source=${encodeURIComponent(source)}&level=${encodeURIComponent(level)}&limit=${encodeURIComponent(limit)}`),
    api(`${base}/status`),
  ]);
  if (!isCurrent("logs", version, slug)) return;
  const entries = logs.entries || [];
  const counts = logs.counts || {};
  $("log-counts").innerHTML = `Showing <strong>${formatNumber(entries.length)}</strong> event(s) · ${Object.entries(counts).map(([key, value]) => `${esc(key)} ${formatNumber(value)}`).join(" · ") || "no events recorded"}`;
  $("logs-list").innerHTML = entries.length ? table(["Time", "Source", "Level", "Event"], entries.map((entry) => `<tr><td title="${esc(formatDate(entry.timestamp))}">${esc(timeAgo(entry.timestamp))}</td><td>${badge(entry.source, "info")}</td><td>${badge(entry.level, entry.level === "error" ? "danger" : entry.level === "warn" ? "warning" : "success")}</td><td><strong>${esc(entry.message)}</strong><span class="cell-secondary mono">${esc(truncate(JSON.stringify(entry.detail), 180))}</span></td></tr>`).join("")) : emptyState("terminal", "No events match these filters", "Try a different source or level. Audit activity appears as soon as you perform actions.");
  const blocked = (status.services || []).filter((service) => ["unavailable", "failed"].includes(service.state));
  const attention = (status.services || []).filter((service) => ["requires_configuration", "partially_implemented", "implemented_unverified"].includes(service.state));
  $("logs-context").innerHTML = `
    <div class="definition-list"><div class="definition-row"><dt>Project state</dt><dd>${serviceBadge(status.overall)}</dd></div><div class="definition-row"><dt>Blocked services</dt><dd>${blocked.length ? esc(blocked.map((service) => service.name).join(", ")) : "none"}</dd></div><div class="definition-row"><dt>Needs configuration</dt><dd>${attention.length ? esc(attention.map((service) => `${service.name} (${service.state.replaceAll("_", " ")})`).join(", ")) : "none"}</dd></div><div class="definition-row"><dt>Generated</dt><dd>${esc(formatDate(logs.generatedAt))}</dd></div></div>
    <div class="notice section-gap">${icon("info")}<p>Function, job, realtime, storage and backup events come from their own records. Server-level request failures surface in the API response and process logs, not this per-project stream.</p></div>`;
}

// ---------------------------------------------------------------- backups

async function loadBackups(version, slug) {
  const base = `/v1/projects/${encodeURIComponent(slug)}`;
  const [backupsResponse, migrationsResponse] = await Promise.all([
    api(`${base}/backups`), api(`${base}/database/migrations`),
  ]);
  if (!isCurrent("backups", version, slug)) return;
  const backups = backupsResponse.backups || [];
  $("backups-list").innerHTML = backups.length ? table(["Snapshot", "Size", "Integrity", "Created", "Status", ""], backups.map((backup) => `<tr><td><strong>${esc(backup.name)}</strong><span class="cell-secondary mono">${esc(backup.id)}</span>${backup.restored_at ? `<span class="cell-secondary">restored ${esc(timeAgo(backup.restored_at))}</span>` : ""}</td><td>${esc(formatBytes(backup.size_bytes))}</td><td><span class="code-inline" title="${esc(backup.checksum_sha256)}">${esc(truncate(backup.checksum_sha256, 12))}</span></td><td>${esc(formatDate(backup.created_at))}</td><td>${badge(backup.status)}</td><td><div class="cell-actions"><button class="btn btn-secondary btn-sm" data-action="verify-backup" data-id="${esc(backup.id)}" data-name="${esc(backup.name)}">Verify</button><button class="btn btn-danger-ghost btn-sm" data-action="restore-backup" data-id="${esc(backup.id)}" data-name="${esc(backup.name)}">Restore</button></div></td></tr>`).join("")) : emptyState("storage", "No backups yet", "Create a logical snapshot before major schema or data changes.");
  const migrations = migrationsResponse.migrations || [];
  $("backup-migrations").innerHTML = migrations.length ? table(["Version", "Name", "Status", "Applied"], migrations.map((migration) => `<tr><td><span class="code-inline">${esc(migration.version)}</span></td><td>${esc(migration.name)}</td><td>${badge(migration.status)}</td><td>${esc(formatDate(migration.applied_at || migration.created_at, false))}</td></tr>`).join("")) : emptyState("layers", "No migrations", "Schema migrations will appear here once applied.");
}

// ---------------------------------------------------------------- settings

async function loadSettings(version, slug) {
  const base = `/v1/projects/${encodeURIComponent(slug)}`;
  const [details, secretsResponse, membersResponse] = await Promise.all([
    api(base), api(`${base}/secrets?reveal=${state.revealSecrets}`), api(`${base}/members`),
  ]);
  if (!isCurrent("settings", version, slug)) return;
  state.projectDetails = details;
  state.activeProject = details.project;
  const project = details.project;
  $("settings-name").value = project.name || "";
  $("settings-description").value = project.description || "";
  $("settings-status").value = project.status || "active";
  $("settings-identity").innerHTML = `<div class="definition-row"><dt>Slug</dt><dd><span class="code-inline">${esc(project.slug)}</span></dd></div><div class="definition-row"><dt>Schema</dt><dd><span class="code-inline">${esc(project.schema_name)}</span></dd></div><div class="definition-row"><dt>Database role</dt><dd><span class="code-inline">${esc(project.db_role_name)}</span></dd></div><div class="definition-row"><dt>Your role</dt><dd>${badge(details.memberRole, details.memberRole === "owner" ? "purple" : "info")}</dd></div><div class="definition-row"><dt>Created</dt><dd>${esc(formatDate(project.created_at))}</dd></div><div class="definition-row"><dt>Project ID</dt><dd><span class="mono">${esc(project.id)}</span></dd></div>`;
  $("settings-env-example").textContent = `MARRY_BASE_URL=${window.location.origin}\nMARRY_BASE_PROJECT=${project.slug}\nMARRY_BASE_ANON_KEY=<create an anon key on the API page>\nMARRY_BASE_SERVICE_KEY=<server-only service_role key>`;
  const environments = details.environments || [];
  $("environments-list").innerHTML = environments.length ? `<div class="list">${environments.map((environment) => `<div class="list-row"><div class="list-main"><span class="resource-icon">${icon(environment.is_production ? "shield" : "layers")}</span><div class="list-text"><strong>${esc(environment.name)}</strong><small class="mono">${esc(environment.slug)}</small></div></div><div class="list-actions">${badge(environment.is_production ? "production" : "non-prod")}${environments.length > 1 ? `<button class="icon-btn btn-sm" data-action="delete-environment" data-id="${esc(environment.id)}" data-name="${esc(environment.name)}" aria-label="Delete ${esc(environment.name)}">${icon("trash")}</button>` : ""}</div></div>`).join("")}</div>` : emptyState("layers", "No environments", "Add a development, staging, or production context.");
  const secrets = secretsResponse.secrets || [];
  $("secrets-list").innerHTML = secrets.length ? table(["Name", "Value", "Version", "Updated", ""], secrets.map((secret) => `<tr><td><strong class="mono">${esc(secret.name)}</strong><span class="cell-secondary">${esc(secret.description || "No description")}</span></td><td><span class="code-inline secret-value">${esc(secret.decrypted_value ?? secret.masked_value)}</span></td><td>v${formatNumber(secret.version)}</td><td title="${esc(formatDate(secret.updated_at))}">${esc(timeAgo(secret.updated_at))}</td><td><div class="cell-actions">${state.revealSecrets && secret.decrypted_value ? `<button class="icon-btn btn-sm" data-action="copy-text" data-copy="${esc(secret.decrypted_value)}" aria-label="Copy ${esc(secret.name)}">${icon("copy")}</button>` : ""}<button class="icon-btn btn-sm" data-action="delete-secret" data-id="${esc(secret.id)}" data-name="${esc(secret.name)}" aria-label="Delete ${esc(secret.name)}">${icon("trash")}</button></div></td></tr>`).join("")) : emptyState("lock", "No secrets stored", "Add environment credentials for functions and backend integrations.");
  if ($("secret-toggle-label")) $("secret-toggle-label").textContent = state.revealSecrets ? "Hide values" : "Reveal values";
  const members = membersResponse.members || [];
  $("members-list").innerHTML = members.length ? table(["Member", "Role", "Permissions", "Joined", ""], members.map((member) => `<tr><td><div class="cell-primary"><span class="avatar">${esc((member.name || member.email || "U").slice(0, 1).toUpperCase())}</span><div><strong>${esc(member.name || member.email)}</strong><span class="cell-secondary">${esc(member.email)}</span></div></div></td><td>${badge(member.role, member.role === "owner" ? "purple" : "info")}</td><td>${esc((member.permissions || []).join(", ") || "Role defaults")}</td><td>${esc(formatDate(member.created_at, false))}</td><td><div class="cell-actions">${member.user_id !== state.user?.id ? `<button class="icon-btn btn-sm" data-action="remove-member" data-user="${esc(member.user_id)}" data-email="${esc(member.email)}" aria-label="Remove ${esc(member.email)}">${icon("trash")}</button>` : `<span class="subtle">You</span>`}</div></td></tr>`).join("")) : emptyState("users", "No team members", "Add an existing platform operator to collaborate on this project.");
}

// ---------------------------------------------------------------- platform

async function loadPlatform(version, slug) {
  void slug;
  const [status, versionInfo, usersResponse, auditResponse, backupsResponse] = await Promise.all([
    api("/v1/platform/status"), api("/v1/platform/version"), api("/v1/platform/users"),
    api("/v1/platform/audit?limit=50"), api("/v1/platform/backups"),
  ]);
  if (state.activeTab !== "platform" || state.requestVersion !== version) return;
  if (!isCurrent("platform", version, state.activeProject?.slug)) return;
  const services = status.services || [];
  const stats = [
    statCard("Platform state", status.overall.replaceAll("_", " "), "shield", `Generated ${timeAgo(status.generatedAt)}`, status.overall === "operational" ? "" : "gold"),
    statCard("Projects", formatNumber(status.metrics?.projects || 0), "layers", "Active control-plane projects", "info"),
    statCard("Operators", formatNumber(status.metrics?.platformUsers || 0), "users", "Platform accounts", "purple"),
    statCard("Application users", formatNumber(status.metrics?.projectAuthUsers || 0), "key", "Across all projects", ""),
    statCard("Storage", formatBytes(status.metrics?.storageBytes || 0), "storage", `${formatNumber(status.metrics?.storageObjects || 0)} objects`, "gold"),
  ].join("");
  $("platform-service-cards").innerHTML = `<div class="stats-grid">${stats}</div>`;
  $("platform-services").innerHTML = table(["Service", "State", "Evidence"], services.map((service) => `<tr><td><strong>${esc(service.name)}</strong><span class="cell-secondary">${esc(service.summary)}</span>${service.action ? `<span class="cell-secondary">Next: ${esc(service.action)}</span>` : ""}</td><td>${serviceBadge(service.state)}</td><td class="cell-sub">${esc(service.verifiedBy)}</td></tr>`).join(""));
  $("platform-version").innerHTML = `
    <div class="definition-row"><dt>Version</dt><dd><span class="mono">${esc(versionInfo.version)}</span></dd></div>
    <div class="definition-row"><dt>Commit</dt><dd><span class="mono">${esc(versionInfo.commit || "not set (APP_COMMIT)")}</span></dd></div>
    <div class="definition-row"><dt>Environment</dt><dd>${esc(versionInfo.environment)}</dd></div>
    <div class="definition-row"><dt>Node.js</dt><dd><span class="mono">${esc(versionInfo.nodeVersion)}</span></dd></div>
    <div class="definition-row"><dt>Uptime</dt><dd>${esc(formatDuration(status.platform.uptimeSeconds))}</dd></div>
    <div class="definition-row"><dt>Database mode</dt><dd><span class="mono">${esc(status.platform.mode)}</span></dd></div>
    <div class="definition-row"><dt>Migrations</dt><dd>${formatNumber(versionInfo.migrations.applied)} applied · ${versionInfo.migrations.pending.length ? `<span class="text-danger">${versionInfo.migrations.pending.length} pending</span>` : "none pending"}</dd></div>
    <div class="definition-row"><dt>Memory (RSS)</dt><dd>${formatBytes(status.metrics?.memoryRssBytes || 0)}</dd></div>
    <div class="definition-row"><dt>Readiness</dt><dd><a class="link-button" href="/ready" target="_blank" rel="noopener">/ready</a> · <a class="link-button" href="/v1/metrics" target="_blank" rel="noopener">/v1/metrics</a></dd></div>`;
  const apk = status.android || {};
  const buildEnv = apk.buildEnvironment || {};
  $("apk-status").innerHTML = `
    <div class="list-row"><div class="list-main"><span class="resource-icon">${icon("download")}</span><div class="list-text"><strong>${esc(apk.packageName || "com.marrybase.platform")}</strong><small>${esc(apk.summary || "")}</small></div></div>${serviceBadge(apk.state === "available" ? "operational" : apk.state === "invalid" ? "failed" : "requires_configuration")}</div>
    <dl class="definition-list section-gap">
      <div class="definition-row"><dt>Artifact state</dt><dd>${esc(apk.state || "unknown")}</dd></div>
      <div class="definition-row"><dt>Version</dt><dd>${esc(apk.artifact?.versionName || "—")} (code ${esc(String(apk.artifact?.versionCode ?? "—"))})</dd></div>
      <div class="definition-row"><dt>Size</dt><dd>${apk.artifact?.sizeBytes ? esc(formatBytes(apk.artifact.sizeBytes)) : "—"}</dd></div>
      <div class="definition-row"><dt>SHA-256</dt><dd><span class="mono">${esc(truncate(apk.artifact?.checksumSha256 || "—", 24))}</span></dd></div>
      <div class="definition-row"><dt>Built at</dt><dd>${esc(apk.artifact?.builtAt ? formatDate(apk.artifact.builtAt) : "—")}</dd></div>
      <div class="definition-row"><dt>Gradle prerequisites</dt><dd>${buildEnv.gradleBuildPossible ? "available" : esc((buildEnv.missingPrerequisites || []).join(", "))}</dd></div>
    </dl>
    ${apk.verification?.problems?.length ? `<div class="notice danger section-gap">${icon("alert")}<p>${esc(apk.verification.problems.join(" "))}</p></div>` : ""}`;
  const download = document.querySelector("[data-apk-download]");
  if (download) download.classList.toggle("disabled", apk.state !== "available");
  $("platform-users-list").innerHTML = (usersResponse.users || []).length ? table(["Operator", "Role", "Created", "Last sign in"], usersResponse.users.map((user) => `<tr><td><strong>${esc(user.email)}</strong><span class="cell-secondary mono">${esc(user.id)}</span></td><td>${badge(user.is_superadmin ? "superadmin" : "operator", user.is_superadmin ? "purple" : "info")}</td><td>${esc(formatDate(user.created_at, false))}</td><td>${esc(timeAgo(user.last_login_at || user.last_sign_in_at))}</td></tr>`).join("")) : emptyState("users", "No operators", "Register the first operator account.");
  $("platform-audit-list").innerHTML = (auditResponse.events || []).length ? table(["Time", "Action", "Actor", "Project", "Resource"], auditResponse.events.map((event) => `<tr><td>${esc(formatDate(event.created_at))}</td><td><span class="code-inline">${esc(event.action)}</span></td><td>${esc(event.actor_type)}<span class="cell-secondary mono">${esc(truncate(event.actor_id || "system", 12))}</span></td><td><span class="mono">${esc(truncate(event.project_id || "—", 12))}</span></td><td>${esc(event.resource_type || "—")}</td></tr>`).join("")) : emptyState("terminal", "No audit events", "Security-relevant activity will appear here.");
  $("platform-backups-list").innerHTML = (backupsResponse.backups || []).length ? table(["Backup", "Scope", "Size", "Status", "Created"], backupsResponse.backups.map((backup) => `<tr><td><strong>${esc(backup.name)}</strong><span class="cell-secondary mono">${esc(backup.id)}</span></td><td>${esc(backup.backup_type)}</td><td>${esc(formatBytes(backup.size_bytes))}</td><td>${badge(backup.status)}</td><td>${esc(formatDate(backup.created_at))}</td></tr>`).join("")) : emptyState("storage", "No platform backups", "Create a platform backup from the CLI: npm run cli -- backup create");
}

function formatDuration(seconds) {
  const s = Number(seconds) || 0;
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

// ---------------------------------------------------------------- docs

async function loadDocs(version, slug) {
  const base = `/v1/projects/${encodeURIComponent(slug)}`;
  const [catalogue, keysResponse] = await Promise.all([
    api(`${base}/api/endpoints`), api(`${base}/api-keys`),
  ]);
  if (!isCurrent("docs", version, slug)) return;
  const project = state.activeProject;
  const baseUrl = `${catalogue.baseUrl}/v1/projects/${project.slug}`;
  const anonKey = (keysResponse.apiKeys || []).find((key) => key.role === "anon" && !key.revoked_at);
  $("docs-base-url").textContent = baseUrl;
  $("docs-sdk").textContent = `import { createMaaryClient } from "./src/sdk/index.js";\n\nconst maary = createMaaryClient(\n  "${catalogue.baseUrl}",\n  "${anonKey ? `${anonKey.key_prefix}…<full anon key>` : "<YOUR_ANON_KEY>"}",\n  { projectRef: "${project.slug}" }\n);\n\nconst { data, error } = await maary\n  .from("todos")\n  .select("*")\n  .order("created_at", { ascending: false });`;
  const firstTable = catalogue.endpoints.find((endpoint) => endpoint.method === "GET" && endpoint.path.includes("/rest/"));
  $("docs-curl").textContent = `curl "${catalogue.baseUrl}${firstTable?.path || `/v1/projects/${project.slug}/rest/<table>`}?limit=5" \\\n  -H "apikey: $MARRY_BASE_ANON_KEY"`;
}

// ---------------------------------------------------------------- dispatch

const loaders = {
  overview: loadOverview, database: loadDatabase, sql: loadSql, migrations: loadMigrations,
  access: loadAccess, auth: loadAuth, api: loadApi, storage: loadStorage,
  realtime: loadRealtime, functions: loadFunctions, jobs: loadJobs, logs: loadLogs,
  backups: loadBackups, settings: loadSettings, platform: loadPlatform, docs: loadDocs,
};

export async function loadPage(tab = state.activeTab) {
  if (!state.activeProject || !PAGE_META[tab]) return;
  const slug = state.activeProject.slug;
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
  const rows = result.rows || [];
  const body = rows.length ? table(Object.keys(rows[0]), rows.map((row) => `<tr>${Object.keys(rows[0]).map((column) => `<td>${formatCell(row[column])}</td>`).join("")}</tr>`).join("")) : emptyState("check", "Query completed", "The statement succeeded and returned no rows.");
  container.innerHTML = `<div class="result-meta">${badge("success", "success", "Success")}<span>${formatNumber(result.rowCount ?? rows.length)} row(s)</span><span>${formatNumber(result.durationMs)} ms</span></div>${body}`;
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
