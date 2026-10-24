import {
  $, api, badge, emptyState, errorState, esc, formatBytes, formatCell, formatDate,
  formatNumber, icon, loadingState, state, timeAgo, truncate,
} from "./core.js";

export const PAGE_META = {
  overview: { title: "Project overview", description: "A live pulse of your backend, environments, and launch readiness.", icon: "overview" },
  database: { title: "Database", description: "Design your schema, enforce row-level security, and inspect table data.", icon: "database" },
  sql: { title: "SQL & RLS", description: "Run scoped SQL and manage the policies that protect every row.", icon: "code" },
  migrations: { title: "Migrations", description: "Version schema changes with checksums and a safe rollback path.", icon: "layers" },
  auth: { title: "Authentication", description: "Manage application users and configure your project’s identity policies.", icon: "users" },
  storage: { title: "Storage", description: "Organize buckets, upload objects, and create secure download links.", icon: "storage" },
  functions: { title: "Functions & Jobs", description: "Deploy isolated functions, automate work, and monitor background queues.", icon: "function" },
  realtime: { title: "Realtime", description: "Inspect live channels, broadcasts, and persisted database change events.", icon: "realtime" },
  security: { title: "Security & Team", description: "Control credentials, encrypted secrets, and project access from one place.", icon: "shield" },
  operations: { title: "Operations", description: "Protect your data, inspect platform activity, and configure the project.", icon: "settings" },
};

function pageHeader(tab, actions = "") {
  const meta = PAGE_META[tab];
  return `<header class="page-header"><div class="page-heading"><div class="breadcrumbs"><span>${esc(state.activeProject?.name || "Workspace")}</span>${icon("chevron")}<span>${esc(meta.title)}</span></div><h1>${esc(meta.title)}</h1><p>${esc(meta.description)}</p></div><div class="page-actions">${actions}<button class="btn btn-secondary" data-action="refresh-page" title="Refresh this view">${icon("refresh")}<span>Refresh</span></button></div></header>`;
}

function table(headers, rows, emptyMessage = "No records found.") {
  return `<div class="table-scroll"><table class="data-table"><thead><tr>${headers.map((header) => `<th>${esc(header)}</th>`).join("")}</tr></thead><tbody>${rows || `<tr><td colspan="${headers.length}" class="table-empty">${esc(emptyMessage)}</td></tr>`}</tbody></table></div>`;
}

function card(title, body, { iconName = "layers", actions = "", flush = false, description = "", className = "" } = {}) {
  return `<section class="card ${esc(className)}"><div class="card-header"><div class="card-title">${icon(iconName)}<div><h2>${esc(title)}</h2>${description ? `<p>${esc(description)}</p>` : ""}</div></div>${actions ? `<div class="card-header-actions">${actions}</div>` : ""}</div><div class="card-body ${flush ? "flush" : ""}">${body}</div></section>`;
}

function noProject() {
  return `<header class="page-header"><div class="page-heading"><div class="breadcrumbs"><span>MARRY BASE</span></div><h1>Your backend starts here</h1><p>Create a project to provision your isolated database, APIs, auth, storage, and more.</p></div></header>${card("Welcome to MARRY BASE", emptyState("layers", "Create your first project", "Each project includes development and production environments, scoped API keys, and complete PostgreSQL isolation.", `<button class="btn btn-primary" data-action="new-project">${icon("plus")}Create project</button>`), { iconName: "overview" })}`;
}

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
    <div class="grid-sidebar-reverse section-gap">
      ${card("Schema tables", `<div class="search-input">${icon("search")}<input id="table-search" placeholder="Filter tables…" aria-label="Filter tables" /></div><div id="tables-list" class="section-gap">${loadingState()}</div>`, { iconName: "database", description: "Tables in the isolated project schema" })}
      <section class="card"><div class="card-header"><div class="card-title">${icon("file")}<div><h2>Data browser <span id="active-table-label" class="subtle"></span></h2><p id="active-table-details">Select a table to inspect its rows.</p></div></div><div class="card-header-actions"><button class="btn btn-secondary btn-sm" data-action="refresh-rows">${icon("refresh")}Refresh</button></div></div><div class="card-body"><form id="insert-row-form" class="form-stack"><div class="field"><label for="row-json-input">Insert a row</label><textarea id="row-json-input" class="code-input" style="min-height:74px" placeholder='{"title":"Ship MARRY BASE"}' spellcheck="false"></textarea><small>Provide one JSON object. Inserts use the generated REST API with your operator privileges.</small></div><div class="form-actions"><button class="btn btn-primary btn-sm" type="submit">${icon("plus")}Insert row</button></div></form></div><div id="table-rows-container" class="card-body flush">${emptyState("table", "No table selected", "Choose a table from the schema list to browse its data.")}</div></section>
    </div>`;
}

function sqlTemplate() {
  return `<div class="stack">
    ${card("SQL editor", `<form id="sql-form"><div class="editor-toolbar"><div class="editor-options"><div class="field"><label for="sql-role-select">Execution role</label><select id="sql-role-select"><option value="service_role">service_role · bypass RLS</option><option value="authenticated">authenticated · enforce RLS</option><option value="anon">anon · enforce RLS</option></select></div><div class="field"><label for="sql-user-id">Impersonated user UUID</label><input id="sql-user-id" placeholder="Optional auth.uid() value" /></div><div class="field"><label for="sql-destructive">Destructive statements</label><select id="sql-destructive"><option value="false">Safeguard on</option><option value="true">Allow DROP / TRUNCATE</option></select></div></div><div class="field"><label for="sql-history">Query history</label><select id="sql-history"><option value="">Recent queries…</option></select></div></div><div class="field"><textarea id="sql-editor-input" class="code-input code-editor" spellcheck="false" aria-label="SQL query">SELECT current_schema(), auth.role() AS current_role, auth.uid() AS current_uid;</textarea></div><div class="editor-footer"><span class="editor-hint"><kbd>⌘</kbd> / <kbd>Ctrl</kbd> + <kbd>Enter</kbd> to run · service_role can bypass RLS</span><div class="button-group"><button type="button" class="btn btn-ghost" data-action="clear-sql">Clear</button><button type="submit" id="btn-run-sql" class="btn btn-primary">${icon("play")}Run query</button></div></div></form><div id="sql-result-box" class="sql-result"></div>`, { iconName: "terminal", description: "Queries run inside this project’s isolated schema" })}
    <div class="grid-sidebar">
      ${card("RLS policies", `<div id="rls-policies-list">${loadingState()}</div>`, { iconName: "shield", flush: true, description: "Native PostgreSQL policies across project tables" })}
      ${card("Create policy", `<form id="create-policy-form" class="form-stack"><div class="field"><label for="pol-table">Table</label><select id="pol-table" required><option value="">Select a table</option></select></div><div class="field-row"><div class="field"><label for="pol-name">Policy name</label><input id="pol-name" placeholder="users_own_rows" required /></div><div class="field"><label for="pol-cmd">Command</label><select id="pol-cmd"><option>ALL</option><option>SELECT</option><option>INSERT</option><option>UPDATE</option><option>DELETE</option></select></div></div><div class="field"><label for="pol-using">USING expression</label><textarea id="pol-using" class="code-input" style="min-height:70px" placeholder="user_id = auth.uid()" spellcheck="false"></textarea></div><div class="field"><label for="pol-check">WITH CHECK expression <span class="subtle">(optional)</span></label><textarea id="pol-check" class="code-input" style="min-height:70px" placeholder="user_id = auth.uid()" spellcheck="false"></textarea></div><label class="checkbox-label"><input id="pol-enable-rls" type="checkbox" checked />Enable RLS on the selected table</label><button class="btn btn-primary" type="submit">${icon("plus")}Create policy</button></form>`, { iconName: "lock" })}
    </div>
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

function authTemplate() {
  return `<div class="stack">
    <div class="grid-2">
      ${card("Add project user", `<form id="admin-create-user-form" class="form-stack"><div class="field-row"><div class="field"><label for="u-email">Email address</label><input id="u-email" type="email" placeholder="user@app.io" required /></div><div class="field"><label for="u-pass">Temporary password</label><input id="u-pass" type="password" minlength="8" placeholder="At least 8 characters" required /></div></div><div class="field-row align-end"><div class="field"><label for="u-role">Application role</label><input id="u-role" value="authenticated" required /></div><label class="checkbox-label"><input id="u-verified" type="checkbox" checked />Mark email as verified</label></div><div class="form-actions"><button class="btn btn-primary" type="submit">${icon("plus")}Create user</button></div></form>`, { iconName: "users" })}
      ${card("Authentication policy", `<form id="auth-config-form" class="form-stack"><div class="field-row"><div class="field"><label for="cfg-public-signup">Public sign-up</label><select id="cfg-public-signup"><option value="true">Enabled</option><option value="false">Admin / invite only</option></select></div><div class="field"><label for="cfg-email-verify">Email verification</label><select id="cfg-email-verify"><option value="false">Not required</option><option value="true">Required before login</option></select></div></div><div class="field-row three"><div class="field"><label for="cfg-pass-len">Min. password</label><input id="cfg-pass-len" type="number" min="6" max="128" value="8" required /></div><div class="field"><label for="cfg-access-ttl">Access TTL (sec)</label><input id="cfg-access-ttl" type="number" min="60" value="3600" required /></div><div class="field"><label for="cfg-refresh-ttl">Refresh TTL (sec)</label><input id="cfg-refresh-ttl" type="number" min="300" value="2592000" required /></div></div><div class="form-actions"><button class="btn btn-primary" type="submit">${icon("check")}Save policy</button></div></form>`, { iconName: "settings" })}
    </div>
    ${card("Project users", `<div id="project-users-list">${loadingState()}</div>`, { iconName: "users", flush: true, actions: `<div class="search-input">${icon("search")}<input id="auth-user-search" placeholder="Search email…" aria-label="Search users" /></div>` })}
  </div>`;
}

function storageTemplate() {
  return `<div class="stack">
    <details class="disclosure" id="create-bucket-disclosure"><summary>${icon("plus")}Create a storage bucket</summary><div class="disclosure-body"><form id="create-bucket-form" class="form-stack"><div class="field-row three align-end"><div class="field"><label for="bucket-name">Bucket name</label><input id="bucket-name" placeholder="avatars" required /></div><div class="field"><label for="bucket-public">Visibility</label><select id="bucket-public"><option value="false">Private</option><option value="true">Public read</option></select></div><div class="field"><label for="bucket-limit">File size limit (MB)</label><input id="bucket-limit" type="number" min="1" value="50" /></div></div><div class="form-actions"><button class="btn btn-primary" type="submit">${icon("plus")}Create bucket</button></div></form></div></details>
    <div class="grid-sidebar-reverse">
      ${card("Buckets", `<div id="buckets-list">${loadingState()}</div>`, { iconName: "storage", description: "Usage and access at a glance" })}
      <div class="stack">
        ${card("Upload object", `<form id="upload-object-form" class="form-stack"><div class="field-row"><div class="field"><label for="obj-path">Object path</label><input id="obj-path" placeholder="docs/readme.txt" required /></div><div class="field"><label for="obj-mime">MIME type <span class="subtle">(text uploads)</span></label><input id="obj-mime" value="text/plain" /></div></div><label class="dropzone" for="obj-file">${icon("upload")}<strong>Choose a file or drop it here</strong><small id="obj-file-label">Any file type allowed by the selected bucket</small><input id="obj-file" type="file" /></label><div class="field"><label for="obj-content">Or upload text content</label><textarea id="obj-content" class="code-input" style="min-height:80px" placeholder="Text is used when no file is selected."></textarea></div><div class="form-actions"><span id="active-bucket-label" class="subtle">Select a bucket first</span><button class="btn btn-primary" type="submit">${icon("upload")}Upload object</button></div></form>`, { iconName: "upload" })}
        ${card("Objects", `<div id="bucket-objects-list">${emptyState("storage", "No bucket selected", "Create or select a bucket to browse objects.")}</div>`, { iconName: "file", flush: true, actions: `<div class="search-input">${icon("search")}<input id="object-prefix" placeholder="Filter by path…" aria-label="Filter object paths" /></div>` })}
      </div>
    </div>
  </div>`;
}

function functionsTemplate() {
  return `<div class="segmented local-tabs" role="tablist" aria-label="Functions and jobs"><button class="active" data-local-tab="functions" role="tab">Functions</button><button data-local-tab="jobs" role="tab">Background jobs</button><button data-local-tab="schedules" role="tab">Schedules</button></div>
    <div id="local-functions" class="local-panel"><div class="grid-sidebar-reverse">
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
}</textarea><small>Deploying an existing slug creates a new version.</small></div><div class="form-actions"><button type="button" class="btn btn-ghost" data-action="reset-function-form">Reset</button><button class="btn btn-primary" type="submit">${icon("upload")}Deploy function</button></div></form>`, { iconName: "code" })}
      <div class="stack">
        ${card("Deployed functions", `<div id="functions-list">${loadingState()}</div>`, { iconName: "function", flush: true })}
        ${card("Invoke & inspect", `<form id="invoke-fn-form" class="form-stack"><div class="field"><label for="fn-invoke-slug">Function</label><select id="fn-invoke-slug"><option value="">Deploy a function first</option></select></div><div class="field"><label for="fn-payload">Request body</label><textarea id="fn-payload" class="code-input" style="min-height:80px" spellcheck="false">{"event":"studio_test"}</textarea></div><button class="btn btn-primary" type="submit">${icon("play")}Invoke function</button></form><div class="field section-gap"><span class="field-label">Response & captured logs</span><pre id="fn-invoke-output" class="code-block">Invocation output will appear here.</pre></div>`, { iconName: "terminal" })}
      </div>
    </div></div>
    <div id="local-jobs" class="local-panel hidden"><div class="stack">
      ${card("Enqueue background job", `<form id="create-job-form" class="form-stack"><div class="field-row three"><div class="field"><label for="job-type">Job type</label><select id="job-type"><option value="function">Function</option><option value="sql_maintenance">SQL maintenance</option><option value="webhook">Webhook</option><option value="storage_cleanup">Storage cleanup</option></select></div><div class="field"><label for="job-queue">Queue</label><input id="job-queue" value="default" required /></div><div class="field"><label for="job-delay">Delay (seconds)</label><input id="job-delay" type="number" min="0" value="0" /></div></div><div class="field"><label for="job-payload">Payload</label><textarea id="job-payload" class="code-input" style="min-height:70px" spellcheck="false">{"functionSlug":"hello-world"}</textarea></div><div class="form-actions"><button class="btn btn-primary" type="submit">${icon("plus")}Enqueue job</button></div></form>`, { iconName: "plus" })}
      ${card("Job queue", `<div id="jobs-list">${loadingState()}</div>`, { iconName: "clock", flush: true, actions: `<select id="job-status-filter" aria-label="Filter job status" style="width:140px"><option value="">All statuses</option><option>queued</option><option>running</option><option>completed</option><option>failed</option><option>dead_letter</option><option>cancelled</option></select><button class="btn btn-secondary btn-sm" data-action="process-jobs">${icon("play")}Process due</button>` })}
    </div></div>
    <div id="local-schedules" class="local-panel hidden"><div class="grid-sidebar-reverse">
      ${card("Create schedule", `<form id="create-schedule-form" class="form-stack"><div class="field"><label for="schedule-name">Schedule name</label><input id="schedule-name" placeholder="Nightly cleanup" required /></div><div class="field-row"><div class="field"><label for="schedule-type">Job type</label><select id="schedule-type"><option value="function">Function</option><option value="sql_maintenance">SQL maintenance</option><option value="webhook">Webhook</option><option value="storage_cleanup">Storage cleanup</option></select></div><div class="field"><label for="schedule-interval">Interval (seconds)</label><input id="schedule-interval" type="number" min="1" value="3600" required /></div></div><div class="field"><label for="schedule-target">Target function slug <span class="subtle">(function jobs)</span></label><input id="schedule-target" placeholder="hello-world" /></div><div class="field"><label for="schedule-payload">Payload</label><textarea id="schedule-payload" class="code-input" style="min-height:70px" spellcheck="false">{}</textarea></div><button class="btn btn-primary" type="submit">${icon("plus")}Create schedule</button></form>`, { iconName: "clock" })}
      ${card("Recurring schedules", `<div id="schedules-list">${loadingState()}</div>`, { iconName: "refresh", flush: true })}
    </div></div>`;
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
  </div>`;
}

function securityTemplate() {
  return `<div class="segmented local-tabs" role="tablist" aria-label="Security sections"><button class="active" data-local-tab="keys" role="tab">API keys</button><button data-local-tab="secrets" role="tab">Secrets</button><button data-local-tab="team" role="tab">Team & RBAC</button></div>
    <div id="local-keys" class="local-panel stack">
      ${card("Generate API key", `<form id="create-key-form" class="form-stack"><div class="field-row three"><div class="field"><label for="key-name">Key name</label><input id="key-name" placeholder="Backend worker" required /></div><div class="field"><label for="key-role">Role</label><select id="key-role"><option value="anon">anon · public client</option><option value="custom">custom · scoped</option><option value="service_role">service_role · secret</option></select></div><div class="field"><label for="key-scopes">Scopes <span class="subtle">(custom role)</span></label><input id="key-scopes" value="db:read,db:write,storage:read,realtime:subscribe" /></div></div><div class="notice">${icon("info")}<p>The full key is shown after creation. Service-role keys bypass RLS and must never be shipped to a client.</p></div><div class="form-actions"><button class="btn btn-primary" type="submit">${icon("key")}Generate key</button></div></form>`, { iconName: "key" })}
      ${card("Project credentials", `<div id="api-keys-list">${loadingState()}</div>`, { iconName: "lock", flush: true })}
    </div>
    <div id="local-secrets" class="local-panel hidden stack">
      ${card("Encrypt a secret", `<form id="create-secret-form" class="form-stack"><div class="field-row"><div class="field"><label for="sec-name">Environment variable name</label><input id="sec-name" placeholder="STRIPE_WEBHOOK_SECRET" pattern="[A-Za-z_][A-Za-z0-9_]*" required /></div><div class="field"><label for="sec-val">Secret value</label><input id="sec-val" type="password" placeholder="whsec_…" required /></div></div><div class="field"><label for="sec-description">Description <span class="subtle">(optional)</span></label><input id="sec-description" placeholder="Used by the billing webhook function" /></div><div class="form-actions"><button class="btn btn-primary" type="submit">${icon("lock")}Encrypt & save</button></div></form>`, { iconName: "lock", description: "AES-256-GCM encryption at rest" })}
      ${card("Project secrets", `<div id="secrets-list">${loadingState()}</div>`, { iconName: "shield", flush: true, actions: `<button class="btn btn-secondary btn-sm" data-action="toggle-secrets">${icon("eye")}<span id="secret-toggle-label">Reveal values</span></button>` })}
    </div>
    <div id="local-team" class="local-panel hidden stack">
      ${card("Add or update a team member", `<form id="add-member-form" class="form-stack"><div class="field-row align-end"><div class="field"><label for="member-email">Platform user email</label><input id="member-email" type="email" placeholder="teammate@company.com" required /><small>The person must already have a MARRY BASE operator account.</small></div><div class="field"><label for="member-role">Project role</label><select id="member-role"><option value="viewer">Viewer · read only</option><option value="developer">Developer · build and deploy</option><option value="admin">Admin · manage project</option><option value="owner">Owner · full control</option></select></div></div><div class="form-actions"><button class="btn btn-primary" type="submit">${icon("plus")}Add member</button></div></form>`, { iconName: "users" })}
      ${card("Project team", `<div id="members-list">${loadingState()}</div>`, { iconName: "users", flush: true, description: "Role-based access to this control plane" })}
    </div>`;
}

function operationsTemplate() {
  return `<div class="segmented local-tabs" role="tablist" aria-label="Operations sections"><button class="active" data-local-tab="backups" role="tab">Backups</button><button data-local-tab="audit" role="tab">Audit log</button><button data-local-tab="api" role="tab">OpenAPI</button><button data-local-tab="settings" role="tab">Project settings</button></div>
    <div id="local-backups" class="local-panel stack">
      ${card("Create project snapshot", `<form id="create-backup-form" class="field-row align-end"><div class="field"><label for="backup-name-input">Snapshot name</label><input id="backup-name-input" placeholder="Pre-migration snapshot" /></div><button class="btn btn-primary" type="submit">${icon("plus")}Create backup</button></form><div class="notice section-gap">${icon("info")}<p>Logical backups capture project tables, constraints, RLS, auth users, functions, and stored objects. Verify integrity before restoring.</p></div>`, { iconName: "storage" })}
      ${card("Backup history", `<div id="backups-list">${loadingState()}</div>`, { iconName: "clock", flush: true })}
    </div>
    <div id="local-audit" class="local-panel hidden">
      ${card("Security & operational audit", `<div id="audit-events-list">${loadingState()}</div>`, { iconName: "shield", flush: true, actions: `<div class="search-input">${icon("search")}<input id="audit-action-filter" placeholder="Filter action…" aria-label="Filter audit action" /></div>` })}
    </div>
    <div id="local-api" class="local-panel hidden stack">
      ${card("OpenAPI 3.1", `<div class="button-group" style="margin-bottom:12px"><a class="btn btn-secondary btn-sm" id="openapi-link" href="#" target="_blank" rel="noopener">${icon("external")}Open specification</a><button class="btn btn-secondary btn-sm" data-action="download-openapi">${icon("download")}Download JSON</button></div><pre id="openapi-preview" class="code-block" style="max-height:620px">Loading specification…</pre>`, { iconName: "code", description: "Generated from your live schema and RPC functions" })}
    </div>
    <div id="local-settings" class="local-panel hidden"><div class="stack">
      <div class="grid-2">
        ${card("Project settings", `<form id="project-settings-form" class="form-stack"><div class="field"><label for="settings-name">Project name</label><input id="settings-name" required minlength="2" /></div><div class="field"><label for="settings-description">Description</label><textarea id="settings-description" rows="3"></textarea></div><div class="field"><label for="settings-status">Status</label><select id="settings-status"><option value="active">Active</option><option value="suspended">Suspended</option><option value="archived">Archived</option></select></div><div class="form-actions"><button class="btn btn-primary" type="submit">${icon("check")}Save changes</button></div></form>`, { iconName: "settings" })}
        ${card("Android application", `<form id="build-apk-form" class="form-stack"><div class="field"><label for="apk-server-url">MARRY BASE server URL</label><input id="apk-server-url" type="url" required /></div><div class="field-row"><div class="field"><label for="apk-version-name">Version name</label><input id="apk-version-name" value="1.0.0" required /></div><div class="field"><label for="apk-version-code">Version code</label><input id="apk-version-code" type="number" min="1" value="1" required /></div></div><p class="muted">Build a signed Android package preconfigured for this project and server.</p><div class="form-actions"><a class="btn btn-secondary" href="/v1/platform/apk/download">${icon("download")}Default APK</a><button class="btn btn-primary" type="submit">${icon("play")}Build project APK</button></div></form><div id="apk-build-result" class="section-gap"></div>`, { iconName: "download" })}
      </div>
      ${card("Danger zone", `<div class="list-row"><div class="list-text"><strong>Delete this project</strong><small>Permanently removes the schema, data, users, functions, and stored objects.</small></div><button class="btn btn-danger-ghost" data-action="delete-project">${icon("trash")}Delete project</button></div>`, { iconName: "alert", className: "danger-zone" })}
    </div></div>`;
}

const templates = { overview: overviewTemplate, database: databaseTemplate, sql: sqlTemplate, migrations: migrationsTemplate, auth: authTemplate, storage: storageTemplate, functions: functionsTemplate, realtime: realtimeTemplate, security: securityTemplate, operations: operationsTemplate };

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
    security: `<button class="btn btn-primary" data-action="focus-create-key">${icon("key")}New API key</button>`,
    operations: `<button class="btn btn-primary" data-action="create-backup-focus">${icon("plus")}New backup</button>`,
  };
  root.innerHTML = `${pageHeader(safeTab, primaryActions[safeTab] || "")}${templates[safeTab]()}`;
}

function isCurrent(tab, version, slug) {
  return state.activeTab === tab && state.requestVersion === version && state.activeProject?.slug === slug;
}

async function loadOverview(version, slug) {
  const base = `/v1/projects/${encodeURIComponent(slug)}`;
  const [details, audit] = await Promise.all([api(base), api(`${base}/audit?limit=6`)]);
  if (!isCurrent("overview", version, slug)) return;
  state.projectDetails = details;
  state.activeProject = details.project;
  state.memberRole = details.memberRole;
  const usage = details.usage || {};
  const project = details.project;
  const environments = details.environments || [];
  const stats = [
    ["Tables", usage.tableCount, "database", "PostgreSQL tables", ""],
    ["Auth users", usage.userCount, "users", "Project identities", "info"],
    ["Storage", formatBytes(usage.storageBytes), "storage", `${formatNumber(usage.storageObjects)} objects`, "gold"],
    ["Functions", usage.functionCount, "function", "Deployed handlers", "purple"],
    ["Queued jobs", usage.queuedJobs, "clock", "Queued or running", "gold"],
  ];
  const checklist = [
    [true, "Project and isolated schema provisioned"],
    [(usage.tableCount || 0) > 0, "Create your first database table"],
    [(usage.userCount || 0) > 0, "Add an application user"],
    [(usage.functionCount || 0) > 0, "Deploy a server function"],
  ];
  const environmentRows = environments.map((environment) => `<div class="list-row"><div class="list-main"><span class="resource-icon">${icon(environment.is_production ? "shield" : "layers")}</span><div class="list-text"><strong>${esc(environment.name)}</strong><small class="mono">${esc(environment.slug)}</small></div></div><div class="list-actions">${badge(environment.is_production ? "production" : "non-prod")}${environments.length > 1 ? `<button class="icon-btn btn-sm" data-action="delete-environment" data-id="${esc(environment.id)}" data-name="${esc(environment.name)}" aria-label="Delete ${esc(environment.name)}">${icon("trash")}</button>` : ""}</div></div>`).join("");
  const auditRows = (audit.events || []).map((event) => `<tr><td><div class="activity-action"><strong>${esc(event.action)}</strong><span class="cell-secondary">${esc(event.actor_type)}</span></div></td><td>${esc(event.resource_type || "—")}</td><td title="${esc(formatDate(event.created_at))}">${esc(timeAgo(event.created_at))}</td></tr>`).join("");
  $("overview-content").innerHTML = `
    <div class="stats-grid">${stats.map(([label, value, iconName, detail, tone]) => `<div class="stat-card"><div class="stat-top"><span>${esc(label)}</span><span class="stat-icon ${esc(tone)}">${icon(iconName)}</span></div><div class="stat-value">${esc(formatNumber(value) === "0" && typeof value !== "number" ? value : (typeof value === "number" ? formatNumber(value) : value ?? 0))}</div><div class="stat-detail">${esc(detail)}</div></div>`).join("")}</div>
    <div class="grid-sidebar">
      <div class="stack">
        ${card("Project identity", `<dl class="definition-list"><div class="definition-row"><dt>Description</dt><dd>${esc(project.description || "No description yet.")}</dd></div><div class="definition-row"><dt>Project slug</dt><dd><span class="code-inline">${esc(project.slug)}</span></dd></div><div class="definition-row"><dt>PostgreSQL schema</dt><dd><span class="code-inline">${esc(project.schema_name)}</span></dd></div><div class="definition-row"><dt>Database role</dt><dd><span class="code-inline">${esc(project.db_role_name)}</span></dd></div><div class="definition-row"><dt>Status</dt><dd>${badge(project.status)}</dd></div><div class="definition-row"><dt>Created</dt><dd>${esc(formatDate(project.created_at))}</dd></div></dl>`, { iconName: "layers", actions: `<button class="icon-btn btn-sm" data-action="copy-text" data-copy="${esc(project.slug)}" aria-label="Copy project slug">${icon("copy")}</button>` })}
        ${card("Quick start", `<div class="code-wrap"><button class="btn btn-sm copy-code" data-action="copy-target" data-target="sdk-snippet">${icon("copy")}Copy</button><pre id="sdk-snippet" class="code-block"></pre></div><div class="notice section-gap">${icon("key")}<p>Create an anon key for client applications under <strong>Security & Team</strong>. Keep the service-role key on trusted servers only.</p></div>`, { iconName: "code", description: "Connect with the fluent TypeScript client" })}
        ${card("Recent project activity", table(["Action", "Resource", "When"], auditRows, "No audit events recorded yet."), { iconName: "clock", flush: true, actions: `<button class="btn btn-ghost btn-sm" data-nav="operations" data-local-target="audit">View all${icon("chevron")}</button>` })}
      </div>
      <div class="stack">
        ${card("Launch checklist", `<div class="checklist">${checklist.map(([done, label]) => `<div class="checklist-item ${done ? "done" : ""}"><span class="checklist-mark">${icon("check")}</span><span>${esc(label)}</span></div>`).join("")}</div><div class="quick-actions section-gap"><button class="quick-action" data-nav="database">${icon("database")}<span><strong>Build schema</strong><small>Tables, rows, and RLS</small></span></button><button class="quick-action" data-nav="functions">${icon("function")}<span><strong>Add logic</strong><small>Functions and jobs</small></span></button><button class="quick-action" data-nav="auth">${icon("users")}<span><strong>Configure auth</strong><small>Users and policies</small></span></button><button class="quick-action" data-nav="security">${icon("key")}<span><strong>Get credentials</strong><small>Scoped project keys</small></span></button></div>`, { iconName: "check" })}
        ${card("Environments", `<div class="list">${environmentRows || emptyState("layers", "No environments", "Create an environment to get started.")}</div><form id="create-env-form" class="form-stack section-gap"><div class="field"><label for="env-name-input">New environment</label><input id="env-name-input" placeholder="qa-testing" required /></div><label class="checkbox-label"><input id="env-production" type="checkbox" />Production environment</label><button class="btn btn-secondary btn-sm" type="submit">${icon("plus")}Add environment</button></form>`, { iconName: "layers" })}
        ${card("API endpoint", `<p class="muted">Base URL for this project’s generated APIs</p><div class="code-wrap section-gap"><button class="btn btn-sm copy-code" data-action="copy-target" data-target="project-endpoint">${icon("copy")}Copy</button><pre id="project-endpoint" class="code-block"></pre></div>`, { iconName: "link" })}
      </div>
    </div>`;
  $("sdk-snippet").textContent = `import { createMaaryClient } from "maary-base/sdk";\n\nconst maary = createMaaryClient(\n  "${window.location.origin}",\n  "<YOUR_ANON_KEY>",\n  { projectRef: "${project.slug}" }\n);\n\nconst { data, error } = await maary\n  .from("todos")\n  .select("*")\n  .order("created_at", { ascending: false });`;
  $("project-endpoint").textContent = `${window.location.origin}/v1/projects/${project.slug}`;
  $("sidebar-project-name").textContent = project.name;
}

export function renderTablesList() {
  const container = $("tables-list");
  if (!container) return;
  const query = ($("table-search")?.value || "").trim().toLowerCase();
  const tables = state.tables.filter((item) => item.name.toLowerCase().includes(query));
  if (!tables.length) {
    container.innerHTML = emptyState("database", query ? "No matching tables" : "Your schema is empty", query ? "Try a different table name." : "Create your first table to start storing application data.");
    return;
  }
  container.innerHTML = `<div class="resource-list">${tables.map((item) => `<div class="resource-item ${state.activeTable === item.name ? "active" : ""}"><div class="list-main"><span class="resource-icon">${icon("database")}</span><div class="list-text"><button class="resource-link" data-action="browse-table" data-table="${esc(item.name)}">${esc(item.name)}</button><small>${formatNumber(item.rowCount)} rows · ${item.columns.length} columns</small></div></div><div class="list-actions"><button class="icon-btn btn-sm" data-action="toggle-table-rls" data-table="${esc(item.name)}" data-enabled="${item.rlsEnabled}" title="${item.rlsEnabled ? "Disable" : "Enable"} RLS" aria-label="${item.rlsEnabled ? "Disable" : "Enable"} RLS for ${esc(item.name)}">${icon(item.rlsEnabled ? "lock" : "unlock")}</button><button class="icon-btn btn-sm" data-action="drop-table" data-table="${esc(item.name)}" title="Drop table" aria-label="Drop ${esc(item.name)}">${icon("trash")}</button></div></div>`).join("")}</div>`;
}

async function loadDatabase(version, slug) {
  const response = await api(`/v1/projects/${encodeURIComponent(slug)}/database/tables`);
  if (!isCurrent("database", version, slug)) return;
  state.tables = response.tables || [];
  if (!state.tables.some((item) => item.name === state.activeTable)) state.activeTable = state.tables[0]?.name || null;
  renderTablesList();
  if (state.activeTable) await browseTable(state.activeTable, version); else {
    $("active-table-label").textContent = "";
    $("active-table-details").textContent = "Create a table to begin inserting rows.";
    $("table-rows-container").innerHTML = emptyState("database", "No tables yet", "Your table data will appear here.");
  }
}

export async function browseTable(tableName, knownVersion = null) {
  if (!tableName || !state.activeProject) return;
  const slug = state.activeProject.slug;
  const version = knownVersion ?? state.requestVersion;
  state.activeTable = tableName;
  if ($("active-table-label")) $("active-table-label").textContent = `· ${tableName}`;
  if ($("table-rows-container")) $("table-rows-container").innerHTML = loadingState("Loading rows…");
  renderTablesList();
  try {
    const response = await api(`/v1/projects/${encodeURIComponent(slug)}/rest/${encodeURIComponent(tableName)}?limit=100`);
    if (state.activeProject?.slug !== slug || state.activeTable !== tableName || state.requestVersion !== version) return;
    const tableInfo = state.tables.find((item) => item.name === tableName);
    if ($("active-table-details")) $("active-table-details").textContent = tableInfo ? `${tableInfo.columns.length} columns · ${tableInfo.rlsEnabled ? "RLS enabled" : "RLS disabled"} · first 100 rows` : "First 100 rows";
    const rows = response.data || [];
    if (!rows.length) {
      $("table-rows-container").innerHTML = emptyState("file", "This table is empty", "Insert a JSON row above or use the generated REST API.");
      return;
    }
    const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
    const body = rows.map((row) => `<tr>${columns.map((column) => `<td>${formatCell(row[column])}</td>`).join("")}</tr>`).join("");
    $("table-rows-container").innerHTML = table(columns, body);
  } catch (error) {
    if ($("table-rows-container")) $("table-rows-container").innerHTML = errorState(error, "refresh-rows");
  }
}

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

async function loadSql(version, slug) {
  const response = await api(`/v1/projects/${encodeURIComponent(slug)}/database/tables`);
  if (!isCurrent("sql", version, slug)) return;
  state.tables = response.tables || [];
  renderPolicies();
}

async function loadMigrations(version, slug) {
  const response = await api(`/v1/projects/${encodeURIComponent(slug)}/database/migrations`);
  if (!isCurrent("migrations", version, slug)) return;
  const migrations = response.migrations || [];
  $("migrations-list").innerHTML = migrations.length ? table(["Version", "Migration", "Status", "Applied", ""], migrations.map((migration) => `<tr><td><span class="code-inline">${esc(migration.version)}</span></td><td><strong>${esc(migration.name)}</strong><span class="cell-secondary mono" title="${esc(migration.checksum)}">${esc(truncate(migration.checksum, 14))}</span></td><td>${badge(migration.status)}</td><td>${esc(formatDate(migration.applied_at || migration.created_at))}</td><td><div class="cell-actions">${migration.status === "applied" && migration.down_sql ? `<button class="btn btn-secondary btn-sm" data-action="rollback-migration" data-version="${esc(migration.version)}" data-name="${esc(migration.name)}">Rollback</button>` : ""}</div></td></tr>`).join("")) : emptyState("layers", "No migrations yet", "Apply a versioned migration to build a repeatable schema history.");
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
  if (config) {
    $("cfg-public-signup").value = String(config.allow_public_signup);
    $("cfg-email-verify").value = String(config.require_email_verification);
    $("cfg-pass-len").value = config.password_min_length;
    $("cfg-access-ttl").value = config.access_token_ttl_seconds;
    $("cfg-refresh-ttl").value = config.refresh_token_ttl_seconds;
  }
}

function renderBuckets() {
  const container = $("buckets-list");
  if (!container) return;
  if (!state.buckets.length) {
    container.innerHTML = emptyState("storage", "No buckets yet", "Create a private or public bucket to start uploading objects.");
    return;
  }
  container.innerHTML = `<div class="resource-list">${state.buckets.map((bucket) => `<div class="resource-item ${state.activeBucket === bucket.name ? "active" : ""}"><div class="list-main"><span class="resource-icon">${icon(bucket.public ? "unlock" : "lock")}</span><div class="list-text"><button class="resource-link" data-action="open-bucket" data-bucket="${esc(bucket.name)}">${esc(bucket.name)}</button><small>${formatNumber(bucket.object_count)} objects · ${formatBytes(bucket.used_bytes)}</small></div></div><div class="list-actions">${badge(bucket.public ? "public" : "private", bucket.public ? "warning" : "success")}<button class="icon-btn btn-sm" data-action="toggle-bucket-visibility" data-bucket="${esc(bucket.name)}" data-public="${bucket.public}" title="Toggle visibility" aria-label="Toggle ${esc(bucket.name)} visibility">${icon("refresh")}</button><button class="icon-btn btn-sm" data-action="delete-bucket" data-bucket="${esc(bucket.name)}" aria-label="Delete ${esc(bucket.name)}">${icon("trash")}</button></div></div>`).join("")}</div>`;
}

async function loadStorage(version, slug) {
  const response = await api(`/v1/projects/${encodeURIComponent(slug)}/storage/buckets`);
  if (!isCurrent("storage", version, slug)) return;
  state.buckets = response.buckets || [];
  if (!state.buckets.some((bucket) => bucket.name === state.activeBucket)) state.activeBucket = state.buckets[0]?.name || null;
  renderBuckets();
  if (state.activeBucket) await openBucket(state.activeBucket, version); else {
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

async function loadFunctions(version, slug) {
  const base = `/v1/projects/${encodeURIComponent(slug)}`;
  const statusFilter = encodeURIComponent($("job-status-filter")?.value || "");
  const [functionsResponse, jobsResponse, schedulesResponse] = await Promise.all([
    api(`${base}/functions`), api(`${base}/jobs?limit=100${statusFilter ? `&status=${statusFilter}` : ""}`), api(`${base}/schedules`),
  ]);
  if (!isCurrent("functions", version, slug)) return;
  state.functions = functionsResponse.functions || [];
  const functions = state.functions;
  $("functions-list").innerHTML = functions.length ? table(["Function", "Version", "Access", "Timeout", ""], functions.map((fn) => `<tr><td><div class="cell-primary"><span class="resource-icon">${icon("function")}</span><div><strong>${esc(fn.name || fn.slug)}</strong><span class="cell-secondary mono">${esc(fn.slug)}</span></div></div></td><td>v${formatNumber(fn.version)}</td><td>${badge(fn.verify_jwt ? "JWT required" : "public", fn.verify_jwt ? "success" : "warning")}</td><td>${formatNumber(fn.timeout_ms)} ms</td><td><div class="cell-actions"><button class="btn btn-secondary btn-sm" data-action="edit-function" data-slug="${esc(fn.slug)}">Edit</button><button class="icon-btn btn-sm" data-action="delete-function" data-slug="${esc(fn.slug)}" aria-label="Delete ${esc(fn.slug)}">${icon("trash")}</button></div></td></tr>`).join("")) : emptyState("function", "No functions deployed", "Deploy the example handler or replace it with your own business logic.");
  const select = $("fn-invoke-slug");
  if (select) {
    select.innerHTML = functions.length ? functions.map((fn) => `<option value="${esc(fn.slug)}">${esc(fn.slug)} · v${formatNumber(fn.version)}</option>`).join("") : `<option value="">Deploy a function first</option>`;
  }
  const jobs = jobsResponse.jobs || [];
  $("jobs-list").innerHTML = jobs.length ? table(["Job", "Queue", "Status", "Attempts", "Run at", ""], jobs.map((job) => `<tr><td><strong>${esc(job.job_type)}</strong><span class="cell-secondary mono">${esc(job.id)}</span>${job.last_error ? `<span class="cell-secondary text-danger">${esc(truncate(job.last_error, 80))}</span>` : ""}</td><td>${esc(job.queue_name)}</td><td>${badge(job.status)}</td><td>${formatNumber(job.attempts)} / ${formatNumber(job.max_attempts)}</td><td title="${esc(formatDate(job.run_at))}">${esc(timeAgo(job.run_at))}</td><td><div class="cell-actions">${["queued", "failed"].includes(job.status) ? `<button class="btn btn-secondary btn-sm" data-action="cancel-job" data-id="${esc(job.id)}">Cancel</button>` : ""}</div></td></tr>`).join("")) : emptyState("clock", "No jobs found", "Enqueue a job or adjust the status filter.");
  const schedules = schedulesResponse.schedules || [];
  $("schedules-list").innerHTML = schedules.length ? table(["Schedule", "Type", "Interval", "Next run", "Status", ""], schedules.map((schedule) => `<tr><td><strong>${esc(schedule.name)}</strong><span class="cell-secondary">${esc(schedule.target_slug || "No function target")}</span></td><td>${esc(schedule.job_type)}</td><td>Every ${formatNumber(schedule.interval_seconds)}s</td><td title="${esc(formatDate(schedule.next_run_at))}">${esc(timeAgo(schedule.next_run_at))}</td><td>${badge(schedule.enabled ? "enabled" : "disabled")}</td><td><div class="cell-actions"><button class="icon-btn btn-sm" data-action="delete-schedule" data-id="${esc(schedule.id)}" data-name="${esc(schedule.name)}" aria-label="Delete ${esc(schedule.name)}">${icon("trash")}</button></div></td></tr>`).join("")) : emptyState("clock", "No schedules", "Create a recurring schedule to automate function or maintenance jobs.");
}

async function loadRealtime(version, slug) {
  const base = `/v1/projects/${encodeURIComponent(slug)}`;
  const [status, eventsResponse, channelsResponse] = await Promise.all([
    api(`${base}/realtime/status`), api(`${base}/realtime/events?limit=50`), api(`${base}/realtime/channels`),
  ]);
  if (!isCurrent("realtime", version, slug)) return;
  const stats = [
    ["Connections", status.connectedClients ?? status.connected_clients ?? 0, "realtime", "Active WebSocket clients", ""],
    ["Subscriptions", status.subscriptions ?? 0, "link", "Active topic subscriptions", "info"],
    ["Delivery", "At least once", "check", "Within retention window", "gold"],
  ];
  $("realtime-status-cards").innerHTML = `<div class="stats-grid" style="grid-template-columns:repeat(3,minmax(0,1fr))">${stats.map(([label, value, iconName, detail, tone]) => `<div class="stat-card"><div class="stat-top"><span>${esc(label)}</span><span class="stat-icon ${esc(tone)}">${icon(iconName)}</span></div><div class="stat-value">${esc(value)}</div><div class="stat-detail">${esc(detail)}</div></div>`).join("")}</div>`;
  const events = eventsResponse.events || [];
  $("rt-events-table").innerHTML = events.length ? table(["Event", "Topic", "Time"], events.map((event) => `<tr><td><strong>${esc(event.operation || event.event_type)}</strong><span class="cell-secondary">${esc(event.table_name || event.payload?.event || "broadcast")}</span></td><td><span class="code-inline">${esc(event.channel_topic)}</span></td><td title="${esc(formatDate(event.created_at))}">${esc(timeAgo(event.created_at))}</td></tr>`).join("")) : emptyState("realtime", "No persisted events", "Database changes and broadcasts will be recorded here.");
  const channels = channelsResponse.channels || [];
  $("rt-channels-list").innerHTML = channels.length ? `<div class="list">${channels.map((channel) => `<div class="list-row"><div class="list-main"><span class="resource-icon">${icon("realtime")}</span><div class="list-text"><strong>${esc(channel.topic)}</strong><small>${channel.is_private ? "Private channel" : "Public channel"}</small></div></div>${badge(channel.is_private ? "private" : "public", channel.is_private ? "warning" : "success")}</div>`).join("")}</div>` : emptyState("realtime", "No configured channels", "Subscribe to a topic to create an ad-hoc realtime channel.");
}

async function loadSecurity(version, slug) {
  const base = `/v1/projects/${encodeURIComponent(slug)}`;
  const [keysResponse, secretsResponse, membersResponse] = await Promise.all([
    api(`${base}/api-keys`), api(`${base}/secrets?reveal=${state.revealSecrets}`), api(`${base}/members`),
  ]);
  if (!isCurrent("security", version, slug)) return;
  const keys = keysResponse.apiKeys || [];
  $("api-keys-list").innerHTML = keys.length ? table(["Name", "Role", "Key prefix", "Scopes", "Status", "Last used", ""], keys.map((key) => `<tr><td><strong>${esc(key.name)}</strong><span class="cell-secondary">${esc(formatDate(key.created_at, false))}</span></td><td>${badge(key.role, key.role === "service_role" ? "danger" : "info")}</td><td><span class="code-inline">${esc(key.key_prefix)}…</span></td><td><span class="cell-truncate" title="${esc((key.scopes || []).join(", "))}">${esc((key.scopes || []).join(", ") || "—")}</span></td><td>${badge(key.revoked_at ? "revoked" : "active")}</td><td>${esc(timeAgo(key.last_used_at))}</td><td><div class="cell-actions">${!key.revoked_at ? `<button class="btn btn-secondary btn-sm" data-action="rotate-key" data-id="${esc(key.id)}" data-name="${esc(key.name)}">Rotate</button><button class="icon-btn btn-sm" data-action="revoke-key" data-id="${esc(key.id)}" data-name="${esc(key.name)}" aria-label="Revoke ${esc(key.name)}">${icon("trash")}</button>` : ""}</div></td></tr>`).join("")) : emptyState("key", "No API keys", "Generate a scoped key to connect an application or backend worker.");
  const secrets = secretsResponse.secrets || [];
  $("secrets-list").innerHTML = secrets.length ? table(["Name", "Value", "Version", "Updated", ""], secrets.map((secret) => `<tr><td><strong class="mono">${esc(secret.name)}</strong><span class="cell-secondary">${esc(secret.description || "No description")}</span></td><td><span class="code-inline secret-value">${esc(secret.decrypted_value ?? secret.masked_value)}</span></td><td>v${formatNumber(secret.version)}</td><td title="${esc(formatDate(secret.updated_at))}">${esc(timeAgo(secret.updated_at))}</td><td><div class="cell-actions">${state.revealSecrets && secret.decrypted_value ? `<button class="icon-btn btn-sm" data-action="copy-text" data-copy="${esc(secret.decrypted_value)}" aria-label="Copy ${esc(secret.name)}">${icon("copy")}</button>` : ""}<button class="icon-btn btn-sm" data-action="delete-secret" data-id="${esc(secret.id)}" data-name="${esc(secret.name)}" aria-label="Delete ${esc(secret.name)}">${icon("trash")}</button></div></td></tr>`).join("")) : emptyState("lock", "No secrets stored", "Add environment credentials for functions and backend integrations.");
  if ($("secret-toggle-label")) $("secret-toggle-label").textContent = state.revealSecrets ? "Hide values" : "Reveal values";
  const members = membersResponse.members || [];
  $("members-list").innerHTML = members.length ? table(["Member", "Role", "Permissions", "Joined", ""], members.map((member) => `<tr><td><div class="cell-primary"><span class="avatar">${esc((member.name || member.email || "U").slice(0, 1).toUpperCase())}</span><div><strong>${esc(member.name || member.email)}</strong><span class="cell-secondary">${esc(member.email)}</span></div></div></td><td>${badge(member.role, member.role === "owner" ? "purple" : "info")}</td><td>${esc((member.permissions || []).join(", ") || "Role defaults")}</td><td>${esc(formatDate(member.created_at, false))}</td><td><div class="cell-actions">${member.user_id !== state.user?.id ? `<button class="icon-btn btn-sm" data-action="remove-member" data-user="${esc(member.user_id)}" data-email="${esc(member.email)}" aria-label="Remove ${esc(member.email)}">${icon("trash")}</button>` : `<span class="subtle">You</span>`}</div></td></tr>`).join("")) : emptyState("users", "No team members", "Add an existing platform operator to collaborate on this project.");
}

async function loadOperations(version, slug) {
  const base = `/v1/projects/${encodeURIComponent(slug)}`;
  const auditFilter = encodeURIComponent($("audit-action-filter")?.value?.trim() || "");
  const [backupsResponse, auditResponse, openapi] = await Promise.all([
    api(`${base}/backups`), api(`${base}/audit?limit=100${auditFilter ? `&action=${auditFilter}` : ""}`), api(`${base}/openapi.json`),
  ]);
  if (!isCurrent("operations", version, slug)) return;
  const backups = backupsResponse.backups || [];
  $("backups-list").innerHTML = backups.length ? table(["Snapshot", "Size", "Integrity", "Created", "Status", ""], backups.map((backup) => `<tr><td><strong>${esc(backup.name)}</strong><span class="cell-secondary mono">${esc(backup.id)}</span></td><td>${esc(formatBytes(backup.size_bytes))}</td><td><span class="code-inline" title="${esc(backup.checksum_sha256)}">${esc(truncate(backup.checksum_sha256, 12))}</span></td><td>${esc(formatDate(backup.created_at))}</td><td>${badge(backup.status)}</td><td><div class="cell-actions"><button class="btn btn-secondary btn-sm" data-action="verify-backup" data-id="${esc(backup.id)}" data-name="${esc(backup.name)}">Verify</button><button class="btn btn-danger-ghost btn-sm" data-action="restore-backup" data-id="${esc(backup.id)}" data-name="${esc(backup.name)}">Restore</button></div></td></tr>`).join("")) : emptyState("storage", "No backups yet", "Create a logical snapshot before major schema or data changes.");
  const events = auditResponse.events || [];
  $("audit-events-list").innerHTML = events.length ? table(["Timestamp", "Action", "Actor", "Resource"], events.map((event) => `<tr><td title="${esc(formatDate(event.created_at))}">${esc(formatDate(event.created_at))}</td><td><span class="code-inline">${esc(event.action)}</span></td><td>${esc(event.actor_type)}<span class="cell-secondary mono">${esc(truncate(event.actor_id || "system", 18))}</span></td><td>${esc(event.resource_type || "—")}<span class="cell-secondary mono">${esc(truncate(event.resource_id || "", 18))}</span></td></tr>`).join("")) : emptyState("shield", "No audit events", "Project security and operational activity will appear here.");
  window.__maaryOpenApi = openapi;
  $("openapi-preview").textContent = JSON.stringify(openapi, null, 2);
  $("openapi-link").href = `${base}/openapi.json`;
  const project = state.activeProject;
  $("settings-name").value = project.name || "";
  $("settings-description").value = project.description || "";
  $("settings-status").value = project.status || "active";
  $("apk-server-url").value = window.location.origin;
}

const loaders = { overview: loadOverview, database: loadDatabase, sql: loadSql, migrations: loadMigrations, auth: loadAuth, storage: loadStorage, functions: loadFunctions, realtime: loadRealtime, security: loadSecurity, operations: loadOperations };

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
