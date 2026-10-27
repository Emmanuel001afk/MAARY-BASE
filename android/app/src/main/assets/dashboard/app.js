import {
  $, PROJECT_FREE_TABS, api, closeDialog, esc, icon, openDialog, reportError,
  sessionTokens, settleConfirm, showToast, slugify, state, storageAdapter, withButtonBusy,
} from "./js/core.js";
import { COMMAND_ITEMS, PAGE_META, loadPage, renderPageSkeleton } from "./js/pages.js";
import { renderContextMenu } from "./js/navigation.js";
import {
  activateLocalTab, applyNavSectionState, closeRealtime, handleAction, handleChange, handleInput, handleSubmit, renderSqlHistory,
} from "./js/actions.js";

function applyTheme(theme) {
  const next = theme === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  storageAdapter.set("maary_theme", next);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", next === "light" ? "#f4f7f8" : "#071015");
  const iconEl = $("theme-icon");
  if (iconEl) iconEl.innerHTML = `<use href="#i-${next === "light" ? "moon" : "sun"}"></use>`;
}

function toggleTheme() {
  applyTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light");
}

function setSidebarOpen(open) {
  $("sidebar")?.classList.toggle("open", open);
  $("sidebar-backdrop")?.classList.toggle("hidden", !open);
  $("mobile-menu-btn")?.setAttribute("aria-expanded", String(open));
}

function setAuthMode(mode) {
  const isRegister = mode === "register";
  $("auth-form").dataset.mode = isRegister ? "register" : "login";
  $("auth-tab-login").classList.toggle("active", !isRegister);
  $("auth-tab-login").setAttribute("aria-selected", String(!isRegister));
  $("auth-tab-register").classList.toggle("active", isRegister);
  $("auth-tab-register").setAttribute("aria-selected", String(isRegister));
  $("auth-name-group").classList.toggle("hidden", !isRegister);
  $("auth-title").textContent = isRegister ? "Create an operator account" : "Welcome back";
  $("auth-subtitle").textContent = isRegister
    ? "Create a Studio operator identity to provision workspaces, projects, and keys."
    : "Sign in to manage workspaces, schemas, keys, and live deployments.";
  $("auth-password").setAttribute("autocomplete", isRegister ? "new-password" : "current-password");
  $("auth-submit-btn").textContent = isRegister ? "Create account" : "Sign in to Studio";
  $("auth-error").classList.add("hidden");
  const needBootstrapToken = $("auth-form").dataset.bootstrapTokenRequired === "true";
  $("auth-bootstrap-token-group")?.classList.toggle("hidden", !(isRegister && needBootstrapToken));
}

function showAuthError(message) {
  const alert = $("auth-error");
  alert.textContent = message;
  alert.classList.remove("hidden");
}

async function refreshPlatformStatus() {
  const [platformResult, readyResult, authStatusResult] = await Promise.allSettled([
    api("/v1/platform", { allowUnauthorized: true, skipPlatformAuth: true }),
    api("/ready", { allowUnauthorized: true, skipPlatformAuth: true }),
    api("/v1/platform/auth/status", { allowUnauthorized: true, skipPlatformAuth: true }),
  ]);

  if (platformResult.status === "fulfilled") state.platformInfo = platformResult.value;
  if (readyResult.status === "fulfilled") state.readyInfo = readyResult.value;

  if (authStatusResult.status === "fulfilled") {
    const authSt = authStatusResult.value;
    $("auth-bootstrap-note")?.classList.toggle("hidden", !authSt.bootstrapAvailable);
    $("auth-form").dataset.bootstrapTokenRequired = String(Boolean(authSt.bootstrapTokenRequired));
    if (authSt.bootstrapAvailable) {
      setAuthMode("register");
    }
  }

  const mode = state.platformInfo?.database?.mode || state.readyInfo?.checks?.database?.mode || "postgres";
  const ready = readyResult.status === "fulfilled" && (readyResult.value?.status === "ready" || readyResult.value?.ready !== false);
  const overall = state.platformInfo?.status || (ready ? "operational" : "degraded");

  $("auth-runtime-label").textContent = ready
    ? `Platform ready · PostgreSQL (${mode}) · ${overall}`
    : "Runtime reachable · check database readiness";
  const pill = $("platform-health-pill");
  if (pill) {
    pill.classList.toggle("healthy", ready);
    pill.classList.toggle("degraded", !ready);
    $("health-pill-text").textContent = ready ? `Ready · ${mode}` : "Degraded";
  }
  $("sidebar-runtime-mode").textContent = `PostgreSQL (${mode})`;
  $("footer-runtime-summary").textContent = ready
    ? `Runtime verified · PostgreSQL (${mode})`
    : "Check /ready for diagnostics";
}

function renderUser() {
  if (!state.user) return;
  const label = state.user.name || state.user.email || "Operator";
  $("user-name").textContent = label;
  $("user-role").textContent = state.user.is_superadmin ? "superadmin" : "operator";
  $("user-avatar").textContent = label.slice(0, 1).toUpperCase();
}

function renderOrganizationsSelect() {
  const select = $("org-select");
  if (select) {
    select.innerHTML = `<option value="">All workspaces</option>${state.organizations.map((org) => `<option value="${esc(org.slug)}">${esc(org.name)}</option>`).join("")}`;
    if (state.activeOrgSlug && state.organizations.some((o) => o.slug === state.activeOrgSlug)) {
      select.value = state.activeOrgSlug;
    } else {
      state.activeOrgSlug = "";
      select.value = "";
    }
  }
  const projOrgSelect = $("proj-org");
  if (projOrgSelect) {
    const activeOrg = state.organizations.find((o) => o.slug === state.activeOrgSlug);
    projOrgSelect.innerHTML = `<option value="">Personal / Unassigned</option>${state.organizations.map((org) => `<option value="${esc(org.id)}">${esc(org.name)} (${esc(org.slug)})</option>`).join("")}`;
    projOrgSelect.value = activeOrg?.id || "";
  }
}

function updateProjectMeta() {
  const project = state.activeProject;
  const dot = $("project-status-dot");
  if (!project) {
    $("sidebar-schema-label").textContent = "No project selected";
    dot?.classList.remove("active", "paused");
    return;
  }
  $("sidebar-schema-label").textContent = project.schema_name || project.slug;
  dot?.classList.toggle("active", project.status === "active");
  dot?.classList.toggle("paused", project.status !== "active");
}

function renderProjectOptions(preferredSlug = null) {
  const select = $("project-select");
  if (!state.projects.length) {
    state.activeProject = null;
    select.innerHTML = `<option value="">No projects</option>`;
    select.disabled = true;
    updateProjectMeta();
    return;
  }
  select.disabled = false;
  select.innerHTML = state.projects.map((project) => `<option value="${esc(project.slug)}">${esc(project.name)} (${esc(project.slug)})</option>`).join("");
  const saved = preferredSlug || storageAdapter.get("maary_active_project");
  const chosen = state.projects.find((project) => project.slug === saved) || state.projects[0];
  select.value = chosen.slug;
  state.activeProject = chosen;
  storageAdapter.set("maary_active_project", chosen.slug);
  updateProjectMeta();
}

function syncWorkspaceVisibility() {
  const canRenderPage = Boolean(state.activeProject) || PROJECT_FREE_TABS.has(state.activeTab);
  $("empty-projects-state").classList.toggle("hidden", canRenderPage);
  $("page-root").classList.toggle("hidden", !canRenderPage);
}

async function handleContextNavigation(link) {
  const targetTab = link.dataset.contextTab;
  const contextKey = link.dataset.contextKey || "";
  if (!targetTab || !PAGE_META[targetTab]) return;
  if (state.activeTab !== targetTab) {
    await navigateTo(targetTab, { contextKey });
  } else {
    state.activeContextKey = contextKey;
    renderContextMenu(targetTab, contextKey);
  }
  const localTab = link.dataset.contextLocal;
  if (localTab) activateLocalTab(localTab);
  const focusId = link.dataset.contextFocus;
  if (focusId) {
    window.setTimeout(() => {
      const target = $(focusId);
      if (!target) return;
      const disclosure = target.closest("details");
      if (disclosure) disclosure.open = true;
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 50);
  }
  const action = link.dataset.contextAction;
  if (action) await handleAction(action, link);
}

async function refreshOrganizations() {
  const res = await api("/v1/organizations");
  state.organizations = res.organizations || [];
  renderOrganizationsSelect();
}

async function refreshProjects(preferredSlug = null) {
  const activeOrg = state.organizations.find((o) => o.slug === state.activeOrgSlug);
  const query = activeOrg ? `?organizationId=${encodeURIComponent(activeOrg.id)}` : "";
  const response = await api(`/v1/projects${query}`);
  state.projects = response.projects || [];
  renderProjectOptions(preferredSlug);
  syncWorkspaceVisibility();
}

export async function navigateTo(tab, options = {}) {
  const target = PAGE_META[tab] ? tab : "overview";
  if (state.activeTab === "realtime" && target !== "realtime") closeRealtime();
  state.activeTab = target;
  state.activeContextKey = options.contextKey || null;
  document.querySelectorAll(".nav-item[data-tab]").forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === target);
  });
  renderContextMenu(target, state.activeContextKey);
  setSidebarOpen(false);
  if (options.updateHash !== false) {
    const hash = `#${target}`;
    if (window.location.hash !== hash) window.history.replaceState(null, "", hash);
  }
  syncWorkspaceVisibility();
  if (!state.activeProject && !PROJECT_FREE_TABS.has(target)) return;
  renderPageSkeleton(target);
  if (target === "sql") renderSqlHistory();
  await loadPage(target);
}

async function selectProject(slug, targetTab = null) {
  const project = state.projects.find((item) => item.slug === slug);
  if (!project) return;
  closeRealtime();
  state.activeProject = project;
  state.activeTable = null;
  state.activeBucket = null;
  state.activeSavedQueryId = null;
  state.lastSqlResult = null;
  state.rowBrowser.offset = 0;
  storageAdapter.set("maary_active_project", project.slug);
  $("project-select").value = project.slug;
  updateProjectMeta();
  await navigateTo(targetTab || state.activeTab, { updateHash: false });
}

function showAuthScreen() {
  closeRealtime();
  state.user = null;
  state.projects = [];
  state.organizations = [];
  state.activeProject = null;
  $("app-shell").classList.add("hidden");
  $("auth-screen").classList.remove("hidden");
}

async function enterStudio(user) {
  state.user = user;
  renderUser();
  $("auth-screen").classList.add("hidden");
  $("app-shell").classList.remove("hidden");
  await refreshOrganizations();
  await refreshProjects();
  const initialTab = window.location.hash.replace(/^#/, "");
  await navigateTo(PAGE_META[initialTab] ? initialTab : "overview", { updateHash: true });
}

function buildCommandItems(query = "") {
  const q = query.trim().toLowerCase();
  const projectItems = state.projects.map((project) => ({
    group: "Switch project",
    label: project.name,
    detail: `${project.slug} · ${project.schema_name}`,
    icon: "layers",
    projectSlug: project.slug,
    shortcut: project.slug === state.activeProject?.slug ? "Active" : "",
  }));
  const orgItems = state.organizations.map((org) => ({
    group: "Filter workspace",
    label: org.name,
    detail: `${org.slug} · ${org.project_count} project(s)`,
    icon: "users",
    orgSlug: org.slug,
    shortcut: org.slug === state.activeOrgSlug ? "Selected" : "",
  }));
  const actionItems = [
    { group: "Quick actions", label: "Create new project", detail: "Provision isolated PostgreSQL schema and keys", icon: "plus", run: () => openNewProject() },
    { group: "Quick actions", label: "Create new workspace", detail: "Create an organization for team RBAC", icon: "users", run: () => openNewOrg() },
    { group: "Quick actions", label: "Switch color theme", detail: "Toggle dark and light Studio appearance", icon: "sun", run: () => toggleTheme() },
  ];
  return [...COMMAND_ITEMS, ...orgItems, ...projectItems, ...actionItems].filter((item) =>
    !q || `${item.group} ${item.label} ${item.detail}`.toLowerCase().includes(q)
  );
}

function renderCommandPalette() {
  const results = $("command-results");
  state.commandItems = buildCommandItems($("command-search").value);
  state.commandIndex = Math.min(state.commandIndex, Math.max(state.commandItems.length - 1, 0));
  if (!state.commandItems.length) {
    results.innerHTML = `<div class="empty-state compact"><p>No matching modules, workspaces, or projects.</p></div>`;
    return;
  }
  let currentGroup = "";
  results.innerHTML = state.commandItems.map((item, index) => {
    const heading = item.group !== currentGroup ? `<div class="command-group-label">${esc(item.group)}</div>` : "";
    currentGroup = item.group;
    return `${heading}<button class="command-item ${index === state.commandIndex ? "selected" : ""}" type="button" role="option" aria-selected="${index === state.commandIndex}" data-command-index="${index}">${icon(item.icon)}<span><strong>${esc(item.label)}</strong><small>${esc(item.detail)}</small></span>${item.shortcut ? `<kbd>${esc(item.shortcut)}</kbd>` : ""}</button>`;
  }).join("");
}

function executeCommand(index) {
  const item = state.commandItems[index];
  if (!item) return;
  closeDialog("command-dialog");
  if (item.tab) navigateTo(item.tab).catch(reportError);
  else if (item.projectSlug) selectProject(item.projectSlug).catch(reportError);
  else if (item.orgSlug !== undefined) {
    state.activeOrgSlug = item.orgSlug;
    storageAdapter.set("maary_active_org", state.activeOrgSlug);
    renderOrganizationsSelect();
    refreshProjects().then(() => loadPage()).catch(reportError);
  } else if (item.run) item.run();
}

function openCommandPalette() {
  $("command-search").value = "";
  state.commandIndex = 0;
  renderCommandPalette();
  openDialog("command-dialog");
  window.setTimeout(() => $("command-search").focus(), 20);
}

function openNewProject() {
  state.slugTouched = false;
  $("create-project-form").reset();
  renderOrganizationsSelect();
  openDialog("new-project-dialog");
  window.setTimeout(() => $("proj-name").focus(), 30);
}

function openNewOrg() {
  state.orgSlugTouched = false;
  $("create-org-form").reset();
  openDialog("new-org-dialog");
  window.setTimeout(() => $("org-name").focus(), 30);
}

async function logout() {
  try {
    await api("/v1/platform/auth/logout", { method: "POST", allowUnauthorized: true });
  } catch {
    // Clear local session regardless
  }
  sessionTokens.clear();
  showAuthScreen();
  await refreshPlatformStatus();
  showToast("You have been signed out.", "info", "Signed out");
}

function bindEvents() {
  document.addEventListener("click", (event) => {
    const authModeBtn = event.target.closest("[data-auth-mode]");
    if (authModeBtn) { setAuthMode(authModeBtn.dataset.authMode); return; }

    const closeBtn = event.target.closest("[data-close-dialog]");
    if (closeBtn) { closeDialog(closeBtn.dataset.closeDialog); return; }

    const commandBtn = event.target.closest("[data-command-index]");
    if (commandBtn) { executeCommand(Number(commandBtn.dataset.commandIndex)); return; }

    const contextLink = event.target.closest("[data-context-tab]");
    if (contextLink && !contextLink.hasAttribute("href")) {
      event.preventDefault();
      handleContextNavigation(contextLink).catch(reportError);
      return;
    }

    const localTab = event.target.closest("[data-local-tab]");
    if (localTab) { activateLocalTab(localTab.dataset.localTab); return; }

    const navEl = event.target.closest("[data-tab], [data-nav]");
    if (navEl) {
      event.preventDefault();
      navigateTo(navEl.dataset.tab || navEl.dataset.nav).catch(reportError);
      return;
    }

    const actionEl = event.target.closest("[data-action]");
    if (!actionEl) return;
    const action = actionEl.dataset.action;
    if (action === "toggle-theme") { toggleTheme(); return; }
    if (action === "toggle-sidebar") { setSidebarOpen(!$("sidebar").classList.contains("open")); return; }
    if (action === "close-sidebar") { setSidebarOpen(false); return; }
    if (action === "open-new-project") { openNewProject(); return; }
    if (action === "open-new-org") { openNewOrg(); return; }
    if (action === "open-command-palette") { openCommandPalette(); return; }
    if (action === "cancel-confirm") { settleConfirm(false); return; }
    if (action === "logout") { logout().catch(reportError); return; }
    handleAction(action, actionEl).catch(reportError);
  });

  document.querySelectorAll("dialog.modal").forEach((dialog) => {
    dialog.addEventListener("click", (event) => {
      if (event.target !== dialog) return;
      if (dialog.id === "confirm-dialog") settleConfirm(false);
      else closeDialog(dialog.id);
    });
  });

  $("confirm-dialog").addEventListener("cancel", (event) => {
    event.preventDefault();
    settleConfirm(false);
  });

  $("confirm-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (state.confirmRequireText && $("confirm-input").value.trim() !== state.confirmRequireText) return;
    settleConfirm(true);
  });

  $("confirm-input").addEventListener("input", (event) => {
    if (state.confirmRequireText) {
      $("confirm-submit-btn").disabled = event.target.value.trim() !== state.confirmRequireText;
    }
  });

  $("auth-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    $("auth-error").classList.add("hidden");
    const mode = $("auth-form").dataset.mode || "login";
    const email = $("auth-email").value.trim();
    const password = $("auth-password").value;
    const name = $("auth-name").value.trim();
    const bootstrapToken = $("auth-bootstrap-token")?.value?.trim() || undefined;
    if (!email || !password) {
      showAuthError("Enter both your email address and password.");
      return;
    }
    try {
      await withButtonBusy($("auth-submit-btn"), async () => {
        const headers = {};
        if (mode === "register" && bootstrapToken) {
          headers["x-platform-bootstrap-token"] = bootstrapToken;
        }
        const response = await api(
          mode === "register" ? "/v1/platform/auth/register" : "/v1/platform/auth/login",
          {
            method: "POST",
            headers,
            body: mode === "register" ? { email, password, name: name || undefined, bootstrapToken } : { email, password },
            allowUnauthorized: true,
            skipPlatformAuth: true,
          }
        );
        if (response.accessToken) {
          sessionTokens.save(response.accessToken, response.refreshToken);
        }
        $("auth-form").reset();
        await enterStudio(response.user);
      }, mode === "register" ? "Creating account…" : "Signing in…");
    } catch (error) {
      showAuthError(error.message);
    }
  });

  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || form.id === "auth-form" || form.id === "confirm-form") return;
    event.preventDefault();
    const submitter = event.submitter instanceof HTMLButtonElement ? event.submitter : form.querySelector('button[type="submit"]');
    withButtonBusy(submitter, () => handleSubmit(form), "Working…").catch(reportError);
  });

  document.addEventListener("change", (event) => {
    if (event.target.id === "project-select") {
      selectProject(event.target.value).catch(reportError);
      return;
    }
    if (event.target.id === "org-select") {
      state.activeOrgSlug = event.target.value;
      storageAdapter.set("maary_active_org", state.activeOrgSlug);
      refreshProjects()
        .then(() => {
          if (state.activeProject || PROJECT_FREE_TABS.has(state.activeTab)) return loadPage();
          return undefined;
        })
        .catch(reportError);
      return;
    }
    handleChange(event.target).catch(reportError);
  });

  document.addEventListener("input", (event) => {
    const target = event.target;
    if (target.id === "proj-slug") { state.slugTouched = Boolean(target.value.trim()); return; }
    if (target.id === "proj-name" && !state.slugTouched) { $("proj-slug").value = slugify(target.value); return; }
    if (target.id === "org-slug") { state.orgSlugTouched = Boolean(target.value.trim()); return; }
    if (target.id === "org-name" && !state.orgSlugTouched) { $("org-slug").value = slugify(target.value); return; }
    if (target.id === "command-search") { state.commandIndex = 0; renderCommandPalette(); return; }
    handleInput(target);
  });

  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      if (!state.user) return;
      if ($("command-dialog").open) closeDialog("command-dialog");
      else openCommandPalette();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && event.target?.id === "sql-editor-input") {
      event.preventDefault();
      $("sql-form")?.requestSubmit();
      return;
    }
    if (!$("command-dialog").open) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      state.commandIndex = Math.min(state.commandIndex + 1, Math.max(state.commandItems.length - 1, 0));
      renderCommandPalette();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      state.commandIndex = Math.max(state.commandIndex - 1, 0);
      renderCommandPalette();
    } else if (event.key === "Enter" && state.commandItems.length) {
      event.preventDefault();
      executeCommand(state.commandIndex);
    }
  });

  window.addEventListener("hashchange", () => {
    if (!state.user) return;
    const tab = window.location.hash.replace(/^#/, "");
    if (PAGE_META[tab] && tab !== state.activeTab) navigateTo(tab, { updateHash: false }).catch(reportError);
  });

  window.addEventListener("maary:unauthorized", () => {
    if (state.user) {
      sessionTokens.clear();
      showAuthScreen();
      showToast("Your session expired. Sign in again to continue.", "warning", "Session expired");
    }
  });

  window.addEventListener("maary:orgs-refresh", async () => {
    try {
      await refreshOrganizations();
      await refreshProjects(state.activeProject?.slug);
    } catch (error) { reportError(error); }
  });

  window.addEventListener("maary:select-project", async (event) => {
    try {
      const slug = event.detail?.slug;
      const tab = event.detail?.tab || "overview";
      if (!state.projects.some((p) => p.slug === slug)) {
        state.activeOrgSlug = "";
        storageAdapter.remove("maary_active_org");
        renderOrganizationsSelect();
        await refreshProjects(slug);
      }
      await selectProject(slug, tab);
    } catch (error) { reportError(error); }
  });

  window.addEventListener("maary:project-created", async (event) => {
    try {
      await refreshOrganizations();
      await refreshProjects(event.detail?.slug);
      await navigateTo("overview");
    } catch (error) { reportError(error); }
  });

  window.addEventListener("maary:project-deleted", async () => {
    try {
      await refreshOrganizations();
      await refreshProjects();
      if (state.activeProject) await navigateTo("overview");
    } catch (error) { reportError(error); }
  });

  window.addEventListener("maary:projects-refresh", async (event) => {
    try { await refreshProjects(event.detail?.slug); } catch (error) { reportError(error); }
  });
}

async function init() {
  applyTheme(storageAdapter.get("maary_theme") || "dark");
  setAuthMode("login");
  applyNavSectionState();
  bindEvents();
  await refreshPlatformStatus();
  try {
    const response = await api("/v1/platform/auth/me", { allowUnauthorized: true });
    await enterStudio(response.user);
  } catch {
    showAuthScreen();
  }
}

init().catch(reportError);
