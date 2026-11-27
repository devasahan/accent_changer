//! The settings file: `settings.json` in the app's local data folder
//! (`%LOCALAPPDATA%\` and the identifier from tauri.conf.json), next to the
//! WebView2 profile and the logs. Device ids and names belong to one PC, so the
//! roaming folder (`app_config_dir`) is not used: the settings never follow
//! the user to another PC.
//!
//! The page checks the settings (src/core/settings.js `validateSettings`)
//! after reading and before saving; this side only reads and writes the text.
//! A save writes a new file and then renames it over the old one, so the file
//! is always either the old settings or the new ones, never half of each.
//! Reads and saves take turns (`AppState::settings_lock`). No message or log
//! line holds the file's path (it contains the Windows user name) or its
//! contents.

use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::PoisonError;

use tauri::{AppHandle, Manager, State};

use crate::AppState;

/// A settings file larger than this is not ours.
pub const MAX_BYTES: usize = 64 * 1024;

const FILE_NAME: &str = "settings.json";

/// Numbers this process's temporary files, so no two saves share one.
static TEMP_COUNT: AtomicU64 = AtomicU64::new(0);

pub fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map(|dir| dir.join(FILE_NAME))
        .map_err(|_| "Could not find the app's data folder.".to_string())
}

fn read_error(e: &io::Error) -> String {
    format!("Could not read the settings file ({}).", e.kind())
}

fn save_error(e: &io::Error) -> String {
    format!("Could not save the settings file ({}).", e.kind())
}

/// The file's text, or None when there is no file yet.
pub fn read_settings(path: &Path) -> Result<Option<String>, String> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(read_error(&e)),
    };
    // One byte more than allowed is enough to know the file is too big.
    let mut bytes = Vec::new();
    file.take(MAX_BYTES as u64 + 1).read_to_end(&mut bytes).map_err(|e| read_error(&e))?;
    if bytes.len() > MAX_BYTES {
        return Err("The settings file is too big, so the defaults are used.".to_string());
    }
    String::from_utf8(bytes).map(Some).map_err(|_| read_error(&io::ErrorKind::InvalidData.into()))
}

/// Replace the settings file with `json` (a JSON object). The new text goes
/// to a temporary file in the same folder first and is then renamed over
/// `settings.json`, which replaces it in one step on Windows too.
pub fn write_settings(path: &Path, json: &str) -> Result<(), String> {
    if json.len() > MAX_BYTES {
        return Err("The settings are too big to save.".to_string());
    }
    if !matches!(serde_json::from_str::<serde_json::Value>(json), Ok(serde_json::Value::Object(_))) {
        return Err("not a settings object".to_string());
    }
    let dir = path.parent().filter(|d| !d.as_os_str().is_empty()).unwrap_or(Path::new("."));
    fs::create_dir_all(dir).map_err(|e| save_error(&e))?;
    let name = path.file_name().map_or_else(|| FILE_NAME.into(), |n| n.to_string_lossy());
    let n = TEMP_COUNT.fetch_add(1, Ordering::Relaxed);
    let temp = dir.join(format!("{name}.{}-{n}.tmp", std::process::id()));
    let written = write_file(&temp, json.as_bytes()).and_then(|()| replace(&temp, path));
    if let Err(e) = written {
        let _ = fs::remove_file(&temp);
        return Err(save_error(&e));
    }
    log::info!("settings saved ({} bytes)", json.len());
    Ok(())
}

/// Write and flush to the disk, so the rename never puts an empty file in place.
fn write_file(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut file = File::create(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

/// On Windows a virus scanner or the search indexer can hold settings.json
/// open for a moment, and a rename over it then fails. Such a failure is
/// tried again a few times (at most 0.25 s in all) before it is reported.
fn replace(temp: &Path, path: &Path) -> io::Result<()> {
    let mut waits = [25, 50, 75, 100].into_iter();
    loop {
        match fs::rename(temp, path) {
            Err(e) if is_busy(&e) => match waits.next() {
                Some(ms) => std::thread::sleep(std::time::Duration::from_millis(ms)),
                None => return Err(e),
            },
            done => return done,
        }
    }
}

/// A rename that may work a moment later: on Windows, access denied, or the
/// file in use by another program (sharing or lock violation).
fn is_busy(e: &io::Error) -> bool {
    cfg!(windows)
        && (matches!(e.kind(), io::ErrorKind::PermissionDenied | io::ErrorKind::ResourceBusy)
            || matches!(e.raw_os_error(), Some(32 | 33)))
}

/// The settings file's text (None: no file yet). The page parses and checks it.
#[tauri::command]
pub async fn settings_load(app: AppHandle, state: State<'_, AppState>) -> Result<Option<String>, String> {
    let path = settings_path(&app)?;
    let read = {
        let _turn = state.settings_lock.lock().unwrap_or_else(PoisonError::into_inner);
        read_settings(&path)
    };
    match &read {
        Ok(Some(text)) => log::info!("settings read ({} bytes)", text.len()),
        Ok(None) => log::info!("no settings file yet"),
        Err(e) => log::warn!("settings not read: {e}"),
    }
    read
}

/// Save the settings (JSON text of an object, checked by the page first).
#[tauri::command]
pub async fn settings_save(app: AppHandle, state: State<'_, AppState>, json: String) -> Result<(), String> {
    let path = settings_path(&app)?;
    let saved = {
        let _turn = state.settings_lock.lock().unwrap_or_else(PoisonError::into_inner);
        write_settings(&path, &json)
    };
    if let Err(e) = &saved {
        log::warn!("settings not saved: {e}");
    }
    saved
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    /// A new, empty folder under the system's temporary folder; removed on drop.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(name: &str) -> Self {
            static N: AtomicU64 = AtomicU64::new(0);
            let dir = std::env::temp_dir().join(format!(
                "accent-changer-test-{name}-{}-{}",
                std::process::id(),
                N.fetch_add(1, Ordering::Relaxed)
            ));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }

        fn file(&self) -> PathBuf {
            self.0.join(FILE_NAME)
        }

        /// Every leftover temporary file.
        fn temps(&self) -> Vec<String> {
            fs::read_dir(&self.0)
                .unwrap()
                .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
                .filter(|n| n.ends_with(".tmp"))
                .collect()
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn no_file_yet_reads_as_none() {
        let dir = TempDir::new("missing");
        assert_eq!(read_settings(&dir.file()), Ok(None));
    }

    #[test]
    fn what_is_written_is_read_back() {
        let dir = TempDir::new("round-trip");
        let json = r#"{"version":1,"micLabel":"Headset Microphone (USB Audio Device)"}"#;
        write_settings(&dir.file(), json).unwrap();
        assert_eq!(read_settings(&dir.file()), Ok(Some(json.to_string())));
        let newer = r#"{"version":1,"micLabel":""}"#;
        write_settings(&dir.file(), newer).unwrap();
        assert_eq!(read_settings(&dir.file()), Ok(Some(newer.to_string())), "a save replaces the file");
        assert!(dir.temps().is_empty(), "no temporary file is left behind: {:?}", dir.temps());
    }

    #[test]
    fn the_folder_is_made_when_it_is_missing() {
        let dir = TempDir::new("new-folder");
        let path = dir.0.join("app-data").join(FILE_NAME);
        write_settings(&path, "{}").unwrap();
        assert_eq!(read_settings(&path), Ok(Some("{}".to_string())));
    }

    #[test]
    fn only_a_json_object_is_saved() {
        let dir = TempDir::new("not-object");
        for bad in ["[1,2]", r#""x""#, "1", "null", "", "{", "{\"a\":1} x"] {
            assert_eq!(write_settings(&dir.file(), bad), Err("not a settings object".to_string()), "{bad:?}");
        }
        assert_eq!(read_settings(&dir.file()), Ok(None), "nothing was written");
        assert!(dir.temps().is_empty());
    }

    #[test]
    fn a_file_over_64_kib_is_refused_on_save_and_on_read() {
        let dir = TempDir::new("too-big");
        let padding = "a".repeat(MAX_BYTES);
        let big = format!(r#"{{"obsPath":"{padding}"}}"#);
        assert!(big.len() > MAX_BYTES);
        let err = write_settings(&dir.file(), &big).unwrap_err();
        assert!(err.contains("too big"), "{err}");
        assert_eq!(read_settings(&dir.file()), Ok(None), "nothing was written");

        fs::write(dir.file(), &big).unwrap();
        assert_eq!(
            read_settings(&dir.file()),
            Err("The settings file is too big, so the defaults are used.".to_string())
        );

        // Exactly 64 KiB is still fine.
        let fits = format!(r#"{{"obsPath":"{}"}}"#, "a".repeat(MAX_BYTES - 14));
        assert_eq!(fits.len(), MAX_BYTES);
        write_settings(&dir.file(), &fits).unwrap();
        assert_eq!(read_settings(&dir.file()), Ok(Some(fits)));
        assert!(dir.temps().is_empty());
    }

    #[test]
    fn errors_name_no_path() {
        let dir = TempDir::new("errors");
        // A folder where the file should be: reading or replacing it fails.
        fs::create_dir_all(dir.file()).unwrap();
        let read = read_settings(&dir.file()).unwrap_err();
        assert!(read.starts_with("Could not read the settings file ("), "{read}");
        let saved = write_settings(&dir.file(), "{}").unwrap_err();
        assert!(saved.starts_with("Could not save the settings file ("), "{saved}");
        for text in [&read, &saved] {
            assert!(!text.contains(&*dir.0.to_string_lossy()), "{text}");
            assert!(!text.contains(FILE_NAME), "{text}");
            assert!(!text.contains("accent-changer-test"), "{text}");
        }
        assert!(dir.temps().is_empty(), "the temporary file is removed when the rename fails: {:?}", dir.temps());
    }

    #[test]
    fn text_that_is_not_utf8_is_an_error() {
        let dir = TempDir::new("not-utf8");
        fs::write(dir.file(), [b'{', 0xff, 0xfe, b'}']).unwrap();
        assert_eq!(read_settings(&dir.file()), Err("Could not read the settings file (invalid data).".to_string()));
    }

    #[test]
    fn two_writers_taking_turns_leave_one_whole_file() {
        let dir = TempDir::new("two-writers");
        let path = Arc::new(dir.file());
        let lock = Arc::new(Mutex::new(()));
        let a = r#"{"micLabel":"first writer","micDeviceId":"aaaaaaaa"}"#;
        let b = r#"{"micLabel":"second writer, a longer text","micDeviceId":"bbbbbbbbbbbbbbbb"}"#;
        let writers: Vec<_> = [a, b]
            .into_iter()
            .map(|json| {
                let (path, lock) = (Arc::clone(&path), Arc::clone(&lock));
                std::thread::spawn(move || {
                    for _ in 0..200 {
                        let _turn = lock.lock().unwrap();
                        write_settings(&path, json).unwrap();
                    }
                })
            })
            .collect();
        // A reader taking the same turns never sees half a file.
        let reader = {
            let (path, lock) = (Arc::clone(&path), Arc::clone(&lock));
            std::thread::spawn(move || {
                for _ in 0..200 {
                    let _turn = lock.lock().unwrap();
                    if let Some(text) = read_settings(&path).unwrap() {
                        assert!(text == a || text == b, "{text}");
                    }
                }
            })
        };
        for w in writers {
            w.join().unwrap();
        }
        reader.join().unwrap();
        let text = read_settings(&path).unwrap().unwrap();
        assert!(text == a || text == b, "{text}");
        assert!(serde_json::from_str::<serde_json::Value>(&text).unwrap().is_object());
        assert!(dir.temps().is_empty(), "{:?}", dir.temps());
    }

    #[test]
    fn only_a_windows_file_in_use_is_tried_again() {
        let denied = io::Error::from(io::ErrorKind::PermissionDenied);
        assert_eq!(is_busy(&denied), cfg!(windows));
        assert!(!is_busy(&io::Error::from(io::ErrorKind::NotFound)));
        assert!(!is_busy(&io::Error::from(io::ErrorKind::InvalidData)));
        if cfg!(windows) {
            assert!(is_busy(&io::Error::from_raw_os_error(32)), "sharing violation");
            assert!(is_busy(&io::Error::from_raw_os_error(33)), "lock violation");
        }
    }

    #[test]
    fn temporary_names_never_repeat() {
        let dir = TempDir::new("names");
        let before = TEMP_COUNT.load(Ordering::Relaxed);
        write_settings(&dir.file(), "{}").unwrap();
        write_settings(&dir.file(), "{}").unwrap();
        assert!(TEMP_COUNT.load(Ordering::Relaxed) >= before + 2);
    }
}
