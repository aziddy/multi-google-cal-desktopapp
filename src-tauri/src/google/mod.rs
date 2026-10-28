// SPDX-License-Identifier: AGPL-3.0-only
mod auth;
mod cache;
mod credentials;
#[cfg(target_os = "macos")]
mod macos_store;
mod model;
mod private_file;
#[cfg(test)]
mod tests;
pub(crate) mod writes;

use auth::{Cancel, ClientConfig, SecretStore};
use cache::Cache;
use chrono::Utc;
use credentials::{CredentialStorage, Credentials};
use model::{Bucket, Error, Result};
use reqwest::Method;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, Instant},
};
use tauri::{Manager, State};
use tokio::sync::{Mutex as AsyncMutex, RwLock, Semaphore};

struct Access {
    token: String,
    expires: Instant,
}
// Secrets are cached only in native process memory. A failed/denied Keychain read
// must not be retried independently by every calendar waiting for an access token.
#[derive(Default)]
struct RefreshState {
    token: Option<String>,
    dirty: bool,
    failure: Option<RefreshFailure>,
    failures: u32,
}
struct RefreshFailure {
    error: Error,
    retry_at: Option<Instant>,
}
struct Work {
    cancel: Arc<Cancel>,
    requests: Semaphore,
    refresh: AsyncMutex<()>,
    writes: AsyncMutex<()>,
    credential: Mutex<RefreshState>,
}
impl Work {
    fn new(connection_status: &str, credential_error: Error) -> Self {
        let failure = match connection_status {
            "credential_access_required" => Some(credential_error),
            "reconnect_required" => Some(Error::new(
                "RECONNECT_REQUIRED",
                "This Google account needs to be reconnected in Settings.",
            )),
            _ => None,
        };
        Self {
            cancel: Arc::new(Cancel::default()),
            requests: Semaphore::new(2),
            refresh: AsyncMutex::new(()),
            writes: AsyncMutex::new(()),
            credential: Mutex::new(RefreshState {
                failure: failure.map(|error| RefreshFailure {
                    error,
                    retry_at: None,
                }),
                ..RefreshState::default()
            }),
        }
    }
}
pub struct Google {
    cache: Mutex<Cache>,
    config: Mutex<Option<ClientConfig>>,
    directory: PathBuf,
    http: reqwest::Client,
    secrets: Credentials,
    access: Mutex<HashMap<String, Access>>,
    work: Mutex<HashMap<String, Arc<Work>>>,
    global: Semaphore,
    lifecycle: AsyncMutex<()>,
    credentials: AsyncMutex<()>,
    // Commands hold a read guard for their full operation. Switching takes the
    // write guard, so event writes and token rotations finish in their old store.
    operations: RwLock<()>,
    connecting: Mutex<Option<Arc<Cancel>>>,
    syncing: Mutex<HashSet<String>>,
    #[cfg(test)]
    api_base: String,
    #[cfg(test)]
    token_endpoint: String,
}
fn lock<T>(mutex: &Mutex<T>) -> Result<MutexGuard<'_, T>> {
    mutex.lock().map_err(|_| {
        Error::new(
            "NATIVE_FAILED",
            "Native calendar state could not be opened. Restart the app.",
        )
    })
}
impl Google {
    pub fn new(directory: PathBuf) -> Result<Self> {
        private_file::directory(&directory).map_err(|_| {
            Error::new(
                "CACHE_FAILED",
                "Could not create or protect the native Google data directory.",
            )
        })?;
        let secrets = Credentials::load(&directory)?;
        let config_path = directory.join("google-client.json");
        let config = if config_path.exists() {
            Some(ClientConfig::parse(
                &std::fs::read_to_string(config_path).map_err(|_| {
                    Error::new(
                        "INVALID_CLIENT",
                        "The saved OAuth configuration could not be read.",
                    )
                })?,
            )?)
        } else {
            None
        };
        let cache = Cache::open(&directory.join("google-cache.sqlite3"))?;
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::none())
            .user_agent("MultiCalendar/0.1")
            .build()
            .map_err(|_| {
                Error::new(
                    "NATIVE_FAILED",
                    "Could not initialize the Google HTTP client.",
                )
            })?;
        let google = Self {
            cache: Mutex::new(cache),
            config: Mutex::new(config),
            directory,
            http,
            secrets,
            access: Mutex::new(HashMap::new()),
            work: Mutex::new(HashMap::new()),
            global: Semaphore::new(4),
            lifecycle: AsyncMutex::new(()),
            credentials: AsyncMutex::new(()),
            operations: RwLock::new(()),
            connecting: Mutex::new(None),
            syncing: Mutex::new(HashSet::new()),
            #[cfg(test)]
            api_base: "https://www.googleapis.com/".into(),
            #[cfg(test)]
            token_endpoint: "https://oauth2.googleapis.com/token".into(),
        };
        if google.secrets.mode()? == CredentialStorage::LocalFile {
            google.storage_status(false)?;
        }
        Ok(google)
    }
    fn storage_status(&self, reset: bool) -> Result<()> {
        let accounts = lock(&self.cache)?.accounts()?;
        for account in accounts {
            let parts = model::parts(model::string(&account, "id"), 1)?;
            let status = match self.secrets.get(&parts[0]) {
                Ok(Some(_)) if !reset => continue,
                Ok(Some(_)) => "connected",
                Ok(None) => "reconnect_required",
                Err(_) => "credential_access_required",
            };
            lock(&self.cache)?.status(&parts[0], status)?;
        }
        Ok(())
    }
    async fn set_credential_storage(&self, storage: CredentialStorage) -> Result<Value> {
        if lock(&self.connecting)?.is_some() {
            return Err(Error::new(
                "BUSY",
                "Complete or cancel Google sign-in before changing credential storage.",
            ));
        }
        let _operations = self.operations.write().await;
        let _life = self.lifecycle.lock().await;
        let _credentials = self.credentials.lock().await;
        if self.secrets.mode()? == storage {
            return self.snapshot();
        }
        // Commit settings before clearing anything. Failed saves retain the current
        // backend and live credentials; no credentials are copied between stores.
        self.secrets.select(storage)?;
        for (_, work) in lock(&self.work)?.drain() {
            work.cancel.cancel();
            *lock(&work.credential)? = RefreshState::default();
        }
        lock(&self.access)?.clear();
        self.storage_status(true)?;
        self.snapshot()
    }
    fn config(&self) -> Result<ClientConfig> {
        lock(&self.config)?.clone().ok_or_else(|| {
            Error::new(
                "CLIENT_REQUIRED",
                "Import a Google Desktop OAuth client JSON in Settings first.",
            )
        })
    }
    fn account_work(&self, sub: &str) -> Result<Arc<Work>> {
        let status = lock(&self.cache)?.connection_status(sub)?;
        Ok(lock(&self.work)?
            .entry(sub.into())
            .or_insert_with(|| Arc::new(Work::new(&status, self.secrets.error())))
            .clone())
    }
    fn snapshot(&self) -> Result<Value> {
        let config = lock(&self.config)?.as_ref().map(ClientConfig::summary);
        let connecting = lock(&self.connecting)?.is_some();
        let storage = self.secrets.mode()?;
        let cache = lock(&self.cache)?;
        let pending:Vec<_>=cache.all_pending()?.iter().map(|p|json!({"requestId":p["requestId"],"accountId":model::key(&[model::string(p,"sub")]),"operation":p["operation"],"title":p["body"]["summary"].as_str().unwrap_or("Previous event change"),"status":p["status"]})).collect();
        Ok(
            json!({"client":config,"credentialStorage":storage,"accounts":cache.accounts()?,"calendars":cache.calendars()?,"events":cache.events()?,"syncStatus":cache.sync_status()?,"connecting":connecting,"pendingMutations":cache.pending_count()?,"pendingWrites":pending}),
        )
    }
    async fn import(&self, use_saved: bool) -> Result<Value> {
        let _lifecycle = self.lifecycle.lock().await;
        if lock(&self.connecting)?.is_some() {
            return Err(Error::new(
                "BUSY",
                "Cancel the current connection before importing an OAuth client.",
            ));
        }
        let path = if use_saved {
            let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
                .ok_or_else(|| {
                    Error::new("INVALID_CLIENT", "Could not find the saved client file.")
                })?;
            PathBuf::from(home).join(".config/multi-calendar/google-desktop-client.json")
        } else {
            rfd::AsyncFileDialog::new()
                .add_filter("Google Desktop OAuth JSON", &["json"])
                .pick_file()
                .await
                .ok_or_else(|| Error::new("CANCELLED", "Client import cancelled."))?
                .path()
                .to_owned()
        };
        let raw = std::fs::read_to_string(path).map_err(|_| {
            Error::new(
                "INVALID_CLIENT",
                "The selected client JSON could not be read.",
            )
        })?;
        if raw.len() > 64 * 1024 {
            return Err(Error::new(
                "INVALID_CLIENT",
                "Choose a Google Desktop OAuth client JSON.",
            ));
        }
        let client = ClientConfig::parse(&raw)?;
        let changing = lock(&self.config)?.as_ref() != Some(&client);
        if changing && !lock(&self.cache)?.accounts()?.is_empty() {
            return Err(Error::new(
                "ACCOUNTS_CONNECTED",
                "Disconnect every Google account before replacing the OAuth client.",
            ));
        }
        let temp = self.directory.join("google-client.tmp");
        {
            use std::io::Write;
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create(true).truncate(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&temp).map_err(|_| {
                Error::new(
                    "CACHE_FAILED",
                    "Could not save the OAuth client configuration.",
                )
            })?;
            file.write_all(client.as_download().to_string().as_bytes())
                .and_then(|_| file.sync_all())
                .map_err(|_| {
                    Error::new(
                        "CACHE_FAILED",
                        "Could not save the OAuth client configuration.",
                    )
                })?;
        }
        std::fs::rename(temp, self.directory.join("google-client.json")).map_err(|_| {
            Error::new(
                "CACHE_FAILED",
                "Could not save the OAuth client configuration.",
            )
        })?;
        *lock(&self.config)? = Some(client);
        self.snapshot()
    }
    async fn connect(&self, reconnect: Option<String>) -> Result<Value> {
        let client = self.config()?;
        let cancel = Arc::new(Cancel::default());
        {
            let _life = self.lifecycle.lock().await;
            let mut connecting = lock(&self.connecting)?;
            if connecting.is_some() {
                return Err(Error::new(
                    "BUSY",
                    "A Google connection is already in progress.",
                ));
            }
            *connecting = Some(cancel.clone());
        }
        let result=async {
            let sub=reconnect.as_deref().map(|id|model::parts(id,1).map(|p|p[0].clone())).transpose()?;
            let email=if let Some(sub)=&sub {let cache=lock(&self.cache)?; cache.generation(sub)?; cache.accounts()?.iter().find(|a|a["id"]==model::key(&[sub])).and_then(|a|a["email"].as_str().map(str::to_owned))} else {None};
            let authorized=tokio::select! {
                _=cancel.cancelled()=>return Err(Error::new("CANCELLED","Google connection cancelled.")),
                value=tokio::time::timeout(Duration::from_secs(300),auth::authorize(&self.http,&client,cancel.clone(),email.as_deref()))=>value.map_err(|_|Error::new("OAUTH_TIMEOUT","Google sign-in timed out after five minutes."))??
            };
            let (tokens,identity)=authorized;
            let actual=model::string(&identity,"sub");
            if sub.as_deref().is_some_and(|sub|sub!=actual) {return Err(Error::new("WRONG_ACCOUNT","Choose the same Google account when reconnecting, or use Connect another account."));}
            let _life=self.lifecycle.lock().await;
            let _credentials=self.credentials.lock().await;
            cancel.check()?;
            if sub.is_some() && !lock(&self.cache)?.exists(actual)? {return Err(Error::new("DISCONNECTED","This account was disconnected during sign-in."));}
            if self.config()? != client {return Err(Error::new("CANCELLED","The OAuth client changed during sign-in."));}
            let existed=lock(&self.cache)?.exists(actual)?;
            // Fresh Google consent can repair an entry belonging to an earlier
            // ad-hoc build without trying to unlock/read that old secret.
            let old=match self.secrets.get(actual) {Ok(old)=>old,Err(_) if tokens.refresh_token.is_some()=>None,Err(error)=>return Err(error)};
            let refresh=tokens.refresh_token.as_ref().or(old.as_ref()).ok_or_else(||Error::new("OAUTH_FAILED","Google did not return offline access. Reconnect and allow access again."))?;
            if tokens.refresh_token.is_some() {self.secrets.replace(actual,refresh)?;} else {self.secrets.set(actual,refresh)?;}
            if let Err(error)=lock(&self.cache)?.save_account(actual,&identity) {
                if let Some(old)=old {let _=self.secrets.replace(actual,&old);} else if !existed {let _=self.secrets.delete(actual);}
                return Err(error);
            }
            if let Some(previous)=lock(&self.work)?.remove(actual) {previous.cancel.cancel();}
            let next=Arc::new(Work::new("connected",self.secrets.error()));lock(&next.credential)?.token=Some(refresh.clone());lock(&self.work)?.insert(actual.into(),next);
            lock(&self.access)?.insert(actual.into(),Access{token:tokens.access_token,expires:Instant::now()+Duration::from_secs(tokens.expires_in.saturating_sub(60))});
            Ok(actual.to_string())
        }.await;
        *lock(&self.connecting)? = None;
        let sub = result?;
        // Connection succeeds independently of a temporary calendar-list failure.
        if let Err(error) = self.refresh_calendars(&sub).await {
            let _ = lock(&self.cache)?.status(
                &sub,
                if error.code == "RECONNECT_REQUIRED" {
                    "reconnect_required"
                } else if error.code == "SECURE_STORE" {
                    "credential_access_required"
                } else {
                    "calendar_refresh_failed"
                },
            );
        }
        self.snapshot()
    }
    async fn disconnect(&self, account: &str) -> Result<Value> {
        let sub = &model::parts(account, 1)?[0];
        let _life = self.lifecycle.lock().await;
        if let Some(session) = lock(&self.connecting)?.as_ref() {
            session.cancel();
        }
        if let Some(work) = lock(&self.work)?.remove(sub) {
            work.cancel.cancel();
        }
        lock(&self.access)?.remove(sub);
        let _credentials = self.credentials.lock().await;
        if let Err(error) = self.secrets.delete(sub) {
            let _ = lock(&self.cache)?.status(sub, "credential_access_required");
            return Err(error);
        }
        lock(&self.cache)?.disconnect(sub)?;
        self.snapshot()
    }
    async fn access_token(&self, sub: &str, work: &Work) -> Result<String> {
        let _refresh = work.refresh.lock().await;
        work.cancel.check()?;
        if let Some(access) = lock(&self.access)?
            .get(sub)
            .filter(|a| a.expires > Instant::now())
        {
            return Ok(access.token.clone());
        }
        {
            let state = lock(&work.credential)?;
            if let Some(failure) = &state.failure {
                if failure.retry_at.is_none_or(|retry| retry > Instant::now()) {
                    return Err(failure.error.clone());
                }
            }
        }
        let client = self.config()?;
        let cached = lock(&work.credential)?.token.clone();
        let refresh = if let Some(token) = cached {
            token
        } else {
            let _credentials = self.credentials.lock().await;
            work.cancel.check()?;
            match self.secrets.get(sub) {
                Ok(Some(token)) => {
                    lock(&work.credential)?.token = Some(token.clone());
                    token
                }
                Ok(None) => {
                    return Err(self.refresh_failure(
                        sub,
                        work,
                        Error::new(
                            "RECONNECT_REQUIRED",
                            "This account needs to be reconnected to Google.",
                        ),
                    )?)
                }
                Err(error) => return Err(self.refresh_failure(sub, work, error)?),
            }
        };
        if lock(&work.credential)?.dirty {
            let _credentials = self.credentials.lock().await;
            work.cancel.check()?;
            if let Err(error) = self.secrets.set(sub, &refresh) {
                return Err(self.refresh_failure(sub, work, error)?);
            }
            lock(&work.credential)?.dirty = false;
        }
        let _account_permit = work
            .requests
            .acquire()
            .await
            .map_err(|_| Error::new("CANCELLED", "Request cancelled."))?;
        let _permit = self
            .global
            .acquire()
            .await
            .map_err(|_| Error::new("CANCELLED", "Request cancelled."))?;
        let form = [
            ("grant_type", "refresh_token"),
            ("client_id", &client.client_id),
            ("client_secret", &client.client_secret),
            ("refresh_token", &refresh),
        ];
        #[cfg(test)]
        let endpoint = self.token_endpoint.as_str();
        #[cfg(not(test))]
        let endpoint = "https://oauth2.googleapis.com/token";
        let response = tokio::select! {_=work.cancel.cancelled()=>return Err(Error::new("DISCONNECTED","Account disconnected.")), response=auth::token_request_at(&self.http,endpoint,&form)=>response};
        let tokens = match response {
            Ok(tokens) => tokens,
            Err(error) => {
                return Err(self.refresh_failure(sub, work, error)?);
            }
        };
        let _credentials = self.credentials.lock().await;
        work.cancel.check()?;
        if !lock(&self.cache)?.exists(sub)? {
            return Err(Error::new("DISCONNECTED", "Account disconnected."));
        }
        if let Some(refresh) = &tokens.refresh_token {
            {
                let mut credential = lock(&work.credential)?;
                credential.token = Some(refresh.clone());
                credential.dirty = true;
            }
            if let Err(error) = self.secrets.set(sub, refresh) {
                return Err(self.refresh_failure(sub, work, error)?);
            }
            lock(&work.credential)?.dirty = false;
        }
        {
            let mut credential = lock(&work.credential)?;
            credential.failure = None;
            credential.failures = 0;
        }
        let token = tokens.access_token.clone();
        lock(&self.access)?.insert(
            sub.into(),
            Access {
                token: tokens.access_token,
                expires: Instant::now() + Duration::from_secs(tokens.expires_in.saturating_sub(60)),
            },
        );
        lock(&self.cache)?.status(sub, "connected")?;
        Ok(token)
    }
    fn refresh_failure(&self, sub: &str, work: &Work, error: Error) -> Result<Error> {
        let permanent = matches!(error.code.as_str(), "SECURE_STORE" | "RECONNECT_REQUIRED");
        {
            let mut credential = lock(&work.credential)?;
            credential.failures = credential.failures.saturating_add(1);
            let wait = Duration::from_secs(
                (30u64.saturating_mul(1 << credential.failures.min(4))).min(300),
            );
            credential.failure = Some(RefreshFailure {
                error: error.clone(),
                retry_at: if permanent {
                    None
                } else {
                    Some(Instant::now() + wait)
                },
            });
        }
        if permanent {
            let _ = lock(&self.cache)?.status(
                sub,
                if error.code == "SECURE_STORE" {
                    "credential_access_required"
                } else {
                    "reconnect_required"
                },
            );
        }
        Ok(error)
    }
    async fn retry_credentials(&self, account: &str) -> Result<Value> {
        let sub = &model::parts(account, 1)?[0];
        let work = self.account_work(sub)?;
        {
            let _refresh = work.refresh.lock().await;
            let mut credential = lock(&work.credential)?;
            credential.failure = None;
            credential.failures = 0;
        }
        lock(&self.cache)?.status(sub, "connected")?;
        self.refresh_calendars(sub).await?;
        self.snapshot()
    }
    async fn api(
        &self,
        sub: &str,
        method: Method,
        path: &[&str],
        query: &[(&str, String)],
        body: Option<&Value>,
        etag: Option<&str>,
    ) -> Result<Value> {
        let work = self.account_work(sub)?;
        #[cfg(test)]
        let base = self.api_base.as_str();
        #[cfg(not(test))]
        let base = "https://www.googleapis.com/";
        let mut url = url::Url::parse(base).unwrap();
        url.path_segments_mut()
            .unwrap()
            .extend(["calendar", "v3"])
            .extend(path.iter().copied());
        let is_get = method == Method::GET;
        for attempt in 0..3 {
            work.cancel.check()?;
            let token = self.access_token(sub, &work).await?;
            let account_permit = work
                .requests
                .acquire()
                .await
                .map_err(|_| Error::new("CANCELLED", "Request cancelled."))?;
            let global_permit = self
                .global
                .acquire()
                .await
                .map_err(|_| Error::new("CANCELLED", "Request cancelled."))?;
            work.cancel.check()?;
            let mut request = self
                .http
                .request(method.clone(), url.clone())
                .bearer_auth(token)
                .query(query);
            if let Some(body) = body {
                request = request.json(body);
            }
            if let Some(etag) = etag {
                request = request.header(reqwest::header::IF_MATCH, etag);
            }
            let response = tokio::select! {_=work.cancel.cancelled()=>return Err(Error::new("DISCONNECTED","Account disconnected.")),response=request.send()=>response};
            drop(global_permit);
            drop(account_permit);
            let response=match response {Ok(response)=>response,Err(_)=>return Err(Error::new("OFFLINE","Could not reach Google. Cached events are still available. Changes require an internet connection."))};
            let status = response.status();
            if status.as_u16() == 401 && attempt == 0 {
                lock(&self.access)?.remove(sub);
                continue;
            }
            let retry_after = response
                .headers()
                .get(reqwest::header::RETRY_AFTER)
                .and_then(|h| h.to_str().ok())
                .and_then(|h| h.parse::<u64>().ok())
                .unwrap_or(1 << attempt)
                .min(30);
            if status.is_success() {
                if status.as_u16() == 204 {
                    return Ok(Value::Null);
                }
                return response.json::<Value>().await.map_err(|_| {
                    Error::new("INVALID_DATA", "Google returned an incomplete response.")
                });
            }
            let details = response.json::<Value>().await.unwrap_or(Value::Null);
            let rate = status.as_u16() == 429
                || (status.as_u16() == 403
                    && details["error"]["errors"].as_array().is_some_and(|errors| {
                        errors.iter().any(|e| {
                            matches!(
                                model::string(e, "reason"),
                                "rateLimitExceeded" | "userRateLimitExceeded"
                            )
                        })
                    }));
            if is_get && (rate || status.is_server_error()) && attempt < 2 {
                tokio::select! {_=work.cancel.cancelled()=>return Err(Error::new("DISCONNECTED","Account disconnected.")),_=tokio::time::sleep(Duration::from_secs(retry_after))=>{}}
                continue;
            }
            return Err(match status.as_u16() {
                401=>Error::new("RECONNECT_REQUIRED","Google authorization is no longer valid. Reconnect this account."),
                403 if rate=>Error::new("RATE_LIMIT","Google's request limit was reached. Synchronization will retry after a delay."),
                403=>Error::new("FORBIDDEN","Google denied access. Check this calendar's permissions or reconnect the account."),
                404|410=>Error::new("NOT_FOUND","This Google event or calendar no longer exists. Reload the calendar."),
                409=>Error::new("ALREADY_EXISTS","This creation attempt already exists in Google Calendar."),
                412=>Error::new("CONFLICT","This event changed in Google Calendar. Close the editor and refresh before editing again."),
                429=>Error::new("RATE_LIMIT","Google's request limit was reached. Try again after a delay."),
                500..=599=>Error::new("GOOGLE_UNAVAILABLE","Google is temporarily unavailable. Cached data is still available."),
                _=>Error::new("INVALID_EVENT","Google rejected this change. Check the event dates and recurrence settings.")
            });
        }
        Err(Error::new(
            "RECONNECT_REQUIRED",
            "Reconnect this Google account.",
        ))
    }
    async fn pages(
        &self,
        sub: &str,
        path: &[&str],
        query: Vec<(&str, String)>,
    ) -> Result<Vec<Value>> {
        let mut items = Vec::new();
        let mut token = String::new();
        let mut seen = HashSet::new();
        loop {
            let mut query = query.clone();
            if !token.is_empty() {
                query.push(("pageToken", token.clone()));
            }
            let page = self.api(sub, Method::GET, path, &query, None, None).await?;
            if !matches!(
                model::string(&page, "kind"),
                "calendar#calendarList" | "calendar#events"
            ) {
                return Err(Error::new(
                    "INVALID_DATA",
                    "Google returned an incomplete calendar page. Cached data was preserved.",
                ));
            }
            if let Some(batch) = page.get("items") {
                let batch = batch.as_array().ok_or_else(|| {
                    Error::new("INVALID_DATA", "Google returned an incomplete page.")
                })?;
                items.extend(batch.iter().cloned());
            }
            match page["nextPageToken"].as_str() {
                Some(next) if !next.is_empty() => {
                    if !seen.insert(next.to_string()) {
                        return Err(Error::new(
                            "INVALID_DATA",
                            "Google repeated a pagination cursor.",
                        ));
                    }
                    token = next.into();
                }
                _ => return Ok(items),
            }
        }
    }
    async fn refresh_calendars(&self, sub: &str) -> Result<()> {
        let generation = lock(&self.cache)?.generation(sub)?;
        let calendars = self
            .pages(
                sub,
                &["users", "me", "calendarList"],
                vec![("maxResults", "250".into()), ("showHidden", "true".into())],
            )
            .await?;
        lock(&self.cache)?.replace_calendars(sub, generation, &calendars)?;
        Ok(())
    }
    async fn sync(
        &self,
        calendar: &str,
        buckets: Vec<Bucket>,
        refresh_calendars: bool,
        force: bool,
    ) -> Result<()> {
        let p = model::parts(calendar, 2)?;
        let (sub, cal) = (&p[0], &p[1]);
        if buckets.len() > 12 {
            return Err(Error::new(
                "INVALID_RANGE",
                "Choose a smaller visible date range.",
            ));
        }
        for bucket in &buckets {
            bucket.validate()?;
        }
        if refresh_calendars {
            if let Err(error) = self.refresh_calendars(sub).await {
                lock(&self.cache)?.sync_failure(sub, cal, &error.message)?;
                return Ok(());
            }
        }
        let mut failure = None;
        for bucket in buckets {
            let id = format!("{calendar}:{}", bucket.start_date);
            if !lock(&self.syncing)?.insert(id.clone()) {
                continue;
            }
            let result = async {
                let (generation, revision) = {
                    let cache = lock(&self.cache)?;
                    if !force && cache.retry_at(sub, cal)? > Utc::now().timestamp() {
                        return Ok(());
                    }
                    (cache.generation(sub)?, cache.revision(sub, cal)?)
                };
                let events = self
                    .pages(
                        sub,
                        &["calendars", cal, "events"],
                        vec![
                            ("timeMin", format!("{}T00:00:00Z", bucket.start_date)),
                            ("timeMax", format!("{}T00:00:00Z", bucket.end_date)),
                            ("singleEvents", "true".into()),
                            ("showDeleted", "false".into()),
                            ("maxResults", "2500".into()),
                            ("timeZone", "UTC".into()),
                        ],
                    )
                    .await?;
                lock(&self.cache)?
                    .replace_bucket(sub, cal, generation, revision, &bucket, &events)?;
                Ok::<_, Error>(())
            }
            .await;
            lock(&self.syncing)?.remove(&id);
            if let Err(error) = result {
                if lock(&self.cache)?.exists(sub)? {
                    lock(&self.cache)?.sync_failure(sub, cal, &error.message)?;
                    failure = Some(error.message);
                }
            }
        }
        if let Some(message) = failure {
            if lock(&self.cache)?.exists(sub)? {
                lock(&self.cache)?.db.execute(
                    "UPDATE calendars SET error=? WHERE sub=? AND id=?",
                    rusqlite::params![message, sub, cal],
                )?;
            }
        }
        Ok(())
    }
}

#[tauri::command]
pub async fn google_snapshot(google: State<'_, Arc<Google>>) -> Result<Value> {
    let _operation = google.operations.read().await;
    google.snapshot()
}
#[tauri::command]
pub async fn google_set_credential_storage(
    google: State<'_, Arc<Google>>,
    storage: CredentialStorage,
) -> Result<Value> {
    google.set_credential_storage(storage).await
}
#[tauri::command]
pub async fn google_import_client(
    google: State<'_, Arc<Google>>,
    use_saved: bool,
) -> Result<Value> {
    let _operation = google.operations.read().await;
    google.import(use_saved).await
}
#[tauri::command]
pub async fn google_connect(
    google: State<'_, Arc<Google>>,
    reconnect: Option<String>,
) -> Result<Value> {
    let _operation = google.operations.read().await;
    google.connect(reconnect).await
}
#[tauri::command]
pub fn google_cancel_connect(google: State<'_, Arc<Google>>) -> Result<()> {
    if let Some(cancel) = lock(&google.connecting)?.as_ref() {
        cancel.cancel();
    }
    Ok(())
}
#[tauri::command]
pub async fn google_disconnect(
    google: State<'_, Arc<Google>>,
    account_id: String,
) -> Result<Value> {
    let _operation = google.operations.read().await;
    google.disconnect(&account_id).await
}
#[tauri::command]
pub async fn google_sync(
    google: State<'_, Arc<Google>>,
    calendar_id: String,
    buckets: Vec<Bucket>,
    refresh_calendars: bool,
    force: bool,
) -> Result<()> {
    let _operation = google.operations.read().await;
    google
        .sync(&calendar_id, buckets, refresh_calendars, force)
        .await
}
#[tauri::command]
pub async fn google_refresh_accounts(google: State<'_, Arc<Google>>) -> Result<Value> {
    let _operation = google.operations.read().await;
    let accounts = lock(&google.cache)?.accounts()?;
    for account in accounts {
        let p = model::parts(model::string(&account, "id"), 1)?;
        // An explicit refresh can retry a network failure, but cannot clear a
        // denied credential read. That requires the dedicated Settings action.
        if let Some(work) = lock(&google.work)?.get(&p[0]) {
            let mut state = lock(&work.credential)?;
            if state
                .failure
                .as_ref()
                .is_some_and(|failure| failure.retry_at.is_some())
            {
                state.failure = None;
            }
        }
        if let Err(error) = google.refresh_calendars(&p[0]).await {
            let _ = lock(&google.cache)?.status(
                &p[0],
                if error.code == "RECONNECT_REQUIRED" {
                    "reconnect_required"
                } else if error.code == "SECURE_STORE" {
                    "credential_access_required"
                } else {
                    "calendar_refresh_failed"
                },
            );
        }
    }
    google.snapshot()
}

#[tauri::command]
pub async fn google_retry_credentials(
    google: State<'_, Arc<Google>>,
    account_id: String,
) -> Result<Value> {
    let _operation = google.operations.read().await;
    google.retry_credentials(&account_id).await
}
#[tauri::command]
pub async fn google_open_event(google: State<'_, Arc<Google>>, event_id: String) -> Result<()> {
    let _operation = google.operations.read().await;
    let p = model::parts(&event_id, 3)?;
    let raw = google
        .api(
            &p[0],
            Method::GET,
            &["calendars", &p[1], "events", &p[2]],
            &[],
            None,
            None,
        )
        .await?;
    let link = model::string(&raw, "htmlLink");
    let url = url::Url::parse(link)
        .map_err(|_| Error::new("INVALID_DATA", "Google did not return an event link."))?;
    if url.scheme() != "https"
        || !matches!(
            url.host_str(),
            Some("calendar.google.com" | "www.google.com")
        )
    {
        return Err(Error::new(
            "INVALID_DATA",
            "Google returned an unsupported event link.",
        ));
    }
    open::that(url.as_str())
        .map_err(|_| Error::new("BROWSER_FAILED", "Could not open your browser."))?;
    Ok(())
}
pub fn setup(app: &mut tauri::App) -> std::result::Result<(), Box<dyn std::error::Error>> {
    let directory = app.path().app_data_dir()?;
    let google = Google::new(directory).map_err(|e| std::io::Error::other(e.message))?;
    app.manage(Arc::new(google));
    Ok(())
}
