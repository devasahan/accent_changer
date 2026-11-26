//! Where the Sanas API key lives: Windows Credential Manager (a generic
//! credential "Accent Changer" / "sanas-api-key"), never a file, the
//! settings, the log or the page. Tests use the in-memory store.

#[cfg(test)]
use std::sync::Mutex;

pub const SERVICE: &str = "Accent Changer";
pub const USER: &str = "sanas-api-key";

pub trait KeyStore: Send + Sync {
    /// The saved key, or None when there is none.
    fn get(&self) -> Result<Option<String>, String>;
    fn set(&self, key: &str) -> Result<(), String>;
    /// Remove the key; removing a key that isn't there is fine.
    fn delete(&self) -> Result<(), String>;
}

/// The operating system's credential store (Windows Credential Manager).
pub struct OsKeyStore;

impl OsKeyStore {
    fn entry() -> Result<keyring::Entry, String> {
        keyring::Entry::new(SERVICE, USER).map_err(|e| format!("Windows Credential Manager is not available: {e}"))
    }
}

impl KeyStore for OsKeyStore {
    fn get(&self) -> Result<Option<String>, String> {
        match Self::entry()?.get_password() {
            Ok(key) => Ok(Some(key)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("Could not read the key from Windows Credential Manager: {e}")),
        }
    }

    fn set(&self, key: &str) -> Result<(), String> {
        Self::entry()?
            .set_password(key)
            .map_err(|e| format!("Could not save the key in Windows Credential Manager: {e}"))
    }

    fn delete(&self) -> Result<(), String> {
        match Self::entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("Could not remove the key from Windows Credential Manager: {e}")),
        }
    }
}

/// A key store that forgets everything when the app closes (tests).
#[cfg(test)]
#[derive(Default)]
pub struct MemoryKeyStore(Mutex<Option<String>>);

#[cfg(test)]
impl KeyStore for MemoryKeyStore {
    fn get(&self) -> Result<Option<String>, String> {
        Ok(self.0.lock().map_err(|_| "key store poisoned")?.clone())
    }

    fn set(&self, key: &str) -> Result<(), String> {
        *self.0.lock().map_err(|_| "key store poisoned")? = Some(key.to_string());
        Ok(())
    }

    fn delete(&self) -> Result<(), String> {
        *self.0.lock().map_err(|_| "key store poisoned")? = None;
        Ok(())
    }
}

/// The last 4 characters, to tell keys apart without showing them.
pub fn tail(key: &str) -> String {
    let chars: Vec<char> = key.chars().collect();
    let start = chars.len().saturating_sub(4);
    format!("…{}", chars[start..].iter().collect::<String>())
}

/// A pasted key, trimmed; an error a person can act on when it can't be a key.
/// The Sanas Console shows a key only once, so the advice is to paste it again
/// from where the person saved it, never to copy it from the Console.
pub fn clean_key(raw: &str) -> Result<String, String> {
    let key = raw.trim();
    if key.is_empty() {
        return Err("Paste the key first, from where you saved it (for example your password manager).".into());
    }
    if key.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(
            "That key contains spaces or invisible characters: paste it again from where you saved it (for example your password manager)."
                .into(),
        );
    }
    if key.chars().count() < 16 {
        return Err(
            "That is too short for a Sanas API key: paste the whole key again from where you saved it (for example your password manager)."
                .into(),
        );
    }
    Ok(key.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_store_round_trip() {
        let store = MemoryKeyStore::default();
        assert_eq!(store.get().unwrap(), None);
        store.set("sk_test_1234567890abcdef").unwrap();
        assert_eq!(store.get().unwrap().as_deref(), Some("sk_test_1234567890abcdef"));
        store.delete().unwrap();
        store.delete().unwrap();
        assert_eq!(store.get().unwrap(), None);
    }

    #[test]
    fn tail_shows_only_four_characters() {
        assert_eq!(tail("sk_test_1234567890abcdef"), "…cdef");
        assert_eq!(tail("ab"), "…ab");
    }

    #[test]
    fn clean_key_trims_and_refuses_nonsense() {
        assert_eq!(clean_key("  sk_test_1234567890abcdef \n").unwrap(), "sk_test_1234567890abcdef");
        assert!(clean_key("").is_err());
        assert!(clean_key("sk_test 1234567890abcdef").is_err());
        assert!(clean_key("sk_\u{16}1234567890abcdef").is_err());
        assert!(clean_key("short").is_err());
    }

    #[test]
    fn clean_key_errors_send_the_person_to_their_saved_copy() {
        for raw in ["", "sk_test 1234567890abcdef", "short"] {
            let err = clean_key(raw).unwrap_err();
            assert!(err.contains("from where you saved it"), "{err}");
            assert!(!err.contains("Console"), "the Console shows a key only once: {err}");
        }
    }
}
