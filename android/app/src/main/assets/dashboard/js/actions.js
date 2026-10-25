import {
  $, api, closeDialog, confirmAction, copyText, debounce,
  downloadCsv, downloadText, esc, formatDate, openDialog, parseJson, projectApi, reportError,
  showCredentials, showToast, state, storageAdapter,
} from "./core.js";
import {
  appendRealtimeLog, browseTable, buildColumnFormFields, collectColumnFormPayload,
  loadPage, openBucket, renderSavedQueries, renderSqlResult,
  renderTablesList, renderVisualColumnsBuilder, updateRealtimeUi, updateSavedQueryLabel,
} from "./pages.js";

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
  if (disclosureId && $(disclosureId)) $(disclosureId).open = true;
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

function readCollapsedNavSections() {
  try {
    const saved = JSON.parse(storageAdapter.get("maary_nav_sections") || "[]");
    return Array.isArray(saved) ? saved : [];
  } catch { return []; }
}

export function applyNavSectionState() {
  const collapsed = new Set(readCollapsedNavSections());
  document.querySelectorAll(".nav-section[data-nav-section]").forEach((section) => {
    const isCollapsed = collapsed.has(section.dataset.navSection);
    section.classList.toggle("collapsed", isCollapsed);
    section.querySelector(".nav-section-head")?.setAttribute("aria-expanded", String(!isCollapsed));
  });
}

function toggleNavSection(button) {
  const section = button.closest(".nav-section[data-nav-section]");
  if (!section) return;
  const key = section.dataset.navSection;
  const collapsed = new Set(readCollapsedNavSections());
  if (collapsed.has(key)) collapsed.delete(key);
  else collapsed.add(key);
  storageAdapter.set("maary_nav_sections", JSON.stringify([...collapsed]));
  applyNavSectionState();
}

function activeTableInfo() {
  return state.tables.find((item) => item.name === state.activeTable) || null;
}

function openInsertRowDialog() {
  const tableInfo = activeTableInfo();
  if (!tableInfo) throw new Error("Select a table before inserting a row.");
  $("insert-row-subtitle").textContent = `${state.activeProject?.name || "Project"} · ${tableInfo.name}`;
  $("insert-row-columns").innerHTML = buildColumnFormFields(tableInfo.columns, null, "ins-col");
  openDialog("insert-row-dialog");
  window.setTimeout(() => $("insert-row-columns").querySelector("input, select, textarea")?.focus(), 30);
}

function openSaveQueryDialog(existing = null) {
  const editor = $("sql-editor-input");
  $("save-query-id").value = existing?.id || "";
  $("save-query-name").value = existing?.name || "";
  $("save-query-description").value = existing?.description || "";
  $("save-query-favorite").checked = Boolean(existing?.favorite);
  $("save-query-sql").value = existing?.sql || editor?.value || "";
  $("save-query-title").textContent = existing ? "Update saved query" : "Save query";
  openDialog("save-query-dialog");
  window.setTimeout(() => $("save-query-name").focus(), 30);
}

async function refreshSavedQueries() {
  const response = await api(projectApi("/database/queries"));
  state.savedQueries = response.queries || [];
  renderSavedQueries();
  updateSavedQueryLabel();
}

async function resolveProjectKeyByRole(role = "anon") {
  const keysResponse = await api(`${projectApi("/api-keys")}?reveal=true`);
  const list = (keysResponse.apiKeys || []).filter((k) => !k.revoked_at && k.raw_key);
  const exact = list.find((k) => k.role === role);
  if (exact) return exact.raw_key;
  const fallback = list[0];
  if (!fallback) throw new Error(`No active ${role} API key is available. Generate one in Security & Keys.`);
  return fallback.raw_key;
}

export function closeRealtime() {
  if (state.ws) {
    const socket = state.ws;
    state.ws = null;
    socket.onclose = null;
    socket.close(1000, "Studio disconnect");
  }
  updateRealtimeUi("disconnected", "Disconnected. Choose a topic and connect to stream live events.");
}

async function connectRealtime() {
  const slug = state.activeProject?.slug;
  if (!slug) return;
  closeRealtime();
  updateRealtimeUi("connecting", "Resolving scoped realtime credential…");
  const keysResponse = await api(`${projectApi("/api-keys")}?reveal=true`);
  const key = (keysResponse.apiKeys || []).find((item) => !item.revoked_at && item.raw_key && (item.role === "service_role" || item.scopes?.includes("*") || item.scopes?.includes("realtime:subscribe")));
  if (!key) throw new Error("No active API key with realtime:subscribe scope is available.");
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
    updateRealtimeUi("error", "The realtime WebSocket encountered a connection error.");
  };
  socket.onclose = (event) => {
    if (state.ws !== socket) return;
    state.ws = null;
    updateRealtimeUi("disconnected", `Disconnected (${event.code}). Reconnect at any time.`);
    appendRealtimeLog({ type: "studio", status: "disconnected", code: event.code, reason: event.reason || undefined });
  };
}

async function deleteProject() {
  const project = state.activeProject;
  if (!project) return;
  const confirmed = await confirmAction({
    title: `Delete ${project.name}?`,
    message: "This permanently drops the PostgreSQL schema, execution roles, application users, functions, API keys, and stored objects.",
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
      showToast("View refreshed with live server state.", "success", "Refreshed");
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
    case "focus-deploy-function": activateLocalTab("functions"); focusElement("fn-slug"); break;
    case "focus-create-key": activateLocalTab("keys"); focusElement("key-name"); break;
    case "create-backup-focus": activateLocalTab("backups-main"); focusElement("backup-name-input"); break;
    case "toggle-nav-section": toggleNavSection(element); break;
    case "open-insert-row": openInsertRowDialog(); break;
    case "copy-row-json": {
      const row = state.rowBrowser.rows[Number(element.dataset.idx)];
      if (row) await copyText(JSON.stringify(row, null, 2), "Row copied as JSON");
      break;
    }
    case "export-rows-csv": {
      if (!state.rowBrowser.rows.length) throw new Error("There are no loaded rows to export.");
      downloadCsv(`${state.activeTable || "rows"}-offset-${state.rowBrowser.offset}.csv`, state.rowBrowser.rows);
      showToast(`${state.rowBrowser.rows.length} row(s) exported as CSV.`, "success", "Export ready");
      break;
    }

    // Organizations
    case "select-org-detail":
      state.activeOrgSlug = element.dataset.slug || "";
      storageAdapter.set("maary_active_org", state.activeOrgSlug);
      window.dispatchEvent(new CustomEvent("maary:orgs-refresh"));
      await loadPage("organizations");
      break;
    case "delete-org": {
      const { slug, name } = element.dataset;
      const confirmed = await confirmAction({
        title: `Delete workspace ${name}?`,
        message: "Projects in this workspace will remain intact and become unassigned, while workspace team memberships are removed.",
        confirmLabel: "Delete workspace",
        requireText: slug,
      });
      if (!confirmed) return;
      await api(`/v1/organizations/${encodeURIComponent(slug)}`, { method: "DELETE", body: { confirmSlug: slug } });
      if (state.activeOrgSlug === slug) {
        state.activeOrgSlug = "";
        storageAdapter.remove("maary_active_org");
      }
      showToast(`${name} workspace deleted.`);
      window.dispatchEvent(new CustomEvent("maary:orgs-refresh"));
      await loadPage("organizations");
      break;
    }
    case "remove-org-member": {
      const { org, user, email } = element.dataset;
      const confirmed = await confirmAction({ title: `Remove ${email}?`, message: "They will lose inherited access to projects in this workspace.", confirmLabel: "Remove member" });
      if (!confirmed) return;
      await api(`/v1/organizations/${encodeURIComponent(org)}/members/${encodeURIComponent(user)}`, { method: "DELETE" });
      showToast("Workspace member removed.");
      await loadPage("organizations");
      break;
    }
    case "switch-project":
      window.dispatchEvent(new CustomEvent("maary:select-project", { detail: { slug: element.dataset.slug, tab: "overview" } }));
      break;

    // Visual column builder & table operations
    case "add-visual-col":
      state.visualColumns.push({ name: "", type: "text", primaryKey: false, nullable: true, defaultValue: "" });
      renderVisualColumnsBuilder();
      break;
    case "remove-visual-col": {
      const idx = Number(element.dataset.idx);
      if (state.visualColumns.length > 1) {
        state.visualColumns.splice(idx, 1);
        renderVisualColumnsBuilder();
      }
      break;
    }
    case "browse-table": await browseTable(element.dataset.table); break;
    case "refresh-rows":
      if (state.activeTable) await browseTable(state.activeTable);
      else showToast("Select a table first.", "warning");
      break;
    case "clear-row-filter":
      state.rowBrowser.filter = "";
      state.rowBrowser.orderBy = "";
      state.rowBrowser.offset = 0;
      if ($("row-filter-input")) $("row-filter-input").value = "";
      if ($("row-sort-col")) $("row-sort-col").value = "";
      if (state.activeTable) await browseTable(state.activeTable);
      break;
    case "rows-prev-page":
      state.rowBrowser.offset = Math.max(0, state.rowBrowser.offset - state.rowBrowser.limit);
      if (state.activeTable) await browseTable(state.activeTable);
      break;
    case "rows-next-page":
      state.rowBrowser.offset += state.rowBrowser.limit;
      if (state.activeTable) await browseTable(state.activeTable);
      break;
    case "open-edit-row": {
      const row = state.rowBrowser.rows[Number(element.dataset.idx)];
      const pkCol = element.dataset.pkCol;
      if (!row || !pkCol) return;
      $("edit-row-pk-col").value = pkCol;
      $("edit-row-pk-val").value = String(row[pkCol]);
      $("edit-row-subtitle").textContent = `${state.activeTable} · ${pkCol} = ${row[pkCol]}`;
      const tableInfo = activeTableInfo();
      const editableColumns = (tableInfo?.columns || []).filter((col) => col.name !== pkCol);
      $("edit-row-columns").innerHTML = editableColumns.length
        ? buildColumnFormFields(editableColumns, row, "edit-col")
        : `<p class="subtle">No column metadata available — edit the raw JSON payload below.</p>`;
      const editable = { ...row };
      delete editable[pkCol];
      $("edit-row-json").value = "";
      $("edit-row-json").placeholder = JSON.stringify(editable, null, 2);
      openDialog("edit-row-dialog");
      window.setTimeout(() => $("edit-row-columns").querySelector("input, select, textarea")?.focus(), 30);
      break;
    }
    case "delete-row": {
      const { pkCol, pkVal } = element.dataset;
      const confirmed = await confirmAction({ title: "Delete row?", message: `Delete row where ${pkCol} = ${pkVal} from ${state.activeTable}?`, confirmLabel: "Delete row" });
      if (!confirmed) return;
      await api(projectApi(`/rest/${encodeURIComponent(state.activeTable)}?${encodeURIComponent(pkCol)}=eq.${encodeURIComponent(pkVal)}`), { method: "DELETE" });
      showToast("Row deleted.");
      await loadPage("database");
      break;
    }
    case "drop-column": {
      const { table: tableName, column } = element.dataset;
      const confirmed = await confirmAction({ title: `Drop column ${column}?`, message: `Permanently drops column ${column} and its values from ${tableName}.`, confirmLabel: "Drop column" });
      if (!confirmed) return;
      await api(projectApi(`/database/tables/${encodeURIComponent(tableName)}`), { method: "PATCH", body: { action: "drop_column", columnName: column } });
      showToast(`Column ${column} dropped.`);
      await loadPage("database");
      break;
    }
    case "drop-index": {
      const { table: tableName, index } = element.dataset;
      const confirmed = await confirmAction({ title: `Drop index ${index}?`, message: `Drops index ${index} from ${tableName}.`, confirmLabel: "Drop index" });
      if (!confirmed) return;
      await api(projectApi(`/database/tables/${encodeURIComponent(tableName)}`), { method: "PATCH", body: { action: "drop_index", indexName: index } });
      showToast(`Index ${index} dropped.`);
      await loadPage("database");
      break;
    }
    case "toggle-table-rls": {
      const tableName = element.dataset.table;
      const enabled = element.dataset.enabled !== "true";
      if (!enabled) {
        const confirmed = await confirmAction({ title: `Disable RLS on ${tableName}?`, message: "Client roles may gain unrestricted row access unless policies remain active.", confirmLabel: "Disable RLS" });
        if (!confirmed) return;
      }
      await api(projectApi(`/database/tables/${encodeURIComponent(tableName)}/rls`), { method: "POST", body: { enabled, force: true } });
      showToast(`RLS ${enabled ? "enabled" : "disabled"} on ${tableName}.`);
      await loadPage("database");
      break;
    }
    case "drop-table": {
      const tableName = element.dataset.table;
      const confirmed = await confirmAction({ title: `Drop ${tableName}?`, message: "The table and all rows will be permanently removed.", confirmLabel: "Drop table", requireText: tableName });
      if (!confirmed) return;
      await api(projectApi(`/database/tables/${encodeURIComponent(tableName)}`), { method: "DELETE", body: { confirmName: tableName } });
      if (state.activeTable === tableName) state.activeTable = null;
      showToast(`${tableName} dropped.`);
      await loadPage("database");
      break;
    }

    // SQL, Saved Queries, Policies & API Explorer
    case "clear-sql":
      $("sql-editor-input").value = "";
      $("sql-result-box").innerHTML = "";
      state.lastSqlResult = null;
      state.activeSavedQueryId = null;
      updateSavedQueryLabel();
      renderSavedQueries();
      $("sql-editor-input").focus();
      break;
    case "sql-snippet":
      $("sql-editor-input").value = element.dataset.sql || "";
      state.activeSavedQueryId = null;
      updateSavedQueryLabel();
      focusElement("sql-editor-input");
      break;
    case "open-save-query": {
      const existing = state.savedQueries.find((query) => query.id === state.activeSavedQueryId) || null;
      openSaveQueryDialog(existing);
      break;
    }
    case "load-saved-query": {
      const query = state.savedQueries.find((item) => item.id === element.dataset.id);
      if (!query) return;
      $("sql-editor-input").value = query.sql;
      state.activeSavedQueryId = query.id;
      updateSavedQueryLabel();
      renderSavedQueries();
      focusElement("sql-editor-input");
      showToast(`Loaded saved query "${query.name}".`, "info", "SQL library");
      break;
    }
    case "edit-saved-query": {
      const query = state.savedQueries.find((item) => item.id === element.dataset.id);
      if (query) openSaveQueryDialog(query);
      break;
    }
    case "delete-saved-query": {
      const confirmed = await confirmAction({
        title: `Delete saved query ${element.dataset.name}?`,
        message: "Removes this query from the project's shared SQL library.",
        confirmLabel: "Delete query",
      });
      if (!confirmed) return;
      await api(projectApi(`/database/queries/${encodeURIComponent(element.dataset.id)}`), { method: "DELETE" });
      if (state.activeSavedQueryId === element.dataset.id) {
        state.activeSavedQueryId = null;
        updateSavedQueryLabel();
      }
      showToast("Saved query deleted.");
      await refreshSavedQueries();
      break;
    }
    case "copy-sql-result":
      if (state.lastSqlResult) await copyText(JSON.stringify(state.lastSqlResult.rows || [], null, 2), "Result rows copied as JSON");
      break;
    case "export-sql-csv":
      if (!state.lastSqlResult?.rows?.length) throw new Error("Run a query with results first.");
      downloadCsv(`sql-result-${Date.now()}.csv`, state.lastSqlResult.rows);
      showToast("Query result exported as CSV.", "success", "Export ready");
      break;
    case "delete-policy": {
      const { table: tableName, policy } = element.dataset;
      const confirmed = await confirmAction({ title: `Delete ${policy}?`, message: `Removes RLS policy ${policy} from ${tableName}.`, confirmLabel: "Delete policy" });
      if (!confirmed) return;
      await api(projectApi(`/database/policies/${encodeURIComponent(tableName)}/${encodeURIComponent(policy)}`), { method: "DELETE" });
      showToast("RLS policy deleted.");
      await loadPage("sql");
      break;
    }
    case "rollback-migration": {
      const { version, name } = element.dataset;
      const confirmed = await confirmAction({ title: `Roll back ${name}?`, message: "Runs the migration's down SQL inside a transaction.", confirmLabel: "Run rollback" });
      if (!confirmed) return;
      await api(projectApi(`/database/migrations/${encodeURIComponent(version)}/rollback`), { method: "POST" });
      showToast(`Migration ${version} rolled back.`);
      await loadPage("migrations");
      break;
    }
    case "prefill-api-test":
      $("api-test-method").value = element.dataset.method || "GET";
      $("api-test-path").value = element.dataset.path || "/rest/";
      focusElement("api-test-path");
      break;

    // Auth & Sessions
    case "verify-user":
      await api(projectApi(`/auth/admin/users/${encodeURIComponent(element.dataset.user)}`), { method: "PATCH", body: { emailVerified: true } });
      showToast("Email marked as verified.");
      await loadPage("auth");
      break;
    case "toggle-user-status": {
      const active = element.dataset.status !== "active";
      const confirmed = await confirmAction({ title: `${active ? "Activate" : "Suspend"} ${element.dataset.email}?`, message: active ? "Restores sign-in access." : "Revokes active sessions and blocks sign-in.", confirmLabel: active ? "Activate" : "Suspend", danger: !active });
      if (!confirmed) return;
      await api(projectApi(`/auth/admin/users/${encodeURIComponent(element.dataset.user)}`), { method: "PATCH", body: { status: active ? "active" : "suspended" } });
      showToast(`User ${active ? "activated" : "suspended"}.`);
      await loadPage("auth");
      break;
    }
    case "delete-user": {
      const confirmed = await confirmAction({ title: `Delete ${element.dataset.email}?`, message: "Permanently deletes this project user and all sessions.", confirmLabel: "Delete user" });
      if (!confirmed) return;
      await api(projectApi(`/auth/admin/users/${encodeURIComponent(element.dataset.user)}`), { method: "DELETE" });
      showToast("Project user deleted.");
      await loadPage("auth");
      break;
    }
    case "revoke-project-session":
      await api(projectApi(`/auth/admin/sessions/${encodeURIComponent(element.dataset.id)}`), { method: "DELETE" });
      showToast("Session revoked.");
      await loadPage("auth");
      break;

    // Storage
    case "open-bucket": await openBucket(element.dataset.bucket); break;
    case "delete-bucket": {
      const bucketName = element.dataset.bucket;
      const confirmed = await confirmAction({ title: `Delete ${bucketName}?`, message: "Permanently deletes the bucket and all stored objects.", confirmLabel: "Delete bucket", requireText: bucketName });
      if (!confirmed) return;
      await api(projectApi(`/storage/buckets/${encodeURIComponent(bucketName)}?force=true`), { method: "DELETE" });
      if (state.activeBucket === bucketName) state.activeBucket = null;
      showToast(`${bucketName} deleted.`);
      await loadPage("storage");
      break;
    }
    case "inspect-object": {
      const { bucket, path } = element.dataset;
      const meta = await api(projectApi(`/storage/buckets/${encodeURIComponent(bucket)}/objects/${encodePath(path)}?metadata=true`));
      const obj = meta.object || meta;
      $("object-metadata-box").innerHTML = `<div style="padding:14px 16px;border-top:1px solid var(--border)"><div class="label-row"><strong>Object Metadata · ${esc(path)}</strong><button class="btn btn-ghost btn-sm" type="button" data-action="copy-text" data-copy="${esc(JSON.stringify(obj, null, 2))}">${"<svg class=\"icon\"><use href=\"#i-copy\"></use></svg>"}Copy JSON</button></div><pre class="code-block top-gap">${esc(JSON.stringify(obj, null, 2))}</pre></div>`;
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
      showToast("Signed download started (valid 5 minutes).", "success", "Download");
      break;
    }
    case "delete-object": {
      const { bucket, path } = element.dataset;
      const confirmed = await confirmAction({ title: "Delete object?", message: `Remove ${path} from ${bucket}?`, confirmLabel: "Delete object" });
      if (!confirmed) return;
      await api(projectApi(`/storage/buckets/${encodeURIComponent(bucket)}/objects/${encodePath(path)}`), { method: "DELETE" });
      showToast("Object deleted.");
      await loadPage("storage");
      break;
    }
    case "delete-storage-policy": {
      const { bucket, id } = element.dataset;
      await api(projectApi(`/storage/buckets/${encodeURIComponent(bucket)}/policies/${encodeURIComponent(id)}`), { method: "DELETE" });
      showToast("Bucket policy removed.");
      await openBucket(bucket);
      break;
    }

    // Functions & Jobs
    case "edit-function": {
      const fn = state.functions.find((item) => item.slug === element.dataset.slug);
      if (!fn) return;
      activateLocalTab("functions");
      $("fn-slug").value = fn.slug;
      $("fn-name").value = fn.name || "";
      $("fn-jwt").value = String(fn.verify_jwt);
      $("fn-timeout").value = fn.timeout_ms;
      $("fn-env").value = JSON.stringify(fn.env_vars || {}, null, 2);
      $("fn-code").value = fn.code;
      focusElement("fn-code");
      showToast(`Loaded ${fn.slug} (v${fn.version}) for editing.`, "info", "Function loaded");
      break;
    }
    case "load-fn-logs": {
      const slug = $("fn-invoke-slug")?.value;
      if (!slug) throw new Error("Select a deployed function first.");
      const res = await api(projectApi(`/functions/${encodeURIComponent(slug)}/logs?limit=25`));
      const logs = res.logs || [];
      $("fn-logs-list").innerHTML = logs.length
        ? `<div class="list">${logs.map((l) => `<div class="list-row"><div class="list-main"><div class="list-text"><strong>HTTP ${esc(l.status_code)} · ${esc(l.duration_ms)} ms</strong><small>${esc(formatDate(l.created_at))}${l.error_message ? ` · ${esc(l.error_message)}` : ""}</small></div></div></div>`).join("")}</div>`
        : `<p class="subtle">No execution logs recorded yet for ${esc(slug)}.</p>`;
      break;
    }
    case "reset-function-form": $("deploy-fn-form").reset(); break;
    case "delete-function": {
      const slug = element.dataset.slug;
      const confirmed = await confirmAction({ title: `Delete ${slug}?`, message: "Removes the function endpoint.", confirmLabel: "Delete function" });
      if (!confirmed) return;
      await api(projectApi(`/functions/${encodeURIComponent(slug)}`), { method: "DELETE" });
      showToast(`${slug} deleted.`);
      await loadPage("functions");
      break;
    }
    case "process-jobs": {
      const result = await api(projectApi("/jobs/process"), { method: "POST", body: { limit: 20 } });
      showToast(`${result.count} due job(s) processed.`, "success", "Worker queue");
      await loadPage("functions");
      break;
    }
    case "retry-job":
      await api(projectApi(`/jobs/${encodeURIComponent(element.dataset.id)}/retry`), { method: "POST" });
      showToast("Job re-queued for execution.");
      await loadPage("functions");
      break;
    case "cancel-job":
      await api(projectApi(`/jobs/${encodeURIComponent(element.dataset.id)}/cancel`), { method: "POST" });
      showToast("Job cancelled.");
      await loadPage("functions");
      break;
    case "delete-schedule": {
      const confirmed = await confirmAction({ title: `Delete ${element.dataset.name}?`, message: "Stops future scheduled runs.", confirmLabel: "Delete schedule" });
      if (!confirmed) return;
      await api(projectApi(`/schedules/${encodeURIComponent(element.dataset.id)}`), { method: "DELETE" });
      showToast("Schedule deleted.");
      await loadPage("functions");
      break;
    }

    // Realtime, Security, Backups & Platform Admin
    case "rt-disconnect": closeRealtime(); break;
    case "clear-realtime-log": $("rt-stream-log").textContent = "Waiting for a realtime connection…"; break;
    case "toggle-secrets":
      state.revealSecrets = !state.revealSecrets;
      await loadPage("security");
      break;
    case "rotate-key": {
      const confirmed = await confirmAction({ title: `Rotate ${element.dataset.name}?`, message: "Revokes the current key immediately and issues a replacement.", confirmLabel: "Rotate key" });
      if (!confirmed) return;
      const result = await api(projectApi(`/api-keys/${encodeURIComponent(element.dataset.id)}/rotate`), { method: "POST" });
      showCredentials("Replacement API key", result.apiKey.raw_key);
      await loadPage("security");
      break;
    }
    case "revoke-key": {
      const confirmed = await confirmAction({ title: `Revoke ${element.dataset.name}?`, message: "Applications using this key immediately lose access.", confirmLabel: "Revoke key" });
      if (!confirmed) return;
      await api(projectApi(`/api-keys/${encodeURIComponent(element.dataset.id)}`), { method: "DELETE" });
      showToast("API key revoked.");
      await loadPage("security");
      break;
    }
    case "delete-secret": {
      const confirmed = await confirmAction({ title: `Delete ${element.dataset.name}?`, message: "Functions relying on this secret will no longer receive it.", confirmLabel: "Delete secret" });
      if (!confirmed) return;
      await api(projectApi(`/secrets/${encodeURIComponent(element.dataset.id)}`), { method: "DELETE" });
      showToast("Secret deleted.");
      await loadPage("security");
      break;
    }
    case "remove-member": {
      const confirmed = await confirmAction({ title: `Remove ${element.dataset.email}?`, message: "Removes direct access to this project.", confirmLabel: "Remove member" });
      if (!confirmed) return;
      await api(projectApi(`/members/${encodeURIComponent(element.dataset.user)}`), { method: "DELETE" });
      showToast("Project member removed.");
      await loadPage("security");
      break;
    }
    case "delete-environment": {
      const confirmed = await confirmAction({ title: `Delete ${element.dataset.name}?`, message: "Removes environment stage metadata.", confirmLabel: "Delete environment" });
      if (!confirmed) return;
      await api(projectApi(`/environments/${encodeURIComponent(element.dataset.id)}`), { method: "DELETE" });
      showToast("Environment deleted.");
      await loadPage("overview");
      break;
    }
    case "verify-backup": {
      const result = await api(projectApi(`/backups/${encodeURIComponent(element.dataset.id)}/verify`), { method: "POST" });
      showToast(result.valid === false ? "Backup SHA-256 checksum mismatch!" : "SHA-256 checksum verified intact.", result.valid === false ? "error" : "success", result.valid === false ? "Integrity failed" : "Backup verified");
      break;
    }
    case "restore-backup": {
      const confirmed = await confirmAction({ title: `Restore ${element.dataset.name}?`, message: "Replaces current project schema and data with this verified snapshot.", confirmLabel: "Restore snapshot", requireText: "RESTORE" });
      if (!confirmed) return;
      await api(projectApi(`/backups/${encodeURIComponent(element.dataset.id)}/restore`), { method: "POST", timeout: 120_000 });
      showToast("Snapshot verified and restored.", "success", "Restore complete");
      await loadPage("backups");
      break;
    }
    case "verify-platform-backup": {
      const result = await api(`/v1/platform/backups/${encodeURIComponent(element.dataset.id)}/verify`, { method: "POST" });
      showToast(result.valid === false ? "Checksum mismatch!" : "Full-platform backup SHA-256 verified.", result.valid === false ? "error" : "success");
      break;
    }
    case "toggle-operator-superadmin": {
      const makeSuper = element.dataset.super !== "true";
      const confirmed = await confirmAction({ title: `${makeSuper ? "Grant" : "Revoke"} Superadmin?`, message: makeSuper ? "Grants full instance-wide administrative privileges." : "Demotes account to standard platform operator.", confirmLabel: "Confirm" });
      if (!confirmed) return;
      await api(`/v1/platform/users/${encodeURIComponent(element.dataset.id)}`, { method: "PATCH", body: { isSuperadmin: makeSuper } });
      showToast("Operator privilege updated.");
      await loadPage("platform");
      break;
    }
    case "toggle-operator-status": {
      const makeActive = element.dataset.status !== "active";
      await api(`/v1/platform/users/${encodeURIComponent(element.dataset.id)}`, { method: "PATCH", body: { status: makeActive ? "active" : "suspended" } });
      showToast(`Operator ${makeActive ? "activated" : "suspended"}.`);
      await loadPage("platform");
      break;
    }
    case "download-openapi":
      if (window.__maaryOpenApi) downloadText(`${state.activeProject.slug}-openapi.json`, JSON.stringify(window.__maaryOpenApi, null, 2));
      break;
    case "delete-project": await deleteProject(); break;
    default: break;
  }
}

const submitHandlers = {
  "create-org-form": async () => {
    const res = await api("/v1/organizations", {
      method: "POST",
      body: {
        name: $("org-name").value.trim(),
        slug: $("org-slug").value.trim() || undefined,
        billingTier: $("org-tier").value,
        description: $("org-desc").value.trim(),
      },
    });
    closeDialog("new-org-dialog");
    $("create-org-form").reset();
    state.orgSlugTouched = false;
    state.activeOrgSlug = res.organization.slug;
    storageAdapter.set("maary_active_org", state.activeOrgSlug);
    showToast(`Workspace ${res.organization.name} created.`);
    window.dispatchEvent(new CustomEvent("maary:orgs-refresh"));
    if (state.activeTab === "organizations") await loadPage("organizations");
  },
  "update-org-form": async () => {
    const slug = $("uorg-slug").value;
    await api(`/v1/organizations/${encodeURIComponent(slug)}`, {
      method: "PATCH",
      body: { name: $("uorg-name").value.trim(), billingTier: $("uorg-tier").value, description: $("uorg-desc").value.trim() },
    });
    showToast("Workspace settings saved.");
    window.dispatchEvent(new CustomEvent("maary:orgs-refresh"));
    await loadPage("organizations");
  },
  "add-org-member-form": async () => {
    const slug = state.selectedOrgDetail?.slug || state.activeOrgSlug;
    if (!slug) throw new Error("Select a workspace first.");
    await api(`/v1/organizations/${encodeURIComponent(slug)}/members`, {
      method: "POST",
      body: { email: $("org-member-email").value.trim(), role: $("org-member-role").value },
    });
    $("add-org-member-form").reset();
    showToast("Workspace member saved.");
    await loadPage("organizations");
  },
  "create-project-form": async () => {
    const orgId = $("proj-org")?.value || undefined;
    const result = await api("/v1/projects", {
      method: "POST",
      body: { name: $("proj-name").value, slug: $("proj-slug").value || undefined, description: $("proj-desc").value, organizationId: orgId },
    });
    closeDialog("new-project-dialog");
    $("create-project-form").reset();
    state.slugTouched = false;
    const keys = result.apiKeys || {};
    showCredentials("Project credentials", `Project: ${result.project.slug}\n\nAnon key (safe for clients with RLS):\n${keys.anonKey || "See Security & Keys"}\n\nService-role key (server only — bypasses RLS):\n${keys.serviceRoleKey || "See Security & Keys"}`);
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
    if (!Array.isArray(columns) || !columns.length) throw new Error("Define at least one column.");
    await api(projectApi("/database/tables"), { method: "POST", body: { name: tableName, columns, enableRls: $("tbl-rls").value === "true" } });
    state.activeTable = tableName;
    $("create-table-disclosure").open = false;
    showToast(`Table ${tableName} created.`);
    await loadPage("database");
  },
  "row-filter-form": async () => {
    state.rowBrowser.filter = $("row-filter-input").value.trim();
    state.rowBrowser.orderBy = $("row-sort-col").value.trim();
    state.rowBrowser.orderDir = $("row-sort-dir").value;
    state.rowBrowser.limit = Number($("row-limit").value) || 25;
    state.rowBrowser.offset = 0;
    if (state.activeTable) await browseTable(state.activeTable);
  },
  "insert-row-form": async () => {
    if (!state.activeTable) throw new Error("Select a table before inserting a row.");
    const payload = parseJson($("row-json-input").value, "Row JSON");
    if (!payload || Array.isArray(payload) || typeof payload !== "object") throw new Error("Row data must be a JSON object.");
    await api(projectApi(`/rest/${encodeURIComponent(state.activeTable)}`), { method: "POST", body: payload });
    $("row-json-input").value = "";
    showToast("Row inserted.");
    await loadPage("database");
  },
  "edit-row-form": async () => {
    const pkCol = $("edit-row-pk-col").value;
    const pkVal = $("edit-row-pk-val").value;
    const rawJson = $("edit-row-json").value.trim();
    const payload = rawJson
      ? parseJson(rawJson, "Row JSON")
      : collectColumnFormPayload($("edit-row-columns"));
    if (!Object.keys(payload).length) throw new Error("Change at least one column value, or provide a JSON payload.");
    await api(projectApi(`/rest/${encodeURIComponent(state.activeTable)}?${encodeURIComponent(pkCol)}=eq.${encodeURIComponent(pkVal)}`), {
      method: "PATCH",
      body: payload,
    });
    closeDialog("edit-row-dialog");
    showToast("Row updated.");
    await browseTable(state.activeTable);
  },
  "alter-add-col-form": async () => {
    if (!state.activeTable) throw new Error("Select a table first.");
    const fkTable = $("alt-fk-table").value.trim();
    const fkCol = $("alt-fk-col").value.trim() || "id";
    await api(projectApi(`/database/tables/${encodeURIComponent(state.activeTable)}`), {
      method: "PATCH",
      body: {
        action: "add_column",
        column: {
          name: $("alt-col-name").value.trim(),
          type: $("alt-col-type").value,
          defaultValue: $("alt-col-default").value.trim() || undefined,
          ...(fkTable ? { references: { table: fkTable, column: fkCol, onDelete: "CASCADE" } } : {}),
        },
      },
    });
    $("alter-add-col-form").reset();
    showToast("Column added.");
    await loadPage("database");
  },
  "alter-rename-col-form": async () => {
    if (!state.activeTable) throw new Error("Select a table first.");
    await api(projectApi(`/database/tables/${encodeURIComponent(state.activeTable)}`), {
      method: "PATCH",
      body: { action: "rename_column", fromName: $("alt-rename-from").value.trim(), toName: $("alt-rename-to").value.trim() },
    });
    $("alter-rename-col-form").reset();
    showToast("Column renamed.");
    await loadPage("database");
  },
  "alter-create-index-form": async () => {
    if (!state.activeTable) throw new Error("Select a table first.");
    const cols = $("alt-idx-cols").value.split(",").map((c) => c.trim()).filter(Boolean);
    await api(projectApi(`/database/tables/${encodeURIComponent(state.activeTable)}`), {
      method: "PATCH",
      body: { action: "create_index", indexName: $("alt-idx-name").value.trim(), columns: cols, unique: $("alt-idx-unique").checked },
    });
    $("alter-create-index-form").reset();
    showToast("Index created.");
    await loadPage("database");
  },
  "sql-form": async () => {
    const sql = $("sql-editor-input").value.trim();
    if (!sql) throw new Error("Enter a SQL statement.");
    const role = $("sql-role-select").value;
    const userId = $("sql-user-id").value.trim();
    try {
      const result = await api(projectApi("/database/sql"), {
        method: "POST",
        body: {
          sql,
          allowDestructive: $("sql-destructive").value === "true",
          savedQueryId: state.activeSavedQueryId || undefined,
          impersonate: role === "service_role" ? undefined : { role, userId: userId || undefined },
        },
        timeout: 60_000,
      });
      renderSqlResult(result);
      rememberSql(sql);
      if (state.activeSavedQueryId) {
        const active = state.savedQueries.find((query) => query.id === state.activeSavedQueryId);
        if (active) {
          active.run_count = Number(active.run_count || 0) + 1;
          active.last_run_at = new Date().toISOString();
          renderSavedQueries();
        }
      }
    } catch (error) {
      state.lastSqlResult = null;
      $("sql-result-box").innerHTML = `<div class="notice danger"><svg class="icon"><use href="#i-alert"></use></svg><p>${esc(error.message)}</p></div>`;
      throw error;
    }
  },
  "insert-row-dialog-form": async () => {
    if (!state.activeTable) throw new Error("Select a table before inserting a row.");
    const payload = collectColumnFormPayload($("insert-row-columns"));
    if (!Object.keys(payload).length) throw new Error("Fill in at least one column value.");
    await api(projectApi(`/rest/${encodeURIComponent(state.activeTable)}`), { method: "POST", body: payload });
    closeDialog("insert-row-dialog");
    showToast(`Row inserted into ${state.activeTable}.`);
    await loadPage("database");
  },
  "save-query-form": async () => {
    const existingId = $("save-query-id").value;
    const body = {
      name: $("save-query-name").value.trim(),
      description: $("save-query-description").value.trim(),
      sql: $("save-query-sql").value,
      favorite: $("save-query-favorite").checked,
    };
    if (!body.name || !body.sql.trim()) throw new Error("A query name and SQL body are required.");
    if (existingId) {
      await api(projectApi(`/database/queries/${encodeURIComponent(existingId)}`), { method: "PATCH", body });
      showToast(`Saved query "${body.name}" updated.`);
    } else {
      const result = await api(projectApi("/database/queries"), { method: "POST", body });
      state.activeSavedQueryId = result.query.id;
      showToast(`Saved query "${body.name}" stored for this project.`);
    }
    closeDialog("save-query-dialog");
    $("save-query-form").reset();
    await refreshSavedQueries();
  },
  "create-policy-form": async () => {
    await api(projectApi("/database/policies"), {
      method: "POST",
      body: {
        tableName: $("pol-table").value,
        policyName: $("pol-name").value,
        command: $("pol-cmd").value,
        usingExpression: $("pol-using").value || null,
        checkExpression: $("pol-check").value || null,
        enableRlsOnTable: $("pol-enable-rls").checked,
      },
    });
    showToast("RLS policy created.");
    await loadPage("sql");
  },
  "apply-migration-form": async () => {
    await api(projectApi("/database/migrations"), {
      method: "POST",
      body: { version: $("mig-version").value, name: $("mig-name").value, upSql: $("mig-up").value, downSql: $("mig-down").value },
      timeout: 60_000,
    });
    showToast("Migration applied and checksummed.");
    await loadPage("migrations");
  },
  "api-tester-form": async () => {
    const method = $("api-test-method").value;
    const relPath = $("api-test-path").value.trim();
    const authMode = $("api-test-auth").value;
    const rawBody = $("api-test-body").value.trim();
    const headers = {};
    let skipPlatformAuth = false;
    if (authMode === "anon" || authMode === "service_role") {
      headers.apikey = await resolveProjectKeyByRole(authMode);
      skipPlatformAuth = true;
    } else if (authMode === "bearer") {
      const jwt = $("api-test-jwt").value.trim();
      if (!jwt) throw new Error("Paste a custom user Bearer JWT first.");
      headers.apikey = await resolveProjectKeyByRole("anon");
      headers.Authorization = `Bearer ${jwt}`;
      skipPlatformAuth = true;
    }
    const body = ["POST", "PATCH"].includes(method) && rawBody ? parseJson(rawBody, "Request body") : undefined;
    const fullUrl = projectApi(relPath.startsWith("/") ? relPath : `/${relPath}`);
    const started = performance.now();
    try {
      const res = await api(fullUrl, { method, headers, body, skipPlatformAuth, allowUnauthorized: true });
      const elapsed = Math.round(performance.now() - started);
      $("api-test-meta").textContent = `${method} ${fullUrl} · 200 OK · ${elapsed} ms`;
      $("api-test-output").textContent = typeof res === "string" ? res : JSON.stringify(res, null, 2);
    } catch (err) {
      const elapsed = Math.round(performance.now() - started);
      $("api-test-meta").textContent = `${method} ${fullUrl} · HTTP ${err.status || "ERR"} · ${elapsed} ms`;
      $("api-test-output").textContent = JSON.stringify({ error: err.message, details: err.details || null }, null, 2);
    }
  },
  "admin-create-user-form": async () => {
    await api(projectApi("/auth/admin/users"), {
      method: "POST",
      body: { email: $("u-email").value, password: $("u-pass").value, role: $("u-role").value, emailVerified: $("u-verified").checked },
    });
    $("admin-create-user-form").reset();
    $("u-role").value = "authenticated";
    $("u-verified").checked = true;
    showToast("Project user created.");
    await loadPage("auth");
  },
  "auth-config-form": async () => {
    await api(projectApi("/auth/config"), {
      method: "PATCH",
      body: {
        allow_public_signup: $("cfg-public-signup").value === "true",
        require_email_verification: $("cfg-email-verify").value === "true",
        password_min_length: Number($("cfg-pass-len").value),
        access_token_ttl_seconds: Number($("cfg-access-ttl").value),
        refresh_token_ttl_seconds: Number($("cfg-refresh-ttl").value),
      },
    });
    showToast("Authentication policy saved.");
  },
  "oauth-provider-form": async () => {
    const provider = $("oauth-provider-name").value;
    const currentProviders = { ...(window.__maaryAuthConfig?.oauth_providers || {}) };
    currentProviders[provider] = {
      enabled: $("oauth-enabled").value === "true",
      clientId: $("oauth-client-id").value.trim(),
      ...(($("oauth-auth-url").value.trim()) ? { authorizeUrl: $("oauth-auth-url").value.trim() } : {}),
      scopes: $("oauth-scopes").value.split(",").map((s) => s.trim()).filter(Boolean),
    };
    await api(projectApi("/auth/config"), { method: "PATCH", body: { oauth_providers: currentProviders } });
    showToast(`OAuth provider ${provider} updated.`);
    await loadPage("auth");
  },
  "client-auth-test-form": async () => {
    const anonKey = await resolveProjectKeyByRole("anon");
    const mode = $("cat-mode").value;
    const res = await api(projectApi(`/auth/${mode}`), {
      method: "POST",
      headers: { apikey: anonKey },
      body: { email: $("cat-email").value.trim(), password: $("cat-password").value },
      skipPlatformAuth: true,
      allowUnauthorized: true,
    });
    $("cat-output").textContent = JSON.stringify(res, null, 2);
    showToast(`Client ${mode} succeeded.`);
  },
  "client-recovery-form": async () => {
    const anonKey = await resolveProjectKeyByRole("anon");
    const res = await api(projectApi("/auth/recover"), {
      method: "POST",
      headers: { apikey: anonKey },
      body: { email: $("rec-email").value.trim() },
      skipPlatformAuth: true,
      allowUnauthorized: true,
    });
    if (res.recoveryToken && $("rec-token")) $("rec-token").value = res.recoveryToken;
    $("rec-output").textContent = JSON.stringify(res, null, 2);
    showToast("Password recovery requested.");
  },
  "client-reset-form": async () => {
    const res = await api(projectApi("/auth/reset-password"), {
      method: "POST",
      body: { token: $("rec-token").value.trim(), password: $("rec-new-pass").value },
      skipPlatformAuth: true,
      allowUnauthorized: true,
    });
    $("rec-output").textContent = JSON.stringify(res, null, 2);
    showToast("End-user password reset completed.");
  },
  "operator-profile-form": async () => {
    const res = await api("/v1/platform/auth/me", { method: "PATCH", body: { name: $("op-name").value.trim() } });
    state.user = res.user;
    if ($("user-name")) $("user-name").textContent = res.user.name || res.user.email;
    showToast("Operator profile updated.");
  },
  "operator-password-form": async () => {
    await api("/v1/platform/auth/change-password", {
      method: "POST",
      body: { currentPassword: $("op-cur-pass").value, newPassword: $("op-new-pass").value },
    });
    $("operator-password-form").reset();
    showToast("Operator password updated.");
  },
  "create-bucket-form": async () => {
    const name = $("bucket-name").value.trim();
    const mimes = $("bucket-mimes").value.split(",").map((m) => m.trim()).filter(Boolean);
    await api(projectApi("/storage/buckets"), {
      method: "POST",
      body: { name, public: $("bucket-public").value === "true", fileSizeLimitBytes: Number($("bucket-limit").value) * 1024 * 1024, ...(mimes.length ? { allowedMimeTypes: mimes } : {}) },
    });
    state.activeBucket = name;
    $("create-bucket-form").reset();
    $("create-bucket-disclosure").open = false;
    showToast(`Bucket ${name} created.`);
    await loadPage("storage");
  },
  "update-bucket-form": async () => {
    if (!state.activeBucket) throw new Error("Select a bucket first.");
    const mimes = $("bset-mimes").value.split(",").map((m) => m.trim()).filter(Boolean);
    const quotaMb = Number($("bset-quota").value);
    await api(projectApi(`/storage/buckets/${encodeURIComponent(state.activeBucket)}`), {
      method: "PATCH",
      body: {
        public: $("bset-public").value === "true",
        fileSizeLimitBytes: Number($("bset-limit").value) * 1024 * 1024,
        quotaBytes: quotaMb > 0 ? quotaMb * 1024 * 1024 : null,
        allowedMimeTypes: mimes.length ? mimes : null,
      },
    });
    showToast("Bucket settings updated.");
    await loadPage("storage");
  },
  "sign-object-form": async () => {
    if (!state.activeBucket) throw new Error("Select a bucket first.");
    const path = $("sign-path").value.trim();
    const res = await api(projectApi(`/storage/buckets/${encodeURIComponent(state.activeBucket)}/sign/${encodePath(path)}`), {
      method: "POST",
      body: { operation: $("sign-op").value, expiresIn: Number($("sign-ttl").value) || 600 },
    });
    const fullUrl = res.signedUrl.startsWith("http") ? res.signedUrl : `${window.location.origin}${res.signedUrl}`;
    $("signed-url-result").innerHTML = `<div class="endpoint-item"><div><span class="endpoint-label">Signed ${esc($("sign-op").value)} URL</span><code class="mono">${esc(fullUrl)}</code></div><button class="icon-btn btn-sm" type="button" data-action="copy-text" data-copy="${esc(fullUrl)}"><svg class="icon"><use href="#i-copy"></use></svg></button></div>`;
    showToast("Signed URL generated.");
  },
  "create-storage-policy-form": async () => {
    if (!state.activeBucket) throw new Error("Select a bucket first.");
    await api(projectApi(`/storage/buckets/${encodeURIComponent(state.activeBucket)}/policies`), {
      method: "POST",
      body: {
        name: $("spol-name").value.trim(),
        operation: $("spol-op").value,
        roles: $("spol-roles").value.split(",").map((r) => r.trim()).filter(Boolean),
        pathPrefix: $("spol-prefix").value.trim() || undefined,
        allowOwnerOnly: $("spol-owner").checked,
      },
    });
    $("create-storage-policy-form").reset();
    $("spol-roles").value = "authenticated";
    showToast("Bucket access policy created.");
    await openBucket(state.activeBucket);
  },
  "upload-object-form": async () => {
    if (!state.activeBucket) throw new Error("Select a bucket before uploading.");
    const path = $("obj-path").value.trim();
    const file = $("obj-file").files[0];
    const text = $("obj-content").value;
    if (!file && !text) throw new Error("Choose a file or enter text content.");
    const endpoint = projectApi(`/storage/buckets/${encodeURIComponent(state.activeBucket)}/objects/${encodePath(path)}`);
    if (file) {
      await api(endpoint, { method: "POST", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file, timeout: 120_000 });
    } else {
      await api(endpoint, { method: "POST", body: { content: text, mimeType: $("obj-mime").value || "text/plain", upsert: true } });
    }
    $("upload-object-form").reset();
    $("obj-mime").value = "text/plain";
    $("obj-file-label").textContent = "Or enter text content below";
    showToast(`${path} uploaded.`);
    await loadPage("storage");
  },
  "deploy-fn-form": async () => {
    const slug = $("fn-slug").value.trim();
    const envRaw = $("fn-env")?.value?.trim();
    const envVars = envRaw ? parseJson(envRaw, "Environment variables") : {};
    await api(projectApi("/functions"), {
      method: "POST",
      body: { slug, name: $("fn-name").value || slug, verifyJwt: $("fn-jwt").value === "true", timeoutMs: Number($("fn-timeout").value), envVars, code: $("fn-code").value },
      timeout: 60_000,
    });
    showToast(`${slug} deployed.`);
    await loadPage("functions");
  },
  "invoke-fn-form": async () => {
    const slug = $("fn-invoke-slug").value;
    if (!slug) throw new Error("Deploy and select a function first.");
    const payload = parseJson($("fn-payload").value, "Invocation payload");
    $("fn-invoke-output").textContent = "Invoking isolated worker…";
    const result = await api(projectApi(`/functions/${encodeURIComponent(slug)}/invoke`), { method: "POST", body: payload, timeout: 70_000 });
    $("fn-invoke-output").textContent = JSON.stringify(result, null, 2);
  },
  "create-job-form": async () => {
    await api(projectApi("/jobs"), {
      method: "POST",
      body: { jobType: $("job-type").value, queueName: $("job-queue").value, delaySeconds: Number($("job-delay").value), payload: parseJson($("job-payload").value, "Job payload") },
    });
    showToast("Background job enqueued.");
    await loadPage("functions");
  },
  "create-schedule-form": async () => {
    await api(projectApi("/schedules"), {
      method: "POST",
      body: { name: $("schedule-name").value, jobType: $("schedule-type").value, intervalSeconds: Number($("schedule-interval").value), targetSlug: $("schedule-target").value || undefined, payload: parseJson($("schedule-payload").value, "Schedule payload") },
    });
    showToast("Recurring schedule created.");
    await loadPage("functions");
  },
  "rt-connect-form": connectRealtime,
  "rt-broadcast-form": async () => {
    await api(projectApi("/realtime/broadcast"), {
      method: "POST",
      body: { topic: $("rt-broadcast-topic").value, event: $("rt-event").value, payload: parseJson($("rt-payload").value, "Broadcast payload") },
    });
    showToast("Broadcast published.");
    await loadPage("realtime");
  },
  "rt-channel-form": async () => {
    await api(projectApi("/realtime/channels"), {
      method: "POST",
      body: { topic: $("rt-chan-topic").value.trim(), isPrivate: $("rt-chan-private").checked },
    });
    $("rt-channel-form").reset();
    showToast("Channel configuration saved.");
    await loadPage("realtime");
  },
  "create-key-form": async () => {
    const result = await api(projectApi("/api-keys"), {
      method: "POST",
      body: { name: $("key-name").value, role: $("key-role").value, scopes: $("key-scopes").value.split(",").map((s) => s.trim()).filter(Boolean) },
    });
    $("create-key-form").reset();
    showCredentials("API key generated", result.apiKey.raw_key);
    await loadPage("security");
  },
  "create-secret-form": async () => {
    await api(projectApi("/secrets"), {
      method: "POST",
      body: { name: $("sec-name").value, value: $("sec-val").value, description: $("sec-description").value },
    });
    $("create-secret-form").reset();
    showToast("Secret encrypted and saved.");
    await loadPage("security");
  },
  "add-member-form": async () => {
    await api(projectApi("/members"), { method: "POST", body: { email: $("member-email").value, role: $("member-role").value } });
    $("add-member-form").reset();
    showToast("Project member saved.");
    await loadPage("security");
  },
  "create-backup-form": async () => {
    await api(projectApi("/backups"), { method: "POST", body: { name: $("backup-name-input").value || undefined }, timeout: 120_000 });
    $("backup-name-input").value = "";
    showToast("Snapshot created and checksummed.", "success", "Backup complete");
    await loadPage("backups");
  },
  "project-settings-form": async () => {
    const orgVal = $("settings-org")?.value;
    const result = await api(projectApi(""), {
      method: "PATCH",
      body: {
        name: $("settings-name").value,
        description: $("settings-description").value,
        status: $("settings-status").value,
        organizationId: orgVal ? orgVal : null,
        quotas: {
          ...(state.activeProject.quotas || {}),
          dbQuotaMb: Number($("settings-db-quota").value) || 500,
          storageQuotaMb: Number($("settings-storage-quota").value) || 1024,
          maxFunctions: Number($("settings-max-fns").value) || 50,
        },
      },
    });
    state.activeProject = result.project;
    showToast("Project settings and quotas saved.");
    window.dispatchEvent(new CustomEvent("maary:projects-refresh", { detail: { slug: result.project.slug } }));
  },
  "build-apk-form": async () => {
    const result = await api("/v1/platform/apk/build", {
      method: "POST",
      body: { projectSlug: state.activeProject.slug, serverUrl: $("apk-server-url").value, versionName: $("apk-version-name").value, versionCode: Number($("apk-version-code").value) },
      timeout: 300_000,
    });
    $("apk-build-result").innerHTML = `<div class="notice"><svg class="icon"><use href="#i-check"></use></svg><p>Verified Android APK compiled with Gradle.<br><span class="mono">SHA-256: ${esc(result.apk.checksumSha256)}</span></p></div><a class="btn btn-primary w-full top-gap" href="/v1/platform/apk/download"><svg class="icon"><use href="#i-download"></use></svg>Download ${esc(result.apk.fileName)}</a>`;
    showToast("Android APK compiled and verified.", "success", "Gradle build complete");
    await loadPage("backups");
  },
  "admin-create-operator-form": async () => {
    await api("/v1/platform/users", {
      method: "POST",
      body: { email: $("pop-email").value.trim(), name: $("pop-name").value.trim() || undefined, password: $("pop-pass").value, isSuperadmin: $("pop-super").checked },
    });
    $("admin-create-operator-form").reset();
    showToast("Platform operator created.");
    await loadPage("platform");
  },
  "enable-ext-form": async () => {
    await api("/v1/platform/extensions", { method: "POST", body: { name: $("ext-name-input").value.trim() } });
    $("enable-ext-form").reset();
    showToast("PostgreSQL extension enabled.");
    await loadPage("platform");
  },
  "create-platform-backup-form": async () => {
    await api("/v1/platform/backups", { method: "POST", body: { name: $("pbackup-name").value.trim() || undefined }, timeout: 120_000 });
    $("create-platform-backup-form").reset();
    showToast("Full-platform disaster recovery snapshot created.");
    await loadPage("platform");
  },
};

export async function handleSubmit(form) {
  const handler = submitHandlers[form.id];
  if (handler) await handler(form);
}

export async function handleChange(element) {
  if (element.dataset.vcolIdx !== undefined) {
    const idx = Number(element.dataset.vcolIdx);
    const field = element.dataset.vcolField;
    if (state.visualColumns[idx]) {
      state.visualColumns[idx][field] = element.type === "checkbox" ? element.checked : element.value;
      renderVisualColumnsBuilder();
    }
    return;
  }
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
    case "job-status-filter": await loadPage("functions"); break;
    case "err-source-filter": await loadPage("logs"); break;
    case "obj-file": {
      const file = element.files[0];
      if (file) {
        $("obj-file-label").textContent = `${file.name} · ${(file.size / 1024).toFixed(1)} KB`;
        if (!$("obj-path").value.trim()) $("obj-path").value = file.name;
        if (file.type) $("obj-mime").value = file.type;
        $("obj-content").value = "";
      } else $("obj-file-label").textContent = "Or enter text content below";
      break;
    }
    default: break;
  }
}

const debouncedUserSearch = debounce(() => loadPage("auth").catch(reportError), 350);
const debouncedObjectFilter = debounce(() => state.activeBucket && openBucket(state.activeBucket).catch(reportError), 300);
const debouncedLogsFilter = debounce(() => loadPage("logs").catch(reportError), 350);

export function handleInput(element) {
  if (element.dataset.vcolIdx !== undefined) {
    const idx = Number(element.dataset.vcolIdx);
    const field = element.dataset.vcolField;
    if (state.visualColumns[idx]) {
      state.visualColumns[idx][field] = element.value;
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
    return;
  }
  switch (element.id) {
    case "table-search": renderTablesList(); break;
    case "auth-user-search": debouncedUserSearch(); break;
    case "object-prefix": debouncedObjectFilter(); break;
    case "err-search-filter":
    case "audit-action-filter": debouncedLogsFilter(); break;
    default: break;
  }
}
