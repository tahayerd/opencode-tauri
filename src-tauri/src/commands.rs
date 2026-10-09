use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;

use base64::Engine as _;
use serde::Deserialize;
use serde_json::json;
use tauri::ipc::Response;
use tauri::{AppHandle, Manager, WebviewWindow};
use tokio::sync::watch;

use crate::events::{self, PickedFile, PickedFileResult, PickerOptions};
use crate::state::{AppState, ReadyEvent as StateReadyEvent};
use crate::store::{self, StoreCache};
use crate::types::{FatalRendererError, NativeBundle, TitlebarTheme};



const MIN_ZOOM: f64 = 0.2;
const MAX_ZOOM: f64 = 10.0;
const SETTINGS_STORE: &str = "opencode.settings";
const PINCH_ZOOM_KEY: &str = "pinchZoomEnabled";
const DEFAULT_SERVER_URL_KEY: &str = "defaultServerUrl";
const FIRST_LAUNCH_KEY: &str = "firstLaunchOnboardingComplete";
const OLD_LAYOUT_KEY: &str = "oldLayoutEligible";

fn clamp_zoom(value: f64) -> f64 {
    value.clamp(MIN_ZOOM, MAX_ZOOM)
}

fn hex_color(input: &str) -> Option<(u8, u8, u8, u8)> {
    let hex = input.trim().strip_prefix('#')?;
    let (r, g, b, a) = match hex.len() {
        6 => (
            u8::from_str_radix(&hex[0..2], 16).ok()?,
            u8::from_str_radix(&hex[2..4], 16).ok()?,
            u8::from_str_radix(&hex[4..6], 16).ok()?,
            255,
        ),
        8 => (
            u8::from_str_radix(&hex[0..2], 16).ok()?,
            u8::from_str_radix(&hex[2..4], 16).ok()?,
            u8::from_str_radix(&hex[4..6], 16).ok()?,
            u8::from_str_radix(&hex[6..8], 16).ok()?,
        ),
        _ => return None,
    };
    Some((r, g, b, a))
}

// ---------------------------------------------------------------------------
// Sidecar / initialization
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn await_initialization(
    state: tauri::State<'_, AppState>,
) -> Result<StateReadyEvent, String> {
    let mut receiver = {
        let guard = state.ready_rx.lock().unwrap();
        guard.clone()
    };
    loop {
        let current = receiver.borrow().clone();
        match current {
            Some(Ok(ready)) => return Ok(ready),
            Some(Err(error)) => return Err(error),
            None => {}
        }
        if receiver.changed().await.is_err() {
            return Err("sidecar channel closed".to_string());
        }
    }
}

#[tauri::command]
pub fn kill_sidecar() -> () {}

#[tauri::command]
pub fn install_cli() -> Result<String, String> {
    // The CLI is expected to be installed through the system package manager
    // on Linux; the desktop app has nothing to stage.
    Ok("opencode".to_string())
}

// ---------------------------------------------------------------------------
// WSL (Windows-only upstream; inert stubs on Linux)
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn wsl_stub() -> Option<()> {
    None
}

// ---------------------------------------------------------------------------
// Updater (packaged updater disabled in this port)
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn updater_subscribe() {}

#[tauri::command]
pub fn updater_unsubscribe() {}

#[tauri::command]
pub fn updater_check() -> serde_json::Value {
    json!({ "status": "disabled" })
}

#[tauri::command]
pub fn updater_install() {}

// ---------------------------------------------------------------------------
// Deep links
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn consume_initial_deep_links(state: tauri::State<'_, AppState>) -> Vec<String> {
    let mut pending = state.deep_links.lock().unwrap();
    std::mem::take(&mut *pending)
}

// ---------------------------------------------------------------------------
// Default server
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_default_server_url(app: AppHandle, store: tauri::State<'_, StoreCache>) -> Option<String> {
    store::store_get(&app, &store, SETTINGS_STORE, DEFAULT_SERVER_URL_KEY)
}

#[tauri::command]
pub fn set_default_server_url(
    app: AppHandle,
    store: tauri::State<'_, StoreCache>,
    url: Option<String>,
) {
    match url {
        Some(url) => store::store_set(&app, &store, SETTINGS_STORE, DEFAULT_SERVER_URL_KEY, &url),
        None => store::store_delete(&app, &store, SETTINGS_STORE, DEFAULT_SERVER_URL_KEY),
    }
}

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------

fn entry_count(path: &PathBuf) -> Vec<(String, bool)> {
    std::fs::read_dir(path)
        .map(|entries| {
            entries
                .flatten()
                .map(|entry| {
                    let name = entry.file_name().to_string_lossy().to_string();
                    let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
                    (name, is_dir)
                })
                .collect()
        })
        .unwrap_or_default()
}

fn has_existing_app_state(entries: &[(String, bool)]) -> bool {
    entries.iter().any(|(name, is_dir)| {
        name == "opencode.settings"
            || name.ends_with(".dat")
            || (name.starts_with("window-state-") && name.ends_with(".json"))
            || (*is_dir && name == "opencode")
    })
}

#[tauri::command]
pub fn is_old_layout_eligible(app: AppHandle, store: tauri::State<'_, StoreCache>) -> bool {
    store::store_get(&app, &store, SETTINGS_STORE, OLD_LAYOUT_KEY)
        .map(|value| value == "true")
        .unwrap_or(false)
}

#[tauri::command]
pub fn initialize_old_layout(app: AppHandle, store: tauri::State<'_, StoreCache>) -> bool {
    if let Some(existing) = store::store_get(&app, &store, SETTINGS_STORE, OLD_LAYOUT_KEY) {
        return existing == "true";
    }
    let eligible = has_existing_app_state(&entry_count(
        &app.path().app_data_dir().unwrap_or_default(),
    ));
    store::store_set(
        &app,
        &store,
        SETTINGS_STORE,
        OLD_LAYOUT_KEY,
        if eligible { "true" } else { "false" },
    );
    eligible
}

#[tauri::command]
pub fn is_first_launch_onboarding_pending(
    app: AppHandle,
    store: tauri::State<'_, StoreCache>,
) -> bool {
    store::store_get(&app, &store, SETTINGS_STORE, FIRST_LAUNCH_KEY)
        .map(|value| value != "true")
        .unwrap_or(true)
}

#[tauri::command]
pub fn finish_first_launch_onboarding(
    app: AppHandle,
    store: tauri::State<'_, StoreCache>,
    create_default_project: bool,
) -> Result<Option<String>, String> {
    if store::store_get(&app, &store, SETTINGS_STORE, FIRST_LAUNCH_KEY).as_deref() == Some("true") {
        return Ok(None);
    }
    let mut default_project = None;
    if create_default_project {
        if let Some(documents) = dirs::document_dir() {
            let dir = documents.join("Default Project");
            std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
            default_project = Some(dir.to_string_lossy().to_string());
        }
    }
    store::store_set(&app, &store, SETTINGS_STORE, FIRST_LAUNCH_KEY, "true");
    Ok(default_project)
}

// ---------------------------------------------------------------------------
// Display backend (Windows/Linux display selector upstream)
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_display_backend() -> Option<String> {
    None
}

#[tauri::command]
pub fn set_display_backend(_backend: Option<String>) {}

#[tauri::command]
pub fn check_app_exists(_app_name: String) -> bool {
    true
}

#[tauri::command]
pub fn resolve_app_path(app_name: String) -> Option<String> {
    Some(app_name)
}

// ---------------------------------------------------------------------------
// Key/value stores
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn store_get(app: AppHandle, store: tauri::State<'_, StoreCache>, name: String, key: String) -> Option<String> {
    store::store_get(&app, &store, &name, &key)
}

#[tauri::command]
pub fn store_set(app: AppHandle, store: tauri::State<'_, StoreCache>, name: String, key: String, value: String) {
    store::store_set(&app, &store, &name, &key, &value)
}

#[tauri::command]
pub fn store_delete(app: AppHandle, store: tauri::State<'_, StoreCache>, name: String, key: String) {
    store::store_delete(&app, &store, &name, &key)
}

#[tauri::command]
pub fn store_clear(app: AppHandle, store: tauri::State<'_, StoreCache>, name: String) {
    store::store_clear(&app, &store, &name)
}

#[tauri::command]
pub fn store_keys(app: AppHandle, store: tauri::State<'_, StoreCache>, name: String) -> Vec<String> {
    store::store_keys(&app, &store, &name)
}

#[tauri::command]
pub fn store_length(app: AppHandle, store: tauri::State<'_, StoreCache>, name: String) -> usize {
    store::store_length(&app, &store, &name)
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn draft_get(state: tauri::State<'_, AppState>, key: String) -> Option<String> {
    state.drafts.get(&key)
}

#[tauri::command]
pub fn draft_set(state: tauri::State<'_, AppState>, key: String, value: Option<String>) {
    state.drafts.set(&key, value.as_deref())
}

#[tauri::command]
pub fn draft_delete(state: tauri::State<'_, AppState>, key: String) {
    state.drafts.set(&key, None)
}

#[tauri::command]
pub fn draft_blob_put(state: tauri::State<'_, AppState>, data_b64: String) -> Result<String, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_b64.as_bytes())
        .map_err(|error| error.to_string())?;
    state
        .drafts
        .put_blob(&bytes)
        .ok_or_else(|| "draft store unavailable".to_string())
}

#[tauri::command]
pub fn draft_blob_get(state: tauri::State<'_, AppState>, id: String) -> Result<Response, String> {
    Ok(match state.drafts.get_blob(&id) {
        Some(bytes) => Response::new(bytes),
        None => Response::new(Vec::new()),
    })
}

// ---------------------------------------------------------------------------
// Window identity / focus / fullscreen
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_window_id(window: WebviewWindow) -> String {
    window.label().to_string()
}

#[tauri::command]
pub fn get_window_focused(window: WebviewWindow) -> bool {
    window.is_focused().unwrap_or(false)
}

#[tauri::command]
pub fn get_window_fullscreen(window: WebviewWindow) -> bool {
    window.is_fullscreen().unwrap_or(false)
}

#[tauri::command]
pub fn set_window_focus(window: WebviewWindow) {
    let _ = window.set_focus();
}

#[tauri::command]
pub fn show_window(window: WebviewWindow) {
    let _ = window.show();
}

#[tauri::command]
pub fn relaunch(app: AppHandle) {
    app.restart()
}

// ---------------------------------------------------------------------------
// Zoom
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_zoom_factor(window: WebviewWindow) -> f64 {
    window_zoom(&window)
}

fn window_zoom(window: &WebviewWindow) -> f64 {
    // WebKitGTK does not expose the current scale through Tauri; the shim
    // tracks the last value it set, and 1.0 is the session default.
    *window
        .app_handle()
        .state::<crate::state::ZoomState>()
        .values
        .lock()
        .unwrap()
        .get(window.label())
        .unwrap_or(&1.0)
}

#[tauri::command]
pub fn set_zoom_factor(
    app: AppHandle,
    window: WebviewWindow,
    factor: f64,
) -> Result<(), String> {
    let factor = clamp_zoom(factor);
    window
        .set_zoom(factor)
        .map_err(|error| error.to_string())?;
    window
        .app_handle()
        .state::<crate::state::ZoomState>()
        .values
        .lock()
        .unwrap()
        .insert(window.label().to_string(), factor);
    events::emit_zoom(&app, factor);
    Ok(())
}

#[tauri::command]
pub fn get_pinch_zoom_enabled(app: AppHandle, store: tauri::State<'_, StoreCache>) -> bool {
    store::store_get(&app, &store, SETTINGS_STORE, PINCH_ZOOM_KEY)
        .map(|value| value == "true")
        .unwrap_or(false)
}

#[tauri::command]
pub fn set_pinch_zoom_enabled(
    app: AppHandle,
    store: tauri::State<'_, StoreCache>,
    enabled: bool,
) {
    store::store_set(
        &app,
        &store,
        SETTINGS_STORE,
        PINCH_ZOOM_KEY,
        if enabled { "true" } else { "false" },
    );
    events::emit_pinch(&app, enabled);
}

// ---------------------------------------------------------------------------
// Titlebar / background / devtools / menu actions
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn set_titlebar(_window: WebviewWindow, theme: TitlebarTheme) -> Result<(), String> {
    if !events::valid_titlebar(&theme) {
        return Err("Invalid titlebar theme".to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn set_background_color(app: AppHandle, color: String) -> Result<(), String> {
    // The renderer sends resolved CSS colors; only #RRGGBB[AA] can be applied
    // natively, anything else (oklch, rgb(), …) is silently ignored.
    let Some((r, g, b, a)) = hex_color(&color) else {
        return Ok(());
    };
    let parsed = tauri::window::Color(r, g, b, a);
    for (_, window) in app.webview_windows() {
        let _ = window.set_background_color(Some(parsed));
    }
    Ok(())
}

#[tauri::command]
pub fn run_desktop_menu_action(
    app: AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, AppState>,
    action: String,
) {
    let _label = window.label().to_string();
    match action.as_str() {
        "app.checkForUpdates" => {}
        "app.relaunch" => app.restart(),
        "window.new" => {
            let _ = crate::windows::create_main_window(&app, None);
        }
        "window.close" => {
            let _ = window.close();
        }
        "window.minimize" => {
            let _ = window.minimize();
        }
        "window.toggleMaximize" => {
            let maximized = window.is_maximized().unwrap_or(false);
            let result = if maximized {
                window.unmaximize()
            } else {
                window.maximize()
            };
            let _ = result;
        }
        "view.reload" => {
            let _ = window.reload();
        }
        "view.toggleDevTools" => {
            if window.is_devtools_open() {
                window.close_devtools();
            } else {
                window.open_devtools();
            }
        }
        "view.toggleFullscreen" => {
            let fullscreen = window.is_fullscreen().unwrap_or(false);
            let _ = window.set_fullscreen(!fullscreen);
            events::emit_fullscreen(&app, !fullscreen);
        }
        "edit.undo" => edit_command(&window, "undo"),
        "edit.redo" => edit_command(&window, "redo"),
        "edit.cut" => edit_command(&window, "cut"),
        "edit.copy" => edit_command(&window, "copy"),
        "edit.paste" => edit_command(&window, "paste"),
        "edit.selectAll" => edit_command(&window, "selectAll"),
        _ => {
            log::warn!("unhandled desktop menu action: {action}");
            state.menu_unknown.lock().unwrap().push(action);
        }
    }
}

fn edit_command(window: &WebviewWindow, command: &str) {
    let _ = window.eval(&format!(
        "document.execCommand({command:?}, false, null)",
        command = command
    ));
}

#[tauri::command]
pub fn set_force_focus() {}

#[tauri::command]
pub fn record_fatal_renderer_error(error: FatalRendererError) {
    log::error!(
        "fatal renderer error: {} (url={}, platform={})",
        error.error,
        error.url,
        error.platform
    );
}

#[tauri::command]
pub fn set_native_translations(bundle: NativeBundle) -> Result<(), String> {
    if !events::valid_native_bundle(&bundle) {
        return Err("Invalid native translation bundle".to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn export_debug_logs(app: AppHandle) -> Result<String, String> {
    let log_path = crate::logging::log_file_path();
    let target = dirs::download_dir()
        .or_else(dirs::document_dir)
        .unwrap_or_else(|| app.path().home_dir().unwrap_or_default())
        .join(format!(
            "opencode-desktop-log-{}.log",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0)
        ));
    std::fs::copy(&log_path, &target).map_err(|error| error.to_string())?;
    Ok(target.to_string_lossy().to_string())
}

// ---------------------------------------------------------------------------
// Pickers
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn open_directory_picker(
    options: Option<PickerOptions>,
) -> Result<Option<Vec<String>>, String> {
    let options = options.unwrap_or(PickerOptions {
        multiple: false,
        title: None,
        default_path: None,
        extensions: None,
    });
    let mut dialog = rfd::FileDialog::new().set_can_create_directories(true);
    if let Some(title) = &options.title {
        dialog = dialog.set_title(title);
    }
    if let Some(default_path) = &options.default_path {
        dialog = dialog.set_directory(std::path::Path::new(default_path));
    }
    let picked = dialog.pick_folders();
    Ok(picked.map(|paths| {
        let mut list: Vec<String> = paths
            .into_iter()
            .map(|path| path.to_string_lossy().to_string())
            .collect();
        if !options.multiple {
            list.truncate(1);
        }
        list
    }))
}

#[derive(Deserialize)]
pub struct PickerOptionsInternal {
    #[serde(default)]
    pub multiple: bool,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub default_path: Option<String>,
    #[serde(default)]
    pub extensions: Option<Vec<String>>,
}

#[tauri::command]
pub fn open_file_picker(
    state: tauri::State<'_, AppState>,
    window: WebviewWindow,
    options: Option<PickerOptionsInternal>,
) -> Result<Option<PickedFileResult>, String> {
    let options = options.unwrap_or(PickerOptionsInternal {
        multiple: false,
        title: None,
        default_path: None,
        extensions: None,
    });
    let mut dialog = rfd::FileDialog::new();
    if let Some(title) = &options.title {
        dialog = dialog.set_title(title);
    }
    if let Some(default_path) = &options.default_path {
        let path = PathBuf::from(default_path);
        if path.is_dir() {
            dialog = dialog.set_directory(&path);
        } else if let Some(parent) = path.parent() {
            dialog = dialog.set_directory(parent);
        }
    }
    if let Some(extensions) = &options.extensions {
        let extensions: Vec<&str> = extensions.iter().map(String::as_str).collect();
        dialog = dialog.add_filter("Files", &extensions);
    }
    let picked = if options.multiple {
        dialog.pick_files()
    } else {
        dialog.pick_file().map(|path| vec![path])
    };
    let Some(paths) = picked else {
        return Ok(None);
    };

    let mut total: u64 = 0;
    let mut files = Vec::with_capacity(paths.len());
    for path in &paths {
        let size = std::fs::metadata(path).map_err(|error| error.to_string())?.len();
        total += size;
        files.push(PickedFile {
            path: path.to_string_lossy().to_string(),
            name: path
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_default(),
            size,
        });
    }
    if total > events::MAX_ATTACHMENT_BYTES {
        return Err(format!(
            "Attachments exceed the {} MB limit",
            events::MAX_ATTACHMENT_BYTES / 1024 / 1024
        ));
    }

    let token = crate::state::new_token();
    state.picked.lock().unwrap().insert(
        token.clone(),
        crate::state::PickedAuthorization {
            window: window.label().to_string(),
            remaining: events::MAX_ATTACHMENT_BYTES,
            paths: paths
                .into_iter()
                .map(|path| path.to_string_lossy().to_string())
                .collect::<HashSet<_>>(),
        },
    );
    Ok(Some(PickedFileResult { token, files }))
}

#[tauri::command]
pub fn read_picked_file(
    state: tauri::State<'_, AppState>,
    window: WebviewWindow,
    token: String,
    path: String,
) -> Result<Response, String> {
    let mut picked = state.picked.lock().unwrap();
    let Some(authorization) = picked.get_mut(&token) else {
        return Err("File was not selected through the picker".to_string());
    };
    if authorization.window != window.label() || !authorization.paths.remove(&path) {
        return Err("File was not selected through the picker".to_string());
    }
    let metadata = std::fs::metadata(&path).map_err(|error| error.to_string())?;
    if metadata.len() > authorization.remaining {
        return Err(format!(
            "Attachments exceed the {} MB limit",
            events::MAX_ATTACHMENT_BYTES / 1024 / 1024
        ));
    }
    authorization.remaining -= metadata.len();
    if authorization.paths.is_empty() {
        picked.remove(&token);
    }
    drop(picked);
    let bytes = std::fs::read(&path).map_err(|error| error.to_string())?;
    Ok(Response::new(bytes))
}

#[tauri::command]
pub fn release_picked_files(state: tauri::State<'_, AppState>, token: String) {
    state.picked.lock().unwrap().remove(&token);
}

#[tauri::command]
pub fn save_file_picker(
    options: Option<SavePickerOptionsInternal>,
) -> Result<Option<String>, String> {
    let options = options.unwrap_or(SavePickerOptionsInternal {
        title: None,
        default_path: None,
    });
    let mut dialog = rfd::FileDialog::new();
    if let Some(title) = &options.title {
        dialog = dialog.set_title(title);
    }
    if let Some(default_path) = &options.default_path {
        let path = PathBuf::from(default_path);
        if let Some(parent) = path.parent() {
            if parent.is_dir() {
                dialog = dialog.set_directory(parent);
            }
        }
        if let Some(name) = path.file_name() {
            dialog = dialog.set_file_name(&name.to_string_lossy().to_string());
        }
    }
    Ok(dialog
        .save_file()
        .map(|path| path.to_string_lossy().to_string()))
}

#[derive(Deserialize)]
pub struct SavePickerOptionsInternal {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub default_path: Option<String>,
}

// ---------------------------------------------------------------------------
// External targets / filesystem
// ---------------------------------------------------------------------------

fn open_with_system(target: &str) {
    let _ = std::process::Command::new("xdg-open")
        .arg(target)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
}

#[tauri::command]
pub fn open_external(url: String) {
    let allowed = url.starts_with("http://")
        || url.starts_with("https://")
        || url.starts_with("mailto:");
    if !allowed {
        log::warn!("blocked external target: {url}");
        return;
    }
    open_with_system(&url);
}

#[tauri::command]
pub fn open_local_file(url: String) {
    if !url.starts_with("file://") {
        log::warn!("blocked local file target: {url}");
        return;
    }
    match url::Url::parse(&url) {
        Ok(parsed) if parsed.host_str().is_none() => {
            let path = parsed
                .to_file_path()
                .ok()
                .map(|path| path.to_string_lossy().to_string())
                .unwrap_or_else(|| url.trim_start_matches("file://").to_string());
            open_with_system(&path);
        }
        _ => log::warn!("blocked local file target: {url}"),
    }
}

#[tauri::command]
pub fn open_path(path: String, app: Option<String>) -> Result<(), String> {
    if !std::path::Path::new(&path).exists() {
        return Err(format!("path does not exist: {path}"));
    }
    match app.filter(|name| !name.trim().is_empty()) {
        Some(app) => std::process::Command::new(app)
            .arg(&path)
            .spawn()
            .map(|_| ())
            .map_err(|error| error.to_string()),
        None => {
            open_with_system(&path);
            Ok(())
        }
    }
}

#[tauri::command]
pub fn reveal_path(path: String) -> Result<bool, String> {
    if !std::path::Path::new(&path).exists() {
        return Ok(false);
    }
    match PathBuf::from(&path).parent() {
        Some(parent) if parent.is_dir() => {
            open_with_system(&parent.to_string_lossy());
            Ok(true)
        }
        _ => {
            open_with_system(&path);
            Ok(true)
        }
    }
}

// ---------------------------------------------------------------------------
// Clipboard
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn read_clipboard_image() -> Result<Option<serde_json::Value>, String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|error| error.to_string())?;
    let Ok(image) = clipboard.get_image() else {
        return Ok(None);
    };
    if image.width == 0 || image.height == 0 {
        return Ok(None);
    }
    let buffer = image::RgbaImage::from_raw(
        image.width as u32,
        image.height as u32,
        image.bytes.into_owned(),
    )
    .ok_or("invalid clipboard image")?;
    let mut png = Vec::new();
    image::DynamicImage::ImageRgba8(buffer)
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|error| error.to_string())?;
    Ok(Some(json!({
        "bufferB64": base64::engine::general_purpose::STANDARD.encode(png),
        "width": image.width,
        "height": image.height,
    })))
}

// ---------------------------------------------------------------------------
// Registration helper
// ---------------------------------------------------------------------------

pub fn generate() -> impl Fn(tauri::ipc::Invoke) -> bool {
    tauri::generate_handler![
        await_initialization,
        kill_sidecar,
        install_cli,
        wsl_stub,
        updater_subscribe,
        updater_unsubscribe,
        updater_check,
        updater_install,
        consume_initial_deep_links,
        get_default_server_url,
        set_default_server_url,
        is_old_layout_eligible,
        initialize_old_layout,
        is_first_launch_onboarding_pending,
        finish_first_launch_onboarding,
        get_display_backend,
        set_display_backend,
        check_app_exists,
        resolve_app_path,
        store_get,
        store_set,
        store_delete,
        store_clear,
        store_keys,
        store_length,
        draft_get,
        draft_set,
        draft_delete,
        draft_blob_put,
        draft_blob_get,
        get_window_id,
        get_window_focused,
        get_window_fullscreen,
        set_window_focus,
        show_window,
        relaunch,
        get_zoom_factor,
        set_zoom_factor,
        get_pinch_zoom_enabled,
        set_pinch_zoom_enabled,
        set_titlebar,
        set_background_color,
        run_desktop_menu_action,
        set_force_focus,
        record_fatal_renderer_error,
        set_native_translations,
        export_debug_logs,
        open_directory_picker,
        open_file_picker,
        read_picked_file,
        release_picked_files,
        save_file_picker,
        open_external,
        open_local_file,
        open_path,
        reveal_path,
        read_clipboard_image,
    ]
}

// used by the shim to distinguish fire-and-forget sends
#[allow(dead_code)]
pub static UNUSED: AtomicU64 = AtomicU64::new(0);
#[allow(dead_code)]
pub type WatchReady = watch::Receiver<Option<StateReadyEvent>>;
