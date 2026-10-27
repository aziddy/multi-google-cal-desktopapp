// SPDX-License-Identifier: AGPL-3.0-only
use super::*;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

#[derive(Default)]
struct MemorySecrets {
    values: Mutex<HashMap<String, String>>,
    fail: AtomicBool,
    reads: AtomicUsize,
}
impl SecretStore for MemorySecrets {
    fn get(&self, sub: &str) -> Result<Option<String>> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        if self.fail.load(Ordering::SeqCst) {
            return Err(Error::new("SECURE_STORE", "Locked test credential store"));
        }
        Ok(lock(&self.values)?.get(sub).cloned())
    }
    fn set(&self, sub: &str, token: &str) -> Result<()> {
        if self.fail.load(Ordering::SeqCst) {
            return Err(Error::new("SECURE_STORE", "Locked test credential store"));
        }
        lock(&self.values)?.insert(sub.into(), token.into());
        Ok(())
    }
    fn delete(&self, sub: &str) -> Result<()> {
        if self.fail.load(Ordering::SeqCst) {
            return Err(Error::new("SECURE_STORE", "Locked test credential store"));
        }
        lock(&self.values)?.remove(sub);
        Ok(())
    }
}
struct Directory(PathBuf);
impl Directory {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!("multi-calendar-test-{}", uuid::Uuid::new_v4())))
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn service() -> (Google, Arc<MemorySecrets>, Directory) {
    let dir = Directory::new();
    let mut google = Google::new(dir.0.clone()).unwrap();
    let secrets = Arc::new(MemorySecrets::default());
    secrets.set("a", "test-refresh").unwrap();
    google.secrets = secrets.clone();
    *lock(&google.config).unwrap() = Some(ClientConfig {
        client_id: "test.apps.googleusercontent.com".into(),
        client_secret: "test-only".into(),
        project_id: "test".into(),
    });
    {
        let mut cache = lock(&google.cache).unwrap();
        cache
            .save_account("a", &json!({"email":"a@example.com"}))
            .unwrap();
        cache
            .replace_calendars(
                "a",
                0,
                &[json!({"id":"cal","accessRole":"owner","timeZone":"UTC"})],
            )
            .unwrap();
    }
    lock(&google.access).unwrap().insert(
        "a".into(),
        Access {
            token: "test-access".into(),
            expires: Instant::now() + Duration::from_secs(3600),
        },
    );
    (google, secrets, dir)
}
struct Reply {
    status: u16,
    body: Value,
    path: &'static str,
    delay: u64,
}
fn reply(status: u16, body: Value, path: &'static str) -> Reply {
    Reply {
        status,
        body,
        path,
        delay: 0,
    }
}
async fn server(replies: Vec<Reply>) -> (String, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        for reply in replies {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut data = Vec::new();
            let mut chunk = [0u8; 4096];
            loop {
                let n = socket.read(&mut chunk).await.unwrap();
                assert!(n > 0);
                data.extend_from_slice(&chunk[..n]);
                if let Some(end) = data.windows(4).position(|v| v == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&data[..end]);
                    let length = headers
                        .lines()
                        .find_map(|line| {
                            line.to_lowercase()
                                .strip_prefix("content-length:")
                                .and_then(|v| v.trim().parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    if data.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            let request = String::from_utf8_lossy(&data);
            assert!(request.lines().next().unwrap().contains(reply.path));
            tokio::time::sleep(Duration::from_millis(reply.delay)).await;
            let body = reply.body.to_string();
            let response=format!("HTTP/1.1 {} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",reply.status,body.len(),body);
            let _ = socket.write_all(response.as_bytes()).await;
        }
    });
    (format!("http://{address}/"), task)
}
fn raw_event(id: &str) -> Value {
    json!({"id":id,"summary":"Original","status":"confirmed","eventType":"default","organizer":{"self":true},"etag":"\"v1\"","start":{"dateTime":"2026-10-26T14:00:00Z","timeZone":"UTC"},"end":{"dateTime":"2026-10-26T15:00:00Z","timeZone":"UTC"}})
}
fn bucket() -> Bucket {
    Bucket {
        start_date: "2026-10-01".into(),
        end_date: "2026-11-01".into(),
        time_zone: "UTC".into(),
    }
}

#[tokio::test]
async fn refresh_is_coalesced_and_invalid_grants_require_reconnection() {
    let (mut google, _, _dir) = service();
    lock(&google.access).unwrap().clear();
    let (base, task) = server(vec![
        reply(
            200,
            json!({"access_token":"new-access","expires_in":3600}),
            "POST /",
        ),
        reply(400, json!({"error":"invalid_grant"}), "POST /"),
    ])
    .await;
    google.token_endpoint = base;
    let work = google.account_work("a").unwrap();
    let (a, b) = tokio::join!(
        google.access_token("a", &work),
        google.access_token("a", &work)
    );
    assert_eq!(a.unwrap(), "new-access");
    assert_eq!(b.unwrap(), "new-access");
    lock(&google.access).unwrap().clear();
    assert_eq!(
        google.access_token("a", &work).await.unwrap_err().code,
        "RECONNECT_REQUIRED"
    );
    assert_eq!(
        google.snapshot().unwrap()["accounts"][0]["connectionStatus"],
        "reconnect_required"
    );
    task.await.unwrap();
}
#[tokio::test]
async fn secure_store_failure_does_not_disconnect_or_fall_back_to_disk() {
    let (google, secrets, _dir) = service();
    secrets.fail.store(true, Ordering::SeqCst);
    lock(&google.access).unwrap().clear();
    let work = google.account_work("a").unwrap();
    assert_eq!(
        google.access_token("a", &work).await.unwrap_err().code,
        "SECURE_STORE"
    );
    assert_eq!(
        google
            .disconnect(&model::key(&["a"]))
            .await
            .unwrap_err()
            .code,
        "SECURE_STORE"
    );
    assert!(lock(&google.cache).unwrap().exists("a").unwrap());
}

#[tokio::test]
async fn denied_keychain_access_is_not_retried_by_each_calendar_or_poll() {
    let (google, secrets, _dir) = service();
    secrets.fail.store(true, Ordering::SeqCst);
    lock(&google.access).unwrap().clear();
    let work = google.account_work("a").unwrap();
    for _ in 0..20 {
        assert_eq!(
            google.access_token("a", &work).await.unwrap_err().code,
            "SECURE_STORE"
        );
    }
    assert_eq!(secrets.reads.load(Ordering::SeqCst), 1);
    assert_eq!(
        google.snapshot().unwrap()["accounts"][0]["connectionStatus"],
        "credential_access_required"
    );
    // Recreating native account work (including after restart) keeps the persisted
    // denial in place until the user explicitly retries in Settings.
    lock(&google.work).unwrap().remove("a");
    let work = google.account_work("a").unwrap();
    assert_eq!(
        google.access_token("a", &work).await.unwrap_err().code,
        "SECURE_STORE"
    );
    assert_eq!(secrets.reads.load(Ordering::SeqCst), 1);
    assert_eq!(
        google
            .retry_credentials(&model::key(&["a"]))
            .await
            .unwrap_err()
            .code,
        "SECURE_STORE"
    );
    assert_eq!(secrets.reads.load(Ordering::SeqCst), 2);
    assert!(google.access_token("a", &work).await.is_err());
    assert_eq!(secrets.reads.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn network_refresh_failure_is_shared_and_retries_reuse_the_native_memory_secret() {
    let (mut google, secrets, _dir) = service();
    lock(&google.access).unwrap().clear();
    let (base, task) = server(vec![
        reply(503, json!({}), "POST /"),
        reply(
            200,
            json!({"access_token":"recovered-access","expires_in":3600}),
            "POST /",
        ),
    ])
    .await;
    google.token_endpoint = base;
    let work = google.account_work("a").unwrap();
    for _ in 0..20 {
        assert_eq!(
            google.access_token("a", &work).await.unwrap_err().code,
            "OAUTH_FAILED"
        );
    }
    assert_eq!(secrets.reads.load(Ordering::SeqCst), 1);
    lock(&work.credential).unwrap().failure = None;
    assert_eq!(
        google.access_token("a", &work).await.unwrap(),
        "recovered-access"
    );
    assert_eq!(secrets.reads.load(Ordering::SeqCst), 1);
    task.await.unwrap();
}
#[tokio::test]
async fn pagination_is_complete_and_partial_failure_preserves_cache() {
    let (mut google, _, _dir) = service();
    let (base, task) = server(vec![
        reply(
            200,
            json!({"kind":"calendar#events","items":[raw_event("one")],"nextPageToken":"second"}),
            "singleEvents=true",
        ),
        reply(
            200,
            json!({"kind":"calendar#events","items":[raw_event("two")]}),
            "pageToken=second",
        ),
        reply(
            200,
            json!({"kind":"calendar#events","items":[],"nextPageToken":"bad"}),
            "singleEvents=true",
        ),
        reply(403, json!({}), "pageToken=bad"),
    ])
    .await;
    google.api_base = base;
    let cal = model::key(&["a", "cal"]);
    google
        .sync(&cal, vec![bucket()], false, true)
        .await
        .unwrap();
    assert_eq!(
        google.snapshot().unwrap()["events"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    google
        .sync(&cal, vec![bucket()], false, true)
        .await
        .unwrap();
    assert_eq!(
        google.snapshot().unwrap()["events"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert!(google.snapshot().unwrap()["syncStatus"][0]["error"].is_string());
    task.await.unwrap();
}
#[tokio::test]
async fn empty_calendar_page_is_complete_and_cancelled_copies_do_not_reappear() {
    let (mut google, _, _dir) = service();
    let mut prior = bucket();
    prior.start_date = "2026-09-01".into();
    prior.end_date = "2026-10-01".into();
    {
        let mut cache = lock(&google.cache).unwrap();
        for b in [&bucket(), &prior] {
            cache
                .replace_bucket("a", "cal", 0, 0, b, &[raw_event("spanning")])
                .unwrap();
        }
    }
    let (base, task) = server(vec![reply(
        200,
        json!({"kind":"calendar#events"}),
        "singleEvents=true",
    )])
    .await;
    google.api_base = base;
    google
        .sync(&model::key(&["a", "cal"]), vec![bucket()], false, true)
        .await
        .unwrap();
    assert!(google.snapshot().unwrap()["events"]
        .as_array()
        .unwrap()
        .is_empty());
    assert_eq!(
        google.snapshot().unwrap()["syncStatus"][0]["coverage"][1]["complete"],
        true
    );
    task.await.unwrap();
}
#[tokio::test]
async fn disconnect_during_sync_cannot_restore_account_data() {
    let (mut google, _, _dir) = service();
    let mut response = reply(
        200,
        json!({"kind":"calendar#events","items":[raw_event("late")]}),
        "singleEvents=true",
    );
    response.delay = 80;
    let (base, task) = server(vec![response]).await;
    google.api_base = base;
    let calendar_id = model::key(&["a", "cal"]);
    let sync = google.sync(&calendar_id, vec![bucket()], false, true);
    let disconnect = async {
        tokio::time::sleep(Duration::from_millis(15)).await;
        google.disconnect(&model::key(&["a"])).await.unwrap();
    };
    let (_, _) = tokio::join!(sync, disconnect);
    assert!(google.snapshot().unwrap()["accounts"]
        .as_array()
        .unwrap()
        .is_empty());
    assert!(google.snapshot().unwrap()["events"]
        .as_array()
        .unwrap()
        .is_empty());
    task.await.unwrap();
}
#[tokio::test]
async fn stale_etag_and_guest_events_never_reach_patch() {
    for guest in [false, true] {
        let (mut google, _, _dir) = service();
        let mut event = raw_event("one");
        if guest {
            event["attendees"] = json!([{"email":"guest@example.com"}]);
        }
        let (base, task) = server(vec![reply(
            200,
            event,
            "GET /calendar/v3/calendars/cal/events/one",
        )])
        .await;
        google.api_base = base;
        let mutation: writes::Mutation=serde_json::from_value(json!({"operation":"update","calendarId":model::key(&["a","cal"]),"eventId":model::key(&["a","cal","one"]),"requestId":"1234567890abcdef","expectedEtag":"\"old\"","scope":"occurrence","changes":{"title":"Mine"}})).unwrap();
        assert_eq!(
            google.mutate(mutation).await.unwrap_err().code,
            if guest { "READ_ONLY" } else { "CONFLICT" }
        );
        task.await.unwrap();
    }
}
#[tokio::test]
async fn uncertain_creation_reconciles_with_stable_google_id() {
    let (mut google, _, _dir) = service();
    let request = "0123456789abcdef0123456789abcdef";
    let mut remote = raw_event(request);
    remote["extendedProperties"] = json!({"private":{"multiCalendarAttempt":request}});
    // The receipt still proves creation after an external client edits the new event.
    remote["summary"] = json!("External edit after creation");
    let (base, task) = server(vec![
        reply(503, json!({}), "POST /calendar/v3/calendars/cal/events"),
        reply(
            200,
            remote,
            "GET /calendar/v3/calendars/cal/events/0123456789abcdef0123456789abcdef",
        ),
    ])
    .await;
    google.api_base = base;
    let mutation:writes::Mutation=serde_json::from_value(json!({"operation":"create","calendarId":model::key(&["a","cal"]),"requestId":request,"scope":"series","input":{"title":"Original","start":"2026-10-26T14:00:00Z","end":"2026-10-26T15:00:00Z","allDay":false,"timeZone":"UTC"}})).unwrap();
    assert_eq!(
        google.mutate(mutation).await.unwrap()["title"],
        "External edit after creation"
    );
    assert_eq!(lock(&google.cache).unwrap().pending_count().unwrap(), 0);
    task.await.unwrap();
}
#[tokio::test]
async fn whole_series_inspection_checks_guests_on_later_pages() {
    let (mut google, _, _dir) = service();
    let mut instance = raw_event("instance");
    instance["recurringEventId"] = json!("parent");
    let mut parent = raw_event("parent");
    parent["recurrence"] = json!(["RRULE:FREQ=DAILY"]);
    let mut exception = instance.clone();
    exception["attendees"] = json!([{"email":"hidden@example.com"}]);
    let (base, task) = server(vec![
        reply(
            200,
            instance,
            "GET /calendar/v3/calendars/cal/events/instance",
        ),
        reply(
            200,
            json!({"kind":"calendar#events","items":[parent],"nextPageToken":"exceptions"}),
            "singleEvents=false",
        ),
        reply(
            200,
            json!({"kind":"calendar#events","items":[exception]}),
            "pageToken=exceptions",
        ),
    ])
    .await;
    google.api_base = base;
    let series = google
        .series(&model::key(&["a", "cal", "instance"]))
        .await
        .unwrap();
    assert_eq!(series["capabilities"]["edit"], false);
    assert_eq!(series["seriesScheduleEditable"], false);
    task.await.unwrap();
}

#[tokio::test]
async fn restart_recovers_a_receipt_by_reading_google_without_replaying_the_write() {
    let (google, secrets, dir) = service();
    let request = "a:stable-receipt";
    let raw = raw_event("recovered");
    lock(&google.cache)
        .unwrap()
        .prepare_mutation(
            request,
            ("a", "cal", "recovered"),
            "create",
            &json!({"summary":"Original"}),
            None,
            "series",
        )
        .unwrap();
    drop(google);
    let mut restored = Google::new(dir.0.clone()).unwrap();
    restored.secrets = secrets;
    lock(&restored.access).unwrap().insert(
        "a".into(),
        Access {
            token: "test-access".into(),
            expires: Instant::now() + Duration::from_secs(3600),
        },
    );
    let (base, task) = server(vec![reply(
        200,
        raw,
        "GET /calendar/v3/calendars/cal/events/recovered",
    )])
    .await;
    restored.api_base = base;
    assert_eq!(
        restored.recover_pending().await.unwrap()["pendingMutations"],
        0
    );
    task.await.unwrap();
}

#[tokio::test]
async fn remote_success_and_cache_failure_leave_a_committed_receipt() {
    let (mut google, _, _dir) = service();
    let request = "0123456789abcdef0123456789abcdef";
    lock(&google.cache).unwrap().db.execute_batch("CREATE TRIGGER fail_cache BEFORE UPDATE ON calendars WHEN NEW.revision=2 BEGIN SELECT RAISE(ABORT,'disk failure'); END;").unwrap();
    let (base, task) = server(vec![reply(
        200,
        raw_event(request),
        "POST /calendar/v3/calendars/cal/events",
    )])
    .await;
    google.api_base = base;
    let mutation:writes::Mutation=serde_json::from_value(json!({"operation":"create","calendarId":model::key(&["a","cal"]),"requestId":request,"scope":"series","input":{"title":"Original","start":"2026-10-26T14:00:00Z","end":"2026-10-26T15:00:00Z","allDay":false,"timeZone":"UTC"}})).unwrap();
    assert_eq!(
        google.mutate(mutation).await.unwrap_err().code,
        "REMOTE_COMMITTED"
    );
    assert_eq!(
        lock(&google.cache).unwrap().all_pending().unwrap()[0]["status"],
        "committed"
    );
    task.await.unwrap();
}

#[tokio::test]
async fn google_precondition_failure_does_not_retry_or_leave_an_uncertain_receipt() {
    let (mut google, _, _dir) = service();
    let (base, task) = server(vec![
        reply(
            200,
            raw_event("one"),
            "GET /calendar/v3/calendars/cal/events/one",
        ),
        reply(
            412,
            json!({}),
            "PATCH /calendar/v3/calendars/cal/events/one",
        ),
    ])
    .await;
    google.api_base = base;
    let mutation:writes::Mutation=serde_json::from_value(json!({"operation":"update","calendarId":model::key(&["a","cal"]),"eventId":model::key(&["a","cal","one"]),"requestId":"1234567890abcdef","expectedEtag":"\"v1\"","scope":"occurrence","changes":{"title":"Mine"}})).unwrap();
    assert_eq!(google.mutate(mutation).await.unwrap_err().code, "CONFLICT");
    assert_eq!(lock(&google.cache).unwrap().pending_count().unwrap(), 0);
    task.await.unwrap();
}

#[tokio::test]
async fn duplicate_bucket_requests_are_coalesced() {
    let (mut google, _, _dir) = service();
    let mut response = reply(
        200,
        json!({"kind":"calendar#events","items":[raw_event("once")]}),
        "singleEvents=true",
    );
    response.delay = 30;
    let (base, task) = server(vec![response]).await;
    google.api_base = base;
    let cal = model::key(&["a", "cal"]);
    let (a, b) = tokio::join!(
        google.sync(&cal, vec![bucket()], false, true),
        google.sync(&cal, vec![bucket()], false, true)
    );
    a.unwrap();
    b.unwrap();
    assert_eq!(
        google.snapshot().unwrap()["events"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    task.await.unwrap();
}

#[tokio::test]
async fn http_work_never_exceeds_four_global_or_two_per_account() {
    let (mut google, _, _dir) = service();
    lock(&google.cache)
        .unwrap()
        .save_account("b", &json!({"email":"b@example.test"}))
        .unwrap();
    for sub in ["a", "b"] {
        lock(&google.access).unwrap().insert(
            sub.into(),
            Access {
                token: format!("test-access-{sub}"),
                expires: Instant::now() + Duration::from_secs(3600),
            },
        );
    }
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    google.api_base = format!("http://{}/", listener.local_addr().unwrap());
    let active = Arc::new(Mutex::new((
        0usize,
        0usize,
        HashMap::<String, usize>::new(),
    )));
    let counts = active.clone();
    let server = tokio::spawn(async move {
        let mut tasks = tokio::task::JoinSet::new();
        for _ in 0..8 {
            let (mut socket, _) = listener.accept().await.unwrap();
            let counts = counts.clone();
            tasks.spawn(async move {
                let mut request=Vec::new();let mut buffer=[0u8;1024];while !request.windows(4).any(|v|v==b"\r\n\r\n") {let n=socket.read(&mut buffer).await.unwrap();assert!(n>0);request.extend_from_slice(&buffer[..n]);}
                let headers=String::from_utf8_lossy(&request);let account=if headers.contains("test-access-a") {"a"} else {"b"};
                {let mut count=counts.lock().unwrap();count.0+=1;count.1=count.1.max(count.0);assert!(count.0<=4);let per=count.2.entry(account.into()).or_default();*per+=1;assert!(*per<=2);}
                tokio::time::sleep(Duration::from_millis(40)).await;
                socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}").await.unwrap();
                {let mut count=counts.lock().unwrap();count.0-=1;*count.2.get_mut(account).unwrap()-=1;}
            });
        }
        while let Some(task) = tasks.join_next().await {
            task.unwrap();
        }
    });
    let calls = async {
        tokio::join!(
            google.api("a", Method::GET, &["test"], &[], None, None),
            google.api("a", Method::GET, &["test"], &[], None, None),
            google.api("a", Method::GET, &["test"], &[], None, None),
            google.api("a", Method::GET, &["test"], &[], None, None),
            google.api("b", Method::GET, &["test"], &[], None, None),
            google.api("b", Method::GET, &["test"], &[], None, None),
            google.api("b", Method::GET, &["test"], &[], None, None),
            google.api("b", Method::GET, &["test"], &[], None, None)
        )
    };
    let results = tokio::time::timeout(Duration::from_secs(5), calls)
        .await
        .unwrap();
    assert!([
        results.0, results.1, results.2, results.3, results.4, results.5, results.6, results.7
    ]
    .iter()
    .all(std::result::Result::is_ok));
    server.await.unwrap();
    assert!(active.lock().unwrap().1 <= 4);
}
