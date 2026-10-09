use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use tokio::sync::watch;

use crate::drafts::DraftStore;

pub struct PickedAuthorization {
    pub window: String,
    pub remaining: u64,
    pub paths: HashSet<String>,
}

pub struct ZoomState {
    pub values: Mutex<HashMap<String, f64>>,
}

pub struct AppState {
    pub ready_tx: watch::Sender<Option<Result<ReadyEvent, String>>>,
    pub ready_rx: Mutex<watch::Receiver<Option<Result<ReadyEvent, String>>>>,
    pub drafts: DraftStore,
    pub picked: Mutex<HashMap<String, PickedAuthorization>>,
    pub deep_links: Mutex<Vec<String>>,
    pub menu_unknown: Mutex<Vec<String>>,
}

/// Mirrors `ServerReadyData` from the Electron preload types.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ReadyEvent {
    pub url: String,
    pub username: Option<String>,
    pub password: Option<String>,
}

pub fn new_token() -> String {
    use rand::Rng;
    let mut rng = rand::rng();
    let bytes: [u8; 16] = rng.random();
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

impl AppState {
    pub fn new() -> Self {
        let (ready_tx, ready_rx) = watch::channel(None);
        Self {
            ready_tx,
            ready_rx: Mutex::new(ready_rx),
            drafts: DraftStore::new(),
            picked: Mutex::new(HashMap::new()),
            deep_links: Mutex::new(Vec::new()),
            menu_unknown: Mutex::new(Vec::new()),
        }
    }
}
