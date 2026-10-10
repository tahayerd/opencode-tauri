//! Plugin Market bridge.
//!
//! Keeps sidecar credentials available to the renderer and shells out to the
//! `opencode` CLI for plugin install/remove — the CLI already knows how to
//! patch the global config, so we don't duplicate that logic here.

use std::path::{Path, PathBuf};
use std::collections::HashSet;
use tokio::process::Command;

use crate::sidecar;
use crate::state::{AppState, new_token};

const PLUGIN_TIMEOUT_SECS: u64 = 300;

fn get_opencode_config_dir() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join("opencode"))
}

/// Normalize and reconcile plugins in opencode.json
/// Ensures both 'plugin' (singular, read by runtime) and 'plugins' (plural, written by CLI) keys exist and match.
pub fn reconcile_opencode_config() -> Result<(), String> {
    let Some(cfg_dir) = get_opencode_config_dir() else {
        return Ok(());
    };
    let cfg_file = cfg_dir.join("opencode.json");
    if !cfg_file.exists() {
        return Ok(());
    }

    let content = std::fs::read_to_string(&cfg_file).map_err(|e| e.to_string())?;
    let mut val: serde_json::Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;

    if let serde_json::Value::Object(ref mut map) = val {
        let mut plugins_list: Vec<String> = Vec::new();
        let mut seen = HashSet::new();

        if let Some(serde_json::Value::Array(arr)) = map.get("plugin") {
            for item in arr {
                if let Some(s) = item.as_str() {
                    if seen.insert(s.to_string()) {
                        plugins_list.push(s.to_string());
                    }
                }
            }
        }

        if let Some(serde_json::Value::Array(arr)) = map.get("plugins") {
            for item in arr {
                if let Some(s) = item.as_str() {
                    if seen.insert(s.to_string()) {
                        plugins_list.push(s.to_string());
                    }
                }
            }
        }

        let arr_json: serde_json::Value = serde_json::json!(plugins_list);
        map.insert("plugin".to_string(), arr_json.clone());
        map.insert("plugins".to_string(), arr_json);

        let new_content = serde_json::to_string_pretty(&val).map_err(|e| e.to_string())?;
        std::fs::write(&cfg_file, new_content).map_err(|e| e.to_string())?;
        log::info!("[plugins] reconciled opencode.json config keys");
    }
    Ok(())
}

/// Ensure npm package dependencies are installed under ~/.config/opencode/plugins/node_modules
async fn install_plugin_package_dependencies(package: &str) {
    let Some(cfg_dir) = get_opencode_config_dir() else { return; };
    let plugins_dir = cfg_dir.join("plugins");
    let _ = std::fs::create_dir_all(&plugins_dir);

    log::info!("[plugins] resolving npm dependency for {} in {}", package, plugins_dir.display());
    let _ = Command::new("npm")
        .arg("install")
        .arg("--prefix")
        .arg(&plugins_dir)
        .arg(package)
        .stdin(std::process::Stdio::null())
        .output()
        .await;
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ServerCredentials {
    pub url: String,
    pub username: String,
    pub password: String,
}

/// Resolve once the sidecar is ready; mirrors `await_initialization` but is
/// only consumed by the plugin market, so it never gates app startup.
#[tauri::command]
pub async fn get_server_credentials(
    state: tauri::State<'_, AppState>,
) -> Result<ServerCredentials, String> {
    let mut rx = {
        let guard = state.ready_rx.lock().map_err(|e| e.to_string())?;
        guard.clone()
    };

    loop {
        let current = rx.borrow().clone();
        match current {
            Some(Ok(ready)) => {
                return Ok(ServerCredentials {
                    url: ready.url,
                    username: ready
                        .username
                        .clone()
                        .unwrap_or_else(|| "opencode".to_string()),
                    password: ready.password.clone().unwrap_or_default(),
                });
            }
            Some(Err(error)) => return Err(error),
            None => {}
        }
        if rx.changed().await.is_err() {
            return Err("sidecar channel closed".to_string());
        }
    }
}

/// Run `opencode plugin add|remove <package>` against the detected CLI.
#[tauri::command]
pub async fn plugin_manage(action: String, package: String) -> Result<serde_json::Value, String> {
    let package = package.trim().to_string();
    if package.is_empty() {
        return Err("package is required".to_string());
    }
    if package.contains(|c: char| c.is_whitespace() || c == ';' || c == '&') {
        return Err("invalid package specifier".to_string());
    }

    let binary = sidecar::detect()
        .ok_or_else(|| "opencode CLI not found on PATH".to_string())?;

    let mut cmd = Command::new(&binary);
    match action.as_str() {
        "add" => {
            cmd.arg("plugin").arg("add").arg(&package);
        }
        "remove" => {
            cmd.arg("plugin").arg("remove").arg(&package);
        }
        "update" => {
            cmd.arg("plugin").arg("update").arg(&package);
        }
        other => return Err(format!("unknown plugin action: {other}")),
    }
    cmd.stdin(std::process::Stdio::null());

    let token = new_token();
    log::info!("[plugin-manage:{}] opencode plugin {} {}", token, action, package);

    let output = tokio::time::timeout(
        std::time::Duration::from_secs(PLUGIN_TIMEOUT_SECS),
        cmd.output(),
    )
    .await
    .map_err(|_| format!("plugin {action} timed out after {PLUGIN_TIMEOUT_SECS}s"))?
    .map_err(|error| format!("failed to run opencode CLI: {error}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let success = output.status.success();

    if success {
        log::info!("[plugin-manage:{token}] {action} {package} ok");
        let _ = reconcile_opencode_config();
        if action == "add" || action == "update" {
            install_plugin_package_dependencies(&package).await;
        }
    } else {
        log::warn!(
            "[plugin-manage:{token}] {action} {package} failed ({}): {stderr}",
            output.status
        );
    }

    Ok(serde_json::json!({
        "success": success,
        "stdout": stdout,
        "stderr": stderr,
    }))
}
