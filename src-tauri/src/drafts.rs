use std::collections::{HashMap, HashSet};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};

/// File-backed port of the Electron desktop draft store.
///
/// Upstream keeps documents and blobs in a SQLite database with a debounced
/// flush. Draft documents are small JSON strings while blobs (image drafts)
/// are content-addressed by sha256, so plain atomic file writes give the same
/// durability guarantees without pulling in SQLite.
pub struct DraftStore {
    root: Mutex<Option<PathBuf>>,
    pending: Mutex<HashMap<String, Option<String>>>,
}

fn encode_key(key: &str) -> String {
    let mut out = String::with_capacity(key.len());
    for byte in key.bytes() {
        match byte {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'.' | b'-' | b'_' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn documents_dir(root: &Path) -> PathBuf {
    root.join("documents")
}

fn blobs_dir(root: &Path) -> PathBuf {
    root.join("blobs")
}

fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension(format!(
        "{}.tmp",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or(0)
    ));
    {
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    std::fs::rename(&tmp, path)
}

fn read_doc(root: &Path, key: &str) -> Option<String> {
    let path = documents_dir(root).join(encode_key(key));
    std::fs::read_to_string(path).ok()
}

fn write_doc(root: &Path, key: &str, value: &str) {
    let path = documents_dir(root).join(encode_key(key));
    if let Err(error) = atomic_write(&path, value.as_bytes()) {
        eprintln!("draft store write failed: {error}");
    }
}

fn collect_blob_ids(value: &serde_json::Value, used: &mut HashSet<String>) {
    match value {
        serde_json::Value::Object(map) => {
            if let Some(serde_json::Value::Object(blob)) = map.get("blob") {
                if let Some(serde_json::Value::String(id)) = blob.get("id") {
                    used.insert(id.clone());
                }
            }
            for item in map.values() {
                collect_blob_ids(item, used);
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                collect_blob_ids(item, used);
            }
        }
        _ => {}
    }
}

impl DraftStore {
    pub fn new() -> Self {
        Self {
            root: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
        }
    }

    pub fn init(&self, root: PathBuf) {
        let mut guard = self.root.lock().unwrap();
        if guard.is_some() {
            return;
        }
        let _ = std::fs::create_dir_all(documents_dir(&root));
        let _ = std::fs::create_dir_all(blobs_dir(&root));
        self.collect_garbage(&root);
        *guard = Some(root);
    }

    /// Removes blob files that no document references anymore, mirroring the
    /// startup cleanup in the upstream SQLite implementation.
    fn collect_garbage(&self, root: &Path) {
        let mut used = HashSet::new();
        let entries = match std::fs::read_dir(documents_dir(root)) {
            Ok(entries) => entries,
            Err(_) => return,
        };
        for entry in entries.flatten() {
            if !entry.path().is_file() {
                continue;
            }
            if let Ok(text) = std::fs::read_to_string(entry.path()) {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                    collect_blob_ids(&value, &mut used);
                }
            }
        }
        if let Ok(entries) = std::fs::read_dir(blobs_dir(root)) {
            for entry in entries.flatten() {
                let path = entry.path();
                if let Some(name) = path.file_name().and_then(|name| name.to_str()) {
                    if !used.contains(name) {
                        let _ = std::fs::remove_file(path);
                    }
                }
            }
        }
    }

    pub fn get(&self, key: &str) -> Option<String> {
        if let Some(pending) = self.pending.lock().unwrap().get(key) {
            return pending.clone();
        }
        let root = self.root.lock().unwrap().clone()?;
        read_doc(&root, key)
    }

    pub fn set(&self, key: &str, value: Option<&str>) {
        let root = self.root.lock().unwrap().clone();
        self.pending
            .lock()
            .unwrap()
            .insert(key.to_string(), value.map(str::to_string));
        if let Some(root) = root {
            match value {
                Some(value) => write_doc(&root, key, value),
                None => {
                    let _ = std::fs::remove_file(documents_dir(&root).join(encode_key(key)));
                }
            }
        }
    }

    pub fn put_blob(&self, data: &[u8]) -> Option<String> {
        let root = self.root.lock().unwrap().clone()?;
        let id = Sha256::digest(data);
        let id = format!("{id:x}");
        let path = blobs_dir(&root).join(&id);
        if !path.exists() {
            atomic_write(&path, data).ok()?;
        }
        Some(id)
    }

    pub fn get_blob(&self, id: &str) -> Option<Vec<u8>> {
        let root = self.root.lock().unwrap().clone()?;
        if !id.chars().all(|c| c.is_ascii_hexdigit()) || id.len() != 64 {
            return None;
        }
        std::fs::read(blobs_dir(&root).join(id)).ok()
    }
}
