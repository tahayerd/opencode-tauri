use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::state::ZoomState;

pub fn create_main_window(app: &AppHandle, _label: Option<String>) -> tauri::Result<WebviewWindow> {
    let label = format!("main-{}", crate::state::new_token());
    let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title("OpenCode")
        .inner_size(1280.0, 800.0)
        .resizable(true)
        .visible(false)
        .build()?;
    let _ = app.state::<ZoomState>();
    Ok(window)
}
