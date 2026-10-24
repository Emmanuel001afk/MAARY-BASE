import {
  $, api, badge, closeDialog, confirmAction, copyText, debounce,
  downloadText, esc, icon, parseJson, projectApi, reportError, showCredentials, showToast,
  state, storageAdapter,
} from "./core.js";
import {
  appendRealtimeLog, browseTable, loadPage, openBucket, renderSqlResult,
  renderTablesList, updateRealtimeUi,
} from "./pages.js";

function formatBytesInline(value) {
  const bytes = Number(value) || 0;
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function encodePath(path) {
  return String(path).split("/").map((part) => encodeURIComponent(part)).join("/");
}

export function activateLocalTab(name) {
  const button = document.querySelector(`[data-local-tab="${name}"]`);
  if (!button) return;
  const group = button.closest(".local-tabs");
  group?.querySelectorAll("[data-local-tab]").forEach((item) => {
    const active = item === button;
    item.classList.toggle("active", active);
    item.setAttribute("aria-selected", String(active));
  });
  document.querySelectorAll(".local-panel").forEach((panel) => panel.classList.add("hidden"));
  $(`local-${name}`)?.classList.remove("hidden");
}

function focusElement(id, disclosureId = null) {
  if (disclosureId) $(disclosureId).open = true;
  const element = $(id);
  if (!element) return;
  element.scrollIntoView({ behavior: "smooth", block: "center" });
  window.setTimeout(() => element.focus(), 250);
}

function readSqlHistory() {
  try {
    const history = JSON.parse(storageAdapter.get("maary_sql_history") || "[]");
    return Array.isArray(history) ? history.filter((item) => typeof item === "string").slice(0, 10) : [];
  } catch { return []; }
}

function rememberSql(sql) {
  const history = [sql, ...readSqlHistory().filter((item) => item !== sql)].slice(0, 10);
  storageAdapter.set("maary_sql_history", JSON.stringify(history));
  renderSqlHistory();
}

export function renderSqlHistory() {
  const select = $("sql-history");
  if (!select) return;
  const history = readSqlHistory();
  select.innerHTML = `<option value="">Recent queries…</option>${history.map((sql, index) => `<option value="${index}">${esc(sql.replace(/\s+/g, " ").slice(0, 72))}</option>`).join("")}`;
}

function closeRealtime() {
  if (state.ws) {
    const socket = state.ws;
    state.ws = null;
    socket.onclose = null;
    socket.close(1000, "Studio disconnect");
  }
  updateRealtimeUi("disconnected", "Disconnected. Choose a topic and connect to begin streaming.");
}

async function connectRealtime() {
  const slug = state.activeProject?.slug;
  if (!slug) return;
  closeRealtime();
  updateRealtimeUi("connecting", "Finding an active realtime credential…");
  const keysResponse = await api(`${projectApi("/api-keys")}?reveal=true`);
  const key = (keysResponse.apiKeys || []).find((item) => !item.revoked_at && item.raw_key && (item.role === "service_role" || item.scopes?.includes("*") || item.scopes?.includes("realtime:subscribe")));
  if (!key) throw new Error("No active API key with realtime:subscribe scope is available to your role.");
  const topic = $("rt-topic").value.trim() || "db:*";
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${protocol}//${window.location.host}/v1/projects/${encodeURIComponent(slug)}/realtime/ws?apikey=${encodeURIComponent(key.raw_key)}`;
  updateRealtimeUi("connecting", `Connecting to ${topic}…`);
  appendRealtimeLog(`Connecting to ${slug} · ${topic}`);
  const socket = new WebSocket(url);
  state.ws = socket;
  socket.onopen = () => {
    if (state.ws !== socket) return;
    socket.send(JSON.stringify({ type: "subscribe", topic }));
    updateRealtimeUi("connected", `Connected · subscribed to ${topic}`);
    appendRealtimeLog({ type: "studio", status: "connected", topic });
  };
  socket.onmessage = (event) => {
    if (state.ws !== socket) return;
    try { appendRealtimeLog(JSON.parse(event.data)); } catch { appendRealtimeLog(event.data); }
  };
  socket.onerror = () => {
    if (state.ws !== socket) return;
    updateRealtimeUi("error", "The realtime connection encountered an error.");
  };
  socket.onclose = (event) => {
    if (state.ws !== socket) return;
    state.ws = null;
    updateRealtimeUi("disconnected", `Disconnected (${event.code}). You can reconnect at any time.`);
    appendRealtimeLog({ type: "studio", status: "disconnected", code: event.code, reason: event.reason || undefined });
  };
}

async function deleteProject() {
  const project = state.activeProject;
  if (!project) return;
  const confirmed = await confirmAction({
    title: `Delete ${project.name}?`,
    message: "This permanently deletes the project schema, application users, functions, API keys, and stored objects. This cannot be undone.",
    confirmLabel: "Delete project",
    requireText: project.slug,
  });
  if (!confirmed) return;
  await api(projectApi(""), { method: "DELETE", body: { confirmSlug: project.slug } });
  showToast(`${project.name} was permanently deleted.`, "success", "Project deleted");
  window.dispatchEvent(new CustomEvent("maary:project-deleted", { detail: { slug: project.slug } }));
}

export async function handleAction(action, element) {
  switch (action) {
    case "refresh-page":
      await loadPage();
      showToast("This view is up to date.", "success", "Refreshed");
      break;
    case "copy-text":
      await copyText(element.dataset.copy || "");
      break;
    case "copy-target": {
      const target = $(element.dataset.target);
      if (target) await copyText(target.textContent || target.value || "");
      break;
    }
    case "copy-credential":
      await copyText($("credential-value").textContent || "");
      break;
    case "focus-create-table": focusElement("tbl-name", "create-table-disclosure"); break;
    case "focus-create-bucket": focusElement("bucket-name", "create-bucket-disclosure"); break;
    case "focus-deploy-function": focusElement("fn-slug"); break;
    case "focus-create-job": focusElement("job-queue"); break;
    case "focus-create-key": focusElement("key-name"); break;
    case "create-backup-focus": focusElement("backup-name-input"); break;
    case "browse-table": await browseTable(element.dataset.table); break;
    case "refresh-rows":
      if (state.activeTable) await browseTable(state.activeTable);
      else showToast("Select a table first.", "warning");
      break;
    case "toggle-table-rls": {
      const tableName = element.dataset.table;
      const enabled = element.dataset.enabled !== "true";
      if (!enabled) {
        const confirmed = await confirmAction({ title: `Disable RLS on ${tableName}?`, message: "Clients may be able to access every row, depending on their database grants. Only continue if another access boundary is in place.", confirmLabel: "Disable RLS" });
        if (!confirmed) return;
      }
      await api(projectApi(`/database/tables/${encodeURIComponent(tableName)}/rls`), { method: "POST", body: { enabled, force: true } });
      showToast(`RLS ${enabled ? "enabled" : "disabled"} on ${tableName}.`);
      await loadPage("database");
      break;
    }
    case "apply-row-query":
      state.rowOffset = 0;
      await browseTable(state.activeTable);
      break;
    case "rows-prev":
      state.rowOffset = Math.max(0, state.rowOffset - (Number($("row-limit")?.value) || 50));
      await browseTable(state.activeTable);
      break;
    case "rows-next":
      state.rowOffset += Number($("row-limit")?.value) || 50;
      await browseTable(state.activeTable);
      break;
    case "edit-row": {
      let row;
      try {
        row = JSON.parse(element.dataset.row || "{}");
      } catch {
        throw new Error("The selected row could not be read.");
      }
      state.rowEdit = { table: element.dataset.table, filter: element.dataset.filter, row };
      $("row-dialog-title").textContent = `Edit row in ${element.dataset.table}`;
      $("row-edit-json").value = JSON.stringify(row, null, 2);
      $("row-dialog").showModal();
      break;
    }
    case "delete-row": {
      const confirmed = await confirmAction({
        title: "Delete this row?",
        message: "The row is permanently removed through the project data API. This cannot be undone.",
        confirmLabel: "Delete row",
      });
      if (!confirmed) return;
      await api(`${projectApi(`/rest/${encodeURIComponent(element.dataset.table)}`)}?${element.dataset.filter}`, { method: "DELETE" });
      showToast("Row deleted.");
      await browseTable(element.dataset.table);
      break;
    }
    case "drop-table": {
      const tableName = element.dataset.table;
      const confirmed = await confirmAction({ title: `Drop ${tableName}?`, message: "The table and all of its rows will be permanently removed.", confirmLabel: "Drop table", requireText: tableName });
      if (!confirmed) return;
      await api(projectApi(`/database/tables/${encodeURIComponent(tableName)}`), { method: "DELETE", body: { confirmName: tableName } });
      if (state.activeTable === tableName) state.activeTable = null;
      showToast(`${tableName} was dropped.`);
      await loadPage("database");
      break;
    }
    case "clear-sql":
      $("sql-editor-input").value = "";
      $("sql-result-box").innerHTML = "";
      $("sql-editor-input").focus();
      break;
    case "delete-policy": {
      const { table: tableName, policy } = element.dataset;
      const confirmed = await confirmAction({ title: `Delete ${policy}?`, message: `This removes the ${policy} policy from ${tableName}. Access may become broader or more restricted depending on remaining policies.`, confirmLabel: "Delete policy" });
      if (!confirmed) return;
      await api(projectApi(`/database/policies/${encodeURIComponent(tableName)}/${encodeURIComponent(policy)}`), { method: "DELETE" });
      showToast("RLS policy deleted.");
      await loadPage("sql");
      break;
    }
    case "rollback-migration": {
      const { version, name } = element.dataset;
      const confirmed = await confirmAction({ title: `Roll back ${name}?`, message: "The migration’s down SQL will run inside the project schema. Verify that it is safe for your current data.", confirmLabel: "Run rollback" });
      if (!confirmed) return;
      await api(projectApi(`/database/migrations/${encodeURIComponent(version)}/rollback`), { method: "POST" });
      showToast(`Migration ${version} rolled back.`);
      await loadPage("migrations");
      break;
    }
    case "verify-user":
      await api(projectApi(`/auth/admin/users/${encodeURIComponent(element.dataset.user)}`), { method: "PATCH", body: { emailVerified: true } });
      showToast("Email marked as verified.");
      await loadPage("auth");
      break;
    case "toggle-user-status": {
      const active = element.dataset.status !== "active";
      const confirmed = await confirmAction({ title: `${active ? "Activate" : "Suspend"} ${element.dataset.email}?`, message: active ? "The user will be able to authenticate again." : "Active sessions will be revoked and the user will no longer be able to sign in.", confirmLabel: active ? "Activate user" : "Suspend user", danger: !active });
      if (!confirmed) return;
      await api(projectApi(`/auth/admin/users/${encodeURIComponent(element.dataset.user)}`), { method: "PATCH", body: { status: active ? "active" : "suspended" } });
      showToast(`User ${active ? "activated" : "suspended"}.`);
      await loadPage("auth");
      break;
    }
    case "delete-user": {
      const confirmed = await confirmAction({ title: `Delete ${element.dataset.email}?`, message: "This permanently deletes the project identity and revokes its sessions.", confirmLabel: "Delete user" });
      if (!confirmed) return;
      await api(projectApi(`/auth/admin/users/${encodeURIComponent(element.dataset.user)}`), { method: "DELETE" });
      showToast("Project user deleted.");
      await loadPage("auth");
      break;
    }
    case "open-bucket": await openBucket(element.dataset.bucket); break;
    case "toggle-bucket-visibility": {
      const bucketName = element.dataset.bucket;
      const makePublic = element.dataset.public !== "true";
      if (makePublic) {
        const confirmed = await confirmAction({ title: `Make ${bucketName} public?`, message: "Anyone with the object URL may be able to read files in this bucket.", confirmLabel: "Make public" });
        if (!confirmed) return;
      }
      await api(projectApi(`/storage/buckets/${encodeURIComponent(bucketName)}`), { method: "PATCH", body: { public: makePublic } });
      showToast(`${bucketName} is now ${makePublic ? "public" : "private"}.`);
      await loadPage("storage");
      break;
    }
    case "delete-bucket": {
      const bucketName = element.dataset.bucket;
      const confirmed = await confirmAction({ title: `Delete ${bucketName}?`, message: "The bucket and all objects in it will be permanently deleted.", confirmLabel: "Delete bucket and objects", requireText: bucketName });
      if (!confirmed) return;
      await api(projectApi(`/storage/buckets/${encodeURIComponent(bucketName)}?force=true`), { method: "DELETE" });
      if (state.activeBucket === bucketName) state.activeBucket = null;
      showToast(`${bucketName} deleted.`);
      await loadPage("storage");
      break;
    }
    case "download-object": {
      const { bucket, path } = element.dataset;
      const result = await api(projectApi(`/storage/buckets/${encodeURIComponent(bucket)}/sign/${encodePath(path)}`), { method: "POST", body: { operation: "download", expiresIn: 300 } });
      const anchor = document.createElement("a");
      anchor.href = result.signedUrl;
      anchor.download = path.split("/").pop() || "download";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      showToast("Secure download link created. It expires in 5 minutes.", "success", "Download started");
      break;
    }
    case "delete-object": {
      const { bucket, path } = element.dataset;
      const confirmed = await confirmAction({ title: "Delete object?", message: `${path} will be permanently removed from ${bucket}.`, confirmLabel: "Delete object" });
      if (!confirmed) return;
      await api(projectApi(`/storage/buckets/${encodeURIComponent(bucket)}/objects/${encodePath(path)}`), { method: "DELETE" });
      showToast("Object deleted.");
      await loadPage("storage");
      break;
    }
    case "edit-function": {
      const fn = state.functions.find((item) => item.slug === element.dataset.slug);
      if (!fn) return;
      activateLocalTab("functions");
      $("fn-slug").value = fn.slug;
      $("fn-name").value = fn.name || "";
      $("fn-jwt").value = String(fn.verify_jwt);
      $("fn-timeout").value = fn.timeout_ms;
      $("fn-code").value = fn.code;
      focusElement("fn-code");
      showToast(`Editing ${fn.slug}. Deploy to create version ${Number(fn.version) + 1}.`, "info", "Function loaded");
      break;
    }
    case "reset-function-form": $("deploy-fn-form").reset(); break;
    case "delete-function": {
      const slug = element.dataset.slug;
      const confirmed = await confirmAction({ title: `Delete ${slug}?`, message: "The function endpoint will stop accepting invocations. Existing queued jobs targeting it may fail.", confirmLabel: "Delete function" });
      if (!confirmed) return;
      await api(projectApi(`/functions/${encodeURIComponent(slug)}`), { method: "DELETE" });
      showToast(`${slug} deleted.`);
      await loadPage("functions");
      break;
    }
    case "process-jobs": {
      const result = await api(projectApi("/jobs/process"), { method: "POST", body: { limit: 20 } });
      showToast(`${result.count} due job(s) processed.`, "success", "Queue processed");
      await loadPage("functions");
      break;
    }
    case "cancel-job":
      await api(projectApi(`/jobs/${encodeURIComponent(element.dataset.id)}/cancel`), { method: "POST" });
      showToast("Job cancelled.");
      await loadPage("jobs");
      break;
    case "delete-schedule": {
      const confirmed = await confirmAction({ title: `Delete ${element.dataset.name}?`, message: "This recurring schedule will no longer enqueue jobs.", confirmLabel: "Delete schedule" });
      if (!confirmed) return;
      await api(projectApi(`/schedules/${encodeURIComponent(element.dataset.id)}`), { method: "DELETE" });
      showToast("Schedule deleted.");
      await loadPage("jobs");
      break;
    }
    case "rt-disconnect": closeRealtime(); break;
    case "clear-realtime-log": $("rt-stream-log").textContent = "Waiting for a realtime connection…"; break;
    case "toggle-secrets":
      state.revealSecrets = !state.revealSecrets;
      await loadPage("settings");
      break;
    case "rotate-key": {
      const confirmed = await confirmAction({ title: `Rotate ${element.dataset.name}?`, message: "The current credential will be revoked immediately. Update every application using it with the replacement key.", confirmLabel: "Rotate key" });
      if (!confirmed) return;
      const result = await api(projectApi(`/api-keys/${encodeURIComponent(element.dataset.id)}/rotate`), { method: "POST" });
      showCredentials("Replacement API key", result.apiKey.raw_key);
      await loadPage("api");
      break;
    }
    case "revoke-key": {
      const confirmed = await confirmAction({ title: `Revoke ${element.dataset.name}?`, message: "Applications using this credential will immediately lose access.", confirmLabel: "Revoke key" });
      if (!confirmed) return;
      await api(projectApi(`/api-keys/${encodeURIComponent(element.dataset.id)}`), { method: "DELETE" });
      showToast("API key revoked.");
      await loadPage("api");
      break;
    }
    case "delete-secret": {
      const confirmed = await confirmAction({ title: `Delete ${element.dataset.name}?`, message: "Functions using this environment secret will no longer receive it.", confirmLabel: "Delete secret" });
      if (!confirmed) return;
      await api(projectApi(`/secrets/${encodeURIComponent(element.dataset.id)}`), { method: "DELETE" });
      showToast("Secret deleted.");
      await loadPage("settings");
      break;
    }
    case "remove-member": {
      const confirmed = await confirmAction({ title: `Remove ${element.dataset.email}?`, message: "This operator will lose access to the project control plane. Their platform account remains active.", confirmLabel: "Remove member" });
      if (!confirmed) return;
      await api(projectApi(`/members/${encodeURIComponent(element.dataset.user)}`), { method: "DELETE" });
      showToast("Team member removed.");
      await loadPage("settings");
      break;
    }
    case "delete-environment": {
      const confirmed = await confirmAction({ title: `Delete ${element.dataset.name}?`, message: "This removes the environment configuration. Project data in the shared schema is not deleted.", confirmLabel: "Delete environment" });
      if (!confirmed) return;
      await api(projectApi(`/environments/${encodeURIComponent(element.dataset.id)}`), { method: "DELETE" });
      showToast("Environment deleted.");
      await loadPage(state.activeTab === "settings" ? "settings" : "overview");
      break;
    }
    case "verify-backup": {
      const result = await api(projectApi(`/backups/${encodeURIComponent(element.dataset.id)}/verify`), { method: "POST" });
      showToast(result.valid === false ? "The backup checksum did not match." : "SHA-256 integrity verification passed.", result.valid === false ? "error" : "success", result.valid === false ? "Verification failed" : "Backup verified");
      break;
    }
    case "restore-backup": {
      const confirmed = await confirmAction({ title: `Restore ${element.dataset.name}?`, message: "The current project schema and related data will be replaced by this snapshot. Create a fresh backup before continuing.", confirmLabel: "Restore backup", requireText: "RESTORE" });
      if (!confirmed) return;
      await api(projectApi(`/backups/${encodeURIComponent(element.dataset.id)}/restore`), { method: "POST", timeout: 120_000 });
      showToast("Backup verified and restored successfully.", "success", "Restore complete");
      await loadPage("backups");
      break;
    }
    case "download-openapi":
      if (window.__maaryOpenApi) downloadText(`${state.activeProject.slug}-openapi.json`, JSON.stringify(window.__maaryOpenApi, null, 2));
      break;
    case "disable-oauth-provider": {
      const providerName = element.dataset.provider;
      const confirmed = await confirmAction({ title: `Disable ${providerName}?`, message: "New OAuth authorizations for this provider will stop until it is enabled again. Existing linked identities remain.", confirmLabel: "Disable provider" });
      if (!confirmed) return;
      const current = {
        ...(state.authConfig?.oauth_providers || {}),
        [providerName]: { ...(state.authConfig?.oauth_providers?.[providerName] || {}), enabled: false },
      };
      await api(projectApi("/auth/config"), { method: "PATCH", body: { oauth_providers: current } });
      showToast(`${providerName} disabled.`);
      await loadPage("auth");
      break;
    }
    case "delete-project": await deleteProject(); break;
    default: break;
  }
}

const submitHandlers = {
  "alter-table-form": async () => {
    const tableName = $("alter-table-name").value.trim();
    const action = $("alter-operation").value;
    const columnName = $("alter-column").value.trim();
    const newName = $("alter-new-name").value.trim();
    const columnType = $("alter-type").value.trim();
    if (!tableName) throw new Error("Select a table before altering it.");
    let body;
    if (action === "add_column") {
      if (!columnName) throw new Error("Enter the column name to add.");
      body = { action, column: { name: columnName, type: columnType || "text", notNull: false } };
    } else if (action === "drop_column") {
      if (!columnName) throw new Error("Enter the column to drop.");
      body = { action, columnName };
    } else if (action === "rename_column") {
      if (!columnName || !newName) throw new Error("Renaming needs the current and new column names.");
      body = { action, fromName: columnName, toName: newName };
    } else if (action === "create_index") {
      if (!columnName) throw new Error("Choose the column to index.");
      body = {
        action,
        indexName: newName || `${tableName}_${columnName}_idx`,
        columns: [columnName],
        unique: $("alter-unique").checked,
      };
    } else {
      const indexName = newName || columnName;
      if (!indexName) throw new Error("Enter the index name to drop.");
      body = { action, indexName };
    }
    await api(projectApi(`/database/tables/${encodeURIComponent(tableName)}`), { method: "PATCH", body });
    showToast(`Schema change applied to ${tableName}.`);
    $("alter-table-form").reset();
    await loadPage("database");
  },
  "row-edit-form": async () => {
    const edit = state.rowEdit;
    if (!edit) throw new Error("Select a row to edit first.");
    const payload = parseJson($("row-edit-json").value, "Row JSON");
    if (!payload || Array.isArray(payload) || typeof payload !== "object") throw new Error("Row data must be a single JSON object.");
    delete payload[edit.filter.split("=")[0]];
    await api(`${projectApi(`/rest/${encodeURIComponent(edit.table)}`)}?${edit.filter}`, { method: "PATCH", body: payload });
    closeDialog("row-dialog");
    state.rowEdit = null;
    showToast("Row updated.");
    await browseTable(edit.table);
  },
  "oauth-provider-form": async () => {
    const provider = $("oauth-provider").value;
    const clientId = $("oauth-client-id").value.trim();
    if (!clientId) throw new Error("Enter the OAuth client ID.");
    const scopes = $("oauth-scopes").value.split(",").map((scope) => scope.trim()).filter(Boolean);
    const definition = {
      enabled: $("oauth-enabled").checked,
      clientId,
      scopes: scopes.length ? scopes : ["openid", "email", "profile"],
    };
    const authorizeUrl = $("oauth-authorize-url").value.trim();
    const tokenUrl = $("oauth-token-url").value.trim();
    if (authorizeUrl) definition.authorizeUrl = authorizeUrl;
    if (tokenUrl) definition.tokenUrl = tokenUrl;
    if (provider === "custom" && !authorizeUrl) throw new Error("A custom OIDC provider needs an authorize URL.");
    const providers = { ...(state.authConfig?.oauth_providers || {}), [provider]: definition };
    await api(projectApi("/auth/config"), { method: "PATCH", body: { oauth_providers: providers } });
    showToast(`${provider} identity provider saved.`);
    $("oauth-provider-form").reset();
    await loadPage("auth");
  },
  "create-project-form": async () => {
    const result = await api("/v1/projects", { method: "POST", body: { name: $("proj-name").value, slug: $("proj-slug").value || undefined, description: $("proj-desc").value } });
    closeDialog("new-project-dialog");
    $("create-project-form").reset();
    state.slugTouched = false;
    const keys = result.apiKeys || {};
    showCredentials("Project credentials", `Project: ${result.project.slug}\n\nAnon key (safe for clients with RLS):\n${keys.anonKey || "See Security & Team"}\n\nService-role key (server only — bypasses RLS):\n${keys.serviceRoleKey || "See Security & Team"}`);
    window.dispatchEvent(new CustomEvent("maary:project-created", { detail: { slug: result.project.slug } }));
  },
  "create-env-form": async () => {
    await api(projectApi("/environments"), { method: "POST", body: { name: $("env-name-input").value, isProduction: $("env-production").checked } });
    showToast("Environment added.");
    await loadPage("overview");
  },
  "create-table-form": async () => {
    const tableName = $("tbl-name").value.trim();
    const columns = parseJson($("tbl-cols").value, "Column definitions");
    if (!Array.isArray(columns)) throw new Error("Column definitions must be a JSON array.");
    await api(projectApi("/database/tables"), { method: "POST", body: { name: tableName, columns, enableRls: $("tbl-rls").value === "true" } });
    state.activeTable = tableName;
    $("create-table-disclosure").open = false;
    showToast(`${tableName} created successfully.`);
    await loadPage("database");
  },
  "insert-row-form": async () => {
    if (!state.activeTable) throw new Error("Select a table before inserting a row.");
    const payload = parseJson($("row-json-input").value, "Row data");
    if (!payload || Array.isArray(payload) || typeof payload !== "object") throw new Error("Row data must be one JSON object.");
    await api(projectApi(`/rest/${encodeURIComponent(state.activeTable)}`), { method: "POST", body: payload });
    $("row-json-input").value = "";
    showToast("Row inserted.");
    const tableResponse = await api(projectApi("/database/tables"));
    state.tables = tableResponse.tables || [];
    await browseTable(state.activeTable);
  },
  "sql-form": async () => {
    const sql = $("sql-editor-input").value.trim();
    if (!sql) throw new Error("Enter a SQL statement to run.");
    const role = $("sql-role-select").value;
    const userId = $("sql-user-id").value.trim();
    try {
      const result = await api(projectApi("/database/sql"), { method: "POST", body: { sql, allowDestructive: $("sql-destructive").value === "true", impersonate: role === "service_role" ? undefined : { role, userId: userId || undefined } }, timeout: 60_000 });
      renderSqlResult(result);
      rememberSql(sql);
    } catch (error) {
      $("sql-result-box").innerHTML = `<div class="notice danger">${"<svg class=\"icon\"><use href=\"#i-alert\"></use></svg>"}<p>${esc(error.message)}</p></div>`;
      throw error;
    }
  },
  "create-policy-form": async () => {
    await api(projectApi("/database/policies"), { method: "POST", body: { tableName: $("pol-table").value, policyName: $("pol-name").value, command: $("pol-cmd").value, usingExpression: $("pol-using").value || null, checkExpression: $("pol-check").value || null, enableRlsOnTable: $("pol-enable-rls").checked } });
    showToast("RLS policy created.");
    await loadPage("access");
  },
  "apply-migration-form": async () => {
    await api(projectApi("/database/migrations"), { method: "POST", body: { version: $("mig-version").value, name: $("mig-name").value, upSql: $("mig-up").value, downSql: $("mig-down").value }, timeout: 60_000 });
    showToast("Migration applied and checksummed.");
    await loadPage("migrations");
  },
  "admin-create-user-form": async () => {
    await api(projectApi("/auth/admin/users"), { method: "POST", body: { email: $("u-email").value, password: $("u-pass").value, role: $("u-role").value, emailVerified: $("u-verified").checked } });
    $("admin-create-user-form").reset();
    $("u-role").value = "authenticated";
    $("u-verified").checked = true;
    showToast("Project user created.");
    await loadPage("auth");
  },
  "auth-config-form": async () => {
    await api(projectApi("/auth/config"), { method: "PATCH", body: { allow_public_signup: $("cfg-public-signup").value === "true", require_email_verification: $("cfg-email-verify").value === "true", password_min_length: Number($("cfg-pass-len").value), access_token_ttl_seconds: Number($("cfg-access-ttl").value), refresh_token_ttl_seconds: Number($("cfg-refresh-ttl").value) } });
    showToast("Authentication policy saved.");
  },
  "create-bucket-form": async () => {
    const name = $("bucket-name").value.trim();
    await api(projectApi("/storage/buckets"), { method: "POST", body: { name, public: $("bucket-public").value === "true", fileSizeLimitBytes: Number($("bucket-limit").value) * 1024 * 1024 } });
    state.activeBucket = name;
    $("create-bucket-form").reset();
    $("create-bucket-disclosure").open = false;
    showToast(`${name} bucket created.`);
    await loadPage("storage");
  },
  "upload-object-form": async () => {
    if (!state.activeBucket) throw new Error("Select a bucket before uploading.");
    const path = $("obj-path").value.trim();
    const file = $("obj-file").files[0];
    const text = $("obj-content").value;
    if (!file && !text) throw new Error("Choose a file or enter text content to upload.");
    const endpoint = projectApi(`/storage/buckets/${encodeURIComponent(state.activeBucket)}/objects/${encodePath(path)}`);
    if (file) {
      await api(endpoint, { method: "POST", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file, timeout: 120_000 });
    } else {
      await api(endpoint, { method: "POST", body: { content: text, mimeType: $("obj-mime").value || "text/plain", upsert: true } });
    }
    $("upload-object-form").reset();
    $("obj-mime").value = "text/plain";
    $("obj-file-label").textContent = "Any file type allowed by the selected bucket";
    showToast(`${path} uploaded.`);
    await loadPage("storage");
  },
  "deploy-fn-form": async () => {
    const slug = $("fn-slug").value.trim();
    await api(projectApi("/functions"), { method: "POST", body: { slug, name: $("fn-name").value || slug, verifyJwt: $("fn-jwt").value === "true", timeoutMs: Number($("fn-timeout").value), code: $("fn-code").value }, timeout: 60_000 });
    showToast(`${slug} deployed successfully.`);
    await loadPage("functions");
  },
  "invoke-fn-form": async () => {
    const slug = $("fn-invoke-slug").value;
    if (!slug) throw new Error("Deploy and select a function first.");
    const payload = parseJson($("fn-payload").value, "Invocation payload");
    $("fn-invoke-output").textContent = "Invoking function…";
    try {
      const result = await api(projectApi(`/functions/${encodeURIComponent(slug)}/invoke`), { method: "POST", body: payload, timeout: 70_000 });
      $("fn-invoke-output").textContent = JSON.stringify(result, null, 2);
    } catch (error) {
      $("fn-invoke-output").textContent = `Invocation failed\n\n${error.message}`;
      throw error;
    }
  },
  "create-job-form": async () => {
    await api(projectApi("/jobs"), { method: "POST", body: { jobType: $("job-type").value, queueName: $("job-queue").value, delaySeconds: Number($("job-delay").value), payload: parseJson($("job-payload").value, "Job payload") } });
    showToast("Background job enqueued.");
    await loadPage("jobs");
  },
  "create-schedule-form": async () => {
    await api(projectApi("/schedules"), { method: "POST", body: { name: $("schedule-name").value, jobType: $("schedule-type").value, intervalSeconds: Number($("schedule-interval").value), targetSlug: $("schedule-target").value || undefined, payload: parseJson($("schedule-payload").value, "Schedule payload") } });
    showToast("Recurring schedule created.");
    await loadPage("jobs");
  },
  "rt-connect-form": connectRealtime,
  "rt-broadcast-form": async () => {
    await api(projectApi("/realtime/broadcast"), { method: "POST", body: { topic: $("rt-broadcast-topic").value, event: $("rt-event").value, payload: parseJson($("rt-payload").value, "Broadcast payload") } });
    showToast("Broadcast published.");
    await loadPage("realtime");
  },
  "create-key-form": async () => {
    const result = await api(projectApi("/api-keys"), { method: "POST", body: { name: $("key-name").value, role: $("key-role").value, scopes: $("key-scopes").value.split(",").map((scope) => scope.trim()).filter(Boolean) } });
    $("create-key-form").reset();
    showCredentials("API key generated", result.apiKey.raw_key);
    await loadPage("api");
  },
  "create-secret-form": async () => {
    await api(projectApi("/secrets"), { method: "POST", body: { name: $("sec-name").value, value: $("sec-val").value, description: $("sec-description").value } });
    $("create-secret-form").reset();
    showToast("Secret encrypted and saved.");
    await loadPage("settings");
  },
  "add-member-form": async () => {
    await api(projectApi("/members"), { method: "POST", body: { email: $("member-email").value, role: $("member-role").value } });
    $("add-member-form").reset();
    showToast("Project membership saved.");
    await loadPage("settings");
  },
  "create-backup-form": async () => {
    await api(projectApi("/backups"), { method: "POST", body: { name: $("backup-name-input").value || undefined }, timeout: 120_000 });
    $("backup-name-input").value = "";
    showToast("Project snapshot created.", "success", "Backup complete");
    await loadPage("backups");
  },
  "project-settings-form": async () => {
    const result = await api(projectApi(""), { method: "PATCH", body: { name: $("settings-name").value, description: $("settings-description").value, status: $("settings-status").value } });
    state.activeProject = result.project;
    showToast("Project settings saved.");
    window.dispatchEvent(new CustomEvent("maary:projects-refresh", { detail: { slug: result.project.slug } }));
  },
  "apk-build-form": async () => {
    const output = $("apk-build-output");
    output.innerHTML = `<div class="notice">${icon("realtime")}<p>Starting the Gradle build on the server. This can take several minutes on a cold cache.</p></div>`;
    try {
      const result = await api("/v1/platform/apk/build", { method: "POST", body: { versionName: $("apk-version-name").value, versionCode: Number($("apk-version-code").value) }, timeout: 900_000 });
      output.innerHTML = `<div class="notice success">${icon("check")}<p>Gradle build succeeded.<br><span class="mono">SHA-256: ${esc(result.build.artifact.checksumSha256)}</span><br>${formatBytesInline(result.build.artifact.sizeBytes)} · ${Math.round(result.build.durationMs / 1000)}s</p></div><a class="btn btn-primary section-gap" href="/v1/platform/apk/download">${icon("download")}Download ${esc(result.build.artifact.fileName)}</a>`;
      showToast("Android package built from source by Gradle.", "success", "Build complete");
    } catch (error) {
      if (error.code === "apk_build_unavailable") {
        const details = error.details || {};
        output.innerHTML = `<div class="notice warning">${icon("alert")}<p><strong>This host cannot run a Gradle build.</strong><br>Missing: ${esc((details.missingPrerequisites || []).join(", ") || "Android toolchain")}<br>${esc(details.instructions || "")}</p></div>`;
      } else if (error.code === "apk_build_failed" && error.details?.logTail) {
        output.innerHTML = `<div class="notice danger">${icon("alert")}<p><strong>Gradle build failed.</strong> ${esc(error.message)}</p></div><pre class="code-block">${esc(error.details.logTail.slice(-40).join("\n"))}</pre>`;
      } else {
        output.innerHTML = `<div class="notice danger">${icon("alert")}<p>${esc(error.message)}</p></div>`;
      }
      throw error;
    }
  },
  "api-test-form": async () => {
    const method = $("api-test-method").value;
    const path = $("api-test-path").value.trim();
    const apiKey = $("api-test-key").value;
    const resultBox = $("api-test-result");
    const metaBox = $("api-test-meta");
    if (!path) throw new Error("Enter a path or URL to request.");
    const slug = state.activeProject?.slug;
    const url = /^https?:\/\//i.test(path) ? path : `${window.location.origin}/v1/projects/${encodeURIComponent(slug)}${path.startsWith("/") ? "" : "/"}${path}`;
    const headers = { Accept: "application/json" };
    if (apiKey) headers.apikey = apiKey;
    else if (state.token) headers.Authorization = `Bearer ${state.token}`;
    let body;
    if (["POST", "PATCH", "PUT"].includes(method)) {
      const raw = $("api-test-body").value.trim();
      body = raw || undefined;
      if (body) headers["Content-Type"] = "application/json";
    }
    const started = performance.now();
    resultBox.textContent = "Sending request…";
    metaBox.innerHTML = "";
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(url, { method, headers, body, signal: controller.signal });
      const text = await response.text();
      let pretty = text;
      try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch { /* Keep raw text. */ }
      metaBox.innerHTML = `${badge(response.status < 400 ? "success" : "error", response.status < 400 ? "success" : "danger", `HTTP ${response.status}`)}<span>${Math.round(performance.now() - started)} ms</span><span class="mono">${esc(method)} ${esc(url)}</span>`;
      resultBox.textContent = pretty || "(empty response)";
    } catch (error) {
      metaBox.innerHTML = `${badge("network_error", "danger")}`;
      resultBox.textContent = error.name === "AbortError" ? "The request timed out after 30 seconds." : String(error.message || error);
    } finally {
      window.clearTimeout(timer);
    }
  },
};

export async function handleSubmit(form) {
  const handler = submitHandlers[form.id];
  if (handler) await handler(form);
}

export async function handleChange(element) {
  if (element.dataset.changeAction === "change-user-role") {
    await api(projectApi(`/auth/admin/users/${encodeURIComponent(element.dataset.user)}`), { method: "PATCH", body: { role: element.value } });
    showToast("User role updated.");
    await loadPage("auth");
    return;
  }
  switch (element.id) {
    case "sql-history": {
      const history = readSqlHistory();
      if (element.value !== "" && history[Number(element.value)]) $("sql-editor-input").value = history[Number(element.value)];
      break;
    }
    case "job-status-filter": await loadPage("jobs"); break;
    case "log-source":
    case "log-level":
    case "log-limit": await loadPage("logs"); break;
    case "row-order-column":
    case "row-order-direction":
    case "row-filter-column": {
      state.rowOffset = 0;
      if (state.activeTable) await browseTable(state.activeTable);
      break;
    }
    case "obj-file": {
      const file = element.files[0];
      if (file) {
        $("obj-file-label").textContent = `${file.name} · ${(file.size / 1024).toFixed(1)} KB`;
        if (!$("obj-path").value.trim()) $("obj-path").value = file.name;
        if (file.type) $("obj-mime").value = file.type;
        $("obj-content").value = "";
      } else $("obj-file-label").textContent = "Any file type allowed by the selected bucket";
      break;
    }
    default: break;
  }
}

const debouncedUserSearch = debounce(() => loadPage("auth").catch(reportError), 350);
const debouncedObjectFilter = debounce(() => state.activeBucket && openBucket(state.activeBucket).catch(reportError), 300);

export function handleInput(element) {
  switch (element.id) {
    case "table-search": renderTablesList(); break;
    case "auth-user-search": debouncedUserSearch(); break;
    case "object-prefix": debouncedObjectFilter(); break;
    default: break;
  }
}
