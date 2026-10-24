const storage = {
  get(key) {
    try { return window.localStorage.getItem(key); } catch { return null; }
  },
  set(key, value) {
    try { window.localStorage.setItem(key, value); } catch { /* Storage can be unavailable in hardened browsers. */ }
  },
  remove(key) {
    try { window.localStorage.removeItem(key); } catch { /* No-op. */ }
  },
};

export const state = {
  token: storage.get("maary_platform_token"),
  refreshToken: storage.get("maary_platform_refresh_token"),
  user: null,
  projects: [],
  activeProject: null,
  projectDetails: null,
  memberRole: null,
  activeTab: "overview",
  activeTable: null,
  rowOffset: 0,
  rowEdit: null,
  activeBucket: null,
  tables: [],
  buckets: [],
  functions: [],
  authConfig: null,
  revealSecrets: false,
  ws: null,
  wsStatus: "disconnected",
  requestVersion: 0,
  slugTouched: false,
};

export const $ = (id) => document.getElementById(id);
export const storageAdapter = storage;

export class ApiError extends Error {
  constructor(message, status = 0, code = "request_failed", details = null, requestId = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }
}

let refreshPromise = null;

export function setSession(result) {
  state.token = result.accessToken;
  state.refreshToken = result.refreshToken;
  state.user = result.user ?? state.user;
  if (state.token) storage.set("maary_platform_token", state.token);
  if (state.refreshToken) storage.set("maary_platform_refresh_token", state.refreshToken);
}

export function clearSession() {
  state.token = null;
  state.refreshToken = null;
  state.user = null;
  state.projects = [];
  state.activeProject = null;
  state.projectDetails = null;
  state.tables = [];
  state.buckets = [];
  storage.remove("maary_platform_token");
  storage.remove("maary_platform_refresh_token");
  storage.remove("maary_active_project");
}

async function refreshSession() {
  if (!state.refreshToken) throw new ApiError("Your session has expired. Please sign in again.", 401, "unauthorized");
  if (!refreshPromise) {
    refreshPromise = (async () => {
      const response = await fetch("/v1/platform/auth/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ refreshToken: state.refreshToken }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new ApiError(data.message || "Your session could not be renewed.", response.status, data.error || "unauthorized");
      }
      setSession(data);
      return data;
    })().finally(() => { refreshPromise = null; });
  }
  return refreshPromise;
}

function isJsonBody(body) {
  if (!body || typeof body !== "object") return false;
  if (body instanceof FormData || body instanceof Blob || body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return false;
  return Array.isArray(body) || Object.getPrototypeOf(body) === Object.prototype;
}

export async function api(path, options = {}) {
  const {
    timeout = 30_000,
    skipRefresh = false,
    responseType = "auto",
    _retry = false,
    ...originalOptions
  } = options;
  const headers = { Accept: "application/json", ...(originalOptions.headers || {}) };
  if (state.token && !headers.Authorization) headers.Authorization = `Bearer ${state.token}`;

  const request = { ...originalOptions, headers };
  if (isJsonBody(request.body)) {
    headers["Content-Type"] = "application/json";
    request.body = JSON.stringify(request.body);
  }

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeout);
  request.signal = controller.signal;

  let response;
  try {
    response = await fetch(path, request);
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new ApiError("The request took too long. Check your connection and try again.", 0, "timeout");
    }
    throw new ApiError(navigator.onLine ? "Unable to reach the MARRY BASE server." : "You appear to be offline.", 0, "network_error");
  } finally {
    window.clearTimeout(timer);
  }

  const isAuthEntrypoint = /\/v1\/platform\/auth\/(login|register|refresh)(?:$|\?)/.test(path);
  if (response.status === 401 && !skipRefresh && !_retry && state.refreshToken && !isAuthEntrypoint) {
    try {
      await refreshSession();
      return api(path, { ...options, _retry: true });
    } catch (error) {
      if (error?.status === 401 || error?.status === 403) {
        window.dispatchEvent(new CustomEvent("maary:unauthorized"));
      }
      throw error;
    }
  }

  let data;
  if (response.status === 204) {
    data = null;
  } else if (responseType === "blob") {
    data = await response.blob();
  } else if (responseType === "text") {
    data = await response.text();
  } else {
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json") || contentType.includes("+json")) {
      data = await response.json().catch(() => ({}));
    } else {
      data = await response.text();
    }
  }

  if (!response.ok) {
    if (response.status === 401 && !isAuthEntrypoint) {
      window.dispatchEvent(new CustomEvent("maary:unauthorized"));
    }
    const message = data && typeof data === "object" ? data.message : null;
    const suffix = data?.requestId ? ` (Request ${data.requestId})` : "";
    throw new ApiError(
      `${message || `Request failed with status ${response.status}`}${suffix}`,
      response.status,
      data?.error || "request_failed",
      data?.details,
      data?.requestId,
    );
  }
  return data;
}

export function projectApi(suffix = "") {
  if (!state.activeProject?.slug) throw new ApiError("Select a project first.", 400, "no_project");
  return `/v1/projects/${encodeURIComponent(state.activeProject.slug)}${suffix}`;
}

export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

export function icon(name, className = "") {
  return `<svg class="icon ${esc(className)}" aria-hidden="true"><use href="#i-${esc(name)}"></use></svg>`;
}

export function formatNumber(value) {
  return new Intl.NumberFormat().format(Number(value) || 0);
}

export function formatBytes(value, precision = 1) {
  const bytes = Number(value) || 0;
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(Math.abs(bytes)) / Math.log(1024)), units.length - 1);
  const amount = bytes / (1024 ** index);
  return `${amount.toFixed(index === 0 ? 0 : precision)} ${units[index]}`;
}

export function formatDate(value, includeTime = true) {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(undefined, includeTime
    ? { dateStyle: "medium", timeStyle: "short" }
    : { dateStyle: "medium" }).format(date);
}

export function timeAgo(value) {
  if (!value) return "Never";
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return String(value);
  const seconds = Math.round((timestamp - Date.now()) / 1000);
  const absolute = Math.abs(seconds);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (absolute < 60) return formatter.format(seconds, "second");
  if (absolute < 3600) return formatter.format(Math.round(seconds / 60), "minute");
  if (absolute < 86400) return formatter.format(Math.round(seconds / 3600), "hour");
  if (absolute < 2_592_000) return formatter.format(Math.round(seconds / 86400), "day");
  return formatDate(value, false);
}

export function truncate(value, length = 42) {
  const text = String(value ?? "");
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

export function slugify(value) {
  return String(value || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
}

export function initials(user) {
  const source = user?.name || user?.email || "MB";
  const parts = String(source).split(/[\s@._-]+/).filter(Boolean);
  return parts.slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "MB";
}

export function statusTone(status) {
  const value = String(status || "").toLowerCase();
  if (["active", "completed", "applied", "ready", "connected", "enabled", "operational", "success", "verified"].includes(value)) return "success";
  if (["failed", "dead_letter", "revoked", "banned", "suspended", "error", "degraded", "disabled"].includes(value)) return "danger";
  if (["queued", "pending", "running", "restored", "non-prod", "archived", "cancelled", "rolled_back"].includes(value)) return "warning";
  if (["production", "service_role", "owner"].includes(value)) return "purple";
  return "info";
}

export function badge(value, tone = statusTone(value), label = null) {
  return `<span class="badge badge-${esc(tone)}">${esc(label ?? String(value ?? "unknown").replaceAll("_", " "))}</span>`;
}

export function emptyState(iconName, title, message, action = "") {
  return `<div class="empty-state"><div class="empty-icon">${icon(iconName)}</div><h3>${esc(title)}</h3><p>${esc(message)}</p>${action}</div>`;
}

export function loadingState(label = "Loading data…") {
  return `<div class="loading-block"><span class="button-group"><span class="spinner"></span>${esc(label)}</span></div>`;
}

export function errorState(error, retryAction = "refresh-page") {
  const message = error instanceof Error ? error.message : String(error || "Something went wrong.");
  return `<div class="error-state">${icon("alert")}<h3>We couldn’t load this view</h3><p>${esc(message)}</p><button class="btn btn-secondary btn-sm" data-action="${esc(retryAction)}">${icon("refresh")}Try again</button></div>`;
}

export function showToast(message, type = "success", title = null) {
  const region = $("toast-region");
  if (!region) return;
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.setAttribute("role", type === "error" ? "alert" : "status");
  const iconName = type === "error" ? "alert" : type === "warning" ? "alert" : type === "info" ? "info" : "check";
  toast.innerHTML = `${icon(iconName)}<div class="toast-content"><strong></strong><p></p></div><button class="icon-btn" aria-label="Dismiss notification">${icon("close")}</button>`;
  toast.querySelector("strong").textContent = title || (type === "error" ? "Something went wrong" : type === "info" ? "Heads up" : "Done");
  toast.querySelector("p").textContent = String(message || "Action completed.");
  const remove = () => {
    if (!toast.isConnected) return;
    toast.classList.add("removing");
    window.setTimeout(() => toast.remove(), 180);
  };
  toast.querySelector("button").addEventListener("click", remove);
  region.appendChild(toast);
  while (region.children.length > 4) region.firstElementChild?.remove();
  window.setTimeout(remove, type === "error" ? 8000 : 4500);
}

export function reportError(error, fallback = "The action could not be completed.") {
  console.error(error);
  showToast(error instanceof Error ? error.message : fallback, "error");
}

export async function busy(button, task, busyLabel = null) {
  if (!button || button.disabled) return;
  const original = button.innerHTML;
  const width = button.offsetWidth;
  if (width) button.style.minWidth = `${width}px`;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  button.innerHTML = `<span class="spinner"></span>${busyLabel ? `<span>${esc(busyLabel)}</span>` : original}`;
  try {
    return await task();
  } finally {
    button.disabled = false;
    button.removeAttribute("aria-busy");
    button.innerHTML = original;
    button.style.minWidth = "";
  }
}

export function confirmAction({ title, message, confirmLabel = "Confirm", requireText = "", danger = true }) {
  const dialog = $("confirm-dialog");
  const form = dialog.querySelector("form");
  const inputWrap = $("confirm-input-wrap");
  const input = $("confirm-input");
  const submit = $("confirm-submit");
  $("confirm-title").textContent = title;
  $("confirm-message").textContent = message;
  $("confirm-icon").classList.toggle("danger", danger);
  submit.textContent = confirmLabel;
  submit.className = `btn ${danger ? "btn-danger" : "btn-primary"}`;
  inputWrap.classList.toggle("hidden", !requireText);
  input.value = "";
  input.required = Boolean(requireText);
  input.removeAttribute("pattern");
  input.setCustomValidity("");
  if (requireText) {
    $("confirm-input-label").textContent = `Type “${requireText}” to confirm`;
    input.oninput = () => input.setCustomValidity(input.value === requireText ? "" : `Enter ${requireText} exactly.`);
  } else {
    input.oninput = null;
  }
  form.onsubmit = (event) => {
    if (event.submitter?.value === "confirm" && requireText && input.value !== requireText) {
      event.preventDefault();
      input.setCustomValidity(`Enter ${requireText} exactly.`);
      input.reportValidity();
    }
  };
  dialog.returnValue = "cancel";
  dialog.showModal();
  if (requireText) window.setTimeout(() => input.focus(), 50);
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), { once: true });
  });
}

export function showCredentials(title, value) {
  $("credential-title").textContent = title;
  $("credential-value").textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  $("credential-dialog").showModal();
}

export async function copyText(value, quiet = false) {
  const text = String(value ?? "");
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      const copied = document.execCommand("copy");
      textarea.remove();
      if (!copied) throw new Error("Copy command was rejected.");
    }
    if (!quiet) showToast("Copied to clipboard.", "success", "Copied");
    return true;
  } catch {
    showToast("Copy wasn’t available. Select the value and copy it manually.", "warning");
    return false;
  }
}

export function parseJson(value, label = "JSON") {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new ApiError(`${label} is invalid: ${error.message}`, 400, "invalid_json");
  }
}

export function formatCell(value) {
  if (value === null || value === undefined) return '<span class="subtle">NULL</span>';
  if (typeof value === "object") return `<div class="json-cell">${esc(JSON.stringify(value))}</div>`;
  if (typeof value === "boolean") return badge(String(value), value ? "success" : "info");
  return esc(String(value));
}

export function debounce(callback, wait = 250) {
  let timer;
  return (...args) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => callback(...args), wait);
  };
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

export function announce(message) {
  const region = $("sr-announcer");
  if (region) region.textContent = message;
}

export function closeDialog(id) {
  const dialog = $(id);
  if (dialog?.open) dialog.close();
}
