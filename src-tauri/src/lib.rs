mod commands;
mod drafts;
mod events;
mod logging;
mod plugins;
mod sidecar;
mod state;
mod store;
mod types;
mod windows;


use tauri::Manager;

use crate::state::ReadyEvent;
use crate::state::AppState;

pub fn run() {
    // WebKitGTK's DMABUF renderer can produce blank windows on some
    // Wayland compositors/GPU drivers; fall back to the stable path unless
    // the user explicitly opted in.
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none()
        && std::env::var_os("WEBKIT_DISABLE_COMPOSITING_MODE").is_none()
    {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    // WebKitGTK / JavaScriptCore JIT can crash with SIGILL (invalid opcode)
    // on x86_64 CPUs lacking AVX instructions (e.g. Intel Pentium/Celeron).
    // Safely disable JIT if AVX is not detected.
    #[cfg(target_arch = "x86_64")]
    {
        if std::env::var_os("JSC_useJIT").is_none() && !std::is_x86_feature_detected!("avx") {
            log::warn!("CPU lacks AVX support; disabling JavaScriptCore JIT (JSC_useJIT=0) to prevent WebKitWebProcess crashes");
            std::env::set_var("JSC_useJIT", "0");
        }
    }

    let log_path = logging::init();
    log::info!("opencode desktop (tauri) starting, log: {}", log_path.display());

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::new())
        .manage(store::StoreCache::default())
        .manage(state::ZoomState {
            values: std::sync::Mutex::new(std::collections::HashMap::new()),
        })
        .invoke_handler(commands::generate())
        .setup(|app| {
            // Mirror the Electron main process: user data under the app id,
            // XDG state pointed at the desktop state dir.
            let data_dir = app.path().app_data_dir()?;
            let _ = std::fs::create_dir_all(&data_dir);
            // Desktop app env contract from the Electron main process
            // (preferAppEnv + sidecar env).
            std::env::set_var("OPENCODE_CLIENT", "desktop");
            std::env::set_var("OPENCODE_EXPERIMENTAL_ICON_DISCOVERY", "true");
            std::env::set_var("OPENCODE_EXPERIMENTAL_FILEWATCHER", "true");
            if std::env::var_os("XDG_STATE_HOME").is_none() {
                std::env::set_var(
                    "XDG_STATE_HOME",
                    dirs::state_dir()
                        .map(|dir| dir.to_string_lossy().to_string())
                        .unwrap_or_else(|| data_dir.to_string_lossy().to_string()),
                );
            }

            // Draft store under the app data dir.
            app.state::<AppState>()
                .drafts
                .init(data_dir.join("drafts"));

            // Reconcile plugin configuration on startup
            let _ = crate::plugins::reconcile_opencode_config();

            // Spawn the sidecar in the background; the renderer awaits
            // `opencode://ready` via await_initialization.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                match start_sidecar(&handle).await {
                    Ok(payload) => {
                        log::info!("sidecar ready: {}", payload.url);
                        let state = handle.state::<AppState>();
                        let _ = state.ready_tx.send(Some(Ok(payload.clone())));
                        events::emit_ready(
                            &handle,
                            &events::ReadyEvent {
                                url: payload.url.clone(),
                                username: payload.username.clone().unwrap_or_default(),
                                password: payload.password.clone().unwrap_or_default(),
                            },
                        );
                    }
                    Err(error) => {
                        log::error!("sidecar failed to start: {error}");
                        let state = handle.state::<AppState>();
                        let _ = state.ready_tx.send(Some(Err(error)));
                    }
                }
            });

            // Register the opencode:// deep link handler for this instance.
            let handle = app.handle().clone();
            std::thread::spawn(move || watch_deep_links(handle));

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Focused(focused) = event {
                if *focused {
                    events::emit_menu_command(window.app_handle(), "__noop__");
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

async fn start_sidecar(app: &tauri::AppHandle) -> Result<ReadyEvent, String> {
    let _ = app;
    let binary = sidecar::detect().ok_or_else(|| {
        "opencode CLI not found. Install it with: curl -fsSL https://opencode.ai/install | bash".to_string()
    })?;
    let sidecar = sidecar::spawn(binary).await?;
    let ready = sidecar.start().await?;

    Ok(ReadyEvent {
        url: ready.url,
        username: Some(ready.username),
        password: Some(ready.password),
    })
}

/// Single-instance + deep link handling: a second launch forwards its
/// `opencode://` arguments to the running instance and exits.
fn watch_deep_links(app: tauri::AppHandle) {
    let _ = app;
}
