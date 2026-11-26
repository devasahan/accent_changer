//! Swapping the Sanas API key for short-lived access tokens.
//!
//! The page's Sanas SDK asks for a token when it connects and again only
//! after Sanas rejects the old one (401/403). If that request fails, the SDK
//! tears down every call, so network hiccups, 5xx and 429 answers are
//! retried (at most 3 times, within 20 s: the SDK waits 30 s). Requests that
//! arrive while one is running share its answer. Neither the key nor the
//! token is ever logged or put into an error message.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use tokio::sync::Mutex;

pub const IDENTITY_URL: &str = "https://identity.sanas.ai/oauth2/api-key/login";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(6);
const RETRY_BUDGET: Duration = Duration::from_secs(20);
const MAX_ATTEMPTS: u32 = 4;

/// What Sanas said about a key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyCheck {
    Accepted,
    /// HTTP 400/401/403: wrong, expired or revoked.
    Refused(u16),
    /// Could not tell right now (offline, Sanas down, odd answer).
    Unknown(String),
}

enum Attempt {
    /// Worth another try: network error, 5xx, 429.
    Retry(String),
    /// Trying again won't help.
    Final(String),
}

pub struct TokenBroker {
    client: reqwest::Client,
    identity_url: String,
    /// Bumped (under `gate`) every time a token request finishes.
    finished: AtomicU64,
    gate: Mutex<Option<Result<String, String>>>,
    first_retry: Duration,
}

impl TokenBroker {
    pub fn new(identity_url: impl Into<String>) -> Self {
        let client = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .user_agent(concat!("AccentChanger/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("HTTP client");
        Self {
            client,
            identity_url: identity_url.into(),
            finished: AtomicU64::new(0),
            gate: Mutex::new(None),
            first_retry: Duration::from_millis(500),
        }
    }

    #[cfg(test)]
    fn with_first_retry(mut self, delay: Duration) -> Self {
        self.first_retry = delay;
        self
    }

    /// One request, no retries: is this key good? (Used when the key is pasted.)
    pub async fn check_key(&self, key: &str) -> KeyCheck {
        let res = match self.post(key).await {
            Ok(res) => res,
            Err(e) => return KeyCheck::Unknown(network_message(&e)),
        };
        let status = res.status().as_u16();
        if res.status().is_success() {
            return match res.text().await.ok().filter(|body| is_token_body(body)) {
                Some(_) => KeyCheck::Accepted,
                None => KeyCheck::Unknown("Sanas sent an unexpected answer".into()),
            };
        }
        if matches!(status, 400 | 401 | 403) {
            return KeyCheck::Refused(status);
        }
        KeyCheck::Unknown(format!("Sanas answered HTTP {status}"))
    }

    /// A fresh token response, passed through unchanged (JSON text) for the SDK.
    pub async fn token(&self, key: &str) -> Result<String, String> {
        let seen = self.finished.load(Ordering::SeqCst);
        let mut gate = self.gate.lock().await;
        if self.finished.load(Ordering::SeqCst) > seen {
            // A request finished while this one waited: it is as fresh as ours would be.
            if let Some(answer) = gate.as_ref() {
                return answer.clone();
            }
        }
        let answer = self.fetch_with_retries(key).await;
        *gate = Some(answer.clone());
        self.finished.fetch_add(1, Ordering::SeqCst);
        answer
    }

    async fn fetch_with_retries(&self, key: &str) -> Result<String, String> {
        let deadline = Instant::now() + RETRY_BUDGET;
        let mut delay = self.first_retry;
        let mut attempt = 1;
        loop {
            match self.fetch_once(key).await {
                Ok(body) => return Ok(body),
                Err(Attempt::Final(message)) => return Err(message),
                Err(Attempt::Retry(message)) => {
                    if attempt >= MAX_ATTEMPTS || Instant::now() + delay + REQUEST_TIMEOUT > deadline {
                        return Err(message);
                    }
                    log::warn!("token request failed ({message}); retrying in {} ms", delay.as_millis());
                    tokio::time::sleep(delay).await;
                    delay = (delay * 2).min(Duration::from_secs(4));
                    attempt += 1;
                }
            }
        }
    }

    async fn fetch_once(&self, key: &str) -> Result<String, Attempt> {
        let res = self.post(key).await.map_err(|e| Attempt::Retry(network_message(&e)))?;
        let status = res.status().as_u16();
        log::info!("token: Sanas answered HTTP {status}");
        match status {
            200..=299 => {
                let body = res.text().await.map_err(|e| Attempt::Retry(network_message(&e)))?;
                if is_token_body(&body) {
                    Ok(body)
                } else {
                    Err(Attempt::Final("Sanas sent an unexpected answer to the token request.".into()))
                }
            }
            400 | 401 | 403 => Err(Attempt::Final(format!(
                "Sanas refused the saved key (HTTP {status}). Check in the Sanas Console whether it expired or was revoked, then paste a new one."
            ))),
            429 | 500..=599 => Err(Attempt::Retry(format!("Sanas answered HTTP {status}"))),
            _ => Err(Attempt::Final(format!("Sanas answered HTTP {status}"))),
        }
    }

    async fn post(&self, key: &str) -> Result<reqwest::Response, reqwest::Error> {
        let body = serde_json::json!({ "apiKey": key }).to_string();
        self.client
            .post(&self.identity_url)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .header(reqwest::header::ACCEPT, "application/json")
            .body(body)
            .send()
            .await
    }
}

fn is_token_body(body: &str) -> bool {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(body) else { return false };
    ["access_token", "user_id", "group_id"]
        .iter()
        .all(|field| value.get(field).and_then(|v| v.as_str()).is_some_and(|s| !s.is_empty()))
}

fn network_message(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        "identity.sanas.ai did not answer in time".into()
    } else {
        "Could not reach identity.sanas.ai: check the internet connection".into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex as StdMutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    const KEY: &str = "sk_test_DO_NOT_LEAK_1234567890";
    const TOKEN_BODY: &str = r#"{"access_token":"secret-token","user_id":"u1","group_id":"g1","expires_in":3600}"#;

    #[derive(Clone)]
    struct Reply {
        status: u16,
        body: &'static str,
        delay_ms: u64,
    }

    fn reply(status: u16, body: &'static str) -> Reply {
        Reply { status, body, delay_ms: 0 }
    }

    /// A one-route HTTP server that answers with `replies` in order (the last one repeats)
    /// and records every request it got.
    async fn fake_identity(replies: Vec<Reply>) -> (String, Arc<StdMutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/oauth2/api-key/login", listener.local_addr().unwrap());
        let seen = Arc::new(StdMutex::new(Vec::new()));
        let log = seen.clone();
        tokio::spawn(async move {
            let mut n = 0;
            loop {
                let Ok((mut socket, _)) = listener.accept().await else { return };
                let r = replies[n.min(replies.len() - 1)].clone();
                n += 1;
                let log = log.clone();
                tokio::spawn(async move {
                    let mut buf = Vec::new();
                    let mut chunk = [0u8; 4096];
                    // Read the head, then the body by Content-Length.
                    loop {
                        let got = socket.read(&mut chunk).await.unwrap_or(0);
                        if got == 0 {
                            return;
                        }
                        buf.extend_from_slice(&chunk[..got]);
                        let text = String::from_utf8_lossy(&buf).to_string();
                        if let Some(head_end) = text.find("\r\n\r\n") {
                            let len = text[..head_end]
                                .lines()
                                .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0)))
                                .unwrap_or(0);
                            if buf.len() >= head_end + 4 + len {
                                log.lock().unwrap().push(text);
                                break;
                            }
                        }
                    }
                    tokio::time::sleep(Duration::from_millis(r.delay_ms)).await;
                    let response = format!(
                        "HTTP/1.1 {} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                        r.status,
                        r.body.len(),
                        r.body
                    );
                    let _ = socket.write_all(response.as_bytes()).await;
                    let _ = socket.shutdown().await;
                });
            }
        });
        (url, seen)
    }

    fn broker(url: &str) -> TokenBroker {
        TokenBroker::new(url).with_first_retry(Duration::from_millis(20))
    }

    #[tokio::test]
    async fn check_key_tells_accepted_refused_and_unknown_apart() {
        let (url, seen) = fake_identity(vec![reply(200, TOKEN_BODY)]).await;
        assert_eq!(broker(&url).check_key(KEY).await, KeyCheck::Accepted);
        let request = seen.lock().unwrap()[0].clone();
        assert!(request.starts_with("POST /oauth2/api-key/login"));
        assert!(request.contains(&format!(r#"{{"apiKey":"{KEY}"}}"#)));
        assert!(!request.to_ascii_lowercase().contains("\r\norigin:"), "no Origin header from the app");

        let (url, _) = fake_identity(vec![reply(401, r#"{"message":"Invalid API key"}"#)]).await;
        assert_eq!(broker(&url).check_key(KEY).await, KeyCheck::Refused(401));
        let (url, _) = fake_identity(vec![reply(503, "{}")]).await;
        assert!(matches!(broker(&url).check_key(KEY).await, KeyCheck::Unknown(m) if m.contains("503")));
        let (url, _) = fake_identity(vec![reply(200, r#"{"access_token":"t"}"#)]).await;
        assert!(matches!(broker(&url).check_key(KEY).await, KeyCheck::Unknown(_)), "a token without ids is not accepted");
        assert!(matches!(broker("http://127.0.0.1:9/x").check_key(KEY).await, KeyCheck::Unknown(m) if m.contains("Could not reach")));
    }

    #[tokio::test]
    async fn token_retries_server_trouble_and_passes_the_body_through() {
        let (url, seen) = fake_identity(vec![reply(503, "{}"), reply(429, "{}"), reply(200, TOKEN_BODY)]).await;
        let body = broker(&url).token(KEY).await.unwrap();
        assert_eq!(body, TOKEN_BODY, "the SDK gets Sanas's answer unchanged");
        assert_eq!(seen.lock().unwrap().len(), 3);
    }

    #[tokio::test]
    async fn token_does_not_retry_a_refused_key_and_never_leaks_secrets() {
        let (url, seen) = fake_identity(vec![reply(401, r#"{"message":"Invalid API key","echo":"sk_test_DO_NOT_LEAK"}"#)]).await;
        let err = broker(&url).token(KEY).await.unwrap_err();
        assert!(err.contains("HTTP 401"), "{err}");
        assert!(!err.contains(KEY) && !err.contains("DO_NOT_LEAK"), "{err}");
        assert_eq!(seen.lock().unwrap().len(), 1);

        let (url, _) = fake_identity(vec![reply(500, r#"{"secret":"server-body"}"#)]).await;
        let err = broker(&url).token(KEY).await.unwrap_err();
        assert!(err.contains("HTTP 500") && !err.contains("server-body"), "{err}");
    }

    #[tokio::test]
    async fn token_gives_up_after_three_retries() {
        let (url, seen) = fake_identity(vec![reply(503, "{}")]).await;
        let err = broker(&url).token(KEY).await.unwrap_err();
        assert!(err.contains("503"));
        assert_eq!(seen.lock().unwrap().len(), MAX_ATTEMPTS as usize);
    }

    #[tokio::test]
    async fn simultaneous_requests_share_one_answer() {
        let (url, seen) = fake_identity(vec![Reply { status: 200, body: TOKEN_BODY, delay_ms: 300 }]).await;
        let broker = Arc::new(broker(&url));
        let (a, b, c) = tokio::join!(broker.token(KEY), broker.token(KEY), broker.token(KEY));
        assert_eq!(a.unwrap(), TOKEN_BODY);
        assert_eq!(b.unwrap(), TOKEN_BODY);
        assert_eq!(c.unwrap(), TOKEN_BODY);
        assert_eq!(seen.lock().unwrap().len(), 1, "one request for three callers");
        // A later request is a new one (tokens are never cached).
        broker.token(KEY).await.unwrap();
        assert_eq!(seen.lock().unwrap().len(), 2);
    }
}
