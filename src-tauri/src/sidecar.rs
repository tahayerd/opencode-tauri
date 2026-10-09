use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;

use tokio::process::Command;
/// Port of the Electron v2 sidecar (background-cli.ts): it talks to the
/// opencode CLI's background service instead of spawning an embedded server,
/// so the desktop app and the terminal share one long-lived instance.
#[derive(Clone)]
pub struct Sidecar {
    binary: Arc<PathBuf>,
    state_home: Arc<tokio::sync::Mutex<Option<String>>>,
}

pub struct SidecarReady {
    pub url: String,
    pub username: String,
    pub password: String,
}

fn cli_binary() -> Option<PathBuf> {
    // 1. Explicit override (used by the packaging scripts).
    if let Ok(path) = std::env::var("OPENCODE_CLI_PATH") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Some(path);
        }
    }
    // 2. A CLI already on PATH (official install or package manager).
    for candidate in ["opencode", "opencode2"] {
        if let Some(path) = which(candidate) {
            if verify_cli(&path) {
                return Some(path);
            }
        }
    }
    // 3. Well-known install locations (launchers do not inherit the user's
    // interactive PATH).
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let mut extra = vec![
        PathBuf::from("/usr/local/bin/opencode"),
        PathBuf::from("/usr/bin/opencode"),
    ];
    if let Some(home) = &home {
        extra.push(home.join(".opencode/bin/opencode"));
        extra.push(home.join(".local/bin/opencode"));
        extra.push(home.join(".cargo/bin/opencode"));
        extra.push(home.join(".bun/bin/opencode"));
    }
    for path in extra {
        if path.is_file() && verify_cli(&path) {
            return Some(path);
        }
    }
    None
}

fn verify_cli(path: &std::path::Path) -> bool {
    std::process::Command::new(path)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn which(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn tokio_sync_mutex<T>(value: T) -> tokio::sync::Mutex<T> {
    tokio::sync::Mutex::new(value)
}

fn service_url(status: &str) -> Option<String> {
    let trimmed = status.trim();
    if trimmed.is_empty() {
        return None;
    }
    if url::Url::parse(trimmed).is_ok() {
        return Some(trimmed.to_string());
    }
    let rest = trimmed.strip_prefix("running ")?;
    let rest = rest.trim();
    if url::Url::parse(rest).is_ok() {
        return Some(rest.to_string());
    }
    None
}

pub async fn spawn(binary: PathBuf) -> Result<Sidecar, String> {
    let version = run(&binary, &["--version"], None, false).await?;
    log::info!("sidecar cli version: {version}");
    Ok(Sidecar {
        binary: Arc::new(binary),
        state_home: Arc::new(tokio_sync_mutex(std::env::var("XDG_STATE_HOME").ok())),
    })
}

pub fn detect() -> Option<PathBuf> {
    cli_binary()
}

impl Sidecar {
    async fn run(&self, args: &[&str], redact: bool) -> Result<String, String> {
        let state_home = self.state_home.lock().await.clone();
        run(&self.binary, args, state_home.as_deref(), redact).await
    }

    pub async fn start(&self) -> Result<SidecarReady, String> {
        let status = self.run(&["service", "status"], false).await.ok();
        let found = status.as_deref().and_then(service_url);
        log::info!(
            "existing background service: {}",
            found.as_deref().unwrap_or("none")
        );

        let url = self.run(&["service", "start"], false).await?;
        let url = service_url(&url)
            .ok_or_else(|| format!("service start returned no URL: {url}"))?;
        let password = self.run(&["service", "get", "password"], true).await?;
        Ok(SidecarReady {
            url,
            username: "opencode".to_string(),
            password: password.trim().to_string(),
        })
    }
}

async fn run(
    binary: &std::path::Path,
    args: &[&str],
    state_home: Option<&str>,
    redact: bool,
) -> Result<String, String> {
    let mut command = Command::new(binary);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(state_home) = state_home {
        command.env("XDG_STATE_HOME", state_home);
    } else {
        command.env_remove("XDG_STATE_HOME");
    }
    let output = command.output().await.map_err(|error| error.to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !output.status.success() {
        let stderr = if redact && !stderr.is_empty() {
            "[redacted]".to_string()
        } else {
            stderr
        };
        return Err(format!(
            "opencode {} failed: {} {}",
            args.join(" "),
            output.status,
            stderr
        ));
    }
    if redact {
        log::info!("opencode {} completed [redacted]", args.join(" "));
    } else {
        log::info!("opencode {} completed: {stdout}", args.join(" "));
    }
    Ok(stdout)
}
