use crate::error::AppResult;
use std::collections::HashMap;
use std::sync::Mutex;

/// Manages global keyboard shortcuts.
///
/// Uses Tauri's global shortcut API to register system-wide hotkeys.
/// The frontend listens for shortcut events and reacts accordingly.
pub struct ShortcutManager {
    registered: Mutex<HashMap<String, bool>>,
}

impl ShortcutManager {
    pub fn new() -> Self {
        Self {
            registered: Mutex::new(HashMap::new()),
        }
    }

    /// Register a global shortcut.
    /// Returns true if registration was successful.
    pub fn register(&self, shortcut: &str) -> AppResult<bool> {
        // In Tauri 2.x, global shortcuts are registered via the Tauri app handle.
        // This is a stub for direct calls; the actual registration happens in lib.rs
        // using app.global_shortcut().register().
        let mut reg = self.registered.lock().unwrap();
        if reg.contains_key(shortcut) {
            return Ok(true); // Already registered
        }
        reg.insert(shortcut.to_string(), true);
        Ok(true)
    }

    /// Unregister a global shortcut
    pub fn unregister(&self, shortcut: &str) -> AppResult<bool> {
        let mut reg = self.registered.lock().unwrap();
        reg.remove(shortcut);
        Ok(true)
    }

    /// Unregister all shortcuts
    pub fn unregister_all(&self) -> AppResult<()> {
        let mut reg = self.registered.lock().unwrap();
        reg.clear();
        Ok(())
    }

    /// Check if a shortcut is currently registered
    pub fn is_registered(&self, shortcut: &str) -> bool {
        let reg = self.registered.lock().unwrap();
        reg.contains_key(shortcut)
    }
}

impl Default for ShortcutManager {
    fn default() -> Self {
        Self::new()
    }
}
