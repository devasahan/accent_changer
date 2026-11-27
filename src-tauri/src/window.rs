//! The only code that hides or shows the main window.
//!
//! Why only here: tao (Tauri's window library) keeps its own "visible" flag
//! and sends Windows a hide only when that flag changes. The quiet re-show
//! below goes around tao (it must not take the keyboard from the meeting), so
//! tao's flag still says "hidden" afterwards. A plain `window.hide()` would
//! then do nothing at all. So:
//! - `hide_window` asks tao to hide and then hides the window itself as well,
//!   which works whatever tao's flag says;
//! - `show_quietly` shows the window again without activating it (Session B's
//!   "Hide 30 min" only);
//! - `show_for_user` shows, restores and focuses it, because the user asked
//!   (a second launch from the Start menu). It also stops a pending re-show.
//!
//! The stale flag has a second effect. While tao's flag says "hidden" but
//! the window is on screen, any change tao makes to its window flags hides
//! the window again (tao-0.37.3 `window_state.rs` 312-319 and 405-409). So
//! after `show_quietly`, until `show_for_user` or `hide_window` runs again,
//! make no other tao call on the main window: no size, position, maximize,
//! resizable, decorations, always on top or fullscreen. tao does the same by
//! itself when the display scale changes while the window is maximized
//! (`event_loop.rs` 1946-1955). The window and its taskbar button are then
//! gone until the user starts the app again from the Start menu
//! (`show_for_user`). The user's own minimize, maximize and restore are
//! safe: tao only takes note of them.
//!
//! Step 5 (close to tray, the tray menu) must use `hide_window` and
//! `show_for_user`, must keep to the rule above, and must never show the
//! window by itself. The timed re-show of `window_hide_for` is the one
//! exception to the plan's "the app never opens a window by itself", for
//! Session B's check only.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Manager, State, WebviewWindow};

use crate::AppState;

/// The app's one window (built in lib.rs `setup`).
pub const MAIN_WINDOW: &str = "main";

/// Which Hide is the current one. Every Hide arms a new generation; a timer
/// shows the window again only while its own generation is still current,
/// so a newer Hide, or the user bringing the window back, cancels it.
#[derive(Default)]
pub struct HideTimer(AtomicU64);

impl HideTimer {
    /// Start a new generation and return it (older ones stop being current).
    pub fn arm(&self) -> u64 {
        self.0.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// No generation armed so far is current any more.
    pub fn cancel(&self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }

    pub fn is_current(&self, generation: u64) -> bool {
        self.0.load(Ordering::SeqCst) == generation
    }
}

/// Whole minutes from 1 to 120 (Session B asks for 30).
pub fn clamp_minutes(minutes: u32) -> Result<u32, String> {
    if (1..=120).contains(&minutes) {
        Ok(minutes)
    } else {
        Err("Hide for 1 to 120 minutes.".to_string())
    }
}

/// What the page gets back from `window_hide_for`: times in ms since 1970.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HideInfo {
    pub hidden_at_ms: u64,
    pub show_at_ms: u64,
    pub minutes: u32,
}

/// The window as Windows sees it now.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowState {
    pub visible: bool,
    pub minimized: bool,
    pub focused: bool,
}

fn epoch_ms(at: SystemTime) -> u64 {
    at.duration_since(UNIX_EPOCH).map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

fn main_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    app.get_webview_window(MAIN_WINDOW).ok_or_else(|| "The app's window is not open.".to_string())
}

/// Hide the main window and its taskbar button, on the main thread. tao hides
/// it only when its own flag changes, which after `show_quietly` it does not,
/// so the window is hidden here a second time, directly.
pub fn hide_window(app: &AppHandle) -> Result<(), String> {
    let window = main_window(app)?;
    app.run_on_main_thread(move || {
        if let Err(e) = window.hide() {
            log::warn!("window hide failed: {e}");
        }
        #[cfg(windows)]
        match window.hwnd() {
            // ShowWindow returns whether the window was visible before; that is no error.
            Ok(hwnd) => unsafe {
                let _ = windows::Win32::UI::WindowsAndMessaging::ShowWindow(
                    hwnd,
                    windows::Win32::UI::WindowsAndMessaging::SW_HIDE,
                );
            },
            Err(e) => log::warn!("window hide: no window handle ({e})"),
        }
    })
    .map_err(|e| format!("Could not hide the window ({e})."))
}

/// Show the window again where it was, restored if it was minimized, without
/// activating it: the meeting keeps the keyboard. Call on the main thread.
/// tao's flag stays "hidden" (on purpose: see the top of this file). Until
/// `show_for_user` or `hide_window` runs again, make no other tao call on the
/// main window (size, position, maximize, resizable, decorations, always on
/// top, fullscreen): tao would hide it again, and so does a display-scale
/// change of a maximized window. The user brings it back from the Start menu.
pub fn show_quietly(window: &WebviewWindow) {
    #[cfg(windows)]
    match window.hwnd() {
        Ok(hwnd) => unsafe {
            let _ = windows::Win32::UI::WindowsAndMessaging::ShowWindow(
                hwnd,
                windows::Win32::UI::WindowsAndMessaging::SW_SHOWNOACTIVATE,
            );
        },
        Err(e) => log::warn!("window show: no window handle ({e})"),
    }
    #[cfg(not(windows))]
    if let Err(e) = window.show() {
        log::warn!("window show failed: {e}");
    }
}

/// Bring the window back because the user asked for it (a second launch):
/// no timed re-show any more, then show, restore and focus. tao's flag is
/// "hidden" after any hide, so `show()` really shows and activates; the focus
/// comes last because tao checks that flag first.
pub fn show_for_user(app: &AppHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        state.hide.cancel();
    }
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };
    if let Err(e) = window.show() {
        log::warn!("window show failed: {e}");
    }
    if let Err(e) = window.unminimize() {
        log::warn!("window restore failed: {e}");
    }
    if let Err(e) = window.set_focus() {
        log::warn!("window focus failed: {e}");
    }
}

/// Session B's "Hide 30 min": hide the window now and show it again quietly
/// after `minutes`, unless a newer Hide or the user brought it back first.
/// The timer runs in Rust, so a throttled hidden page cannot delay it.
#[tauri::command]
pub async fn window_hide_for(app: AppHandle, state: State<'_, AppState>, minutes: u32) -> Result<HideInfo, String> {
    let minutes = clamp_minutes(minutes)?;
    let generation = state.hide.arm();
    hide_window(&app)?;
    let hidden_at_ms = epoch_ms(SystemTime::now());
    log::info!("window hidden for {minutes} min");
    let timer = Arc::clone(&state.hide);
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(u64::from(minutes) * 60)).await;
        if !timer.is_current(generation) {
            return;
        }
        let Ok(window) = main_window(&app) else {
            return;
        };
        // Checked again on the main thread, where the user's relaunch runs too:
        // no re-show after the user has already brought the window back.
        let shown = app.run_on_main_thread(move || {
            if timer.is_current(generation) {
                show_quietly(&window);
                log::info!("window shown again after {minutes} min");
            }
        });
        if let Err(e) = shown {
            log::warn!("window not shown again ({e})");
        }
    });
    Ok(HideInfo { hidden_at_ms, show_at_ms: hidden_at_ms + u64::from(minutes) * 60_000, minutes })
}

/// Windows' own answer (IsWindowVisible, IsIconic), so it is right whatever
/// tao's flag says.
#[tauri::command]
pub async fn window_state(window: WebviewWindow) -> Result<WindowState, String> {
    Ok(WindowState {
        visible: window.is_visible().map_err(|e| e.to_string())?,
        minimized: window.is_minimized().map_err(|e| e.to_string())?,
        focused: window.is_focused().map_err(|e| e.to_string())?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hide_takes_1_to_120_whole_minutes() {
        assert_eq!(clamp_minutes(0), Err("Hide for 1 to 120 minutes.".to_string()));
        assert_eq!(clamp_minutes(1), Ok(1));
        assert_eq!(clamp_minutes(30), Ok(30));
        assert_eq!(clamp_minutes(120), Ok(120));
        assert_eq!(clamp_minutes(121), Err("Hide for 1 to 120 minutes.".to_string()));
        assert!(clamp_minutes(u32::MAX).is_err());
    }

    #[test]
    fn only_the_newest_hide_may_show_the_window_again() {
        let timer = HideTimer::default();
        let first = timer.arm();
        let second = timer.arm();
        assert!(second > first, "generations increase");
        assert!(!timer.is_current(first), "an older hide is not current after a newer one");
        assert!(timer.is_current(second));
        timer.cancel();
        assert!(!timer.is_current(second), "the user bringing the window back cancels the timer");
        let third = timer.arm();
        assert!(third > second && timer.is_current(third));
    }

    #[test]
    fn a_cancel_stops_every_hide_armed_before_it() {
        let timer = HideTimer::default();
        timer.cancel(); // the user relaunched before any Hide: harmless
        let armed: Vec<u64> = (0..3).map(|_| timer.arm()).collect();
        assert!(timer.is_current(armed[2]));
        timer.cancel();
        assert!(armed.iter().all(|&g| !timer.is_current(g)), "{armed:?}");
        let next = timer.arm();
        assert!(!armed.contains(&next), "a new Hide never reuses an old generation");
        assert!(timer.is_current(next));
    }

    #[test]
    fn the_page_gets_camel_case_fields() {
        let info = HideInfo { hidden_at_ms: 1_700_000_000_000, show_at_ms: 1_700_001_800_000, minutes: 30 };
        assert_eq!(
            serde_json::to_value(info).unwrap(),
            serde_json::json!({ "hiddenAtMs": 1_700_000_000_000u64, "showAtMs": 1_700_001_800_000u64, "minutes": 30 })
        );
        let state = WindowState { visible: true, minimized: false, focused: false };
        assert_eq!(
            serde_json::to_value(state).unwrap(),
            serde_json::json!({ "visible": true, "minimized": false, "focused": false })
        );
    }

    #[test]
    fn times_are_ms_since_1970() {
        assert_eq!(epoch_ms(UNIX_EPOCH), 0);
        assert_eq!(epoch_ms(UNIX_EPOCH + Duration::from_millis(1_234)), 1_234);
        assert_eq!(epoch_ms(UNIX_EPOCH - Duration::from_secs(1)), 0, "a clock before 1970 is not an error");
        let now = epoch_ms(SystemTime::now());
        assert!(now > 1_700_000_000_000, "now is after November 2023: {now}");
    }
}
