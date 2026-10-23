import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { FastifyInstance } from "fastify";

const DASHBOARD_CSS = `
:root {
  --bg: #0b0f17;
  --bg-panel: #111827;
  --bg-card: #1f2937;
  --bg-input: #0f172a;
  --border: #334155;
  --text: #f8fafc;
  --text-muted: #94a3b8;
  --primary: #10b981;
  --primary-hover: #059669;
  --danger: #ef4444;
  --warn: #f59e0b;
  --info: #3b82f6;
  --font: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  background: var(--bg);
  color: var(--text);
  font-family: var(--font);
  font-size: 14px;
  line-height: 1.5;
  min-height: 100vh;
}
header.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 24px;
  background: var(--bg-panel);
  border-bottom: 1px solid var(--border);
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  font-weight: 700;
  font-size: 16px;
  letter-spacing: 0.4px;
}
.brand-badge {
  background: var(--primary);
  color: #042f2e;
  font-weight: 800;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 12px;
}
.topbar-controls {
  display: flex;
  align-items: center;
  gap: 12px;
}
.layout {
  display: grid;
  grid-template-columns: 230px 1fr;
  min-height: calc(100vh - 57px);
}
aside.sidebar {
  background: var(--bg-panel);
  border-right: 1px solid var(--border);
  padding: 16px 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.nav-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  text-align: left;
  background: transparent;
  color: var(--text-muted);
  border: none;
  padding: 9px 12px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13.5px;
  font-weight: 500;
}
.nav-btn:hover { background: rgba(255,255,255,0.05); color: var(--text); }
.nav-btn.active { background: rgba(16,185,129,0.15); color: var(--primary); font-weight: 600; }
main.content {
  padding: 24px;
  overflow-y: auto;
  max-width: 1400px;
}
.card {
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 18px;
  margin-bottom: 18px;
}
.card h2, .card h3 {
  margin-bottom: 12px;
  font-size: 16px;
}
.grid-4 {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: 14px;
  margin-bottom: 18px;
}
.grid-2 {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(380px, 1fr));
  gap: 18px;
}
.stat-box {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 14px 16px;
}
.stat-label { color: var(--text-muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; }
.stat-value { font-size: 24px; font-weight: 700; margin-top: 4px; color: var(--primary); }
input, select, textarea {
  background: var(--bg-input);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px 11px;
  font-size: 13.5px;
  font-family: inherit;
  width: 100%;
}
textarea.code {
  font-family: var(--mono);
  font-size: 12.5px;
  min-height: 130px;
}
button.btn {
  background: var(--primary);
  color: #022c22;
  font-weight: 600;
  border: none;
  border-radius: 6px;
  padding: 8px 14px;
  cursor: pointer;
  font-size: 13px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
button.btn:hover { background: var(--primary-hover); }
button.btn-secondary {
  background: var(--bg-card);
  color: var(--text);
  border: 1px solid var(--border);
}
button.btn-danger {
  background: var(--danger);
  color: #fff;
}
.form-row {
  display: flex;
  gap: 10px;
  margin-bottom: 10px;
  align-items: flex-end;
}
.form-group {
  flex: 1;
  margin-bottom: 10px;
}
.form-group label {
  display: block;
  font-size: 12px;
  color: var(--text-muted);
  margin-bottom: 4px;
}
table.data-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
table.data-table th, table.data-table td {
  border-bottom: 1px solid var(--border);
  padding: 8px 10px;
  text-align: left;
}
table.data-table th {
  color: var(--text-muted);
  font-weight: 600;
  background: rgba(0,0,0,0.2);
}
.badge {
  display: inline-block;
  padding: 2px 7px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  background: var(--bg-card);
  border: 1px solid var(--border);
}
.badge-green { background: rgba(16,185,129,0.15); color: #34d399; border-color: rgba(16,185,129,0.4); }
.badge-warn { background: rgba(245,158,11,0.15); color: #fbbf24; border-color: rgba(245,158,11,0.4); }
.badge-danger { background: rgba(239,68,68,0.15); color: #f87171; border-color: rgba(239,68,68,0.4); }
pre.code-block {
  background: #090d16;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 12px;
  font-family: var(--mono);
  font-size: 12px;
  overflow-x: auto;
  white-space: pre-wrap;
}
.toast-banner {
  padding: 10px 16px;
  border-radius: 6px;
  margin-bottom: 16px;
  font-size: 13px;
  display: none;
}
.toast-banner.show { display: block; }
.toast-banner.error { background: rgba(239,68,68,0.18); border: 1px solid var(--danger); color: #fca5a5; }
.toast-banner.success { background: rgba(16,185,129,0.18); border: 1px solid var(--primary); color: #6ee7b7; }
.auth-container {
  max-width: 440px;
  margin: 60px auto;
}
.hidden { display: none !important; }
`;

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>MARRY BASE — Platform Management Studio</title>
  <link rel="icon" type="image/png" href="/v1/platform/logo" />
  <link rel="stylesheet" href="/dashboard/styles.css" />
</head>
<body>
  <header class="topbar">
    <div class="brand">
      <img src="/v1/platform/logo" alt="MARRY BASE Logo" style="width:32px;height:32px;border-radius:6px;border:1px solid rgba(16,185,129,0.5);" />
      <span class="brand-badge">MARRY BASE</span>
      <span>Backend Platform Studio</span>
      <span id="health-pill" class="badge badge-green">Checking...</span>
      <a href="/v1/platform/apk/download" class="btn btn-secondary" style="text-decoration:none;padding:4px 10px;font-size:12px;">Download Android APK</a>
    </div>
    <div id="topbar-authenticated" class="topbar-controls hidden">
      <select id="project-select" style="width: 220px;" title="Select active project"></select>
      <button id="btn-new-project" class="btn btn-secondary">+ New Project</button>
      <span id="current-user-label" class="badge"></span>
      <button id="btn-logout" class="btn btn-secondary">Sign Out</button>
    </div>
  </header>

  <div id="auth-view" class="auth-container hidden">
    <div class="card">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:10px;">
        <img src="/v1/platform/logo" alt="MARRY BASE Logo" style="width:48px;height:48px;border-radius:10px;border:1px solid rgba(16,185,129,0.5);" />
        <h2 id="auth-title" style="margin-bottom:0;">Sign in to MARRY BASE Control Plane</h2>
      </div>
      <p style="color: var(--text-muted); margin-bottom: 14px; font-size: 13px;">
        First registered operator automatically receives platform superadmin privileges.
      </p>
      <div id="auth-feedback" class="toast-banner"></div>
      <form id="auth-form">
        <div class="form-group" id="auth-name-group">
          <label for="auth-name">Operator Name</label>
          <input id="auth-name" type="text" placeholder="Jane Doe" />
        </div>
        <div class="form-group">
          <label for="auth-email">Email Address</label>
          <input id="auth-email" type="email" required placeholder="admin@example.com" />
        </div>
        <div class="form-group">
          <label for="auth-password">Password (min 8 chars)</label>
          <input id="auth-password" type="password" required minlength="8" placeholder="••••••••" />
        </div>
        <div class="form-row" style="margin-top: 14px;">
          <button type="submit" class="btn" id="auth-submit-btn">Register / Sign In</button>
          <button type="button" class="btn btn-secondary" id="auth-toggle-mode">Switch to Login</button>
        </div>
      </form>
    </div>
  </div>

  <div id="studio-view" class="layout hidden">
    <aside class="sidebar">
      <button class="nav-btn active" data-tab="overview">Overview & Status</button>
      <button class="nav-btn" data-tab="database">Database & Tables</button>
      <button class="nav-btn" data-tab="sql">SQL Editor & RLS</button>
      <button class="nav-btn" data-tab="migrations">Migrations</button>
      <button class="nav-btn" data-tab="auth">Authentication & Users</button>
      <button class="nav-btn" data-tab="storage">Object Storage</button>
      <button class="nav-btn" data-tab="functions">Functions & Jobs</button>
      <button class="nav-btn" data-tab="realtime">Realtime Inspector</button>
      <button class="nav-btn" data-tab="security">API Keys, Secrets & RBAC</button>
      <button class="nav-btn" data-tab="operations">Backups, Audit & OpenAPI</button>
    </aside>

    <main class="content">
      <div id="global-toast" class="toast-banner"></div>

      <!-- Create Project Modal Card -->
      <div id="new-project-card" class="card hidden">
        <h3>Create Independent Project</h3>
        <form id="create-project-form" class="form-row">
          <div class="form-group">
            <label>Project Name</label>
            <input id="proj-name" required placeholder="Acme Production API" />
          </div>
          <div class="form-group">
            <label>Slug (optional)</label>
            <input id="proj-slug" placeholder="acme-api" />
          </div>
          <div class="form-group">
            <label>Description</label>
            <input id="proj-desc" placeholder="Core backend services" />
          </div>
          <button type="submit" class="btn">Create Project</button>
          <button type="button" id="btn-cancel-project" class="btn btn-secondary">Cancel</button>
        </form>
      </div>

      <!-- TAB: OVERVIEW -->
      <section id="tab-overview" class="tab-panel">
        <div class="grid-4" id="overview-stats"></div>
        <div class="grid-2">
          <div class="card">
            <h3>Project Identity & Isolation</h3>
            <div id="project-meta-box">Select or create a project to begin.</div>
          </div>
          <div class="card">
            <h3>Environments</h3>
            <div id="environments-list"></div>
            <form id="create-env-form" class="form-row" style="margin-top: 12px;">
              <div class="form-group">
                <label>New Environment Name</label>
                <input id="env-name-input" placeholder="qa-testing" required />
              </div>
              <button type="submit" class="btn btn-secondary">Add Environment</button>
            </form>
          </div>
        </div>
        <div class="card">
          <h3>Quick-Start Client SDK Example</h3>
          <pre id="sdk-snippet" class="code-block"></pre>
        </div>
      </section>

      <!-- TAB: DATABASE & TABLES -->
      <section id="tab-database" class="tab-panel hidden">
        <div class="grid-2">
          <div class="card">
            <h3>Create Table in Isolated Schema</h3>
            <form id="create-table-form">
              <div class="form-row">
                <div class="form-group">
                  <label>Table Name</label>
                  <input id="tbl-name" placeholder="todos" required />
                </div>
                <div class="form-group">
                  <label>Row-Level Security</label>
                  <select id="tbl-rls">
                    <option value="true">Enable & Force RLS</option>
                    <option value="false">Disabled initially</option>
                  </select>
                </div>
              </div>
              <div class="form-group">
                <label>Columns JSON Definition</label>
                <textarea id="tbl-cols" class="code">[
  { "name": "id", "type": "uuid", "primaryKey": true, "defaultValue": "gen_random_uuid()" },
  { "name": "title", "type": "text", "notNull": true },
  { "name": "completed", "type": "boolean", "defaultValue": "false" },
  { "name": "created_at", "type": "timestamptz", "defaultValue": "now()" }
]</textarea>
              </div>
              <button type="submit" class="btn">Create Table</button>
            </form>
          </div>
          <div class="card">
            <h3>Schema Tables & Row Inspector</h3>
            <div id="tables-list"></div>
          </div>
        </div>
        <div class="card">
          <h3>Table Data Browser (<span id="active-table-label">none</span>)</h3>
          <div class="form-row">
            <input id="row-json-input" placeholder='{"title": "Ship MAARY BASE"}' />
            <button id="btn-insert-row" class="btn">Insert Row via REST API</button>
            <button id="btn-refresh-rows" class="btn btn-secondary">Refresh Rows</button>
          </div>
          <div id="table-rows-container"></div>
        </div>
      </section>

      <!-- TAB: SQL & RLS -->
      <section id="tab-sql" class="tab-panel hidden">
        <div class="card">
          <h3>Interactive Project SQL Editor</h3>
          <div class="form-row">
            <div class="form-group" style="flex: 2;">
              <label>Execution Role Context</label>
              <select id="sql-role-select">
                <option value="service_role">service_role (Admin / Bypass RLS)</option>
                <option value="authenticated">authenticated (Enforce Postgres RLS)</option>
                <option value="anon">anon (Enforce Postgres RLS as anonymous)</option>
              </select>
            </div>
            <div class="form-group" style="flex: 2;">
              <label>Impersonate User UUID (auth.uid())</label>
              <input id="sql-user-id" placeholder="Optional UUID for testing RLS policies" />
            </div>
            <div class="form-group">
              <label>Allow Destructive DDL</label>
              <select id="sql-destructive">
                <option value="false">Safeguard ON</option>
                <option value="true">Allow DROP/TRUNCATE</option>
              </select>
            </div>
          </div>
          <textarea id="sql-editor-input" class="code">SELECT current_schema(), auth.role() AS current_role, auth.uid() AS current_uid;</textarea>
          <div style="margin-top: 10px;">
            <button id="btn-run-sql" class="btn">Run SQL Query</button>
          </div>
          <div id="sql-result-box" style="margin-top: 14px;"></div>
        </div>

        <div class="card">
          <h3>Row-Level Security (RLS) Policy Manager</h3>
          <form id="create-policy-form" class="form-row">
            <div class="form-group">
              <label>Table Name</label>
              <input id="pol-table" placeholder="todos" required />
            </div>
            <div class="form-group">
              <label>Policy Name</label>
              <input id="pol-name" placeholder="users_own_rows" required />
            </div>
            <div class="form-group">
              <label>Command</label>
              <select id="pol-cmd">
                <option value="ALL">ALL</option>
                <option value="SELECT">SELECT</option>
                <option value="INSERT">INSERT</option>
                <option value="UPDATE">UPDATE</option>
                <option value="DELETE">DELETE</option>
              </select>
            </div>
            <div class="form-group" style="flex: 2;">
              <label>USING Expression</label>
              <input id="pol-using" placeholder="user_id = auth.uid()" required />
            </div>
            <button type="submit" class="btn">Create Policy</button>
          </form>
          <div id="rls-policies-list"></div>
        </div>
      </section>

      <!-- TAB: MIGRATIONS -->
      <section id="tab-migrations" class="tab-panel hidden">
        <div class="grid-2">
          <div class="card">
            <h3>Apply Versioned Project Migration</h3>
            <form id="apply-migration-form">
              <div class="form-row">
                <div class="form-group">
                  <label>Version</label>
                  <input id="mig-version" placeholder="001" required />
                </div>
                <div class="form-group">
                  <label>Migration Name</label>
                  <input id="mig-name" placeholder="create_profiles_table" required />
                </div>
              </div>
              <div class="form-group">
                <label>Up SQL</label>
                <textarea id="mig-up" class="code" required>CREATE TABLE IF NOT EXISTS profiles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bio text);</textarea>
              </div>
              <div class="form-group">
                <label>Down Rollback SQL</label>
                <textarea id="mig-down" class="code" style="min-height: 70px;">DROP TABLE IF EXISTS profiles;</textarea>
              </div>
              <button type="submit" class="btn">Apply Migration</button>
            </form>
          </div>
          <div class="card">
            <h3>Applied Project Migrations</h3>
            <div id="migrations-list"></div>
          </div>
        </div>
      </section>

      <!-- TAB: AUTH & USERS -->
      <section id="tab-auth" class="tab-panel hidden">
        <div class="grid-2">
          <div class="card">
            <h3>Project End-Users</h3>
            <form id="admin-create-user-form" class="form-row">
              <div class="form-group">
                <label>User Email</label>
                <input id="u-email" type="email" placeholder="user@app.io" required />
              </div>
              <div class="form-group">
                <label>Password</label>
                <input id="u-pass" type="password" placeholder="Password123!" required />
              </div>
              <button type="submit" class="btn">Create User</button>
            </form>
            <div id="project-users-list"></div>
          </div>
          <div class="card">
            <h3>Authentication Policy Settings</h3>
            <form id="auth-config-form">
              <div class="form-group">
                <label>Allow Public Signup</label>
                <select id="cfg-public-signup">
                  <option value="true">Enabled</option>
                  <option value="false">Disabled (Invite/Admin only)</option>
                </select>
              </div>
              <div class="form-group">
                <label>Require Email Verification</label>
                <select id="cfg-email-verify">
                  <option value="false">Not required</option>
                  <option value="true">Required before login</option>
                </select>
              </div>
              <div class="form-row">
                <div class="form-group">
                  <label>Minimum Password Length</label>
                  <input id="cfg-pass-len" type="number" min="6" max="128" value="8" />
                </div>
                <div class="form-group">
                  <label>Access Token TTL (seconds)</label>
                  <input id="cfg-access-ttl" type="number" min="60" value="3600" />
                </div>
              </div>
              <button type="submit" class="btn">Save Auth Settings</button>
            </form>
          </div>
        </div>
      </section>

      <!-- TAB: STORAGE -->
      <section id="tab-storage" class="tab-panel hidden">
        <div class="grid-2">
          <div class="card">
            <h3>Storage Buckets</h3>
            <form id="create-bucket-form" class="form-row">
              <div class="form-group">
                <label>Bucket Name</label>
                <input id="bucket-name" placeholder="avatars" required />
              </div>
              <div class="form-group">
                <label>Visibility</label>
                <select id="bucket-public">
                  <option value="true">Public (read allowed)</option>
                  <option value="false">Private (policy/signed URL required)</option>
                </select>
              </div>
              <button type="submit" class="btn">Create Bucket</button>
            </form>
            <div id="buckets-list"></div>
          </div>
          <div class="card">
            <h3>Upload & Browse Files (<span id="active-bucket-label">none</span>)</h3>
            <form id="upload-object-form">
              <div class="form-row">
                <div class="form-group">
                  <label>Object Path</label>
                  <input id="obj-path" placeholder="docs/readme.txt" required />
                </div>
                <div class="form-group">
                  <label>MIME Type</label>
                  <input id="obj-mime" value="text/plain" />
                </div>
              </div>
              <div class="form-group">
                <label>Text Content</label>
                <textarea id="obj-content" class="code" style="min-height: 75px;">Hello from MAARY BASE Storage!</textarea>
              </div>
              <button type="submit" class="btn">Upload Object</button>
            </form>
            <div id="bucket-objects-list" style="margin-top: 14px;"></div>
          </div>
        </div>
      </section>

      <!-- TAB: FUNCTIONS & JOBS -->
      <section id="tab-functions" class="tab-panel hidden">
        <div class="grid-2">
          <div class="card">
            <h3>Deploy Isolated Server Function</h3>
            <form id="deploy-fn-form">
              <div class="form-row">
                <div class="form-group">
                  <label>Function Slug</label>
                  <input id="fn-slug" placeholder="hello-world" required />
                </div>
                <div class="form-group">
                  <label>Require JWT</label>
                  <select id="fn-jwt">
                    <option value="true">Require Auth</option>
                    <option value="false">Public Endpoint</option>
                  </select>
                </div>
              </div>
              <div class="form-group">
                <label>Handler Code (Sandboxed VM Runtime)</label>
                <textarea id="fn-code" class="code">async function handler(ctx) {
  console.log("Invoked by role:", ctx.auth.role);
  const dbRes = await ctx.db.query("SELECT current_schema() AS schema");
  return {
    statusCode: 200,
    body: {
      message: "Hello from MAARY BASE Function!",
      schema: dbRes.rows[0]?.schema,
      input: ctx.req.body
    }
  };
}</textarea>
              </div>
              <button type="submit" class="btn">Deploy Function</button>
            </form>
          </div>
          <div class="card">
            <h3>Deployed Functions & Live Invocation</h3>
            <div id="functions-list"></div>
            <div style="margin-top: 12px;">
              <label style="font-size: 12px; color: var(--text-muted);">Invocation Output & Captured Logs</label>
              <pre id="fn-invoke-output" class="code-block">Invoke a function to see execution results and console logs.</pre>
            </div>
          </div>
        </div>
        <div class="card">
          <h3>Background Queue Jobs</h3>
          <div class="form-row">
            <button id="btn-process-jobs" class="btn btn-secondary">Process Pending Jobs Now</button>
          </div>
          <div id="jobs-list"></div>
        </div>
      </section>

      <!-- TAB: REALTIME -->
      <section id="tab-realtime" class="tab-panel hidden">
        <div class="grid-2">
          <div class="card">
            <h3>Live WebSocket Realtime Stream</h3>
            <div class="form-row">
              <div class="form-group">
                <label>Channel Topic (e.g. db:* or room:lobby)</label>
                <input id="rt-topic" value="db:*" />
              </div>
              <button id="btn-rt-connect" class="btn">Connect & Subscribe</button>
              <button id="btn-rt-broadcast" class="btn btn-secondary">Send Test Broadcast</button>
            </div>
            <pre id="rt-stream-log" class="code-block" style="min-height: 220px;">Disconnected. Click "Connect & Subscribe" to stream live PostgreSQL row changes and broadcasts.</pre>
          </div>
          <div class="card">
            <h3>Recent Persisted Realtime Events</h3>
            <div id="rt-events-table"></div>
          </div>
        </div>
      </section>

      <!-- TAB: SECURITY, KEYS & SECRETS -->
      <section id="tab-security" class="tab-panel hidden">
        <div class="card">
          <h3>Project API Keys & Scoped Credentials</h3>
          <form id="create-key-form" class="form-row">
            <div class="form-group">
              <label>Key Name</label>
              <input id="key-name" placeholder="Backend Worker Key" required />
            </div>
            <div class="form-group">
              <label>Role</label>
              <select id="key-role">
                <option value="custom">custom (scoped)</option>
                <option value="anon">anon (public)</option>
                <option value="service_role">service_role (secret)</option>
              </select>
            </div>
            <div class="form-group" style="flex: 2;">
              <label>Scopes (comma-separated)</label>
              <input id="key-scopes" value="db:read,db:write,functions:invoke" />
            </div>
            <button type="submit" class="btn">Generate API Key</button>
          </form>
          <div id="api-keys-list"></div>
        </div>

        <div class="card">
          <h3>Encrypted Environment Secrets (AES-256-GCM)</h3>
          <form id="create-secret-form" class="form-row">
            <div class="form-group">
              <label>Secret Name</label>
              <input id="sec-name" placeholder="STRIPE_WEBHOOK_SECRET" required />
            </div>
            <div class="form-group" style="flex: 2;">
              <label>Secret Plaintext Value</label>
              <input id="sec-val" type="password" placeholder="whsec_..." required />
            </div>
            <button type="submit" class="btn">Encrypt & Save Secret</button>
            <button type="button" id="btn-reveal-secrets" class="btn btn-secondary">Toggle Reveal</button>
          </form>
          <div id="secrets-list"></div>
        </div>
      </section>

      <!-- TAB: OPERATIONS, BACKUPS & AUDIT -->
      <section id="tab-operations" class="tab-panel hidden">
        <div class="grid-2">
          <div class="card">
            <h3>Database Backups & Point-in-Time Snapshots</h3>
            <div class="form-row">
              <input id="backup-name-input" placeholder="Pre-migration snapshot" />
              <button id="btn-create-backup" class="btn">Create Backup Snapshot</button>
            </div>
            <div id="backups-list"></div>
          </div>
          <div class="card">
            <h3>Auto-Generated OpenAPI 3.1 Specification</h3>
            <button id="btn-load-openapi" class="btn btn-secondary" style="margin-bottom: 10px;">Refresh OpenAPI Spec</button>
            <pre id="openapi-preview" class="code-block" style="max-height: 300px;"></pre>
          </div>
        </div>
        <div class="card">
          <h3>Security & Operational Audit Trail</h3>
          <div id="audit-events-list"></div>
        </div>
      </section>
    </main>
  </div>

  <script src="/dashboard/app.js"></script>
</body>
</html>`;

const DASHBOARD_JS = `
(() => {
  const state = {
    token: localStorage.getItem("maary_platform_token") || null,
    user: null,
    projects: [],
    activeProject: null,
    activeTable: null,
    activeBucket: null,
    revealSecrets: false,
    authMode: "register",
    ws: null,
  };

  const $ = (id) => document.getElementById(id);

  function showToast(msg, type = "success") {
    const el = $("global-toast");
    if (!el) return;
    el.textContent = msg;
    el.className = "toast-banner show " + type;
    setTimeout(() => { el.className = "toast-banner"; }, 4500);
  }

  async function api(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (state.token) {
      headers["Authorization"] = "Bearer " + state.token;
    }
    if (options.body && typeof options.body === "object" && !(options.body instanceof FormData)) {
      headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(options.body);
    }
    const res = await fetch(path, { ...options, headers });
    const contentType = res.headers.get("content-type") || "";
    const data = contentType.includes("application/json") ? await res.json() : await res.text();
    if (!res.ok) {
      throw new Error((data && data.message) || "Request failed (" + res.status + ")");
    }
    return data;
  }

  async function checkHealth() {
    try {
      const ready = await api("/ready");
      const pill = $("health-pill");
      pill.textContent = "PostgreSQL Ready (" + (ready.pool?.mode || "ok") + ")";
      pill.className = "badge badge-green";
    } catch {
      const pill = $("health-pill");
      pill.textContent = "Degraded";
      pill.className = "badge badge-danger";
    }
  }

  async function initSession() {
    await checkHealth();
    if (!state.token) {
      showAuthView();
      return;
    }
    try {
      const me = await api("/v1/platform/auth/me");
      state.user = me.user;
      showStudioView();
      await loadProjects();
    } catch {
      localStorage.removeItem("maary_platform_token");
      state.token = null;
      showAuthView();
    }
  }

  function showAuthView() {
    $("auth-view").classList.remove("hidden");
    $("studio-view").classList.add("hidden");
    $("topbar-authenticated").classList.add("hidden");
  }

  function showStudioView() {
    $("auth-view").classList.add("hidden");
    $("studio-view").classList.remove("hidden");
    $("topbar-authenticated").classList.remove("hidden");
    $("current-user-label").textContent = state.user.email + (state.user.is_superadmin ? " (superadmin)" : "");
  }

  async function loadProjects() {
    const res = await api("/v1/projects");
    state.projects = res.projects || [];
    const sel = $("project-select");
    sel.innerHTML = "";
    for (const p of state.projects) {
      const opt = document.createElement("option");
      opt.value = p.slug;
      opt.textContent = p.name + " (" + p.slug + ")";
      sel.appendChild(opt);
    }
    if (state.projects.length > 0) {
      const currentSlug = state.activeProject?.slug;
      const match = state.projects.find((p) => p.slug === currentSlug) || state.projects[0];
      sel.value = match.slug;
      await selectProject(match.slug);
    } else {
      state.activeProject = null;
      $("new-project-card").classList.remove("hidden");
    }
  }

  async function selectProject(slug) {
    if (!slug) return;
    const details = await api("/v1/projects/" + encodeURIComponent(slug));
    state.activeProject = details.project;
    renderOverview(details);
    await Promise.all([
      loadTables(),
      loadMigrations(),
      loadAuthUsersAndConfig(),
      loadBuckets(),
      loadFunctionsAndJobs(),
      loadKeysAndSecrets(),
      loadBackupsAndAudit(),
    ]);
  }

  function renderOverview(details) {
    const p = details.project;
    const u = details.usage || {};
    $("overview-stats").innerHTML = [
      { label: "Database Tables", val: u.tableCount ?? 0 },
      { label: "Auth End-Users", val: u.userCount ?? 0 },
      { label: "Storage Objects", val: (u.storageObjects ?? 0) + " (" + ((u.storageBytes ?? 0) / 1024).toFixed(1) + " KB)" },
      { label: "Server Functions", val: u.functionCount ?? 0 },
    ]
      .map((s) => '<div class="stat-box"><div class="stat-label">' + s.label + '</div><div class="stat-value">' + s.val + '</div></div>')
      .join("");

    $("project-meta-box").innerHTML =
      '<p><strong>Project ID:</strong> <code>' + p.id + '</code></p>' +
      '<p><strong>Slug:</strong> <code>' + p.slug + '</code></p>' +
      '<p><strong>Isolated PG Schema:</strong> <span class="badge badge-green">' + p.schema_name + '</span></p>' +
      '<p><strong>Isolated PG Role:</strong> <code>' + p.db_role_name + '</code></p>' +
      '<p><strong>Status:</strong> <span class="badge badge-green">' + p.status + '</span></p>';

    $("environments-list").innerHTML = (details.environments || [])
      .map((e) => '<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);"><span><strong>' + e.name + '</strong> (<code>' + e.slug + '</code>)</span><span class="badge">' + (e.is_production ? "production" : "non-prod") + '</span></div>')
      .join("");

    $("sdk-snippet").textContent =
      'import { createMaaryClient } from "maary-base/sdk";\\n\\n' +
      'const maary = createMaaryClient(window.location.origin, "<YOUR_ANON_OR_SERVICE_KEY>", {\\n' +
      '  projectRef: "' + p.slug + '"\\n' +
      '});\\n\\n' +
      '// Query rows with automatic PostgreSQL Row-Level Security:\\n' +
      'const { data } = await maary.from("todos").select("*").eq("completed", false);';
  }

  async function loadTables() {
    if (!state.activeProject) return;
    const res = await api("/v1/projects/" + state.activeProject.slug + "/database/tables");
    const tables = res.tables || [];
    const listEl = $("tables-list");
    if (tables.length === 0) {
      listEl.innerHTML = '<p style="color:var(--text-muted)">No tables in schema yet. Create one on the left.</p>';
      return;
    }
    listEl.innerHTML = '<table class="data-table"><thead><tr><th>Table</th><th>Columns</th><th>Rows</th><th>RLS</th><th>Actions</th></tr></thead><tbody>' +
      tables.map((t) =>
        '<tr>' +
        '<td><strong>' + t.name + '</strong></td>' +
        '<td>' + t.columns.map((c) => c.name + ':' + c.dataType).join(', ') + '</td>' +
        '<td>' + t.rowCount + '</td>' +
        '<td><span class="badge ' + (t.rlsEnabled ? 'badge-green' : 'badge-warn') + '">' + (t.rlsEnabled ? 'Enabled' : 'Disabled') + '</span></td>' +
        '<td><button class="btn btn-secondary btn-inspect-tbl" data-table="' + t.name + '">Browse</button></td>' +
        '</tr>'
      ).join('') + '</tbody></table>';

    document.querySelectorAll(".btn-inspect-tbl").forEach((btn) => {
      btn.addEventListener("click", () => browseTable(btn.getAttribute("data-table")));
    });

    // Render RLS policies
    const allPolicies = [];
    for (const t of tables) {
      for (const pol of t.policies || []) {
        allPolicies.push(pol);
      }
    }
    $("rls-policies-list").innerHTML = allPolicies.length === 0
      ? '<p style="color:var(--text-muted)">No RLS policies defined yet.</p>'
      : '<table class="data-table"><thead><tr><th>Table</th><th>Policy</th><th>Command</th><th>USING</th></tr></thead><tbody>' +
        allPolicies.map((p) => '<tr><td>' + p.tableName + '</td><td>' + p.policyName + '</td><td><span class="badge">' + p.command + '</span></td><td><code>' + (p.usingExpression || '') + '</code></td></tr>').join('') +
        '</tbody></table>';

    if (!state.activeTable && tables[0]) {
      await browseTable(tables[0].name);
    }
  }

  async function browseTable(tableName) {
    if (!state.activeProject || !tableName) return;
    state.activeTable = tableName;
    $("active-table-label").textContent = tableName;
    const res = await api("/v1/projects/" + state.activeProject.slug + "/rest/" + encodeURIComponent(tableName) + "?limit=50");
    const rows = res.data || [];
    if (rows.length === 0) {
      $("table-rows-container").innerHTML = '<p style="color:var(--text-muted);margin-top:8px;">Table is empty.</p>';
      return;
    }
    const cols = Object.keys(rows[0]);
    $("table-rows-container").innerHTML =
      '<table class="data-table" style="margin-top:10px;"><thead><tr>' +
      cols.map((c) => '<th>' + c + '</th>').join('') +
      '</tr></thead><tbody>' +
      rows.map((r) => '<tr>' + cols.map((c) => '<td><code>' + (typeof r[c] === "object" ? JSON.stringify(r[c]) : String(r[c] ?? "NULL")) + '</code></td>').join('') + '</tr>').join('') +
      '</tbody></table>';
  }

  async function loadMigrations() {
    if (!state.activeProject) return;
    const res = await api("/v1/projects/" + state.activeProject.slug + "/database/migrations");
    const migs = res.migrations || [];
    $("migrations-list").innerHTML = migs.length === 0
      ? '<p style="color:var(--text-muted)">No project migrations applied yet.</p>'
      : '<table class="data-table"><thead><tr><th>Version</th><th>Name</th><th>Status</th><th>Checksum</th><th>Action</th></tr></thead><tbody>' +
        migs.map((m) =>
          '<tr><td><code>' + m.version + '</code></td><td>' + m.name + '</td><td><span class="badge ' + (m.status === 'applied' ? 'badge-green' : 'badge-warn') + '">' + m.status + '</span></td><td><code>' + m.checksum.slice(0, 10) + '...</code></td>' +
          '<td>' + (m.status === 'applied' && m.down_sql ? '<button class="btn btn-secondary btn-rollback-mig" data-ver="' + m.version + '">Rollback</button>' : '') + '</td></tr>'
        ).join('') + '</tbody></table>';

    document.querySelectorAll(".btn-rollback-mig").forEach((b) => {
      b.addEventListener("click", async () => {
        try {
          await api("/v1/projects/" + state.activeProject.slug + "/database/migrations/" + b.getAttribute("data-ver") + "/rollback", { method: "POST" });
          showToast("Migration rolled back");
          await loadMigrations();
          await loadTables();
        } catch (err) {
          showToast(err.message, "error");
        }
      });
    });
  }

  async function loadAuthUsersAndConfig() {
    if (!state.activeProject) return;
    const [usersRes, cfgRes] = await Promise.all([
      api("/v1/projects/" + state.activeProject.slug + "/auth/admin/users"),
      api("/v1/projects/" + state.activeProject.slug + "/auth/config"),
    ]);
    const users = usersRes.users || [];
    $("project-users-list").innerHTML = users.length === 0
      ? '<p style="color:var(--text-muted)">No end-users registered in this project yet.</p>'
      : '<table class="data-table"><thead><tr><th>Email</th><th>Role</th><th>Verified</th><th>Status</th></tr></thead><tbody>' +
        users.map((u) => '<tr><td>' + u.email + '</td><td><code>' + u.role + '</code></td><td>' + (u.email_verified ? 'Yes' : 'No') + '</td><td><span class="badge badge-green">' + u.status + '</span></td></tr>').join('') +
        '</tbody></table>';

    if (cfgRes.config) {
      $("cfg-public-signup").value = String(cfgRes.config.allow_public_signup);
      $("cfg-email-verify").value = String(cfgRes.config.require_email_verification);
      $("cfg-pass-len").value = String(cfgRes.config.password_min_length);
      $("cfg-access-ttl").value = String(cfgRes.config.access_token_ttl_seconds);
    }
  }

  async function loadBuckets() {
    if (!state.activeProject) return;
    const res = await api("/v1/projects/" + state.activeProject.slug + "/storage/buckets");
    const buckets = res.buckets || [];
    $("buckets-list").innerHTML = buckets.length === 0
      ? '<p style="color:var(--text-muted)">No storage buckets created yet.</p>'
      : '<table class="data-table"><thead><tr><th>Bucket</th><th>Access</th><th>Objects</th><th>Used</th><th>Action</th></tr></thead><tbody>' +
        buckets.map((b) =>
          '<tr><td><strong>' + b.name + '</strong></td><td><span class="badge ' + (b.public ? 'badge-green' : 'badge-warn') + '">' + (b.public ? 'Public' : 'Private') + '</span></td><td>' + b.object_count + '</td><td>' + b.used_bytes + ' B</td><td><button class="btn btn-secondary btn-open-bucket" data-bucket="' + b.name + '">Open</button></td></tr>'
        ).join('') + '</tbody></table>';

    document.querySelectorAll(".btn-open-bucket").forEach((b) => {
      b.addEventListener("click", () => openBucket(b.getAttribute("data-bucket")));
    });

    if (!state.activeBucket && buckets[0]) {
      await openBucket(buckets[0].name);
    }
  }

  async function openBucket(bucketName) {
    if (!state.activeProject || !bucketName) return;
    state.activeBucket = bucketName;
    $("active-bucket-label").textContent = bucketName;
    const res = await api("/v1/projects/" + state.activeProject.slug + "/storage/buckets/" + encodeURIComponent(bucketName) + "/objects");
    const objs = res.objects || [];
    $("bucket-objects-list").innerHTML = objs.length === 0
      ? '<p style="color:var(--text-muted)">Bucket is empty.</p>'
      : '<table class="data-table"><thead><tr><th>Path</th><th>MIME</th><th>Size</th><th>SHA-256</th></tr></thead><tbody>' +
        objs.map((o) => '<tr><td><code>' + o.path + '</code></td><td>' + o.mime_type + '</td><td>' + o.size_bytes + ' B</td><td><code>' + o.checksum_sha256.slice(0, 12) + '...</code></td></tr>').join('') +
        '</tbody></table>';
  }

  async function loadFunctionsAndJobs() {
    if (!state.activeProject) return;
    const [fnRes, jobsRes] = await Promise.all([
      api("/v1/projects/" + state.activeProject.slug + "/functions"),
      api("/v1/projects/" + state.activeProject.slug + "/jobs"),
    ]);
    const fns = fnRes.functions || [];
    $("functions-list").innerHTML = fns.length === 0
      ? '<p style="color:var(--text-muted)">No server functions deployed yet.</p>'
      : '<table class="data-table"><thead><tr><th>Slug</th><th>Version</th><th>Auth</th><th>Action</th></tr></thead><tbody>' +
        fns.map((f) =>
          '<tr><td><code>' + f.slug + '</code></td><td>v' + f.version + '</td><td>' + (f.verify_jwt ? 'JWT' : 'Public') + '</td><td><button class="btn btn-secondary btn-invoke-fn" data-slug="' + f.slug + '">Invoke Test</button></td></tr>'
        ).join('') + '</tbody></table>';

    document.querySelectorAll(".btn-invoke-fn").forEach((b) => {
      b.addEventListener("click", async () => {
        const slug = b.getAttribute("data-slug");
        try {
          const out = await api("/v1/projects/" + state.activeProject.slug + "/functions/" + slug + "/invoke", {
            method: "POST",
            body: { timestamp: new Date().toISOString() },
          });
          $("fn-invoke-output").textContent = JSON.stringify(out, null, 2);
        } catch (err) {
          $("fn-invoke-output").textContent = "Error: " + err.message;
        }
      });
    });

    const jobs = jobsRes.jobs || [];
    $("jobs-list").innerHTML = jobs.length === 0
      ? '<p style="color:var(--text-muted)">No background jobs queued.</p>'
      : '<table class="data-table"><thead><tr><th>ID</th><th>Type</th><th>Queue</th><th>Status</th><th>Attempts</th></tr></thead><tbody>' +
        jobs.map((j) => '<tr><td><code>' + j.id.slice(0, 8) + '</code></td><td>' + j.job_type + '</td><td>' + j.queue_name + '</td><td><span class="badge">' + j.status + '</span></td><td>' + j.attempts + '/' + j.max_attempts + '</td></tr>').join('') +
        '</tbody></table>';
  }

  async function loadKeysAndSecrets() {
    if (!state.activeProject) return;
    const [keysRes, secRes] = await Promise.all([
      api("/v1/projects/" + state.activeProject.slug + "/api-keys?reveal=true"),
      api("/v1/projects/" + state.activeProject.slug + "/secrets?reveal=" + state.revealSecrets),
    ]);
    const keys = keysRes.apiKeys || [];
    $("api-keys-list").innerHTML = '<table class="data-table"><thead><tr><th>Name</th><th>Role</th><th>Key / Prefix</th><th>Status</th><th>Action</th></tr></thead><tbody>' +
      keys.map((k) =>
        '<tr><td>' + k.name + '</td><td><span class="badge">' + k.role + '</span></td><td><code>' + (k.raw_key || k.key_prefix + '...') + '</code></td><td>' + (k.revoked_at ? '<span class="badge badge-danger">Revoked</span>' : '<span class="badge badge-green">Active</span>') + '</td>' +
        '<td>' + (!k.revoked_at ? '<button class="btn btn-secondary btn-rotate-key" data-id="' + k.id + '">Rotate</button>' : '') + '</td></tr>'
      ).join('') + '</tbody></table>';

    document.querySelectorAll(".btn-rotate-key").forEach((b) => {
      b.addEventListener("click", async () => {
        await api("/v1/projects/" + state.activeProject.slug + "/api-keys/" + b.getAttribute("data-id") + "/rotate", { method: "POST" });
        showToast("API key rotated");
        await loadKeysAndSecrets();
      });
    });

    const secrets = secRes.secrets || [];
    $("secrets-list").innerHTML = secrets.length === 0
      ? '<p style="color:var(--text-muted)">No encrypted secrets stored yet.</p>'
      : '<table class="data-table"><thead><tr><th>Name</th><th>Value</th><th>Version</th><th>Updated</th></tr></thead><tbody>' +
        secrets.map((s) => '<tr><td><code>' + s.name + '</code></td><td><code>' + (s.decrypted_value ?? s.masked_value) + '</code></td><td>v' + s.version + '</td><td>' + new Date(s.updated_at).toLocaleString() + '</td></tr>').join('') +
        '</tbody></table>';
  }

  async function loadBackupsAndAudit() {
    if (!state.activeProject) return;
    const [bRes, aRes, oRes] = await Promise.all([
      api("/v1/projects/" + state.activeProject.slug + "/backups"),
      api("/v1/projects/" + state.activeProject.slug + "/audit?limit=25"),
      api("/v1/projects/" + state.activeProject.slug + "/openapi.json"),
    ]);
    const backups = bRes.backups || [];
    $("backups-list").innerHTML = backups.length === 0
      ? '<p style="color:var(--text-muted)">No backups created yet.</p>'
      : '<table class="data-table"><thead><tr><th>Name</th><th>Size</th><th>SHA-256</th><th>Status</th><th>Action</th></tr></thead><tbody>' +
        backups.map((b) =>
          '<tr><td>' + b.name + '</td><td>' + b.size_bytes + ' B</td><td><code>' + b.checksum_sha256.slice(0, 10) + '...</code></td><td><span class="badge badge-green">' + b.status + '</span></td>' +
          '<td><button class="btn btn-secondary btn-restore-backup" data-id="' + b.id + '">Restore</button></td></tr>'
        ).join('') + '</tbody></table>';

    document.querySelectorAll(".btn-restore-backup").forEach((b) => {
      b.addEventListener("click", async () => {
        await api("/v1/projects/" + state.activeProject.slug + "/backups/" + b.getAttribute("data-id") + "/restore", { method: "POST" });
        showToast("Backup verified & restored!");
        await selectProject(state.activeProject.slug);
      });
    });

    $("openapi-preview").textContent = JSON.stringify(oRes, null, 2);

    const events = aRes.events || [];
    $("audit-events-list").innerHTML = '<table class="data-table"><thead><tr><th>Timestamp</th><th>Action</th><th>Actor</th><th>Resource</th></tr></thead><tbody>' +
      events.map((e) => '<tr><td>' + new Date(e.created_at).toLocaleTimeString() + '</td><td><code>' + e.action + '</code></td><td>' + e.actor_type + '</td><td>' + e.resource_type + ':' + (e.resource_id || '') + '</td></tr>').join('') +
      '</tbody></table>';
  }

  // Event Listeners
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.add("hidden"));
      btn.classList.add("active");
      const tab = btn.getAttribute("data-tab");
      $("tab-" + tab)?.classList.remove("hidden");
    });
  });

  $("auth-toggle-mode").addEventListener("click", () => {
    state.authMode = state.authMode === "register" ? "login" : "register";
    $("auth-name-group").style.display = state.authMode === "register" ? "block" : "none";
    $("auth-submit-btn").textContent = state.authMode === "register" ? "Register Operator" : "Sign In";
    $("auth-toggle-mode").textContent = state.authMode === "register" ? "Switch to Login" : "Switch to Register";
  });

  $("auth-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("auth-email").value;
    const password = $("auth-password").value;
    const name = $("auth-name").value;
    try {
      const endpoint = state.authMode === "register" ? "/v1/platform/auth/register" : "/v1/platform/auth/login";
      const res = await api(endpoint, { method: "POST", body: { email, password, name } });
      state.token = res.accessToken;
      state.user = res.user;
      localStorage.setItem("maary_platform_token", state.token);
      showStudioView();
      await loadProjects();
    } catch (err) {
      const fb = $("auth-feedback");
      fb.textContent = err.message;
      fb.className = "toast-banner show error";
    }
  });

  $("btn-logout").addEventListener("click", () => {
    localStorage.removeItem("maary_platform_token");
    state.token = null;
    showAuthView();
  });

  $("project-select").addEventListener("change", (e) => selectProject(e.target.value));
  $("btn-new-project").addEventListener("click", () => $("new-project-card").classList.remove("hidden"));
  $("btn-cancel-project").addEventListener("click", () => $("new-project-card").classList.add("hidden"));

  $("create-project-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const created = await api("/v1/projects", {
        method: "POST",
        body: {
          name: $("proj-name").value,
          slug: $("proj-slug").value || undefined,
          description: $("proj-desc").value,
        },
      });
      $("new-project-card").classList.add("hidden");
      showToast("Project '" + created.project.slug + "' created!");
      await loadProjects();
      $("project-select").value = created.project.slug;
      await selectProject(created.project.slug);
    } catch (err) {
      showToast(err.message, "error");
    }
  });

  $("create-env-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!state.activeProject) return;
    try {
      await api("/v1/projects/" + state.activeProject.slug + "/environments", {
        method: "POST",
        body: { name: $("env-name-input").value },
      });
      $("env-name-input").value = "";
      await selectProject(state.activeProject.slug);
      showToast("Environment added");
    } catch (err) {
      showToast(err.message, "error");
    }
  });

  $("create-table-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!state.activeProject) return;
    try {
      const columns = JSON.parse($("tbl-cols").value);
      await api("/v1/projects/" + state.activeProject.slug + "/database/tables", {
        method: "POST",
        body: {
          name: $("tbl-name").value,
          enableRls: $("tbl-rls").value === "true",
          columns,
        },
      });
      showToast("Table created!");
      await loadTables();
      await browseTable($("tbl-name").value);
    } catch (err) {
      showToast(err.message, "error");
    }
  });

  $("btn-insert-row").addEventListener("click", async () => {
    if (!state.activeProject || !state.activeTable) return;
    try {
      const payload = JSON.parse($("row-json-input").value);
      await api("/v1/projects/" + state.activeProject.slug + "/rest/" + state.activeTable, {
        method: "POST",
        body: payload,
      });
      showToast("Row inserted!");
      await browseTable(state.activeTable);
      await loadTables();
    } catch (err) {
      showToast(err.message, "error");
    }
  });

  $("btn-refresh-rows").addEventListener("click", () => browseTable(state.activeTable));

  $("btn-run-sql").addEventListener("click", async () => {
    if (!state.activeProject) return;
    try {
      const role = $("sql-role-select").value;
      const userId = $("sql-user-id").value.trim();
      const res = await api("/v1/projects/" + state.activeProject.slug + "/database/sql", {
        method: "POST",
        body: {
          sql: $("sql-editor-input").value,
          allowDestructive: $("sql-destructive").value === "true",
          impersonate: role === "service_role" ? undefined : { role, userId: userId || undefined },
        },
      });
      $("sql-result-box").innerHTML =
        '<p style="color:var(--text-muted);margin-bottom:6px;">Returned ' + res.rowCount + ' row(s) in ' + res.durationMs + 'ms</p>' +
        '<pre class="code-block">' + JSON.stringify(res.rows, null, 2) + '</pre>';
      await loadTables();
    } catch (err) {
      $("sql-result-box").innerHTML = '<div class="toast-banner show error">' + err.message + '</div>';
    }
  });

  $("create-policy-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!state.activeProject) return;
    try {
      await api("/v1/projects/" + state.activeProject.slug + "/database/policies", {
        method: "POST",
        body: {
          tableName: $("pol-table").value,
          policyName: $("pol-name").value,
          command: $("pol-cmd").value,
          usingExpression: $("pol-using").value,
        },
      });
      showToast("RLS Policy created!");
      await loadTables();
    } catch (err) {
      showToast(err.message, "error");
    }
  });

  $("apply-migration-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!state.activeProject) return;
    try {
      await api("/v1/projects/" + state.activeProject.slug + "/database/migrations", {
        method: "POST",
        body: {
          version: $("mig-version").value,
          name: $("mig-name").value,
          upSql: $("mig-up").value,
          downSql: $("mig-down").value,
        },
      });
      showToast("Migration applied!");
      await loadMigrations();
      await loadTables();
    } catch (err) {
      showToast(err.message, "error");
    }
  });

  $("admin-create-user-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!state.activeProject) return;
    try {
      await api("/v1/projects/" + state.activeProject.slug + "/auth/admin/users", {
        method: "POST",
        body: {
          email: $("u-email").value,
          password: $("u-pass").value,
          emailVerified: true,
        },
      });
      $("u-email").value = "";
      $("u-pass").value = "";
      showToast("Project user created!");
      await loadAuthUsersAndConfig();
    } catch (err) {
      showToast(err.message, "error");
    }
  });

  $("auth-config-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!state.activeProject) return;
    try {
      await api("/v1/projects/" + state.activeProject.slug + "/auth/config", {
        method: "PATCH",
        body: {
          allow_public_signup: $("cfg-public-signup").value === "true",
          require_email_verification: $("cfg-email-verify").value === "true",
          password_min_length: Number($("cfg-pass-len").value),
          access_token_ttl_seconds: Number($("cfg-access-ttl").value),
        },
      });
      showToast("Auth policy updated!");
    } catch (err) {
      showToast(err.message, "error");
    }
  });

  $("create-bucket-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!state.activeProject) return;
    try {
      const name = $("bucket-name").value;
      await api("/v1/projects/" + state.activeProject.slug + "/storage/buckets", {
        method: "POST",
        body: { name, public: $("bucket-public").value === "true" },
      });
      $("bucket-name").value = "";
      showToast("Bucket created!");
      await loadBuckets();
      await openBucket(name);
    } catch (err) {
      showToast(err.message, "error");
    }
  });

  $("upload-object-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!state.activeProject || !state.activeBucket) return;
    try {
      await api(
        "/v1/projects/" + state.activeProject.slug + "/storage/buckets/" + state.activeBucket + "/objects/" + $("obj-path").value,
        {
          method: "POST",
          body: {
            content: $("obj-content").value,
            mimeType: $("obj-mime").value,
            upsert: true,
          },
        }
      );
      showToast("Object uploaded!");
      await openBucket(state.activeBucket);
      await loadBuckets();
    } catch (err) {
      showToast(err.message, "error");
    }
  });

  $("deploy-fn-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!state.activeProject) return;
    try {
      await api("/v1/projects/" + state.activeProject.slug + "/functions", {
        method: "POST",
        body: {
          slug: $("fn-slug").value,
          verifyJwt: $("fn-jwt").value === "true",
          code: $("fn-code").value,
        },
      });
      showToast("Server function deployed!");
      await loadFunctionsAndJobs();
    } catch (err) {
      showToast(err.message, "error");
    }
  });

  $("btn-process-jobs").addEventListener("click", async () => {
    if (!state.activeProject) return;
    const res = await api("/v1/projects/" + state.activeProject.slug + "/jobs/process", { method: "POST" });
    showToast("Processed " + res.count + " job(s)");
    await loadFunctionsAndJobs();
  });

  $("create-key-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!state.activeProject) return;
    try {
      await api("/v1/projects/" + state.activeProject.slug + "/api-keys", {
        method: "POST",
        body: {
          name: $("key-name").value,
          role: $("key-role").value,
          scopes: $("key-scopes").value.split(",").map((s) => s.trim()).filter(Boolean),
        },
      });
      showToast("API key generated!");
      await loadKeysAndSecrets();
    } catch (err) {
      showToast(err.message, "error");
    }
  });

  $("create-secret-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!state.activeProject) return;
    try {
      await api("/v1/projects/" + state.activeProject.slug + "/secrets", {
        method: "POST",
        body: { name: $("sec-name").value, value: $("sec-val").value },
      });
      $("sec-name").value = "";
      $("sec-val").value = "";
      showToast("Secret encrypted & stored!");
      await loadKeysAndSecrets();
    } catch (err) {
      showToast(err.message, "error");
    }
  });

  $("btn-reveal-secrets").addEventListener("click", async () => {
    state.revealSecrets = !state.revealSecrets;
    await loadKeysAndSecrets();
  });

  $("btn-create-backup").addEventListener("click", async () => {
    if (!state.activeProject) return;
    await api("/v1/projects/" + state.activeProject.slug + "/backups", {
      method: "POST",
      body: { name: $("backup-name-input").value || undefined },
    });
    showToast("Backup snapshot created!");
    await loadBackupsAndAudit();
  });

  $("btn-load-openapi").addEventListener("click", () => loadBackupsAndAudit());

  $("btn-rt-connect").addEventListener("click", async () => {
    if (!state.activeProject) return;
    if (state.ws) {
      state.ws.close();
      state.ws = null;
    }
    const keysRes = await api("/v1/projects/" + state.activeProject.slug + "/api-keys?reveal=true");
    const validKey = (keysRes.apiKeys || []).find((k) => !k.revoked_at && k.raw_key);
    if (!validKey) {
      showToast("No active API key found", "error");
      return;
    }
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = proto + "//" + window.location.host + "/v1/projects/" + state.activeProject.slug + "/realtime/ws?apikey=" + encodeURIComponent(validKey.raw_key);
    const ws = new WebSocket(wsUrl);
    state.ws = ws;
    const logEl = $("rt-stream-log");
    logEl.textContent = "Connecting to " + state.activeProject.slug + "...\\n";
    ws.onopen = () => {
      const topic = $("rt-topic").value.trim() || "db:*";
      ws.send(JSON.stringify({ type: "subscribe", topic }));
    };
    ws.onmessage = (ev) => {
      logEl.textContent += ev.data + "\\n";
    };
  });

  $("btn-rt-broadcast").addEventListener("click", async () => {
    if (!state.activeProject) return;
    const topic = $("rt-topic").value.trim() || "room:lobby";
    await api("/v1/projects/" + state.activeProject.slug + "/realtime/broadcast", {
      method: "POST",
      body: { topic, event: "ping", payload: { sentAt: new Date().toISOString() } },
    });
    showToast("Broadcast published to " + topic);
  });

  void initSession();
})();
`;

export async function registerDashboardRoutes(
  app: FastifyInstance
): Promise<void> {
  app.get("/", async (_request, reply) => {
    return reply
      .header("content-type", "text/html; charset=utf-8")
      .send(DASHBOARD_HTML);
  });

  app.get("/dashboard", async (_request, reply) => {
    return reply
      .header("content-type", "text/html; charset=utf-8")
      .send(DASHBOARD_HTML);
  });

  app.get("/dashboard/styles.css", async (_request, reply) => {
    return reply
      .header("content-type", "text/css; charset=utf-8")
      .send(DASHBOARD_CSS);
  });

  app.get("/dashboard/app.js", async (_request, reply) => {
    return reply
      .header("content-type", "application/javascript; charset=utf-8")
      .send(DASHBOARD_JS);
  });

  app.get("/dashboard/logo.png", async (_request, reply) => {
    const logoPath = resolve(process.cwd(), "assets", "logo.png");
    const buf = await readFile(logoPath);
    return reply.header("content-type", "image/png").send(buf);
  });

  app.get("/dashboard/logo.svg", async (_request, reply) => {
    const svgPath = resolve(process.cwd(), "assets", "logo.svg");
    const buf = await readFile(svgPath);
    return reply.header("content-type", "image/svg+xml").send(buf);
  });
}
