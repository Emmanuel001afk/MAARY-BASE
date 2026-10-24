import {
  $, api, busy, clearSession, closeDialog, esc, icon, initials, reportError,
  setSession, showToast, slugify, state, storageAdapter,
} from "./js/core.js";
import { PAGE_META, loadPage, renderPage, updateRealtimeUi } from "./js/pages.js";
import {
  activateLocalTab, handleAction, handleChange, handleInput, handleSubmit,
  renderSqlHistory,
} from "./js/actions.js";

let authMode = "login";
let projectSequence = 0;
let pendingLocalTab = null;
let commandSelection = 0;
let filteredCommands = [];

const commands = [
  ...Object.entries(PAGE_META).map(([id, page]) => ({ id: `page:${id}`, group: "Navigate", title: page.title, description: page.description, icon: page.icon, tab: id })),
  { id: "new-project", group: "Actions", title: "Create a new project", description: "Provision an isolated backend", icon: "plus" },
  { id: "refresh", group: "Actions", title: "Refresh current view", description: "Fetch the latest project data", icon: "refresh" },
  { id: "theme", group: "Actions", title: "Toggle color theme", description: "Switch between dark and light mode", icon: "sun" },
  { id: "apk", group: "Actions", title: "Android companion", description: "Open build status and download the Gradle-built APK", icon: "download" },
  { id: "logout", group: "Account", title: "Sign out", description: "End this operator session", icon: "logout" },
];

function applyTheme(theme) {
  const safeTheme = theme === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = safeTheme;
  storageAdapter.set("maary_studio_theme", safeTheme);
  $("theme-icon-use")?.setAttribute("href", safeTheme === "dark" ? "#i-sun" : "#i-moon");
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", safeTheme === "dark" ? "#0a0f14" : "#f3f6f5");
}

function setAuthFeedback(message = "", type = "error") {
  const feedback = $("auth-feedback");
  feedback.textContent = message;
  feedback.className = `inline-feedback${message ? "" : " hidden"}${type === "success" ? " success" : ""}`;
}

function setAuthMode(mode) {
  authMode = mode === "register" ? "register" : "login";
  document.querySelectorAll("[data-auth-mode]").forEach((button) => {
    const active = button.dataset.authMode === authMode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  const registering = authMode === "register";
  $("auth-title").textContent = registering ? "Create your operator account" : "Welcome back";
  $("auth-subtitle").textContent = registering ? "Set up secure access to this MARRY BASE control plane." : "Sign in to your operator account to continue.";
  $("auth-name-field").classList.toggle("hidden", !registering);
  $("auth-bootstrap-field").classList.toggle("hidden", !registering);
  $("auth-name").required = registering;
  $("auth-password").autocomplete = registering ? "new-password" : "current-password";
  $("password-hint").textContent = registering ? "At least 8 characters" : "Your operator password";
  $("auth-submit").querySelector("span").textContent = registering ? "Create operator account" : "Sign in to Studio";
  setAuthFeedback();
}

function resetRealtime() {
  if (state.ws) {
    const socket = state.ws;
    state.ws = null;
    socket.onclose = null;
    socket.close(1000, "Project changed");
  }
  updateRealtimeUi("disconnected");
}

function showAuth(message = "") {
  resetRealtime();
  $("app-shell").classList.add("hidden");
  $("auth-view").classList.remove("hidden");
  $("boot-screen").classList.add("hidden");
  setAuthMode("login");
  if (message) setAuthFeedback(message);
  document.title = "Sign in · MARRY BASE Management Studio";
}

function showStudio() {
  $("auth-view").classList.add("hidden");
  $("boot-screen").classList.add("hidden");
  $("app-shell").classList.remove("hidden");
  $("current-user-label").textContent = state.user?.email || "Operator";
  $("current-user-label").title = state.user?.is_superadmin ? `${state.user.email} · Superadmin` : state.user?.email || "";
  $("user-avatar").textContent = initials(state.user);
  void loadVersionLabel();
}

async function loadVersionLabel() {
  const label = $("sidebar-version");
  if (!label) return;
  try {
    const version = await api("/v1/platform/version", { timeout: 8_000 });
    if (version?.version) label.textContent = `v${version.version}`;
    label.title = version?.commit ? `Commit ${version.commit}` : "Installed platform version";
  } catch {
    label.title = "Version unavailable — the server did not answer the version endpoint.";
  }
}

async function checkHealth() {
  const pill = $("health-pill");
  if (!pill) return;
  try {
    const ready = await api("/ready", { skipRefresh: true, timeout: 10_000 });
    pill.classList.remove("degraded");
    pill.querySelector("span:last-child").textContent = "Healthy";
    pill.title = `PostgreSQL ready · ${ready.pool?.mode || "connected"} · Worker ${ready.worker?.running ? "running" : "idle"}`;
  } catch {
    pill.classList.add("degraded");
    pill.querySelector("span:last-child").textContent = "Degraded";
    pill.title = "The instance is not ready. Click to retry.";
  }
}

function currentHashTab() {
  const tab = window.location.hash.replace(/^#\/?/, "").split("/")[0];
  return PAGE_META[tab] ? tab : "overview";
}

async function activateRoute() {
  if (!state.activeProject) {
    state.activeTab = currentHashTab();
    renderPage(state.activeTab);
    return;
  }
  const tab = currentHashTab();
  if (state.ws && tab !== "realtime") {
    // Keep an existing stream alive across views; only project changes and sign-out close it.
  }
  renderPage(tab);
  if (tab === "sql") renderSqlHistory();
  await loadPage(tab);
  if (pendingLocalTab) {
    activateLocalTab(pendingLocalTab);
    pendingLocalTab = null;
  }
}

function navigate(tab, localTab = null) {
  if (!PAGE_META[tab]) return;
  pendingLocalTab = localTab;
  closeSidebar();
  if (currentHashTab() === tab && window.location.hash) {
    void activateRoute().catch(reportError);
  } else {
    window.location.hash = tab;
  }
}

async function selectProject(slug) {
  if (!slug) return;
  const sequence = ++projectSequence;
  resetRealtime();
  state.requestVersion += 1;
  state.activeTable = null;
  state.activeBucket = null;
  state.revealSecrets = false;
  const listed = state.projects.find((project) => project.slug === slug);
  state.activeProject = listed || { slug, name: slug };
  storageAdapter.set("maary_active_project", slug);
  $("project-select").value = slug;
  $("sidebar-project-name").textContent = state.activeProject.name;
  renderPage(currentHashTab());
  try {
    const details = await api(`/v1/projects/${encodeURIComponent(slug)}`);
    if (sequence !== projectSequence) return;
    state.activeProject = details.project;
    state.projectDetails = details;
    state.memberRole = details.memberRole;
    const index = state.projects.findIndex((project) => project.slug === slug);
    if (index >= 0) state.projects[index] = details.project;
    $("sidebar-project-name").textContent = details.project.name;
    await activateRoute();
  } catch (error) {
    if (sequence === projectSequence) reportError(error);
  }
}

async function loadProjects(preferredSlug = null) {
  const response = await api("/v1/projects");
  state.projects = response.projects || [];
  const select = $("project-select");
  select.innerHTML = "";
  select.disabled = state.projects.length === 0;
  if (!state.projects.length) {
    const option = document.createElement("option");
    option.textContent = "No projects yet";
    select.appendChild(option);
    state.activeProject = null;
    state.projectDetails = null;
    $("sidebar-project-name").textContent = "No project selected";
    renderPage(currentHashTab());
    return;
  }
  for (const project of state.projects) {
    const option = document.createElement("option");
    option.value = project.slug;
    option.textContent = project.name;
    option.title = project.slug;
    select.appendChild(option);
  }
  const stored = storageAdapter.get("maary_active_project");
  const preferred = preferredSlug || state.activeProject?.slug || stored;
  const selected = state.projects.find((project) => project.slug === preferred) || state.projects[0];
  await selectProject(selected.slug);
}

async function handleAuthSubmit(button) {
  const email = $("auth-email").value.trim();
  const password = $("auth-password").value;
  if (!email || !password || (authMode === "register" && password.length < 8)) {
    setAuthFeedback("Enter a valid email and a password of at least 8 characters.");
    return;
  }
  setAuthFeedback();
  await busy(button, async () => {
    try {
      const registering = authMode === "register";
      const bootstrap = $("auth-bootstrap").value;
      const result = await api(registering ? "/v1/platform/auth/register" : "/v1/platform/auth/login", {
        method: "POST",
        skipRefresh: true,
        headers: registering && bootstrap ? { "x-platform-bootstrap-token": bootstrap } : {},
        body: { email, password, ...(registering ? { name: $("auth-name").value } : {}) },
      });
      setSession(result);
      state.user = result.user;
      $("auth-form").reset();
      showStudio();
      await loadProjects();
      showToast(`Welcome${state.user?.name ? `, ${state.user.name}` : ""}. Your workspace is ready.`, "success", "Signed in");
      void checkHealth();
    } catch (error) {
      setAuthFeedback(error.message || "Authentication failed.");
    }
  }, authMode === "register" ? "Creating account…" : "Signing in…");
}

async function logout() {
  try {
    if (state.token) await api("/v1/platform/auth/logout", { method: "POST", skipRefresh: true, timeout: 8000 });
  } catch { /* Local sign-out still proceeds if the server is unavailable. */ }
  clearSession();
  showAuth();
}

function openNewProject() {
  const dialog = $("new-project-dialog");
  if (!dialog.open) dialog.showModal();
  window.setTimeout(() => $("proj-name").focus(), 60);
}

function openCommandPalette() {
  const dialog = $("command-dialog");
  if (!dialog.open) dialog.showModal();
  $("command-search").value = "";
  commandSelection = 0;
  renderCommands();
  window.setTimeout(() => $("command-search").focus(), 50);
}

function renderCommands() {
  const query = $("command-search").value.trim().toLowerCase();
  filteredCommands = commands.filter((command) => `${command.title} ${command.description} ${command.group}`.toLowerCase().includes(query));
  commandSelection = Math.min(commandSelection, Math.max(filteredCommands.length - 1, 0));
  const container = $("command-results");
  if (!filteredCommands.length) {
    container.innerHTML = `<div class="empty-state" style="min-height:110px"><p>No commands match “${esc(query)}”.</p></div>`;
    return;
  }
  let previousGroup = "";
  container.innerHTML = filteredCommands.map((command, index) => {
    const heading = command.group !== previousGroup ? `<span class="command-group-label">${esc(command.group)}</span>` : "";
    previousGroup = command.group;
    return `${heading}<button class="command-item ${index === commandSelection ? "selected" : ""}" data-command-index="${index}">${icon(command.icon)}<span><strong>${esc(command.title)}</strong><small>${esc(command.description)}</small></span>${command.tab ? `<kbd>${esc(command.tab)}</kbd>` : icon("chevron")}</button>`;
  }).join("");
  container.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
}

async function runCommand(index) {
  const command = filteredCommands[index];
  if (!command) return;
  closeDialog("command-dialog");
  if (command.tab) return navigate(command.tab);
  switch (command.id) {
    case "new-project": openNewProject(); break;
    case "refresh": await loadPage(); showToast("View refreshed."); break;
    case "theme": applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"); break;
    case "apk": navigate("platform"); break;
    case "logout": await logout(); break;
    default: break;
  }
}

function closeSidebar() {
  $("sidebar").classList.remove("open");
  $("sidebar-backdrop").classList.add("hidden");
  document.querySelector('[data-action="toggle-sidebar"]')?.setAttribute("aria-expanded", "false");
}

function toggleSidebar() {
  const open = !$("sidebar").classList.contains("open");
  $("sidebar").classList.toggle("open", open);
  $("sidebar-backdrop").classList.toggle("hidden", !open);
  document.querySelector('[data-action="toggle-sidebar"]')?.setAttribute("aria-expanded", String(open));
}

async function handleGlobalAction(action, element) {
  switch (action) {
    case "toggle-password": {
      const input = $(element.dataset.target);
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      element.setAttribute("aria-label", show ? "Hide password" : "Show password");
      element.querySelector("use").setAttribute("href", show ? "#i-eye-off" : "#i-eye");
      return true;
    }
    case "new-project": openNewProject(); return true;
    case "theme-toggle": applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"); return true;
    case "logout": await logout(); return true;
    case "toggle-sidebar": toggleSidebar(); return true;
    case "close-sidebar": closeSidebar(); return true;
    case "health-check": await checkHealth(); showToast("Platform health check complete.", "info"); return true;
    case "command-palette": openCommandPalette(); return true;
    default: return false;
  }
}

function bindEvents() {
  window.addEventListener("hashchange", () => void activateRoute().catch(reportError));
  window.addEventListener("online", () => { $("offline-banner").classList.add("hidden"); void checkHealth(); });
  window.addEventListener("offline", () => $("offline-banner").classList.remove("hidden"));
  window.addEventListener("maary:unauthorized", () => { clearSession(); showAuth("Your session expired. Please sign in again."); });
  window.addEventListener("maary:project-created", (event) => {
    window.history.replaceState(null, "", "#overview");
    state.activeTab = "overview";
    void loadProjects(event.detail.slug).catch(reportError);
  });
  window.addEventListener("maary:project-deleted", () => {
    state.activeProject = null;
    window.history.replaceState(null, "", "#overview");
    void loadProjects().catch(reportError);
  });
  window.addEventListener("maary:projects-refresh", (event) => void loadProjects(event.detail?.slug).catch(reportError));

  document.addEventListener("click", async (event) => {
    const authModeButton = event.target.closest("[data-auth-mode]");
    if (authModeButton) { setAuthMode(authModeButton.dataset.authMode); return; }
    const closeButton = event.target.closest("[data-close-dialog]");
    if (closeButton) { closeDialog(closeButton.dataset.closeDialog); return; }
    const localTab = event.target.closest("[data-local-tab]");
    if (localTab) { activateLocalTab(localTab.dataset.localTab); return; }
    const commandItem = event.target.closest("[data-command-index]");
    if (commandItem) { await runCommand(Number(commandItem.dataset.commandIndex)).catch(reportError); return; }
    const nav = event.target.closest("[data-nav], .nav-item[data-tab]");
    if (nav) { navigate(nav.dataset.nav || nav.dataset.tab, nav.dataset.localTarget || null); return; }
    const actionElement = event.target.closest("[data-action]");
    if (!actionElement || actionElement.matches("select, input, textarea")) return;
    event.preventDefault();
    const action = actionElement.dataset.action;
    try {
      if (await handleGlobalAction(action, actionElement)) return;
      if (actionElement.tagName === "BUTTON") {
        await busy(actionElement, () => handleAction(action, actionElement));
      } else await handleAction(action, actionElement);
    } catch (error) { reportError(error); }
  });

  document.addEventListener("submit", async (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.id) return;
    event.preventDefault();
    const button = event.submitter || form.querySelector('button[type="submit"]');
    try {
      if (form.id === "auth-form") await handleAuthSubmit(button);
      else await busy(button, () => handleSubmit(form));
    } catch (error) { reportError(error); }
  });

  document.addEventListener("change", async (event) => {
    const element = event.target;
    if (element.id === "project-select") {
      await selectProject(element.value).catch(reportError);
      return;
    }
    try { await handleChange(element); } catch (error) { reportError(error); await loadPage().catch(() => {}); }
  });

  document.addEventListener("input", (event) => {
    const element = event.target;
    if (element.id === "proj-name" && !state.slugTouched) $("proj-slug").value = slugify(element.value);
    if (element.id === "proj-slug") state.slugTouched = Boolean(element.value);
    if (element.id === "command-search") { commandSelection = 0; renderCommands(); }
    handleInput(element);
  });

  document.addEventListener("keydown", async (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      if (state.user) openCommandPalette();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && event.target.id === "sql-editor-input") {
      event.preventDefault();
      $("sql-form").requestSubmit();
      return;
    }
    if ($("command-dialog").open && ["ArrowDown", "ArrowUp", "Enter"].includes(event.key)) {
      event.preventDefault();
      if (event.key === "Enter") await runCommand(commandSelection).catch(reportError);
      else {
        const direction = event.key === "ArrowDown" ? 1 : -1;
        commandSelection = Math.max(0, Math.min(filteredCommands.length - 1, commandSelection + direction));
        renderCommands();
      }
    }
  });

  document.querySelectorAll("dialog").forEach((dialog) => {
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) {
        const bounds = dialog.getBoundingClientRect();
        const inside = event.clientX >= bounds.left && event.clientX <= bounds.right && event.clientY >= bounds.top && event.clientY <= bounds.bottom;
        if (!inside && dialog.id !== "confirm-dialog") dialog.close();
      }
    });
  });
}

async function init() {
  applyTheme(storageAdapter.get("maary_studio_theme") || "dark");
  bindEvents();
  $("offline-banner").classList.toggle("hidden", navigator.onLine);
  void checkHealth();
  window.setInterval(() => { if (!document.hidden) void checkHealth(); }, 60_000);
  if (!state.token) {
    showAuth();
    return;
  }
  try {
    const result = await api("/v1/platform/auth/me");
    state.user = result.user;
    showStudio();
    await loadProjects();
  } catch (error) {
    if (error?.status === 401 || error?.status === 403) clearSession();
    showAuth(error?.status !== 401 && error?.status !== 403 ? "The server could not be reached. Your saved session will be retried on the next visit." : "");
  } finally {
    $("boot-screen").classList.add("hidden");
  }
}

void init();
