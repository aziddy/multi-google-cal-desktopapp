// SPDX-License-Identifier: AGPL-3.0-only
use super::model::{Error, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::Notify,
};
use url::Url;

pub const SCOPES: &str = "openid email profile https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events";
pub(super) const SERVICE: &str = "com.aziddy.multicalendar.google";

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct ClientConfig {
    pub client_id: String,
    pub client_secret: String,
    pub project_id: String,
}
impl ClientConfig {
    pub fn parse(raw: &str) -> Result<Self> {
        let value: Value = serde_json::from_str(raw).map_err(|_| {
            Error::new(
                "INVALID_CLIENT",
                "Choose a Desktop OAuth client JSON downloaded from Google Cloud.",
            )
        })?;
        let installed = &value["installed"];
        let id = installed["client_id"].as_str().unwrap_or("");
        let secret = installed["client_secret"].as_str().unwrap_or("");
        if !id.ends_with(".apps.googleusercontent.com")
            || secret.is_empty()
            || id.len() > 512
            || secret.len() > 512
            || installed["auth_uri"] != "https://accounts.google.com/o/oauth2/auth"
            || installed["token_uri"] != "https://oauth2.googleapis.com/token"
        {
            return Err(Error::new(
                "INVALID_CLIENT",
                "Choose an unmodified Google Desktop OAuth client JSON, rather than a Web client.",
            ));
        }
        Ok(Self {
            client_id: id.into(),
            client_secret: secret.into(),
            project_id: installed["project_id"].as_str().unwrap_or("").into(),
        })
    }
    pub fn summary(&self) -> Value {
        serde_json::json!({"clientId":self.client_id,"projectId":self.project_id})
    }
    pub fn as_download(&self) -> Value {
        serde_json::json!({"installed":{"client_id":self.client_id,"client_secret":self.client_secret,"project_id":self.project_id,"auth_uri":"https://accounts.google.com/o/oauth2/auth","token_uri":"https://oauth2.googleapis.com/token"}})
    }
}

pub trait SecretStore: Send + Sync {
    fn get(&self, sub: &str) -> Result<Option<String>>;
    fn set(&self, sub: &str, token: &str) -> Result<()>;
    fn delete(&self, sub: &str) -> Result<()>;
    fn replace(&self, sub: &str, token: &str) -> Result<()> {
        self.set(sub, token)
    }
}
pub struct OsSecrets;
pub(super) fn secure_error() -> Error {
    Error::new("SECURE_STORE", "Operating-system credential storage is unavailable, locked, or access was denied. Unlock it, then choose Retry credential access for this account in Settings.")
}
#[cfg(not(target_os = "macos"))]
impl SecretStore for OsSecrets {
    fn get(&self, sub: &str) -> Result<Option<String>> {
        match keyring::Entry::new(SERVICE, sub)
            .map_err(|_| secure_error())?
            .get_password()
        {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(secure_error()),
        }
    }
    fn set(&self, sub: &str, token: &str) -> Result<()> {
        keyring::Entry::new(SERVICE, sub)
            .map_err(|_| secure_error())?
            .set_password(token)
            .map_err(|_| secure_error())
    }
    fn delete(&self, sub: &str) -> Result<()> {
        match keyring::Entry::new(SERVICE, sub)
            .map_err(|_| secure_error())?
            .delete_credential()
        {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(secure_error()),
        }
    }
}

#[derive(Default)]
pub struct Cancel {
    flag: AtomicBool,
    notify: Notify,
}
impl Cancel {
    pub fn cancel(&self) {
        self.flag.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }
    pub fn check(&self) -> Result<()> {
        if self.flag.load(Ordering::SeqCst) {
            Err(Error::new("CANCELLED", "Google connection cancelled."))
        } else {
            Ok(())
        }
    }
    pub async fn cancelled(&self) {
        let notified = self.notify.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if self.flag.load(Ordering::SeqCst) {
            return;
        }
        notified.await;
    }
}
pub fn random_url_token() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}
pub fn challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}
fn same_state(a: &str, b: &str) -> bool {
    let a = Sha256::digest(a.as_bytes());
    let b = Sha256::digest(b.as_bytes());
    a.iter().zip(b.iter()).fold(0u8, |n, (a, b)| n | (a ^ b)) == 0
}

// No Debug implementation: access/refresh tokens must never enter diagnostics.
#[derive(Deserialize)]
pub struct Tokens {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_in: u64,
    pub scope: Option<String>,
}
pub async fn token_request(http: &reqwest::Client, form: &[(&str, &str)]) -> Result<Tokens> {
    token_request_at(http, "https://oauth2.googleapis.com/token", form).await
}
pub(super) async fn token_request_at(
    http: &reqwest::Client,
    endpoint: &str,
    form: &[(&str, &str)],
) -> Result<Tokens> {
    let response = http.post(endpoint).form(form).send().await.map_err(|_| {
        Error::new(
            "OFFLINE",
            "Could not reach Google. Check your internet connection.",
        )
    })?;
    if !response.status().is_success() {
        let invalid = response
            .json::<Value>()
            .await
            .ok()
            .is_some_and(|v| v["error"] == "invalid_grant");
        return Err(Error::new(
            if invalid {
                "RECONNECT_REQUIRED"
            } else {
                "OAUTH_FAILED"
            },
            if invalid {
                "Google authorization expired or was revoked. Reconnect this account."
            } else {
                "Google could not authorize this client. Check its configuration and try again."
            },
        ));
    }
    let tokens: Tokens = response.json().await.map_err(|_| {
        Error::new(
            "OAUTH_FAILED",
            "Google returned an incomplete authorization response.",
        )
    })?;
    if tokens.access_token.is_empty() {
        return Err(Error::new(
            "OAUTH_FAILED",
            "Google returned an incomplete authorization response.",
        ));
    }
    Ok(tokens)
}

pub async fn wait_for_code(
    listener: TcpListener,
    state: &str,
    cancel: Arc<Cancel>,
    timeout: Duration,
) -> Result<String> {
    let deadline = tokio::time::sleep(timeout);
    tokio::pin!(deadline);
    loop {
        let (mut socket, _) = tokio::select! {
            _=cancel.cancelled()=>return Err(Error::new("CANCELLED","Google connection cancelled.")),
            _=&mut deadline=>return Err(Error::new("OAUTH_TIMEOUT","Google sign-in timed out after five minutes. Try connecting again.")),
            result=listener.accept()=>result.map_err(|_|Error::new("OAUTH_FAILED","The local sign-in callback could not be received."))?
        };
        let read = async {
            let mut request = Vec::new();
            let mut chunk = [0u8; 1024];
            loop {
                let n = socket.read(&mut chunk).await.ok()?;
                if n == 0 {
                    return None;
                }
                request.extend_from_slice(&chunk[..n]);
                if request.len() > 16_384 {
                    return None;
                }
                if request.windows(4).any(|v| v == b"\r\n\r\n") {
                    break;
                }
            }
            let line = std::str::from_utf8(&request).ok()?.lines().next()?;
            let mut fields = line.split_whitespace();
            if fields.next()? != "GET" {
                return None;
            }
            let path = fields.next()?;
            if !path.starts_with("/oauth/callback?") {
                return None;
            }
            let parsed = Url::parse(&format!("http://127.0.0.1{path}")).ok()?;
            let pairs: Vec<_> = parsed.query_pairs().collect();
            let states: Vec<_> = pairs.iter().filter(|(k, _)| k == "state").collect();
            if states.len() != 1 || !same_state(&states[0].1, state) {
                return None;
            }
            if pairs.iter().any(|(k, _)| k == "error") {
                return Some(Err(Error::new(
                    "OAUTH_DENIED",
                    "Google sign-in was declined. You can connect again when ready.",
                )));
            }
            let codes: Vec<_> = pairs.iter().filter(|(k, _)| k == "code").collect();
            if codes.len() != 1 || codes[0].1.is_empty() {
                return None;
            }
            Some(Ok(codes[0].1.to_string()))
        };
        let result = tokio::select! {
            _=cancel.cancelled()=>return Err(Error::new("CANCELLED","Google connection cancelled.")),
            _=&mut deadline=>return Err(Error::new("OAUTH_TIMEOUT","Google sign-in timed out after five minutes.")),
            value=tokio::time::timeout(Duration::from_secs(3),read)=>value.ok().flatten()
        };
        let (status, body) = if result.is_some() {
            (
                "200 OK",
                "Sign-in received. You may close this window and return to Multi Calendar.",
            )
        } else {
            (
                "400 Bad Request",
                "Invalid sign-in callback. Return to Multi Calendar to try again.",
            )
        };
        let reply=format!("HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nContent-Security-Policy: default-src 'none'\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}",body.len());
        let _ =
            tokio::time::timeout(Duration::from_secs(1), socket.write_all(reply.as_bytes())).await;
        if let Some(result) = result {
            return result;
        }
    }
}

pub async fn authorize(
    http: &reqwest::Client,
    client: &ClientConfig,
    cancel: Arc<Cancel>,
    email: Option<&str>,
) -> Result<(Tokens, Value)> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.map_err(|_| {
        Error::new(
            "OAUTH_FAILED",
            "Could not open a temporary local sign-in listener.",
        )
    })?;
    let port = listener
        .local_addr()
        .map_err(|_| Error::new("OAUTH_FAILED", "Could not open the sign-in listener."))?
        .port();
    let redirect = format!("http://127.0.0.1:{port}/oauth/callback");
    let state = random_url_token();
    let verifier = random_url_token();
    let challenge = challenge(&verifier);
    let mut url = Url::parse("https://accounts.google.com/o/oauth2/v2/auth").unwrap();
    url.query_pairs_mut().extend_pairs([
        ("client_id", client.client_id.as_str()),
        ("redirect_uri", &redirect),
        ("response_type", "code"),
        ("scope", SCOPES),
        ("state", &state),
        ("code_challenge", &challenge),
        ("code_challenge_method", "S256"),
        ("access_type", "offline"),
        ("prompt", "consent select_account"),
    ]);
    if let Some(email) = email {
        url.query_pairs_mut().append_pair("login_hint", email);
    }
    cancel.check()?;
    open::that(url.as_str()).map_err(|_| {
        Error::new(
            "BROWSER_FAILED",
            "Could not open the system browser. Check your default browser and try again.",
        )
    })?;
    let code = wait_for_code(listener, &state, cancel.clone(), Duration::from_secs(300)).await?;
    cancel.check()?;
    let tokens = token_request(
        http,
        &[
            ("grant_type", "authorization_code"),
            ("client_id", &client.client_id),
            ("client_secret", &client.client_secret),
            ("code", &code),
            ("code_verifier", &verifier),
            ("redirect_uri", &redirect),
        ],
    )
    .await?;
    let granted = tokens
        .scope
        .as_deref()
        .unwrap_or("")
        .split_whitespace()
        .collect::<Vec<_>>();
    if ![
        "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
        "https://www.googleapis.com/auth/calendar.events",
    ]
    .iter()
    .all(|scope| granted.contains(scope))
    {
        return Err(Error::new(
            "MISSING_SCOPE",
            "Allow both Calendar permissions to connect this account.",
        ));
    }
    let response = http
        .get("https://openidconnect.googleapis.com/v1/userinfo")
        .bearer_auth(&tokens.access_token)
        .send()
        .await
        .map_err(|_| {
            Error::new(
                "OFFLINE",
                "Could not verify your Google account. Check your connection.",
            )
        })?;
    if !response.status().is_success() {
        return Err(Error::new(
            "OAUTH_FAILED",
            "Google account identity could not be verified.",
        ));
    }
    let identity: Value = response
        .json()
        .await
        .map_err(|_| Error::new("OAUTH_FAILED", "Google did not return a valid identity."))?;
    if identity["sub"].as_str().is_none()
        || identity["email"].as_str().is_none()
        || identity["email_verified"] != true
    {
        return Err(Error::new(
            "OAUTH_FAILED",
            "Google did not return a verified account identity.",
        ));
    }
    cancel.check()?;
    Ok((tokens, identity))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pkce_matches_rfc7636_and_state_is_unpredictable() {
        assert_eq!(
            challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
        let a = random_url_token();
        assert_eq!(a.len(), 43);
        assert_ne!(a, random_url_token());
        assert!(same_state(&a, &a));
        assert!(!same_state(&a, "different"));
    }
    #[tokio::test]
    async fn rejects_wrong_state_then_accepts_callback() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(wait_for_code(
            listener,
            "expected",
            Arc::new(Cancel::default()),
            Duration::from_secs(5),
        ));
        for state in ["wrong", "expected"] {
            let mut client = tokio::net::TcpStream::connect(address).await.unwrap();
            client.write_all(format!("GET /oauth/callback?state={state}&code=code HTTP/1.1\r\nHost: localhost\r\n\r\n").as_bytes()).await.unwrap();
            let mut response = String::new();
            client.read_to_string(&mut response).await.unwrap();
            assert!(response.contains(if state == "wrong" { "400" } else { "200" }));
        }
        assert_eq!(task.await.unwrap().unwrap(), "code");
    }
    #[tokio::test]
    async fn cancellation_and_timeout_release_listener() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let cancel = Arc::new(Cancel::default());
        cancel.cancel();
        assert_eq!(
            wait_for_code(listener, "state", cancel, Duration::from_secs(5))
                .await
                .unwrap_err()
                .code,
            "CANCELLED"
        );
        let listener = TcpListener::bind(address).await.unwrap();
        assert_eq!(
            wait_for_code(
                listener,
                "state",
                Arc::new(Cancel::default()),
                Duration::from_millis(1)
            )
            .await
            .unwrap_err()
            .code,
            "OAUTH_TIMEOUT"
        );
    }
}
