(() => {
  "use strict";

  const config = window.__MARRY_BASE_CONFIG__ || {};
  const STORAGE_KEY = "marry-base.server-url";
  const DEFAULT_URL = config.serverUrl || "http://10.0.2.2:4100";
  const elements = {
    form: document.querySelector("#server-form"),
    input: document.querySelector("#server-url"),
    error: document.querySelector("#form-error"),
    hint: document.querySelector("#url-hint"),
    connect: document.querySelector("#connect-button"),
    check: document.querySelector("#check-button"),
    reset: document.querySelector("#reset-button"),
    feedback: document.querySelector("#connection-feedback"),
    status: document.querySelector("#status-pill"),
    statusLabel: document.querySelector("#status-label"),
    runtime: document.querySelector("#runtime-card"),
    runtimeHost: document.querySelector("#runtime-host"),
    database: document.querySelector("#database-value"),
    migrations: document.querySelector("#migrations-value"),
    worker: document.querySelector("#worker-value"),
    studio: document.querySelector("#studio-link"),
    platform: document.querySelector("#platform-link"),
    health: document.querySelector("#health-link"),
    project: document.querySelector("#project-badge"),
    package: document.querySelector("#package-label"),
  };

  let activeUrl = DEFAULT_URL;
  let connectedUrl = null;
  let checking = false;

  function readSavedUrl() {
    try { return window.localStorage.getItem(STORAGE_KEY); } catch { return null; }
  }

  function saveUrl(value) {
    try { window.localStorage.setItem(STORAGE_KEY, value); } catch { /* Storage may be unavailable in privacy mode. */ }
  }

  function normalizeUrl(value) {
    const input = String(value || "").trim();
    if (!input) throw new Error("Enter the URL of your MARRY BASE server.");
    const url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("Use an HTTP or HTTPS server URL.");
    if (url.username || url.password) throw new Error("Remove credentials from the URL. Sign in inside the Studio instead.");
    if (url.search || url.hash) throw new Error("Use the server address without a query string or fragment.");
    url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/dashboard$/, "");
    return url.toString().replace(/\/$/, "");
  }

  function endpoint(path) {
    return `${activeUrl}${path}`;
  }

  function setStatus(status, label, message) {
    elements.status.dataset.status = status;
    elements.statusLabel.textContent = label;
    elements.feedback.dataset.status = status;
    elements.feedback.textContent = message;
  }

  function setBusy(value) {
    checking = value;
    elements.connect.disabled = value;
    elements.check.disabled = value;
    elements.input.readOnly = value;
    elements.connect.classList.toggle("is-loading", value);
    elements.connect.querySelector("span").textContent = value ? "Checking your instance…" : "Connect & open Studio";
  }

  function showFormError(message = "") {
    elements.error.textContent = message;
    elements.error.classList.toggle("hidden", !message);
    elements.input.setAttribute("aria-invalid", message ? "true" : "false");
  }

  function updateLinks(url) {
    try {
      activeUrl = normalizeUrl(url);
      elements.studio.href = endpoint("/dashboard");
      elements.platform.href = endpoint("/v1/platform");
      elements.health.href = endpoint("/health");
      elements.runtimeHost.textContent = new URL(activeUrl).host;
      elements.reset.classList.toggle("hidden", activeUrl === normalizeUrl(DEFAULT_URL));
      elements.hint.textContent = activeUrl.startsWith("http:")
        ? "Local development URL. Use HTTPS for a production server."
        : "Your URL is stored only on this device after a successful check.";
      return true;
    } catch {
      return false;
    }
  }

  function renderRuntime(payload) {
    const mode = payload.pool?.mode || "external";
    elements.runtime.classList.remove("hidden");
    elements.database.textContent = mode === "embedded-memory"
      ? "Embedded memory"
      : mode === "embedded-disk" ? "Embedded PGlite" : "PostgreSQL";
    elements.migrations.textContent = payload.dependencies.migrations === "ok" ? "Applied" : "Pending";
    elements.worker.textContent = payload.worker?.running
      ? "Running"
      : payload.worker?.enabled ? "Enabled" : "Disabled";
  }

  async function checkConnection({ openStudio = false } = {}) {
    if (checking) return;
    showFormError();
    let candidate;
    try {
      candidate = normalizeUrl(elements.input.value);
    } catch (error) {
      showFormError(error.message);
      setStatus("error", "Check URL", "Enter a valid server address, then try again.");
      elements.input.focus();
      return;
    }

    updateLinks(candidate);
    setBusy(true);
    elements.runtime.classList.add("hidden");
    setStatus("checking", "Connecting", `Checking ${new URL(candidate).host}…`);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 10000);

    try {
      const response = await fetch(endpoint("/ready"), {
        method: "GET",
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({}));
      const failedChecks = ["postgres", "migrations", "storage"]
        .filter((name) => payload.dependencies?.[name] !== "ok");
      if (!response.ok || payload.status !== "ready" || failedChecks.length > 0) {
        throw new Error(failedChecks.length ? `The server responded, but ${failedChecks.join(" and ")} is not ready.` : "This address did not return a ready MARRY BASE instance.");
      }

      connectedUrl = candidate;
      saveUrl(candidate);
      updateLinks(candidate);
      renderRuntime(payload);
      setStatus("connected", "Connected", `Connected to ${new URL(candidate).host}. Your workspace is ready.`);
      if (openStudio) window.location.assign(endpoint("/dashboard"));
    } catch (error) {
      connectedUrl = null;
      elements.runtime.classList.add("hidden");
      const message = error.name === "AbortError"
        ? "The connection timed out. Check the address, server, and network."
        : error.message || "The server could not be reached.";
      setStatus("error", "Unavailable", message);
      showFormError("Check that MARRY BASE is running and reachable from this device. Connection help is below.");
    } finally {
      window.clearTimeout(timeout);
      setBusy(false);
    }
  }

  elements.form.addEventListener("submit", (event) => {
    event.preventDefault();
    void checkConnection({ openStudio: true });
  });
  elements.check.addEventListener("click", () => void checkConnection());
  elements.reset.addEventListener("click", () => {
    elements.input.value = normalizeUrl(DEFAULT_URL);
    connectedUrl = null;
    saveUrl(elements.input.value);
    updateLinks(elements.input.value);
    elements.runtime.classList.add("hidden");
    showFormError();
    setStatus("idle", "Not connected", "Packaged server restored. Test the connection or open your Studio.");
  });
  elements.input.addEventListener("input", () => {
    showFormError();
    let normalized = null;
    try {
      normalized = normalizeUrl(elements.input.value);
      updateLinks(normalized);
    } catch { /* Wait for a complete URL before changing navigation links. */ }
    if (connectedUrl && normalized !== connectedUrl) {
      connectedUrl = null;
      elements.runtime.classList.add("hidden");
      setStatus("idle", "Not connected", "Server changed. Test the new address before opening your Studio.");
    }
  });
  elements.studio.addEventListener("click", (event) => {
    if (!updateLinks(elements.input.value)) {
      event.preventDefault();
      showFormError("Enter a valid server URL before opening the Studio.");
      elements.input.focus();
    }
  });

  const savedUrl = readSavedUrl();
  elements.input.value = savedUrl || DEFAULT_URL;
  updateLinks(elements.input.value);
  elements.project.textContent = config.projectSlug ? `Project · ${config.projectSlug}` : "Platform client";
  elements.package.textContent = `${config.packageName || "com.marrybase.platform"} · v${config.versionName || "1.0.0"}`;

  if (new URLSearchParams(window.location.search).get("connection") === "failed") {
    setStatus("error", "Page unavailable", "The Studio page could not be loaded. Verify the server connection below.");
  } else {
    void checkConnection();
  }
})();
