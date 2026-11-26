//! Accent Changer's desktop shell (Tauri 2).
//!
//! The audio pipeline runs as plain JavaScript in the window (WebView2). This
//! side keeps the Sanas API key in Windows Credential Manager, swaps it for
//! short-lived tokens, gives the microphone to the app's own page only, and
//! keeps the window on that page (links open in the normal browser).

mod keystore;
mod sanas;

use std::sync::Arc;

use serde::Serialize;
use tauri::webview::{PermissionKind, PermissionResponse};
use tauri::{AppHandle, Manager, State, Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

use keystore::{clean_key, tail, KeyStore, OsKeyStore};
use sanas::{KeyCheck, TokenBroker};

pub struct AppState {
    keys: Arc<dyn KeyStore>,
    broker: TokenBroker,
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

/// Microphone (and audio autoplay) for the app's own page; nothing for anyone else.
fn permission_for(url: Option<Url>, kind: PermissionKind) -> PermissionResponse {
    let own = url.as_ref().is_some_and(is_app_url);
    match kind {
        PermissionKind::Microphone | PermissionKind::Autoplay if own => PermissionResponse::Allow,
        _ => PermissionResponse::Deny,
    }
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
}

#[tauri::command]
fn app_info(app: AppHandle) -> AppInfo {
    let info = app.package_info();
    AppInfo { name: info.name.clone(), version: info.version.to_string() }
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
        KeyCheck::Refused(status) => Err(format!(
            "Sanas refused this key (HTTP {status}). Copy it again from the Sanas Console; if it is still refused, check whether it expired or was revoked."
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

pub fn run() {
    tauri::Builder::default()
        // First, so a second launch only brings the running app forward.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_log::Builder::new().level(log::LevelFilter::Info).build())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState { keys: Arc::new(OsKeyStore), broker: TokenBroker::new(sanas::IDENTITY_URL) })
        .on_permission_request(|webview, kind| permission_for(webview.url().ok(), kind))
        .invoke_handler(tauri::generate_handler![app_info, key_status, key_set, key_delete, sanas_token])
        .setup(|app| {
            let handle = app.handle().clone();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
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
}
