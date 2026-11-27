//! Lines from the page for the app's log file (`[page]` in "Accent
//! Changer.log", in the `logs` folder of the app's local data folder).
//!
//! The page sends state names, warning codes and numbers only, and redacts
//! them first (src/core/redact.js). This side cleans every line again, in
//! case a page bug sends something it should not: no line breaks (a line
//! cannot pretend to be another log line), no long key-like runs, no API
//! keys, no bearer tokens, and at most 500 characters.

/// What a hidden part of a line becomes (the same as the page's redact()).
const REDACTED: &str = "[redacted]";

/// The longest line kept, in characters.
const MAX_CHARS: usize = 500;

/// Characters a key or an id is made of; anything else separates tokens.
fn is_token_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '-'
}

/// Characters of a bearer token (RFC 6750: letters, digits and - . _ ~ + /, then = padding).
fn is_bearer_char(c: char) -> bool {
    is_token_char(c) || matches!(c, '.' | '~' | '+' | '/' | '=')
}

/// Control characters, line and paragraph separators, and the bidirectional
/// controls that could make a log line read differently from what it holds.
fn is_control(c: char) -> bool {
    c.is_control() || matches!(c, '\u{2028}' | '\u{2029}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}')
}

/// A token that is a secret whatever it says: 32 or more key characters, or
/// an sk_/pk_ API key of 10 or more. `start` holds the token's first
/// characters, `len` its whole length.
fn is_secret_token(start: &str, len: usize) -> bool {
    len >= 32 || (len >= 10 && ["sk_", "pk_", "sk-", "pk-"].iter().any(|p| start.starts_with(p)))
}

/// One clean log line: control characters become spaces; tokens (runs of
/// A-Z a-z 0-9 _ -) of 32 or more characters, sk_/pk_ keys of 10 or more and
/// the token after "Bearer " become "[redacted]"; then at most 500
/// characters, followed by "…" when it was longer. Secrets are hidden before
/// the cut, so a key that crosses it is hidden whole. The text is read only
/// as far as the cut, however long it is.
pub fn clean_line(text: &str) -> String {
    let mut chars = text.chars().map(|c| if is_control(c) { ' ' } else { c }).peekable();
    let mut out = String::new();
    let mut n = 0; // characters in `out`
    while n <= MAX_CHARS {
        let Some(&c) = chars.peek() else { break };
        if !is_token_char(c) {
            out.push(c);
            n += 1;
            chars.next();
            continue;
        }
        // A token: keep its first characters, count all of them.
        let mut start = String::new();
        let mut len = 0;
        while let Some(c) = chars.next_if(|&c| is_token_char(c)) {
            if len < 32 {
                start.push(c);
            }
            len += 1;
        }
        if is_secret_token(&start, len) {
            out.push_str(REDACTED);
            n += REDACTED.len();
        } else {
            out.push_str(&start);
            n += len;
        }
        if len == 6 && start.eq_ignore_ascii_case("bearer") {
            // The credentials after "Bearer" and its spaces, dots and slashes included.
            let mut spaced = false;
            while n <= MAX_CHARS {
                let Some(c) = chars.next_if(|c| c.is_whitespace()) else { break };
                out.push(c);
                n += 1;
                spaced = true;
            }
            if spaced && chars.next_if(|&c| is_bearer_char(c)).is_some() {
                while chars.next_if(|&c| is_bearer_char(c)).is_some() {}
                out.push_str(REDACTED);
                n += REDACTED.len();
            }
        }
    }
    if n > MAX_CHARS {
        let mut short: String = out.chars().take(MAX_CHARS).collect();
        short.push('…');
        return short;
    }
    out
}

/// The page's level names: "warn" and "error"; anything else is info.
pub fn level_of(s: &str) -> log::Level {
    match s {
        "warn" => log::Level::Warn,
        "error" => log::Level::Error,
        _ => log::Level::Info,
    }
}

/// One line from the page, cleaned, under the target "page".
#[tauri::command]
pub fn log_line(level: String, text: String) {
    log::log!(target: "page", level_of(&level), "{}", clean_line(&text));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_normal_line_is_unchanged() {
        for line in [
            "state running",
            "warn STAND_IN",
            "recovery back cause=render-error outageMs=1400 attempts=3 steps=resume,rebuild",
            "long check done: passed (gaps 0, clicks 1)",
            "csp connect-src",
            "",
        ] {
            assert_eq!(clean_line(line), line);
        }
    }

    #[test]
    fn long_key_like_runs_are_hidden() {
        let key = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0"; // 40 characters
        assert_eq!(clean_line(&format!("key {key} saved")), "key [redacted] saved");
        let id = "a".repeat(64); // a device id is 64 hex digits
        assert_eq!(clean_line(&format!("sink {id}")), "sink [redacted]");
        let short = "a".repeat(31);
        assert_eq!(clean_line(&short), short, "31 characters is a word, not a key");
        assert_eq!(clean_line(&"b".repeat(32)), "[redacted]");
    }

    #[test]
    fn api_keys_are_hidden() {
        assert_eq!(clean_line("using sk_live_abc123 now"), "using [redacted] now");
        assert_eq!(clean_line("pk_test_9876"), "[redacted]");
        assert_eq!(clean_line("sk-proj-12345"), "[redacted]");
        assert_eq!(clean_line("sk_short"), "sk_short", "fewer than 10 characters");
        assert_eq!(clean_line("task_list"), "task_list", "sk_ inside a word is not a key");
    }

    #[test]
    fn bearer_tokens_are_hidden() {
        assert_eq!(clean_line("Authorization: Bearer abc.def"), "Authorization: Bearer [redacted]");
        assert_eq!(clean_line("Bearer abc.def ghi"), "Bearer [redacted] ghi");
        assert_eq!(clean_line("bearer  a/b+c=="), "bearer  [redacted]");
        assert_eq!(clean_line("Bearer"), "Bearer", "nothing after it");
        assert_eq!(clean_line("Bearer, then"), "Bearer, then", "no space after it");
    }

    #[test]
    fn control_characters_become_spaces() {
        assert_eq!(clean_line("one\ntwo"), "one two");
        assert_eq!(clean_line("a\r\nb\tc\u{1b}[31md"), "a  b c [31md");
        assert_eq!(clean_line("x\u{2028}y\u{202E}z"), "x y z");
        assert_eq!(clean_line("Bearer\nabc.def"), "Bearer [redacted]", "a line break does not save the token");
    }

    #[test]
    fn lines_stop_at_500_characters() {
        let long = "ab ".repeat(200); // 600 characters
        let cleaned = clean_line(&long);
        assert_eq!(cleaned.chars().count(), 501);
        assert!(cleaned.ends_with('…'));
        assert!(long.starts_with(cleaned.trim_end_matches('…')));
        // Characters, not bytes: 600 "é" (1200 bytes) also keep 500.
        let accents = "é ".repeat(300);
        assert_eq!(clean_line(&accents).chars().count(), 501);
        let exact = "ab ".repeat(166) + "ab"; // 500 characters
        assert_eq!(clean_line(&exact), exact);
    }

    #[test]
    fn a_key_at_the_cut_is_hidden_before_the_cut() {
        let line = format!("{}{}", "ab ".repeat(160), "Z".repeat(40)); // the key crosses character 500
        let cleaned = clean_line(&line);
        assert!(cleaned.ends_with("[redacted]"), "{cleaned}");
        assert!(!cleaned.contains("ZZ"), "{cleaned}");
    }

    #[test]
    fn levels() {
        assert_eq!(level_of("warn"), log::Level::Warn);
        assert_eq!(level_of("error"), log::Level::Error);
        assert_eq!(level_of("info"), log::Level::Info);
        assert_eq!(level_of(""), log::Level::Info);
        assert_eq!(level_of("debug"), log::Level::Info);
    }
}
