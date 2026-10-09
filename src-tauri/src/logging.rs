use std::path::PathBuf;
use std::sync::OnceLock;

static LOG_PATH: OnceLock<PathBuf> = OnceLock::new();

pub fn init() -> PathBuf {
    let path = dirs::state_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join("ai.opencode.desktop")
        .join("logs")
        .join("opencode-desktop.log");
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = LOG_PATH.set(path.clone());
    let target = path.clone();
    let file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&target)
        .unwrap_or_else(|_| std::fs::File::create("/tmp/opencode-desktop.log").unwrap());
    let _ = simplelog::WriteLogger::init(simplelog::LevelFilter::Info, simplelog::Config::default(), file);
    log::info!("opencode desktop (tauri) starting, log: {}", path.display());
    path
}

pub fn log_file_path() -> PathBuf {
    LOG_PATH
        .get()
        .cloned()
        .unwrap_or_else(|| PathBuf::from("/tmp/opencode-desktop.log"))
}
