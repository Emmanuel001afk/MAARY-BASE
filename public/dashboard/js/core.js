export const $ = (id) => document.getElementById(id);

export const storageAdapter = {
  get(key) {
    try { return window.localStorage.getItem(key); } catch { return null; }
  },
  set(key, value) {
    try { window.localStorage.setItem(key, value); } catch {}
  },
  remove(key) {
    try { window.localStorage.removeItem(key); } catch {}
  },
};

export const PROJECT_FREE_TABS = new Set(["organizations", "platform", "docs"]);

export const state = {
  user: null,
  organizations: [],
  activeOrgSlug: storageAdapter.get("maary_active_org") || "",
  selectedOrgDetail: null,
  projects: [],
  activeProject: null,
  activeTab: "overview",
  activeTable: null,
  activeBucket: null,
  tables: [],
  buckets: [],
  functions: [],
  revealSecrets: false,
  platformInfo: null,
  readyInfo: null,
  ws: null,
  wsStatus: "disconnected",
  requestVersion: 0,
  confirmResolver: null,
  confirmRequireText: null,
  slugTouched: false,
  orgSlugTouched: false,
  commandIndex: 0,
  commandItems: [],
  savedQueries: [],
  activeSavedQueryId: null,
  lastSqlResult: null,
  rowBrowser: {
    limit: 25,
    offset: 0,
    filter: "",
    orderBy: "",
    orderDir: "desc",
    rows: [],
    total: null,
  },
  visualColumns: [
    { name: "id", type: "uuid", primaryKey: true, nullable: false, defaultValue: "gen_random_uuid()" },
    { name: "title", type: "text", primaryKey: false, nullable: false, defaultValue: "" },
    { name: "created_at", type: "timestamptz", primaryKey: false, nullable: false, defaultValue: "now()" },
  ],
};

export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  }[char]));
}

export function icon(name) {
  return `<svg class="icon" aria-hidden="true"><use href="#i-${esc(name)}"></use></svg>`;
}

export function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export function formatNumber(value) {
  const num = Number(value ?? 0);
  return Number.isFinite(num) ? new Intl.NumberFormat().format(num) : "0";
}

export function formatBytes(bytes) {
  const value = Number(bytes ?? 0);
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const scaled = value / 1024 ** index;
  return `${scaled.toFixed(index === 0 || scaled >= 10 ? 0 : 1)} ${units[index]}`;
}

export function formatDate(value, withTime = true) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(undefined, withTime ? {
    dateStyle: "medium", timeStyle: "short",
  } : { dateStyle: "medium" }).format(date);
}

export function timeAgo(value) {
  if (!value) return "Never";
  const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000);
  if (!Number.isFinite(seconds)) return "—";
  if (seconds < 10) return "Just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatDate(value, false);
}

export function truncate(value, length = 36) {
  const text = String(value ?? "");
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

export function badge(label, tone = null, text = label) {
  const normalized = String(tone || label || "").toLowerCase();
  const map = {
    active: "success", applied: "success", completed: "success", ready: "success",
    enabled: "success", verified: "success", public: "warning", warning: "warning",
    queued: "warning", pending: "warning", suspended: "warning", paused: "warning",
    failed: "danger", revoked: "danger", error: "danger", danger: "danger",
    cancelled: "neutral", disabled: "neutral", rolled_back: "neutral", private: "info",
    authenticated: "info", info: "info", owner: "purple", admin: "purple",
    superadmin: "purple", service_role: "danger", gold: "gold", success: "success",
  };
  const resolved = map[normalized] || "neutral";
  const dot = ["success", "warning", "danger"].includes(resolved) ? '<span class="badge-dot"></span>' : "";
  return `<span class="badge badge-${resolved}">${dot}${esc(text)}</span>`;
}

export function moduleStatusBadge(statusState) {
  const map = {
    operational_verified: ["success", "Operational & verified"],
    implemented_unverified: ["info", "Implemented · unverified"],
    partially_implemented: ["warning", "Partially implemented"],
    requires_configuration: ["warning", "Requires configuration"],
    unavailable: ["neutral", "Unavailable"],
    failed: ["danger", "Failed"],
  };
  const [tone, label] = map[statusState] || ["neutral", String(statusState || "unknown")];
  return badge(tone, tone, label);
}

export function quotaMeter(label, used, limit, formatter = formatNumber) {
  const safeUsed = Math.max(0, Number(used || 0));
  const safeLimit = Math.max(1, Number(limit || 1));
  const pct = Math.min(100, Math.round((safeUsed / safeLimit) * 100));
  const tone = pct >= 90 ? "danger" : pct >= 75 ? "warn" : "";
  return `<div class="quota-meter"><div class="quota-meter-head"><strong>${esc(label)}</strong><span class="mono">${esc(formatter(safeUsed))} / ${esc(formatter(safeLimit))} (${pct}%)</span></div><div class="quota-track"><div class="quota-fill ${tone}" style="width:${pct}%"></div></div></div>`;
}

export function showToast(message, type = "success", title = null) {
  const region = $("toast-region");
  if (!region) return;
  const titles = { success: "Completed", error: "Action failed", warning: "Attention", info: "Updated" };
  const icons = { success: "check", error: "alert", warning: "alert", info: "sparkles" };
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.innerHTML = `${icon(icons[type] || "check")}<div class="toast-content"><strong>${esc(title || titles[type] || "Notice")}</strong><p>${esc(message)}</p></div><button class="icon-btn" type="button" aria-label="Dismiss notification">${icon("close")}</button>`;
  const remove = () => {
    toast.classList.add("removing");
    window.setTimeout(() => toast.remove(), 190);
  };
  toast.querySelector("button")?.addEventListener("click", remove);
  region.appendChild(toast);
  window.setTimeout(remove, type === "error" ? 6800 : 4200);
}

export function reportError(error) {
  console.error(error);
  showToast(error?.message || "Something went wrong.", "error");
}

export async function copyText(text, label = "Copied to clipboard") {
  const value = String(text ?? "");
  try {
    await navigator.clipboard.writeText(value);
    showToast(label, "success", "Copied");
  } catch {
    const area = document.createElement("textarea");
    area.value = value;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
    showToast(label, "success", "Copied");
  }
}

export function downloadText(filename, content, mimeType = "application/json") {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function csvCell(value) {
  if (value === null || value === undefined) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows) {
  if (!Array.isArray(rows) || !rows.length) return "";
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row || {})))];
  const lines = [columns.map(csvCell).join(",")];
  for (const row of rows) lines.push(columns.map((column) => csvCell(row?.[column])).join(","));
  return lines.join("\r\n");
}

export function downloadCsv(filename, rows) {
  const csv = toCsv(rows);
  if (!csv) throw new Error("There are no rows to export.");
  downloadText(filename, csv, "text/csv;charset=utf-8");
}

export function openDialog(id) {
  const dialog = $(id);
  if (!dialog) return;
  if (typeof dialog.showModal === "function" && !dialog.open) dialog.showModal();
  else dialog.setAttribute("open", "");
}

export function closeDialog(id) {
  const dialog = $(id);
  if (!dialog) return;
  if (typeof dialog.close === "function" && dialog.open) dialog.close();
  else dialog.removeAttribute("open");
}

export function showCredentials(title, content, subtitle = "Raw secret keys are only displayed once when created or rotated.") {
  $("credentials-title").textContent = title;
  $("credentials-subtitle").textContent = subtitle;
  $("credential-value").textContent = content;
  openDialog("credentials-dialog");
}

export function confirmAction({ title, message, confirmLabel = "Continue", danger = true, requireText = null }) {
  return new Promise((resolve) => {
    state.confirmResolver = resolve;
    state.confirmRequireText = requireText;
    $("confirm-title").textContent = title;
    $("confirm-message").textContent = message;
    const submit = $("confirm-submit-btn");
    submit.textContent = confirmLabel;
    submit.className = danger ? "btn btn-danger" : "btn btn-primary";
    $("confirm-icon").className = danger ? "dialog-icon danger" : "dialog-icon";
    const wrap = $("confirm-input-wrap");
    const input = $("confirm-input");
    if (requireText) {
      wrap.classList.remove("hidden");
      $("confirm-input-label").textContent = `Type "${requireText}" to confirm`;
      input.value = "";
      input.placeholder = requireText;
      submit.disabled = true;
    } else {
      wrap.classList.add("hidden");
      input.value = "";
      submit.disabled = false;
    }
    openDialog("confirm-dialog");
    window.setTimeout(() => (requireText ? input : submit).focus(), 30);
  });
}

export function settleConfirm(confirmed) {
  const resolve = state.confirmResolver;
  state.confirmResolver = null;
  state.confirmRequireText = null;
  closeDialog("confirm-dialog");
  if (resolve) resolve(Boolean(confirmed));
}

export function parseJson(text, label = "JSON") {
  try {
    return JSON.parse(String(text || "").trim());
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

export const sessionTokens = {
  getAccess() {
    try { return window.sessionStorage.getItem("maary_access_token"); } catch { return null; }
  },
  getRefresh() {
    try { return window.sessionStorage.getItem("maary_refresh_token"); } catch { return null; }
  },
  save(accessToken, refreshToken) {
    try {
      if (accessToken) window.sessionStorage.setItem("maary_access_token", accessToken);
      if (refreshToken) window.sessionStorage.setItem("maary_refresh_token", refreshToken);
    } catch {}
  },
  clear() {
    try {
      window.sessionStorage.removeItem("maary_access_token");
      window.sessionStorage.removeItem("maary_refresh_token");
    } catch {}
  },
};

let refreshPromise = null;

async function tryRefreshSession() {
  const refreshToken = sessionTokens.getRefresh();
  if (!refreshToken) return false;
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    try {
      const response = await fetch("/v1/platform/auth/refresh", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      });
      if (!response.ok) {
        sessionTokens.clear();
        return false;
      }
      const data = await response.json();
      if (data.accessToken) {
        sessionTokens.save(data.accessToken, data.refreshToken);
        return true;
      }
      return false;
    } catch {
      return false;
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

export async function api(path, options = {}) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), options.timeout || 45_000);
  const headers = { ...(options.headers || {}) };
  if (!headers.Authorization && !headers.authorization && !options.skipPlatformAuth) {
    const accessToken = sessionTokens.getAccess();
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  }
  let body = options.body;
  const isRawBody = body instanceof Blob || body instanceof FormData || body instanceof ArrayBuffer || ArrayBuffer.isView(body);
  if (body !== undefined && !isRawBody && typeof body !== "string") {
    if (!headers["Content-Type"]) headers["Content-Type"] = "application/json";
    body = JSON.stringify(body);
  }
  try {
    let response = await fetch(path, {
      method: options.method || "GET",
      credentials: "same-origin",
      headers,
      body,
      signal: controller.signal,
    });
    if (
      response.status === 401 &&
      !options.retried &&
      !options.skipPlatformAuth &&
      !path.startsWith("/v1/platform/auth/login") &&
      !path.startsWith("/v1/platform/auth/register") &&
      !path.startsWith("/v1/platform/auth/refresh")
    ) {
      const refreshed = await tryRefreshSession();
      if (refreshed) {
        window.clearTimeout(timeout);
        const retryHeaders = { ...(options.headers || {}) };
        const nextAccess = sessionTokens.getAccess();
        if (nextAccess) retryHeaders.Authorization = `Bearer ${nextAccess}`;
        return api(path, { ...options, headers: retryHeaders, retried: true });
      }
    }
    const contentType = response.headers.get("content-type") || "";
    const payload = contentType.includes("application/json")
      ? await response.json().catch(() => ({}))
      : await response.text();
    if (
      response.status === 401 &&
      !options.allowUnauthorized &&
      !options.skipPlatformAuth &&
      !path.startsWith("/v1/platform/auth/")
    ) {
      window.dispatchEvent(new CustomEvent("maary:unauthorized"));
    }
    if (!response.ok) {
      const message = typeof payload === "object" && payload
        ? payload.error?.message || payload.message || `Request failed (${response.status})`
        : payload || `Request failed (${response.status})`;
      const error = new Error(message);
      error.status = response.status;
      error.details = payload?.error?.details;
      throw error;
    }
    return payload;
  } catch (error) {
    if (error.name === "AbortError") throw new Error("The request timed out. Check server load and try again.");
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

export function projectApi(suffix = "") {
  if (!state.activeProject?.slug) throw new Error("Select or create a project first.");
  return `/v1/projects/${encodeURIComponent(state.activeProject.slug)}${suffix}`;
}

export async function withButtonBusy(button, work, busyLabel = "Working…") {
  if (!button) return work();
  const previousHtml = button.innerHTML;
  const wasDisabled = button.disabled;
  button.disabled = true;
  button.classList.add("is-busy");
  button.innerHTML = `<span class="spinner" aria-hidden="true"></span><span>${esc(busyLabel)}</span>`;
  try {
    return await work();
  } finally {
    button.disabled = wasDisabled;
    button.classList.remove("is-busy");
    button.innerHTML = previousHtml;
  }
}

export function debounce(fn, wait = 260) {
  let timer = null;
  return (...args) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), wait);
  };
}
