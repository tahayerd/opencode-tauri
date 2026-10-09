use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::Manager;

const SETTINGS_STORE: &str = "opencode.settings";

fn store_path(app: &tauri::AppHandle, name: &str) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join(name)
}

fn sanitize_key(key: &str) -> String {
    // electron-store is configured with accessPropertiesByDotNotation: false,
    // so keys are stored verbatim as flat JSON properties.
    key.to_string()
}

pub struct StoreCache {
    caches: Mutex<BTreeMap<String, BTreeMap<String, serde_json::Value>>>,
}

impl Default for StoreCache {
    fn default() -> Self {
        Self {
            caches: Mutex::new(BTreeMap::new()),
        }
    }
}

impl StoreCache {
    fn load(&self, path: &Path) -> BTreeMap<String, serde_json::Value> {
        std::fs::read(path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    fn persist(&self, path: &Path, map: &BTreeMap<String, serde_json::Value>) {
        if map.is_empty() {
            let _ = std::fs::remove_file(path);
            return;
        }
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(mut file) = std::fs::File::create(path) {
            let _ = serde_json::to_writer_pretty(&mut file, map);
            let _ = file.write_all(b"\n");
        }
    }

    pub fn with<F, T>(&self, app: &tauri::AppHandle, name: &str, f: F) -> T
    where
        F: FnOnce(&mut BTreeMap<String, serde_json::Value>) -> T,
    {
        let mut caches = self.caches.lock().unwrap();
        let entry = caches.entry(name.to_string());
        let map = match entry {
            std::collections::btree_map::Entry::Occupied(occupied) => occupied.into_mut(),
            std::collections::btree_map::Entry::Vacant(vacant) => {
                vacant.insert(self.load(&store_path(app, name)))
            }
        };
        let result = f(map);
        self.persist(&store_path(app, name), map);
        result
    }
}

pub fn store_get(app: &tauri::AppHandle, cache: &StoreCache, name: &str, key: &str) -> Option<String> {
    cache.with(app, name, |map| {
        map.get(&sanitize_key(key)).map(|value| match value {
            serde_json::Value::String(text) => text.clone(),
            other => serde_json::to_string(other).unwrap_or_default(),
        })
    })
}

pub fn store_set(app: &tauri::AppHandle, cache: &StoreCache, name: &str, key: &str, value: &str) {
    cache.with(app, name, |map| {
        map.insert(sanitize_key(key), serde_json::Value::String(value.to_string()));
    });
}

pub fn store_delete(app: &tauri::AppHandle, cache: &StoreCache, name: &str, key: &str) {
    cache.with(app, name, |map| {
        map.remove(&sanitize_key(key));
    });
}

pub fn store_clear(app: &tauri::AppHandle, cache: &StoreCache, name: &str) {
    cache.with(app, name, |map| {
        map.clear();
    });
}

pub fn store_keys(app: &tauri::AppHandle, cache: &StoreCache, name: &str) -> Vec<String> {
    cache.with(app, name, |map| map.keys().cloned().collect())
}

pub fn store_length(app: &tauri::AppHandle, cache: &StoreCache, name: &str) -> usize {
    cache.with(app, name, |map| map.len())
}

pub fn default_settings_name() -> &'static str {
    SETTINGS_STORE
}
