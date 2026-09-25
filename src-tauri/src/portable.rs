//! Portable mode: when a `cascade-data` folder sits next to the app (the
//! AppImage file, or the executable), every per-user location — settings,
//! backups, logs and webview caches — is redirected into it, so Cascade can
//! live on a USB stick and leave nothing behind on the host machine.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager};

/// Name of the folder that switches portable mode on.
pub const DATA_DIR_NAME: &str = "cascade-data";

/// Webview/cache folders that are not worth copying when switching to portable.
const SKIP_ON_COPY: &[&str] = &["CacheStorage", "WebKitCache", "storage", "mediakeys", "hsts-storage.sqlite", "logs"];

/// The folder that contains the app: the AppImage's folder when running from
/// an AppImage (not its temporary mount point), otherwise the executable's.
pub fn app_location_dir() -> Option<PathBuf> {
    std::env::var_os("APPIMAGE")
        .map(PathBuf::from)
        .or_else(|| std::env::current_exe().ok())
        .and_then(|p| p.parent().map(Path::to_path_buf))
}

/// The portable data folder, if portable mode is on. `CASCADE_DATA_DIR`
/// overrides the location explicitly.
pub fn portable_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("CASCADE_DATA_DIR") {
        return Some(PathBuf::from(dir));
    }
    let dir = app_location_dir()?.join(DATA_DIR_NAME);
    dir.is_dir().then_some(dir)
}

/// Redirect the XDG base directories into the portable folder. Must run before
/// Tauri/GTK/WebKit start, since they read these variables at startup.
pub fn init() -> Option<PathBuf> {
    let dir = portable_dir()?;
    for (var, sub) in [
        ("XDG_DATA_HOME", "data"),
        ("XDG_CONFIG_HOME", "config"),
        ("XDG_CACHE_HOME", "cache"),
        ("XDG_STATE_HOME", "state"),
    ] {
        let path = dir.join(sub);
        let _ = std::fs::create_dir_all(&path);
        std::env::set_var(var, path);
    }
    Some(dir)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortableStatus {
    /// Portable mode is active for this run.
    pub enabled: bool,
    /// The portable data folder (when enabled).
    pub data_dir: Option<String>,
    /// The folder the app lives in; documents under it are stored relative to
    /// it so they still open when a USB stick mounts at a different path.
    pub root: Option<String>,
    /// Portable mode can be switched on (the app's folder is writable).
    pub can_enable: bool,
}

fn is_writable(dir: &Path) -> bool {
    let probe = dir.join(".cascade-write-test");
    let ok = std::fs::write(&probe, b"").is_ok();
    let _ = std::fs::remove_file(&probe);
    ok
}

#[tauri::command]
pub fn portable_status() -> PortableStatus {
    let enabled_dir = portable_dir();
    let root = app_location_dir();
    PortableStatus {
        enabled: enabled_dir.is_some(),
        data_dir: enabled_dir.map(|p| p.to_string_lossy().into_owned()),
        can_enable: root.as_deref().is_some_and(is_writable),
        root: root.map(|p| p.to_string_lossy().into_owned()),
    }
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let name = entry.file_name();
        if SKIP_ON_COPY.iter().any(|s| name == *s) {
            continue;
        }
        let dest = to.join(&name);
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &dest)?;
        } else if !dest.exists() {
            std::fs::copy(entry.path(), &dest)?;
        }
    }
    Ok(())
}

/// Create `cascade-data` next to the app and copy the current settings and
/// backups into it. Takes effect after a restart. Returns the folder path.
#[tauri::command]
pub fn enable_portable_mode(app: AppHandle) -> Result<String, String> {
    let root = app_location_dir().ok_or("Could not determine where Cascade is installed.")?;
    if !is_writable(&root) {
        return Err(format!("The folder {} is not writable.", root.display()));
    }
    let dir = root.join(DATA_DIR_NAME);
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    let id = app.config().identifier.clone();
    let paths = app.path();
    let copies = [
        (paths.app_data_dir(), dir.join("data").join(&id)),
        (paths.app_config_dir(), dir.join("config").join(&id)),
    ];
    for (src, dest) in copies {
        if let Ok(src) = src {
            if src.is_dir() && src != dest {
                copy_dir(&src, &dest).map_err(|e| format!("Could not copy {}: {e}", src.display()))?;
            }
        }
    }
    Ok(dir.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copy_skips_caches_and_keeps_settings() {
        let base = std::env::temp_dir().join(format!("cascade-portable-test-{}", std::process::id()));
        let src = base.join("src");
        let dst = base.join("dst");
        std::fs::create_dir_all(src.join("document-backups/abc")).unwrap();
        std::fs::create_dir_all(src.join("WebKitCache")).unwrap();
        std::fs::write(src.join("preferences.json"), "{}").unwrap();
        std::fs::write(src.join("document-backups/abc/1.col"), "x").unwrap();
        std::fs::write(src.join("WebKitCache/blob"), "x").unwrap();
        copy_dir(&src, &dst).unwrap();
        assert!(dst.join("preferences.json").exists());
        assert!(dst.join("document-backups/abc/1.col").exists());
        assert!(!dst.join("WebKitCache").exists());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn explicit_env_dir_wins() {
        std::env::set_var("CASCADE_DATA_DIR", "/tmp/somewhere-portable");
        assert_eq!(portable_dir(), Some(PathBuf::from("/tmp/somewhere-portable")));
        std::env::remove_var("CASCADE_DATA_DIR");
    }
}
