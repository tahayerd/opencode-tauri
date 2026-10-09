use serde::Deserialize;
use tauri::Emitter;

use crate::types::{NativeBundle, TitlebarTheme};

#[derive(Debug, Deserialize)]
pub struct PickerOptions {
    #[serde(default)]
    pub multiple: bool,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub default_path: Option<String>,
    #[serde(default)]
    pub extensions: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
pub struct SavePickerOptions {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub default_path: Option<String>,
}

#[derive(serde::Serialize)]
pub struct PickedFile {
    pub path: String,
    pub name: String,
    pub size: u64,
}

#[derive(serde::Serialize)]
pub struct PickedFileResult {
    pub token: String,
    pub files: Vec<PickedFile>,
}

#[derive(serde::Serialize, Clone)]
pub struct ReadyEvent {
    pub url: String,
    pub username: String,
    pub password: String,
}

#[derive(serde::Serialize, Clone)]
pub struct FullscreenEvent {
    pub fullscreen: bool,
}

#[derive(serde::Serialize, Clone)]
pub struct ZoomEvent {
    pub factor: f64,
}

#[derive(serde::Serialize, Clone)]
pub struct BoolEvent {
    pub enabled: bool,
}

pub const MAX_ATTACHMENT_BYTES: u64 = 20 * 1024 * 1024;

pub fn emit_ready(app: &tauri::AppHandle, payload: &ReadyEvent) {
    let _ = app.emit("opencode://ready", payload);
}

pub fn emit_menu_command(app: &tauri::AppHandle, id: &str) {
    let _ = app.emit("opencode://menu-command", id);
}

pub fn emit_deep_links(app: &tauri::AppHandle, urls: &[String]) {
    let _ = app.emit("opencode://deep-link", urls);
}

pub fn emit_fullscreen(app: &tauri::AppHandle, fullscreen: bool) {
    let _ = app.emit("opencode://fullscreen-changed", FullscreenEvent { fullscreen });
}

pub fn emit_zoom(app: &tauri::AppHandle, factor: f64) {
    let _ = app.emit("opencode://zoom-changed", ZoomEvent { factor });
}

pub fn emit_pinch(app: &tauri::AppHandle, enabled: bool) {
    let _ = app.emit("opencode://pinch-changed", BoolEvent { enabled });
}

pub fn valid_titlebar(theme: &TitlebarTheme) -> bool {
    matches!(theme.mode.as_str(), "light" | "dark")
}

pub fn valid_native_bundle(bundle: &NativeBundle) -> bool {
    bundle.locale.is_some() || !bundle.rest.is_empty()
}
