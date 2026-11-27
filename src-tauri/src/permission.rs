//! The microphone permission, set directly in WebView2's saved permissions.
//!
//! WebView2 has no permission of its own for choosing a playback device:
//! Chromium's check for `setSinkId` rides on the microphone permission. The
//! app already allows the microphone when WebView2 asks (lib.rs
//! `permission_for`), and WebView2 saves that answer. If `setSinkId` is
//! refused anyway, the page asks for this once
//! (`ICoreWebView2Profile4::SetPermissionState`) and then tries again.

use tauri::{Url, WebviewWindow};

use crate::is_app_url;

/// The origin to grant, "scheme://host[:port]", for the app's own pages only:
/// `http://tauri.localhost`, `https://tauri.localhost`, `tauri://localhost`,
/// and in debug builds the dev server (`http://localhost:8080`).
pub fn permission_origin(url: &Url) -> Option<String> {
    if !is_app_url(url) {
        return None;
    }
    let host = url.host_str()?;
    Some(match url.port() {
        Some(port) => format!("{}://{host}:{port}", url.scheme()),
        None => format!("{}://{host}", url.scheme()),
    })
}

/// Allow the microphone for the app's own origin in the WebView2 profile.
/// Ok(note) or Err(why): an old WebView2 without this call, a refusal, no
/// answer within 5 s, or not on Windows.
#[tauri::command]
pub async fn mic_permission_allow(window: WebviewWindow) -> Result<String, String> {
    let url = window.url().map_err(|e| format!("not the app's own page ({e})"))?;
    let origin = permission_origin(&url).ok_or_else(|| "not the app's own page".to_string())?;
    let outcome = allow_microphone(&window, &origin).await;
    match &outcome {
        Ok(_) => log::info!("microphone permission for {origin}: allowed in the WebView2 profile"),
        Err(e) => log::warn!("microphone permission for {origin}: {e}"),
    }
    outcome
}

#[cfg(windows)]
mod webview2 {
    use std::sync::{Arc, Mutex, PoisonError};

    use tokio::sync::oneshot;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Controller, ICoreWebView2Profile4, ICoreWebView2_13, COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
        COREWEBVIEW2_PERMISSION_STATE_ALLOW,
    };
    use webview2_com::SetPermissionStateCompletedHandler;
    use windows_core::{Interface, HSTRING};

    /// Where the answer goes: whoever answers first (the completion handler,
    /// or the call failing before it is set up) takes the sender.
    pub type Answer = Arc<Mutex<Option<oneshot::Sender<Result<(), String>>>>>;

    pub fn answer(to: &Answer, result: Result<(), String>) {
        if let Some(tx) = to.lock().unwrap_or_else(PoisonError::into_inner).take() {
            let _ = tx.send(result);
        }
    }

    pub fn error_text(e: &windows_core::Error) -> String {
        let message = e.message();
        let message = message.trim();
        // The HRESULT as Windows prints it, e.g. 0x80004002 (no such interface: an old WebView2).
        // Hex formatting of an i32 prints its bits, so a negative HRESULT needs no cast.
        let code = e.code().0;
        if message.is_empty() {
            format!("SetPermissionState failed (0x{code:08X})")
        } else {
            format!("SetPermissionState failed: {message} (0x{code:08X})")
        }
    }

    /// Runs on the main thread, where WebView2 lives. The completion handler
    /// runs later on the same thread.
    pub fn request(controller: &ICoreWebView2Controller, origin: &str, done: &Answer) -> windows_core::Result<()> {
        // SAFETY: COM calls on WebView2's own objects, on WebView2's thread
        // (with_webview runs this on the main thread).
        unsafe {
            let profile = controller
                .CoreWebView2()?
                .cast::<ICoreWebView2_13>()?
                .Profile()?
                .cast::<ICoreWebView2Profile4>()?;
            let to = Arc::clone(done);
            let handler = SetPermissionStateCompletedHandler::create(Box::new(move |result| {
                answer(&to, result.map_err(|e| error_text(&e)));
                Ok(())
            }));
            profile.SetPermissionState(
                COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
                &HSTRING::from(origin),
                COREWEBVIEW2_PERMISSION_STATE_ALLOW,
                &handler,
            )
        }
    }
}

#[cfg(windows)]
async fn allow_microphone(window: &WebviewWindow, origin: &str) -> Result<String, String> {
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    let (tx, rx) = tokio::sync::oneshot::channel();
    let done: webview2::Answer = Arc::new(Mutex::new(Some(tx)));
    let on_main = Arc::clone(&done);
    let target = origin.to_string();
    window
        .with_webview(move |webview| {
            if let Err(e) = webview2::request(&webview.controller(), &target, &on_main) {
                webview2::answer(&on_main, Err(webview2::error_text(&e)));
            }
        })
        .map_err(|e| format!("SetPermissionState failed: {e}"))?;
    drop(done);
    match tokio::time::timeout(Duration::from_secs(5), rx).await {
        Ok(Ok(Ok(()))) => Ok(format!("microphone allowed for {origin} in the WebView2 profile")),
        Ok(Ok(Err(e))) => Err(e),
        // Every sender is gone without an answer: WebView2 dropped the request.
        Ok(Err(_)) => Err("SetPermissionState did not answer".to_string()),
        Err(_) => Err("SetPermissionState did not answer within 5 seconds".to_string()),
    }
}

#[cfg(not(windows))]
async fn allow_microphone(_window: &WebviewWindow, _origin: &str) -> Result<String, String> {
    Err("only on Windows".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn origin(s: &str) -> Option<String> {
        permission_origin(&Url::parse(s).unwrap())
    }

    #[test]
    fn the_permission_goes_to_the_app_s_own_origin_only() {
        assert_eq!(origin("http://tauri.localhost/index.html").as_deref(), Some("http://tauri.localhost"));
        assert_eq!(origin("https://tauri.localhost/").as_deref(), Some("https://tauri.localhost"));
        assert_eq!(origin("tauri://localhost/x").as_deref(), Some("tauri://localhost"));
        assert_eq!(origin("https://evil.example/"), None);
        assert_eq!(origin("http://tauri.localhost.evil.example/"), None);
        assert_eq!(origin("https://portal-api.sanas.ai/"), None);
        assert_eq!(origin("about:blank"), None);
        let dev = origin("http://localhost:8080/src/");
        if cfg!(debug_assertions) {
            assert_eq!(dev.as_deref(), Some("http://localhost:8080"), "the dev server, in debug builds");
        } else {
            assert_eq!(dev, None, "never the dev server in a release build");
        }
    }

    #[test]
    fn the_origin_has_no_path_query_or_default_port() {
        assert_eq!(origin("http://tauri.localhost:80/index.html?x=1#y").as_deref(), Some("http://tauri.localhost"));
        assert_eq!(origin("https://tauri.localhost/a/b").as_deref(), Some("https://tauri.localhost"));
        if cfg!(debug_assertions) {
            assert_eq!(origin("http://127.0.0.1:8080/src/index.html").as_deref(), Some("http://127.0.0.1:8080"));
        }
    }
}
