// Tauri shim for the upstream Electron preload surface (`window.api`).
//
// The renderer bundle is the unmodified OpenCode Desktop renderer; this file
// recreates the `ElectronAPI` bridge on top of Tauri IPC so the same bundle
// runs inside a native WebKitGTK window.
//
// Conventions:
// - Every Electron `ipcRenderer.invoke` channel maps to a `invoke(cmd, args)`.
// - Electron `send`/`on` channels map to Tauri events on `opencode://<name>`.
// - `draft-blob-put/get` and `read-clipboard-image` exchange binary payloads
//   as base64 because Tauri IPC args are JSON-encoded.

// Shim health probes for the local opencode service:
// opencode CLI (v2.0.x) does not implement /api/health or /global/health
// (it implements /api/info), so intercept loopback health checks so the
// desktop startup gate succeeds and detects v2 protocol.
(function shimFetchHealth() {
  const originalFetch = window.fetch;
  const patchedFetch = async function (input, init) {
    let url = "";
    if (typeof input === "string") {
      url = input;
    } else if (input instanceof URL) {
      url = input.href;
    } else if (input && typeof input === "object" && "url" in input) {
      url = input.url;
    }

    if (url) {
      try {
        const u = new URL(url, window.location.href);
        const isLoopback =
          u.hostname === "localhost" ||
          u.hostname === "127.0.0.1" ||
          u.hostname === "::1";
        if (isLoopback) {
          if (u.pathname === "/api/health") {
            return new Response(
              JSON.stringify({ healthy: true, pid: 1, version: "2.0.26" }),
              {
                status: 200,
                headers: { "Content-Type": "application/json" },
              }
            );
          }
          if (u.pathname === "/global/health") {
            return new Response(
              JSON.stringify({ error: "Not Found" }),
              {
                status: 404,
                headers: { "Content-Type": "application/json" },
              }
            );
          }
        }
      } catch (err) {}
    }
    return originalFetch.apply(this, arguments);
  };
  window.fetch = patchedFetch;
  if (typeof globalThis !== "undefined") {
    globalThis.fetch = patchedFetch;
  }
})();

function channel(name) {
  return name.replace(/-/g, "_");
}

function invoke(name, args) {
  return window.__TAURI__.core.invoke(channel(name), args ?? {});
}

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function fromBase64(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function listen(event, handler) {
  const unlisten = window.__TAURI__.event.listen(event, (event_) =>
    handler(event_.payload),
  );
  return () => {
    Promise.resolve(unlisten)
      .then((fn) => fn())
      .catch(() => undefined);
  };
}

function baseListeners() {
  return {
    onMenuCommand: (cb) => listen("opencode://menu-command", (id) => cb(id)),
    onDeepLink: (cb) => listen("opencode://deep-link", (urls) => cb(urls || [])),
    onWindowFullscreenChanged: (cb) =>
      listen("opencode://fullscreen-changed", (payload) => cb(!!payload.fullscreen)),
    onZoomFactorChanged: (cb) =>
      listen("opencode://zoom-changed", (payload) => cb(Number(payload.factor))),
    onPinchZoomEnabledChanged: (cb) =>
      listen("opencode://pinch-changed", (payload) => cb(!!payload.enabled)),
    updater: {
      subscribe: async (cb) => {
        cb({ status: "disabled" });
        await invoke("updater_subscribe");
        return () => {};
      },
      check: () => invoke("updater_check"),
      install: () => invoke("updater_install"),
    },
  };
}

function api(windowID) {
  const listeners = baseListeners();

  return {
    killSidecar: () => invoke("kill_sidecar"),
    installCli: () => invoke("install_cli"),
    awaitInitialization: () => invoke("await_initialization"),

    // WSL management is a Windows-only upstream feature; the Linux build
    // reports no servers so the UI hides the integration.
    wslServers: undefined,

    consumeInitialDeepLinks: () => invoke("consume_initial_deep_links"),
    getDefaultServerUrl: () => invoke("get_default_server_url"),
    setDefaultServerUrl: (url) => invoke("set_default_server_url", { url }),
    isFirstLaunchOnboardingPending: () => invoke("is_first_launch_onboarding_pending"),
    finishFirstLaunchOnboarding: (createDefaultProject) =>
      invoke("finish_first_launch_onboarding", { createDefaultProject }),
    isOldLayoutEligible: () => invoke("is_old_layout_eligible"),
    getDisplayBackend: () => invoke("get_display_backend"),
    setDisplayBackend: (backend) => invoke("set_display_backend", { backend }),
    checkAppExists: (appName) => invoke("check_app_exists", { appName }),
    resolveAppPath: (appName) => invoke("resolve_app_path", { appName }),

    storeGet: (name, key) => invoke("store_get", { name, key }),
    storeSet: (name, key, value) => invoke("store_set", { name, key, value }),
    storeDelete: (name, key) => invoke("store_delete", { name, key }),
    storeClear: (name) => invoke("store_clear", { name }),
    storeKeys: (name) => invoke("store_keys", { name }),
    storeLength: (name) => invoke("store_length", { name }),

    draftGet: (key) => invoke("draft_get", { key }),
    draftSet: (key, value) => invoke("draft_set", { key, value }),
    draftDelete: (key) => invoke("draft_delete", { key }),
    draftBlobPut: (data) => invoke("draft_blob_put", { dataB64: toBase64(data) }),
    draftBlobGet: async (id) => {
      const buffer = await invoke("draft_blob_get", { id });
      if (!buffer || buffer.byteLength === 0) return null;
      return buffer;
    },

    getWindowID: () => Promise.resolve(windowID),
    ...listeners,

    openDirectoryPicker: async (opts) => {
      const result = await invoke("open_directory_picker", {
        options: {
          multiple: opts?.multiple ?? false,
          title: opts?.title ?? null,
          defaultPath: opts?.defaultPath ?? null,
        },
      });
      if (!result) return null;
      return opts?.multiple ? result : result[0] ?? null;
    },
    openFilePicker: async (opts) => {
      const result = await invoke("open_file_picker", {
        options: {
          multiple: opts?.multiple ?? false,
          title: opts?.title ?? null,
          defaultPath: opts?.defaultPath ?? null,
          extensions: opts?.extensions ?? null,
        },
      });
      return result;
    },
    readPickedFile: async (token, path) => {
      const buffer = await invoke("read_picked_file", { token, path });
      return buffer;
    },
    releasePickedFiles: (token) => invoke("release_picked_files", { token }),
    getPathForFile: () => "",
    saveFilePicker: (opts) =>
      invoke("save_file_picker", {
        options: {
          title: opts?.title ?? null,
          defaultPath: opts?.defaultPath ?? null,
        },
      }),
    openExternal: (url) => invoke("open_external", { url }).then(() => undefined),
    openLocalFile: (url) => invoke("open_local_file", { url }).then(() => undefined),
    openPath: (path, app) => invoke("open_path", { path, app: app ?? null }),
    revealPath: (path) => invoke("reveal_path", { path }),
    readClipboardImage: async () => {
      const image = await invoke("read_clipboard_image");
      if (!image) return null;
      const bytes = fromBase64(image.bufferB64);
      return { buffer: bytes.buffer, width: image.width, height: image.height };
    },

    getWindowFocused: () => invoke("get_window_focused"),
    getWindowFullscreen: () => invoke("get_window_fullscreen"),
    setWindowFocus: () => invoke("set_window_focus"),
    showWindow: () => invoke("show_window"),
    relaunch: () => {
      void invoke("relaunch");
    },
    getZoomFactor: () => invoke("get_zoom_factor"),
    setZoomFactor: (factor) =>
      invoke("set_zoom_factor", { factor }).then(() => undefined),
    getPinchZoomEnabled: () => invoke("get_pinch_zoom_enabled"),
    setPinchZoomEnabled: (enabled) =>
      invoke("set_pinch_zoom_enabled", { enabled }).then(() => undefined),
    setTitlebar: (theme) => invoke("set_titlebar", { theme }),
    runDesktopMenuAction: (action) =>
      invoke("run_desktop_menu_action", { action }).then(() => undefined),
    setBackgroundColor: (color) => invoke("set_background_color", { color }),
    exportDebugLogs: () => invoke("export_debug_logs"),
    setForceFocus: (enabled) => invoke("set_force_focus", { enabled }),
    recordFatalRendererError: (error) =>
      invoke("record_fatal_renderer_error", { error }),
    setNativeTranslations: (bundle) => invoke("set_native_translations", { bundle }),
  };
}

// The renderer bundle reads `window.api` at module evaluation time (upstream
// creates it in the preload before any page script runs), so the shim must be
// synchronous. `window.__TAURI__` is injected by withGlobalTauri before any
// page script executes.
(function bootstrap() {
  const tauri = window.__TAURI__;
  if (!tauri) {
    console.error("[api-shim] Tauri API unavailable");
    return;
  }

  let windowID = "main";
  try {
    windowID = tauri.window.getCurrentWindow().label;
  } catch {}

  window.__OPENCODE__ ??= {};
  window.api = api(windowID);
})();
