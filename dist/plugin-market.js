/**
 * OpenCode Desktop - Plugin Market Extension (Standalone Overlay)
 *
 * Injects a "Plugin Market" tab into the native Settings dialog (v2).
 * Communicates with the sidecar server via credentials retrieved from Tauri,
 * and shells out to the `opencode` CLI for plugin installation and removal.
 */
(function initPluginMarket() {
  "use strict";

  // Prevent double-initialization
  if (window.__OPENCODE_PLUGIN_MARKET_INITIALIZED__) {
    return;
  }
  window.__OPENCODE_PLUGIN_MARKET_INITIALIZED__ = true;

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  const state = {
    credentials: null,
    installedPlugins: [],       // Array of { id, name, version, outdated, status, raw }
    marketPackages: [],          // Array of npm packages
    activeSubtab: "market",      // "market" | "installed"
    searchQuery: "",
    isLoading: false,
    loadingMessage: "Loading plugins...",
    error: null,
    pendingOps: new Set(),       // Set of package names currently being installed/removed/updated
    hasPendingChanges: false,
    toast: null,                 // { type: "info"|"success"|"error", message: string, timer }
  };

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  function escapeHtml(str) {
    if (!str) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function formatDownloads(count) {
    if (!count || count < 0) return "0";
    if (count >= 1000000) return (count / 1000000).toFixed(1) + "M";
    if (count >= 1000) return (count / 1000).toFixed(1) + "k";
    return String(count);
  }

  function getTauriInvoke() {
    if (window.__TAURI__ && window.__TAURI__.core && typeof window.__TAURI__.core.invoke === "function") {
      return window.__TAURI__.core.invoke;
    }
    return null;
  }

  async function tauriInvoke(cmd, args = {}) {
    const inv = getTauriInvoke();
    if (!inv) {
      throw new Error("Tauri IPC bridge not available");
    }
    return await inv(cmd, args);
  }

  function openExternalUrl(url) {
    if (!url || (!url.startsWith("http://") && !url.startsWith("https://"))) return;
    tauriInvoke("open_external", { url }).catch(() => {
      window.open(url, "_blank", "noopener,noreferrer");
    });
  }

  // ---------------------------------------------------------------------------
  // Backend & Sidecar API
  // ---------------------------------------------------------------------------
  async function fetchCredentials() {
    if (state.credentials) return state.credentials;
    try {
      const creds = await tauriInvoke("get_server_credentials");
      state.credentials = creds;
      return creds;
    } catch (err) {
      console.warn("[plugin-market] failed to get server credentials:", err);
      throw new Error("Could not connect to OpenCode sidecar: " + (err.message || String(err)));
    }
  }

  function getAuthHeaders(creds) {
    const username = creds.username || "opencode";
    const password = creds.password || "";
    const token = btoa(`${username}:${password}`);
    return {
      "Authorization": `Basic ${token}`,
      "Content-Type": "application/json",
      "Accept": "application/json",
    };
  }

  async function loadInstalledPlugins() {
    const creds = await fetchCredentials();
    const url = `${creds.url.replace(/\/+$/, "")}/api/plugin`;
    const res = await fetch(url, { headers: getAuthHeaders(creds) });
    if (!res.ok) {
      throw new Error(`Sidecar /api/plugin error (${res.status} ${res.statusText})`);
    }
    const json = await res.json();
    const items = Array.isArray(json?.data) ? json.data : [];

    // Filter package plugins (user-installed)
    const installed = [];
    for (const item of items) {
      const src = item.source || {};
      if (src.type === "package" || src.target) {
        const pkgName = src.target || item.id;
        installed.push({
          id: item.id || pkgName,
          name: pkgName,
          version: src.version || "unknown",
          outdated: !!src.outdated,
          status: item.state?.status || "active",
          error: item.state?.error || null,
          features: item.features || {},
          raw: item,
        });
      }
    }
    state.installedPlugins = installed;
    return installed;
  }

  async function searchNpm(query = "") {
    const trimmed = query.trim();
    let url = "https://registry.npmjs.org/-/v1/search?text=keywords:opencode-plugin&size=100";
    if (trimmed) {
      url = `https://registry.npmjs.org/-/v1/search?text=keywords:opencode-plugin+${encodeURIComponent(trimmed)}&size=60`;
    }

    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`npm search failed (${res.status})`);
    }
    const data = await res.json();
    const rawList = Array.isArray(data.objects) ? data.objects : [];

    const pkgs = rawList.map((obj) => {
      const p = obj.package || {};
      return {
        name: p.name,
        version: p.version,
        description: p.description || "No description provided.",
        keywords: p.keywords || [],
        downloads: obj.downloads?.monthly || 0,
        homepage: p.links?.homepage || null,
        repository: p.links?.repository || null,
        npmUrl: p.links?.npm || `https://www.npmjs.com/package/${encodeURIComponent(p.name)}`,
        publisher: p.publisher?.username || (p.maintainers && p.maintainers[0]?.username) || "unknown",
        date: p.date ? new Date(p.date).toLocaleDateString() : null,
      };
    });

    // Sort by downloads descending
    pkgs.sort((a, b) => (b.downloads || 0) - (a.downloads || 0));

    state.marketPackages = pkgs;
    return pkgs;
  }

  async function managePluginCli(action, pkgName) {
    return await tauriInvoke("plugin_manage", {
      action,
      package: pkgName,
    });
  }

  async function reloadSidecarLocation() {
    try {
      const creds = await fetchCredentials();
      const url = `${creds.url.replace(/\/+$/, "")}/api/location/reload`;
      const res = await fetch(url, {
        method: "POST",
        headers: getAuthHeaders(creds),
      });
      return res.ok;
    } catch (e) {
      console.warn("[plugin-market] location reload failed:", e);
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Action Handlers
  // ---------------------------------------------------------------------------
  function showToast(message, type = "info", duration = 4000) {
    if (state.toast && state.toast.timer) {
      clearTimeout(state.toast.timer);
    }
    const timer = duration > 0 ? setTimeout(() => {
      state.toast = null;
      renderToast();
    }, duration) : null;

    state.toast = { message, type, timer };
    renderToast();
  }

  async function handleInstall(pkgName) {
    if (state.pendingOps.has(pkgName)) return;
    state.pendingOps.add(pkgName);
    renderList();

    showToast(`Installing ${pkgName}...`, "info", 0);

    try {
      const res = await managePluginCli("add", pkgName);
      if (res && res.success) {
        state.hasPendingChanges = true;
        showToast(`Successfully installed ${pkgName}. Apply changes to activate.`, "success", 5000);
        await loadInstalledPlugins();
      } else {
        const errMsg = res?.stderr || res?.stdout || "Installation failed";
        showToast(`Failed to install ${pkgName}: ${errMsg}`, "error", 6000);
      }
    } catch (err) {
      showToast(`Error installing ${pkgName}: ${err.message || String(err)}`, "error", 6000);
    } finally {
      state.pendingOps.delete(pkgName);
      render();
    }
  }

  async function handleRemove(pkgName) {
    if (state.pendingOps.has(pkgName)) return;

    const confirmed = window.confirm(`Are you sure you want to uninstall "${pkgName}"?`);
    if (!confirmed) return;

    state.pendingOps.add(pkgName);
    renderList();

    showToast(`Removing ${pkgName}...`, "info", 0);

    try {
      const res = await managePluginCli("remove", pkgName);
      if (res && res.success) {
        state.hasPendingChanges = true;
        showToast(`Successfully removed ${pkgName}. Apply changes to activate.`, "success", 5000);
        await loadInstalledPlugins();
      } else {
        const errMsg = res?.stderr || res?.stdout || "Removal failed";
        showToast(`Failed to remove ${pkgName}: ${errMsg}`, "error", 6000);
      }
    } catch (err) {
      showToast(`Error removing ${pkgName}: ${err.message || String(err)}`, "error", 6000);
    } finally {
      state.pendingOps.delete(pkgName);
      render();
    }
  }

  async function handleUpdate(pkgName) {
    if (state.pendingOps.has(pkgName)) return;
    state.pendingOps.add(pkgName);
    renderList();

    showToast(`Updating ${pkgName}...`, "info", 0);

    try {
      // CLI update or add (add overwrites with latest)
      let res = await managePluginCli("update", pkgName).catch(() => null);
      if (!res || !res.success) {
        res = await managePluginCli("add", pkgName);
      }

      if (res && res.success) {
        state.hasPendingChanges = true;
        showToast(`Successfully updated ${pkgName}. Apply changes to activate.`, "success", 5000);
        await loadInstalledPlugins();
      } else {
        const errMsg = res?.stderr || res?.stdout || "Update failed";
        showToast(`Failed to update ${pkgName}: ${errMsg}`, "error", 6000);
      }
    } catch (err) {
      showToast(`Error updating ${pkgName}: ${err.message || String(err)}`, "error", 6000);
    } finally {
      state.pendingOps.delete(pkgName);
      render();
    }
  }

  async function handleApplyChanges() {
    showToast("Reloading OpenCode configuration...", "info", 0);
    const ok = await reloadSidecarLocation();
    state.hasPendingChanges = false;
    if (ok) {
      showToast("Configuration reloaded successfully.", "success", 4000);
    } else {
      showToast("Changes saved. Restart the desktop app if plugins are not active yet.", "info", 5000);
    }
    renderHeaderActions();
  }

  async function refreshData() {
    state.isLoading = true;
    state.error = null;
    state.loadingMessage = "Refreshing plugins...";
    render();

    try {
      await Promise.all([
        loadInstalledPlugins(),
        searchNpm(state.searchQuery),
      ]);
    } catch (err) {
      state.error = err.message || String(err);
    } finally {
      state.isLoading = false;
      render();
    }
  }

  // ---------------------------------------------------------------------------
  // Styles Injection
  // ---------------------------------------------------------------------------
  function injectStyles() {
    if (document.getElementById("oc-plugin-market-styles")) return;
    const style = document.createElement("style");
    style.id = "oc-plugin-market-styles";
    style.textContent = `
      .oc-subtab-btn {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 4px 12px;
        border-radius: 4px;
        font-size: 12px;
        font-weight: 500;
        color: var(--v2-text-text-muted, #888);
        background: transparent;
        border: none;
        cursor: pointer;
        transition: all 0.15s ease;
        user-select: none;
      }
      .oc-subtab-btn:hover {
        color: var(--v2-text-text-base, #eee);
      }
      .oc-subtab-btn.active {
        color: var(--v2-text-text-base, #fff);
        background: var(--v2-background-bg-layer-03, rgba(255, 255, 255, 0.08));
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
      }
      .oc-badge {
        display: inline-flex;
        align-items: center;
        font-size: 11px;
        font-weight: 500;
        padding: 2px 7px;
        border-radius: 4px;
        line-height: 1;
      }
      .oc-badge-installed {
        background: rgba(16, 185, 129, 0.15);
        color: #10b981;
        border: 0.5px solid rgba(16, 185, 129, 0.3);
      }
      .oc-badge-outdated {
        background: rgba(245, 158, 11, 0.15);
        color: #f59e0b;
        border: 0.5px solid rgba(245, 158, 11, 0.3);
      }
      .oc-badge-count {
        background: var(--v2-background-bg-layer-03, rgba(255,255,255,0.1));
        color: var(--v2-text-text-muted, #aaa);
        border-radius: 999px;
        padding: 1px 6px;
        font-size: 10px;
        margin-left: 4px;
      }
      .oc-spin {
        animation: oc-spin 1s linear infinite;
      }
      @keyframes oc-spin {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
      }
      .oc-apply-btn-pulse {
        position: relative;
      }
      .oc-apply-btn-pulse::after {
        content: "";
        position: absolute;
        top: -2px;
        right: -2px;
        width: 7px;
        height: 7px;
        background: #3b82f6;
        border-radius: 50%;
        box-shadow: 0 0 0 2px var(--v2-background-bg-base, #111);
      }
      .oc-market-search-wrap:focus-within {
        border-color: var(--v2-text-text-muted, #777) !important;
      }
    `;
    document.head.appendChild(style);
  }

  // ---------------------------------------------------------------------------
  // UI Rendering
  // ---------------------------------------------------------------------------
  let marketPanelEl = null;
  let navTriggerWrapperEl = null;

  function renderToast() {
    if (!marketPanelEl) return;
    const toastEl = marketPanelEl.querySelector("#oc-plugin-toast");
    if (!toastEl) return;

    if (!state.toast) {
      toastEl.style.display = "none";
      toastEl.innerHTML = "";
      return;
    }

    const { message, type } = state.toast;
    let bg = "var(--v2-background-bg-layer-02, #222)";
    let border = "var(--v2-border-border-muted, #333)";
    let textColor = "var(--v2-text-text-base, #fff)";

    if (type === "success") {
      bg = "rgba(16, 185, 129, 0.12)";
      border = "rgba(16, 185, 129, 0.3)";
      textColor = "#10b981";
    } else if (type === "error") {
      bg = "rgba(239, 68, 68, 0.12)";
      border = "rgba(239, 68, 68, 0.3)";
      textColor = "#ef4444";
    } else if (type === "info") {
      bg = "rgba(59, 130, 246, 0.12)";
      border = "rgba(59, 130, 246, 0.3)";
      textColor = "#60a5fa";
    }

    toastEl.style.display = "flex";
    toastEl.style.alignItems = "center";
    toastEl.style.justifyContent = "space-between";
    toastEl.style.background = bg;
    toastEl.style.borderColor = border;
    toastEl.style.color = textColor;
    toastEl.innerHTML = `
      <div style="display: flex; align-items: center; gap: 8px;">
        <span>${escapeHtml(message)}</span>
      </div>
      <button type="button" id="oc-toast-close" style="background: none; border: none; color: inherit; cursor: pointer; padding: 2px; font-size: 14px; opacity: 0.7;">&times;</button>
    `;

    const closeBtn = toastEl.querySelector("#oc-toast-close");
    if (closeBtn) {
      closeBtn.onclick = () => {
        state.toast = null;
        renderToast();
      };
    }
  }

  function renderHeaderActions() {
    if (!marketPanelEl) return;
    const applyBtn = marketPanelEl.querySelector("#oc-plugin-apply-btn");
    if (applyBtn) {
      if (state.hasPendingChanges) {
        applyBtn.classList.add("oc-apply-btn-pulse");
        applyBtn.setAttribute("data-variant", "neutral");
        applyBtn.style.borderColor = "var(--v2-text-text-accent, #3b82f6)";
      } else {
        applyBtn.classList.remove("oc-apply-btn-pulse");
        applyBtn.setAttribute("data-variant", "outline");
        applyBtn.style.borderColor = "";
      }
    }

    const countBadge = marketPanelEl.querySelector("#oc-installed-count-badge");
    if (countBadge) {
      const count = state.installedPlugins.length;
      countBadge.textContent = count > 0 ? String(count) : "";
      countBadge.style.display = count > 0 ? "inline" : "none";
    }
  }

  function renderList() {
    if (!marketPanelEl) return;

    const listEl = marketPanelEl.querySelector("#oc-plugin-list");
    const loadingEl = marketPanelEl.querySelector("#oc-plugin-loading");
    const emptyEl = marketPanelEl.querySelector("#oc-plugin-empty");
    const errorEl = marketPanelEl.querySelector("#oc-plugin-error");

    if (!listEl || !loadingEl || !emptyEl || !errorEl) return;

    if (state.isLoading) {
      loadingEl.style.display = "flex";
      listEl.style.display = "none";
      emptyEl.style.display = "none";
      errorEl.style.display = "none";
      const loadMsg = loadingEl.querySelector("#oc-plugin-loading-msg");
      if (loadMsg) loadMsg.textContent = state.loadingMessage || "Loading plugins...";
      return;
    }

    loadingEl.style.display = "none";

    if (state.error) {
      errorEl.style.display = "flex";
      errorEl.innerHTML = `
        <div style="display: flex; flex-direction: column; align-items: center; gap: 8px; text-align: center;">
          <span style="color: #ef4444; font-weight: 500;">Failed to load plugins</span>
          <span style="font-size: 12px; color: var(--v2-text-text-muted);">${escapeHtml(state.error)}</span>
          <button type="button" id="oc-retry-btn" data-component="button-v2" data-variant="outline" data-size="small" style="margin-top: 8px;">Retry</button>
        </div>
      `;
      const retryBtn = errorEl.querySelector("#oc-retry-btn");
      if (retryBtn) retryBtn.onclick = refreshData;
      listEl.style.display = "none";
      emptyEl.style.display = "none";
      return;
    }

    errorEl.style.display = "none";

    // Build the items to display based on subtab and search
    const installedMap = new Map();
    for (const inst of state.installedPlugins) {
      installedMap.set(inst.name, inst);
    }

    let items = [];
    const query = state.searchQuery.toLowerCase().trim();

    if (state.activeSubtab === "installed") {
      items = state.installedPlugins.map((inst) => {
        // Find matching npm package meta if available
        const npmMeta = state.marketPackages.find((p) => p.name === inst.name) || {};
        return {
          name: inst.name,
          version: inst.version,
          installedVersion: inst.version,
          isInstalled: true,
          isOutdated: inst.outdated,
          description: npmMeta.description || (inst.error ? `Error: ${inst.error}` : "Installed plugin"),
          downloads: npmMeta.downloads || 0,
          homepage: npmMeta.homepage,
          repository: npmMeta.repository,
          npmUrl: npmMeta.npmUrl || `https://www.npmjs.com/package/${encodeURIComponent(inst.name)}`,
          publisher: npmMeta.publisher || "installed",
        };
      });

      if (query) {
        items = items.filter((it) =>
          it.name.toLowerCase().includes(query) ||
          it.description.toLowerCase().includes(query)
        );
      }
    } else {
      // Market view: show npm packages
      items = state.marketPackages.map((pkg) => {
        const inst = installedMap.get(pkg.name);
        return {
          ...pkg,
          isInstalled: !!inst,
          installedVersion: inst ? inst.version : null,
          isOutdated: inst ? inst.outdated : false,
        };
      });

      if (query) {
        items = items.filter((it) =>
          it.name.toLowerCase().includes(query) ||
          it.description.toLowerCase().includes(query) ||
          (it.keywords && it.keywords.some((k) => k.toLowerCase().includes(query)))
        );
      }
    }

    if (items.length === 0) {
      emptyEl.style.display = "flex";
      emptyEl.textContent = query
        ? `No plugins found matching "${query}".`
        : state.activeSubtab === "installed"
        ? "No plugins installed yet. Explore the Market tab to find plugins!"
        : "No plugins available.";
      listEl.style.display = "none";
      return;
    }

    emptyEl.style.display = "none";
    listEl.style.display = "block";

    // Render list rows
    listEl.innerHTML = items
      .map((item) => {
        const isPending = state.pendingOps.has(item.name);
        const actionHtml = item.isInstalled
          ? `
            <div style="display: flex; align-items: center; gap: 8px;">
              ${
                item.isOutdated
                  ? `
                    <button type="button" class="oc-btn-update" data-pkg="${escapeHtml(item.name)}" data-component="button-v2" data-variant="warning" data-size="small" ${isPending ? "disabled" : ""}>
                      ${isPending ? `<span class="oc-spin" style="display:inline-block; margin-right:4px;">⟳</span> Updating...` : "Update"}
                    </button>
                  `
                  : ""
              }
              <button type="button" class="oc-btn-remove" data-pkg="${escapeHtml(item.name)}" data-component="button-v2" data-variant="outline" data-size="small" style="color: #ef4444; border-color: rgba(239, 68, 68, 0.35);" ${isPending ? "disabled" : ""}>
                ${isPending ? `<span class="oc-spin" style="display:inline-block; margin-right:4px;">⟳</span> Removing...` : "Remove"}
              </button>
            </div>
          `
          : `
            <button type="button" class="oc-btn-install" data-pkg="${escapeHtml(item.name)}" data-component="button-v2" data-variant="neutral" data-size="small" ${isPending ? "disabled" : ""}>
              ${isPending ? `<span class="oc-spin" style="display:inline-block; margin-right:4px;">⟳</span> Installing...` : "Install"}
            </button>
          `;

        return `
          <div data-component="settings-v2-row" style="display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 18px 0; border-bottom: 0.5px solid var(--v2-border-border-base, rgba(255,255,255,0.06));">
            <div data-slot="settings-v2-row-copy" style="flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px;">
              <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                <span data-slot="settings-v2-row-title" style="font-size: 13.5px; font-weight: 600; color: var(--v2-text-text-base, #fff); letter-spacing: -0.01em;">
                  ${escapeHtml(item.name)}
                </span>
                <span style="font-size: 11px; padding: 1px 6px; border-radius: 4px; background: var(--v2-background-bg-layer-03, rgba(255,255,255,0.06)); color: var(--v2-text-text-muted, #888); font-family: monospace;">
                  v${escapeHtml(item.isInstalled ? item.installedVersion : item.version)}
                </span>
                ${
                  item.isInstalled
                    ? `<span class="oc-badge oc-badge-installed">Installed</span>`
                    : ""
                }
                ${
                  item.isOutdated
                    ? `<span class="oc-badge oc-badge-outdated">Update Available</span>`
                    : ""
                }
              </div>

              <div data-slot="settings-v2-row-description" style="font-size: 12.5px; line-height: 1.45; color: var(--v2-text-text-muted, #999);">
                ${escapeHtml(item.description)}
              </div>

              <div style="display: flex; align-items: center; gap: 14px; font-size: 11.5px; color: var(--v2-text-text-faint, #666); margin-top: 4px;">
                ${item.downloads ? `<span>↓ ${formatDownloads(item.downloads)}/mo</span>` : ""}
                ${item.publisher ? `<span>by <strong style="color: var(--v2-text-text-muted);">${escapeHtml(item.publisher)}</strong></span>` : ""}
                ${
                  item.homepage
                    ? `<a href="${escapeHtml(item.homepage)}" class="oc-external-link" style="color: var(--v2-text-text-accent, #3b82f6); text-decoration: none;">Homepage</a>`
                    : ""
                }
                ${
                  item.repository
                    ? `<a href="${escapeHtml(item.repository)}" class="oc-external-link" style="color: var(--v2-text-text-accent, #3b82f6); text-decoration: none;">Repository</a>`
                    : ""
                }
                ${
                  item.npmUrl
                    ? `<a href="${escapeHtml(item.npmUrl)}" class="oc-external-link" style="color: var(--v2-text-text-accent, #3b82f6); text-decoration: none;">npm</a>`
                    : ""
                }
              </div>
            </div>

            <div data-slot="settings-v2-row-control" style="flex-shrink: 0; display: flex; align-items: center; gap: 8px;">
              ${actionHtml}
            </div>
          </div>
        `;
      })
      .join("");

    // Attach row button listeners
    listEl.querySelectorAll(".oc-btn-install").forEach((btn) => {
      btn.onclick = () => handleInstall(btn.getAttribute("data-pkg"));
    });
    listEl.querySelectorAll(".oc-btn-remove").forEach((btn) => {
      btn.onclick = () => handleRemove(btn.getAttribute("data-pkg"));
    });
    listEl.querySelectorAll(".oc-btn-update").forEach((btn) => {
      btn.onclick = () => handleUpdate(btn.getAttribute("data-pkg"));
    });

    // Attach external links
    listEl.querySelectorAll(".oc-external-link").forEach((a) => {
      a.onclick = (e) => {
        e.preventDefault();
        openExternalUrl(a.getAttribute("href"));
      };
    });
  }

  function render() {
    renderToast();
    renderHeaderActions();
    renderList();
  }

  // ---------------------------------------------------------------------------
  // Panel Construction
  // ---------------------------------------------------------------------------
  function createMarketPanel() {
    const panel = document.createElement("div");
    panel.id = "oc-plugin-market-panel";
    panel.className = "settings-v2-panel";
    panel.style.display = "none";
    panel.style.flex = "1";
    panel.style.height = "100%";
    panel.style.overflowY = "auto";

    panel.innerHTML = `
      <!-- Header -->
      <div class="settings-v2-tab-header" style="position: sticky; top: 0; z-index: 10; padding: 36px 40px 20px; background: linear-gradient(to bottom, var(--v2-background-bg-base) calc(100% - 24px), transparent);">
        <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 16px;">
          <div>
            <h2 class="settings-v2-tab-title" style="font-size: 15px; font-weight: 640; color: var(--v2-text-text-base);">Plugin Market</h2>
            <p style="font-size: 13px; color: var(--v2-text-text-muted); margin-top: 4px;">Discover, install, and manage OpenCode community plugins.</p>
          </div>
          <div style="display: flex; align-items: center; gap: 8px;">
            <button id="oc-plugin-refresh-btn" type="button" data-component="button-v2" data-variant="outline" data-size="small" title="Refresh plugins list">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
                <path d="M3 3v5h5"/>
                <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/>
                <path d="M16 21h5v-5"/>
              </svg>
            </button>
            <button id="oc-plugin-apply-btn" type="button" data-component="button-v2" data-variant="outline" data-size="small" title="Reload configuration to activate newly installed or removed plugins">
              Apply Changes
            </button>
          </div>
        </div>

        <!-- Toast notification banner -->
        <div id="oc-plugin-toast" style="display: none; margin-top: 14px; padding: 10px 14px; border-radius: 6px; font-size: 13px; border: 0.5px solid transparent;"></div>

        <!-- Subtabs & Search bar -->
        <div style="display: flex; gap: 12px; margin-top: 18px; align-items: center; flex-wrap: wrap;">
          <!-- Filter toggle -->
          <div style="display: inline-flex; background: var(--v2-background-bg-layer-02, rgba(255,255,255,0.04)); padding: 2px; border-radius: 6px; border: 0.5px solid var(--v2-border-border-muted, rgba(255,255,255,0.08));">
            <button id="oc-subtab-market" type="button" class="oc-subtab-btn active">Market</button>
            <button id="oc-subtab-installed" type="button" class="oc-subtab-btn">
              Installed <span id="oc-installed-count-badge" class="oc-badge-count" style="display: none;">0</span>
            </button>
          </div>

          <!-- Search Input -->
          <div class="oc-market-search-wrap" style="flex: 1; min-width: 220px; position: relative; border: 0.5px solid var(--v2-border-border-muted, rgba(255,255,255,0.1)); border-radius: 6px; background: var(--v2-background-bg-layer-01, rgba(255,255,255,0.03));">
            <svg style="position: absolute; left: 10px; top: 8.5px; width: 14px; height: 14px; color: var(--v2-text-text-muted, #777); pointer-events: none;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="11" cy="11" r="8"/>
              <line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
            <input id="oc-plugin-search-input" type="search" placeholder="Search plugins by name, keyword, or author..."
                   style="width: 100%; height: 32px; padding: 0 10px 0 32px; font-size: 12.5px; background: transparent; border: none; color: var(--v2-text-text-base, #eee); outline: none;" />
          </div>
        </div>
      </div>

      <!-- Body / List -->
      <div class="settings-v2-tab-body" style="padding: 0 40px 40px; display: flex; flex-direction: column;">
        <div id="oc-plugin-loading" style="display: flex; align-items: center; justify-content: center; gap: 8px; padding: 48px 0; color: var(--v2-text-text-muted);">
          <span class="oc-spin" style="font-size: 16px;">⟳</span>
          <span id="oc-plugin-loading-msg">Loading plugins...</span>
        </div>

        <div id="oc-plugin-error" style="display: none; align-items: center; justify-content: center; padding: 48px 0;"></div>

        <div id="oc-plugin-empty" style="display: none; align-items: center; justify-content: center; padding: 48px 0; color: var(--v2-text-text-muted); font-size: 13px; text-align: center;"></div>

        <div id="oc-plugin-list" data-component="settings-v2-list" style="display: none;"></div>
      </div>
    `;

    // Event listeners on panel elements
    const refreshBtn = panel.querySelector("#oc-plugin-refresh-btn");
    if (refreshBtn) refreshBtn.onclick = refreshData;

    const applyBtn = panel.querySelector("#oc-plugin-apply-btn");
    if (applyBtn) applyBtn.onclick = handleApplyChanges;

    const marketTabBtn = panel.querySelector("#oc-subtab-market");
    const instTabBtn = panel.querySelector("#oc-subtab-installed");

    if (marketTabBtn && instTabBtn) {
      marketTabBtn.onclick = () => {
        state.activeSubtab = "market";
        marketTabBtn.classList.add("active");
        instTabBtn.classList.remove("active");
        renderList();
      };
      instTabBtn.onclick = () => {
        state.activeSubtab = "installed";
        instTabBtn.classList.add("active");
        marketTabBtn.classList.remove("active");
        renderList();
      };
    }

    let searchTimeout = null;
    const searchInput = panel.querySelector("#oc-plugin-search-input");
    if (searchInput) {
      searchInput.oninput = (e) => {
        state.searchQuery = e.target.value;
        if (searchTimeout) clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => {
          if (state.activeSubtab === "market") {
            // Re-fetch npm if query changed
            searchNpm(state.searchQuery).finally(renderList);
          } else {
            renderList();
          }
        }, 300);
      };
    }

    return panel;
  }

  // ---------------------------------------------------------------------------
  // Navigation Trigger Item Construction
  // ---------------------------------------------------------------------------
  function createNavTrigger() {
    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-slot", "tabs-v2-trigger-wrapper");
    wrapper.setAttribute("data-value", "plugin-market");
    wrapper.className = "oc-plugin-market-trigger-wrapper";

    const button = document.createElement("button");
    button.setAttribute("data-slot", "tabs-v2-trigger");
    button.setAttribute("data-value", "plugin-market");
    button.setAttribute("role", "tab");
    button.setAttribute("type", "button");
    button.className = "oc-plugin-market-trigger";

    button.innerHTML = `
      <span class="inline-flex items-center gap-2" data-slot="tabs-v2-trigger-content">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;">
          <path d="m16.5 9.4-9-5.19M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
          <polyline points="3.29 7 12 12 20.71 7"/>
          <line x1="12" y1="22" x2="12" y2="12"/>
        </svg>
        Plugin Market
      </span>
    `;

    wrapper.appendChild(button);
    return wrapper;
  }

  // ---------------------------------------------------------------------------
  // Tab Activation Logic
  // ---------------------------------------------------------------------------
  function activatePluginMarketTab(tabsRoot) {
    if (!tabsRoot || !navTriggerWrapperEl || !marketPanelEl) return;

    // Deselect all native tabs
    const triggers = tabsRoot.querySelectorAll('[data-slot="tabs-v2-trigger"]');
    triggers.forEach((trig) => {
      if (trig !== navTriggerWrapperEl.querySelector("button")) {
        trig.removeAttribute("data-selected");
        trig.setAttribute("aria-selected", "false");
      }
    });

    const wrappers = tabsRoot.querySelectorAll('[data-slot="tabs-v2-trigger-wrapper"]');
    wrappers.forEach((w) => {
      if (w !== navTriggerWrapperEl) {
        w.removeAttribute("data-selected");
      }
    });

    // Select our tab
    const ourBtn = navTriggerWrapperEl.querySelector("button");
    if (ourBtn) {
      ourBtn.setAttribute("data-selected", "");
      ourBtn.setAttribute("aria-selected", "true");
    }
    navTriggerWrapperEl.setAttribute("data-selected", "");

    // Hide native panels
    const nativePanels = tabsRoot.querySelectorAll('.settings-v2-panel:not(#oc-plugin-market-panel)');
    nativePanels.forEach((p) => {
      p.style.setProperty("display", "none", "important");
    });

    // Show our panel
    marketPanelEl.style.setProperty("display", "flex", "important");

    // Fetch initial data if not yet loaded
    if (state.marketPackages.length === 0 && !state.isLoading) {
      refreshData();
    }
  }

  function deactivatePluginMarketTab(tabsRoot) {
    if (!tabsRoot || !navTriggerWrapperEl || !marketPanelEl) return;

    const ourBtn = navTriggerWrapperEl.querySelector("button");
    if (ourBtn) {
      ourBtn.removeAttribute("data-selected");
      ourBtn.setAttribute("aria-selected", "false");
    }
    navTriggerWrapperEl.removeAttribute("data-selected");

    // Hide our panel
    marketPanelEl.style.setProperty("display", "none", "important");

    // Restore native panels
    const nativePanels = tabsRoot.querySelectorAll('.settings-v2-panel:not(#oc-plugin-market-panel)');
    nativePanels.forEach((p) => {
      p.style.removeProperty("display");
    });
  }

  // ---------------------------------------------------------------------------
  // Observer & DOM Integration
  // ---------------------------------------------------------------------------
  function attachToSettingsDialog(dialogEl) {
    const tabsRoot = dialogEl.querySelector('[data-component="tabs-v2"]') || dialogEl.querySelector(".settings-v2");
    if (!tabsRoot) return;

    const tabsList = tabsRoot.querySelector('[data-slot="tabs-v2-list"]');
    if (!tabsList) return;

    // Check if our nav item is already present
    if (tabsList.querySelector(".oc-plugin-market-trigger-wrapper")) {
      return;
    }

    injectStyles();

    // 1. Create and mount nav trigger
    navTriggerWrapperEl = createNavTrigger();

    // Place it under the Server section (or last trigger container)
    const serverTriggerGroup = tabsList.querySelector('[data-value="models"]')?.closest(".flex.flex-col.gap-1\\.5") ||
                               tabsList.querySelector('[data-value="providers"]')?.closest(".flex.flex-col.gap-1\\.5");

    if (serverTriggerGroup) {
      serverTriggerGroup.appendChild(navTriggerWrapperEl);
    } else {
      // Fallback: append inside the first section container
      const targetDiv = tabsList.querySelector(".flex.flex-col.gap-3 .flex.flex-col.gap-1\\.5:last-child") || tabsList;
      targetDiv.appendChild(navTriggerWrapperEl);
    }

    // 2. Create and mount our panel inside tabsRoot
    marketPanelEl = tabsRoot.querySelector("#oc-plugin-market-panel");
    if (!marketPanelEl) {
      marketPanelEl = createMarketPanel();
      tabsRoot.appendChild(marketPanelEl);
    }

    // 3. Setup click listeners
    const ourBtn = navTriggerWrapperEl.querySelector("button");
    if (ourBtn) {
      ourBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        activatePluginMarketTab(tabsRoot);
      });
    }

    // Listen for clicks on native tabs to deactivate our panel
    tabsList.addEventListener("click", (e) => {
      const clickedTrigger = e.target.closest('[data-slot="tabs-v2-trigger"]');
      if (clickedTrigger && clickedTrigger !== ourBtn) {
        deactivatePluginMarketTab(tabsRoot);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Sidebar Rail Integration & Standalone Market Overlay
  // ---------------------------------------------------------------------------
  let standaloneModalEl = null;

  function openMarketStandaloneModal() {
    injectStyles();
    if (!standaloneModalEl) {
      standaloneModalEl = document.createElement("div");
      standaloneModalEl.id = "oc-plugin-market-modal-backdrop";
      standaloneModalEl.style.cssText = `
        position: fixed; inset: 0; z-index: 9999;
        background: rgba(0, 0, 0, 0.65); backdrop-filter: blur(4px);
        display: flex; align-items: center; justify-content: center;
      `;

      const container = document.createElement("div");
      container.style.cssText = `
        width: 860px; max-width: 92vw; height: 85vh;
        background: var(--v2-background-bg-base, #18181b);
        border: 0.5px solid var(--v2-border-border-muted, rgba(255,255,255,0.1));
        border-radius: 12px; display: flex; flex-direction: column; overflow: hidden;
        position: relative; box-shadow: 0 20px 40px rgba(0,0,0,0.5);
      `;

      const closeBtn = document.createElement("button");
      closeBtn.type = "button";
      closeBtn.innerHTML = `✕`;
      closeBtn.style.cssText = `
        position: absolute; top: 20px; right: 24px; z-index: 20;
        background: transparent; border: none; font-size: 18px;
        color: var(--v2-text-text-muted, #999); cursor: pointer;
      `;
      closeBtn.onclick = () => {
        standaloneModalEl.style.display = "none";
      };
      container.appendChild(closeBtn);

      const panel = createMarketPanel();
      panel.style.display = "flex";
      container.appendChild(panel);
      standaloneModalEl.appendChild(container);
      document.body.appendChild(standaloneModalEl);

      standaloneModalEl.onclick = (e) => {
        if (e.target === standaloneModalEl) {
          standaloneModalEl.style.display = "none";
        }
      };

      window.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && standaloneModalEl && standaloneModalEl.style.display !== "none") {
          standaloneModalEl.style.display = "none";
        }
      });

      marketPanelEl = panel;
      refreshData();
    } else {
      standaloneModalEl.style.display = "flex";
      refreshData();
    }
  }

  function findSettingsButton() {
    const byIcon = document.querySelector('button[data-icon="settings-gear"]');
    if (byIcon) return byIcon;

    const rail = document.querySelector('[data-component="sidebar-rail"]');
    if (rail) {
      const byAria = rail.querySelector('button[aria-label*="Setting" i], button[aria-label*="Ayar" i]');
      if (byAria) return byAria;

      for (const btn of rail.querySelectorAll('button')) {
        const aria = btn.getAttribute('aria-label') || '';
        const iconAttr = btn.getAttribute('data-icon') || '';
        if (
          iconAttr === 'settings-gear' ||
          /setting|ayar/i.test(aria) ||
          btn.querySelector('svg [d*="M7.62516"]') ||
          btn.querySelector('svg [d*="M7.99998"]')
        ) {
          return btn;
        }
      }
    }

    for (const btn of document.querySelectorAll('button')) {
      const aria = btn.getAttribute('aria-label') || '';
      const iconAttr = btn.getAttribute('data-icon') || '';
      if (
        iconAttr === 'settings-gear' ||
        /setting|ayar/i.test(aria) ||
        btn.querySelector('svg [d*="M7.62516"]') ||
        btn.querySelector('svg [d*="M7.99998"]')
      ) {
        return btn;
      }
    }
    return null;
  }

  function attachToSidebarRail() {
    const settingsBtn = findSettingsButton();
    if (!settingsBtn) return;

    const targetItem = settingsBtn.closest('[data-component="tooltip-trigger"]') || settingsBtn;
    const navContainer = targetItem.parentElement;
    if (!navContainer || navContainer.querySelector('.oc-rail-market-wrapper')) return;

    const wrapper = document.createElement("div");
    wrapper.className = "oc-rail-market-wrapper";
    wrapper.setAttribute("data-component", "tooltip-trigger");

    const railBtn = document.createElement("button");
    railBtn.type = "button";
    railBtn.className = "oc-rail-market-btn";
    railBtn.setAttribute("data-component", "icon-button");
    railBtn.setAttribute("data-variant", "ghost");
    railBtn.setAttribute("data-size", "large");
    railBtn.title = "Plugin Market";
    railBtn.setAttribute("aria-label", "Plugin Market");
    railBtn.style.cssText = `
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 32px;
      height: 32px;
      border-radius: 6px;
      background: transparent;
      border: none;
      color: var(--icon-base, #999);
      cursor: pointer;
      transition: background-color 0.15s, color 0.15s;
    `;
    railBtn.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;">
        <path d="m16.5 9.4-9-5.19M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
        <polyline points="3.29 7 12 12 20.71 7"/>
        <line x1="12" y1="22" x2="12" y2="12"/>
      </svg>
    `;

    railBtn.onmouseenter = () => {
      railBtn.style.backgroundColor = "var(--surface-base-hover, rgba(255, 255, 255, 0.08))";
      railBtn.style.color = "var(--icon-strong-base, #fff)";
    };
    railBtn.onmouseleave = () => {
      railBtn.style.backgroundColor = "transparent";
      railBtn.style.color = "var(--icon-base, #999)";
    };
    railBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      openMarketStandaloneModal();
    };

    wrapper.appendChild(railBtn);

    const monitorItem = navContainer.querySelector('.oc-rail-monitor-wrapper');
    const insertBeforeItem = monitorItem || targetItem;
    navContainer.insertBefore(wrapper, insertBeforeItem);
  }

  function attachToHomeUtilityNav() {
    const buttons = document.querySelectorAll('button');
    let homeSettingsBtn = null;
    for (const btn of buttons) {
      const text = btn.textContent.trim();
      const isSettingsText = text === 'Ayarlar' || text === 'Settings' || /^(Ayarlar|Settings)$/i.test(text);
      if (isSettingsText) {
        const parent = btn.parentElement;
        if (parent) {
          const siblingTexts = Array.from(parent.querySelectorAll('button')).map(b => b.textContent.trim());
          if (siblingTexts.some(t => /Yardım|Help/i.test(t))) {
            homeSettingsBtn = btn;
            break;
          }
        }
      }
    }

    if (!homeSettingsBtn) return;
    const navContainer = homeSettingsBtn.parentElement;
    if (!navContainer || navContainer.querySelector('.oc-home-market-btn')) return;

    const marketBtn = document.createElement('button');
    marketBtn.type = 'button';
    marketBtn.className =
      'oc-home-market-btn flex h-7 min-w-0 w-full shrink-0 cursor-pointer items-center gap-2 rounded-[6px] bg-transparent px-1.5 text-left text-v2-text-text-faint [font-weight:440] transition-[background-color,color] duration-[120ms] ease-in-out hover:bg-v2-background-bg-layer-01 hover:text-v2-text-text-base';
    marketBtn.innerHTML = `
      <svg data-slot="icon-svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0; color: var(--v2-icon-icon-muted, #999);">
        <path d="m16.5 9.4-9-5.19M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
        <polyline points="3.29 7 12 12 20.71 7"/>
        <line x1="12" y1="22" x2="12" y2="12"/>
      </svg>
      <span class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[13px]">Plugin Market</span>
    `;
    marketBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      openMarketStandaloneModal();
    };

    const monitorBtn = navContainer.querySelector('.oc-home-monitor-btn');
    const insertBeforeItem = monitorBtn || homeSettingsBtn;
    navContainer.insertBefore(marketBtn, insertBeforeItem);
  }

  // Observe dialog lifecycle and sidebar in DOM
  const observer = new MutationObserver(() => {
    attachToHomeUtilityNav();
    attachToSidebarRail();
    const dialogs = document.querySelectorAll('.settings-v2-dialog, [data-component="dialog-v2"][data-variant="settings"], .settings-v2');
    for (const dialog of dialogs) {
      attachToSettingsDialog(dialog);
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });

  // Initial scan
  attachToHomeUtilityNav();
  attachToSidebarRail();
  const existingDialogs = document.querySelectorAll('.settings-v2-dialog, [data-component="dialog-v2"][data-variant="settings"], .settings-v2');
  for (const dialog of existingDialogs) {
    attachToSettingsDialog(dialog);
  }

  console.info("[plugin-market] overlay script ready");
})();
