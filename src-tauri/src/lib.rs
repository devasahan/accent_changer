//! Accent Changer's desktop shell (Tauri 2).
//!
//! The audio pipeline runs as plain JavaScript in the window (WebView2). This
//! side keeps the Sanas API key in Windows Credential Manager, swaps it for
//! short-lived tokens, gives the microphone to the app's own page only, and
//! keeps the window on that page (links open in the normal browser). It also
//! keeps the settings file (settings.rs), hides and shows the window
//! (window.rs, the only code allowed to), sets the microphone permission in
//! WebView2's profile (permission.rs) and writes the page's log lines
//! (pagelog.rs).

mod keystore;
mod pagelog;
mod permission;
mod sanas;
mod settings;
mod window;

use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::webview::{PermissionKind, PermissionResponse};
use tauri::{AppHandle, Manager, State, Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

use keystore::{clean_key, tail, KeyStore, OsKeyStore};
use sanas::{KeyCheck, TokenBroker};
use window::HideTimer;

pub struct AppState {
    keys: Arc<dyn KeyStore>,
    broker: TokenBroker,
    /// Which "Hide" may still show the window again (window.rs).
    hide: Arc<HideTimer>,
    /// Reads and saves of the settings file take turns (settings.rs).
    settings_lock: Mutex<()>,
}

/// Pages that belong to the app: its bundled page (http://tauri.localhost on
/// Windows, https:// with useHttpsScheme, tauri://localhost elsewhere) and,
/// in debug builds only, the local dev server.
pub fn is_app_url(url: &Url) -> bool {
    let bundled = matches!(
        (url.scheme(), url.host_str()),
        ("http" | "https", Some("tauri.localhost")) | ("tauri", Some("localhost"))
    );
    let dev_server =
        cfg!(debug_assertions) && url.scheme() == "http" && matches!(url.host_str(), Some("localhost" | "127.0.0.1"));
    bundled || dev_server
}

/// Microphone (and audio autoplay) for the app's own page; nothing for anyone
/// else. Every answer is logged ("permission Microphone: allow"), so a Session B
/// log shows whether WebView2 asked for anything else when choosing a playback
/// device (it would arrive as `Other`) and was refused.
fn permission_for(url: Option<Url>, kind: PermissionKind) -> PermissionResponse {
    let own = url.as_ref().is_some_and(is_app_url);
    let answer = match kind {
        PermissionKind::Microphone | PermissionKind::Autoplay if own => PermissionResponse::Allow,
        _ => PermissionResponse::Deny,
    };
    log::info!("permission {kind:?}: {}", if answer == PermissionResponse::Allow { "allow" } else { "deny" });
    answer
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct KeyStatus {
    saved: bool,
    /// The last 4 characters, to tell keys apart.
    tail: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct KeySaved {
    /// "accepted", or "unknown" when Sanas couldn't be asked (saved anyway).
    checked: &'static str,
    note: Option<String>,
    tail: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    name: String,
    version: String,
    /// Which build this is; see `build_stamp`.
    build: String,
}

/// The tag or branch and the commit GitHub Actions built this from, such as
/// "v0.1.0-test.2 1a2b3c4", or "local". Every test build has the same version,
/// so this is what tells them apart in the copied results.
fn build_stamp(ref_name: Option<&str>, sha: Option<&str>) -> String {
    let ref_name = ref_name.map(str::trim).filter(|r| !r.is_empty());
    let sha = sha.map(str::trim).filter(|s| !s.is_empty()).map(|s| s.chars().take(7).collect::<String>());
    match (ref_name, sha) {
        (Some(r), Some(s)) => format!("{r} {s}"),
        (Some(r), None) => r.to_string(),
        (None, Some(s)) => s,
        (None, None) => "local".to_string(),
    }
}

#[tauri::command]
fn app_info(app: AppHandle) -> AppInfo {
    let info = app.package_info();
    AppInfo {
        name: info.name.clone(),
        version: info.version.to_string(),
        // Read when this crate is compiled; cargo compiles it again when either changes.
        build: build_stamp(option_env!("GITHUB_REF_NAME"), option_env!("GITHUB_SHA")),
    }
}

#[tauri::command]
fn key_status(state: State<'_, AppState>) -> Result<KeyStatus, String> {
    let key = state.keys.get()?;
    Ok(KeyStatus { saved: key.is_some(), tail: key.as_deref().map(tail) })
}

/// Check a pasted key with Sanas and save it. A key Sanas refuses is not saved.
#[tauri::command]
async fn key_set(state: State<'_, AppState>, key: String) -> Result<KeySaved, String> {
    let key = clean_key(&key)?;
    match state.broker.check_key(&key).await {
        KeyCheck::Accepted => {
            state.keys.set(&key)?;
            log::info!("key saved (Sanas accepted it)");
            Ok(KeySaved { checked: "accepted", note: None, tail: tail(&key) })
        }
        // The Console shows a key only once: it is only for checking expiry or revocation.
        KeyCheck::Refused(status) => Err(format!(
            "Sanas refused this key (HTTP {status}). Paste it again from where you saved it (for example your password manager); if it is still refused, check in the Sanas Console whether it expired or was revoked."
        )),
        KeyCheck::Unknown(why) => {
            state.keys.set(&key)?;
            log::warn!("key saved without a check ({why})");
            Ok(KeySaved { checked: "unknown", note: Some(why), tail: tail(&key) })
        }
    }
}

#[tauri::command]
fn key_delete(state: State<'_, AppState>) -> Result<(), String> {
    state.keys.delete()?;
    log::info!("key removed");
    Ok(())
}

/// A fresh Sanas token response (JSON text) for the page's SDK.
#[tauri::command]
async fn sanas_token(state: State<'_, AppState>) -> Result<String, String> {
    let key = state
        .keys
        .get()?
        .ok_or_else(|| "No Sanas key saved yet: paste it on the Diagnostics page.".to_string())?;
    state.broker.token(&key).await
}

/// The log file's settings, for run() and a test. The plugin's default
/// deletes the whole file at 40 kB, which a Session B with the page's lines
/// could reach, losing the first start's lines. Here a full file (1 MB) is
/// kept as one older file, named with the date, and a new file starts; the
/// older file before it is deleted. So the log holds at most about 2 MB.
/// KeepSome counts the older files only.
fn log_settings() -> tauri_plugin_log::Builder {
    tauri_plugin_log::Builder::new()
        .level(log::LevelFilter::Info)
        .max_file_size(1_000_000)
        .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(1))
}

pub fn run() {
    // A failed start (WebView2 can't start, say) ends in a panic, and the
    // installed app has no console to show it on. So panics also go to the log:
    // %LOCALAPPDATA%\io.github.devasahan.accentchanger\logs\Accent Changer.log.
    // The log opens while the app is built, before setup runs; a failure before
    // it opens (the window system itself not starting) still leaves no trace.
    let print = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        log::error!("{info}");
        log::logger().flush();
        print(info);
    }));
    tauri::Builder::default()
        // First, so a second launch only brings the running app forward (and
        // ends a "Hide" early: the Start menu is the user's way back).
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| window::show_for_user(app)))
        .plugin(log_settings().build())
        .plugin(tauri_plugin_opener::init())
        .on_permission_request(|webview, kind| permission_for(webview.url().ok(), kind))
        .invoke_handler(tauri::generate_handler![
            app_info,
            key_status,
            key_set,
            key_delete,
            sanas_token,
            window::window_hide_for,
            window::window_state,
            permission::mic_permission_allow,
            settings::settings_load,
            settings::settings_save,
            pagelog::log_line
        ])
        .setup(|app| {
            // Here rather than before the app starts: the log is open by now, so a
            // failure to set up the HTTP client is written down. The page, the only
            // caller of the commands, comes after.
            app.manage(AppState {
                keys: Arc::new(OsKeyStore),
                broker: TokenBroker::new(sanas::IDENTITY_URL),
                hide: Arc::new(HideTimer::default()),
                settings_lock: Mutex::new(()),
            });
            let handle = app.handle().clone();
            WebviewWindowBuilder::new(app, window::MAIN_WINDOW, WebviewUrl::App("index.html".into()))
                .title("Accent Changer")
                .inner_size(820.0, 680.0)
                .min_inner_size(520.0, 480.0)
                .on_navigation(move |url| {
                    if is_app_url(url) {
                        return true;
                    }
                    if matches!(url.scheme(), "http" | "https") {
                        let _ = handle.opener().open_url(url.as_str(), None::<&str>);
                    }
                    false
                })
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Accent Changer");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn only_the_app_s_own_pages_count() {
        assert!(is_app_url(&url("http://tauri.localhost/index.html")));
        assert!(is_app_url(&url("https://tauri.localhost/")));
        assert!(is_app_url(&url("tauri://localhost/index.html")));
        assert!(!is_app_url(&url("https://evil.example/")));
        assert!(!is_app_url(&url("http://tauri.localhost.evil.example/")));
        assert!(!is_app_url(&url("https://portal-api.sanas.ai/")));
        assert_eq!(is_app_url(&url("http://localhost:8080/src/")), cfg!(debug_assertions));
    }

    #[test]
    fn the_microphone_goes_to_the_app_only() {
        let own = Some(url("http://tauri.localhost/index.html"));
        let other = Some(url("https://evil.example/"));
        assert_eq!(permission_for(own.clone(), PermissionKind::Microphone), PermissionResponse::Allow);
        assert_eq!(permission_for(other, PermissionKind::Microphone), PermissionResponse::Deny);
        assert_eq!(permission_for(None, PermissionKind::Microphone), PermissionResponse::Deny);
        assert_eq!(permission_for(own, PermissionKind::Camera), PermissionResponse::Deny);
    }

    #[test]
    fn the_build_stamp_names_the_tag_or_branch_and_the_commit() {
        let sha = Some("1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d");
        assert_eq!(build_stamp(Some("v0.1.0-test.2"), sha), "v0.1.0-test.2 1a2b3c4");
        assert_eq!(build_stamp(Some("claude/step0plus-step1"), sha), "claude/step0plus-step1 1a2b3c4");
        assert_eq!(build_stamp(None, None), "local");
        assert_eq!(build_stamp(Some(""), Some(" ")), "local", "set but empty counts as not set");
        assert_eq!(build_stamp(Some("main"), None), "main");
        assert_eq!(build_stamp(None, sha), "1a2b3c4");
    }

    #[test]
    fn the_log_keeps_its_file_and_one_older_file() {
        use log::Log as _;
        use tauri_plugin_log::{Target, TargetKind};
        // The app's log settings, writing to a test folder. The logger does not
        // become the global one, so the other tests' lines stay out of it.
        let dir = std::env::temp_dir().join(format!("accent-changer-test-log-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let app = tauri::test::mock_app();
        let folder = TargetKind::Folder { path: dir.clone(), file_name: Some("Accent Changer".into()) };
        let (_, _, logger) = log_settings().clear_targets().target(Target::new(folder)).split(app.handle()).unwrap();
        // 3.5 MB in lines of 100 kB: the file fills up three times.
        let line = "x".repeat(100_000);
        for _ in 0..35 {
            logger.log(&log::Record::builder().level(log::Level::Info).args(format_args!("{line}")).build());
        }
        logger.flush();
        // Close the file first: Windows may list an open file with an old size,
        // and cannot remove a folder with an open file in it.
        drop(logger);
        let mut files: Vec<(String, u64)> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| {
                let path = e.unwrap().path();
                (path.file_name().unwrap().to_string_lossy().into_owned(), std::fs::metadata(&path).unwrap().len())
            })
            .collect();
        let _ = std::fs::remove_dir_all(&dir);
        files.sort();
        let names: Vec<&str> = files.iter().map(|(name, _)| name.as_str()).collect();
        assert_eq!(names.len(), 2, "the file and one older file: {names:?}");
        assert_eq!(names[0], "Accent Changer.log");
        assert!(names[1].starts_with("Accent Changer_") && names[1].ends_with(".log"), "{names:?}");
        assert!(files.iter().all(|&(_, bytes)| bytes <= 1_000_000), "at most 1 MB each: {files:?}");
        assert!(files[1].1 > 900_000, "the older file was full (1 MB, not the plugin's 40 kB): {files:?}");
    }

    #[test]
    fn app_info_has_the_fields_the_page_reads() {
        let info = AppInfo { name: "Accent Changer".into(), version: "0.1.0".into(), build: "local".into() };
        assert_eq!(
            serde_json::to_value(info).unwrap(),
            serde_json::json!({ "name": "Accent Changer", "version": "0.1.0", "build": "local" })
        );
    }
}
