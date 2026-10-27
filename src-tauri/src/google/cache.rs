// SPDX-License-Identifier: AGPL-3.0-only
use super::model::{self, Bucket, Error, Result};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::path::Path;

pub struct Cache {
    pub db: Connection,
}
impl Cache {
    pub fn open(path: &Path) -> Result<Self> {
        Self::init(Connection::open(path)?)
    }
    pub fn init(db: Connection) -> Result<Self> {
        db.execute_batch("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS accounts(sub TEXT PRIMARY KEY, identity TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'connected');
        CREATE TABLE IF NOT EXISTS calendars(sub TEXT NOT NULL REFERENCES accounts(sub) ON DELETE CASCADE, id TEXT NOT NULL, raw TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, last_success INTEGER, error TEXT, retry_at INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(sub,id));
        CREATE TABLE IF NOT EXISTS buckets(sub TEXT NOT NULL, calendar TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL, complete INTEGER NOT NULL DEFAULT 0, fetched INTEGER, PRIMARY KEY(sub,calendar,start), FOREIGN KEY(sub,calendar) REFERENCES calendars(sub,id) ON DELETE CASCADE);
        CREATE TABLE IF NOT EXISTS events(sub TEXT NOT NULL, calendar TEXT NOT NULL, id TEXT NOT NULL, raw TEXT NOT NULL, PRIMARY KEY(sub,calendar,id), FOREIGN KEY(sub,calendar) REFERENCES calendars(sub,id) ON DELETE CASCADE);
        CREATE TABLE IF NOT EXISTS bucket_events(sub TEXT NOT NULL, calendar TEXT NOT NULL, bucket TEXT NOT NULL, event TEXT NOT NULL, PRIMARY KEY(sub,calendar,bucket,event), FOREIGN KEY(sub,calendar,bucket) REFERENCES buckets(sub,calendar,start) ON DELETE CASCADE, FOREIGN KEY(sub,calendar,event) REFERENCES events(sub,calendar,id) ON DELETE CASCADE);
        CREATE TABLE IF NOT EXISTS mutations(request_id TEXT PRIMARY KEY, sub TEXT NOT NULL REFERENCES accounts(sub) ON DELETE CASCADE, calendar TEXT NOT NULL, event TEXT NOT NULL, operation TEXT NOT NULL, body TEXT NOT NULL, etag TEXT, status TEXT NOT NULL DEFAULT 'uncertain', scope TEXT NOT NULL DEFAULT 'occurrence');")?;
        let has_scope = db
            .prepare("PRAGMA table_info(mutations)")?
            .query_map([], |r| r.get::<_, String>(1))?
            .collect::<std::result::Result<Vec<_>, _>>()?
            .iter()
            .any(|name| name == "scope");
        if !has_scope {
            db.execute(
                "ALTER TABLE mutations ADD COLUMN scope TEXT NOT NULL DEFAULT 'occurrence'",
                [],
            )?;
        }
        Ok(Self { db })
    }
    pub fn accounts(&self) -> Result<Vec<Value>> {
        let mut stmt = self
            .db
            .prepare("SELECT sub,identity,status FROM accounts ORDER BY rowid")?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?;
        rows.map(|r| {
            let (sub, raw, status) = r?;
            let mut value = model::account(&sub, &serde_json::from_str(&raw)?);
            value["connectionStatus"] = json!(status);
            Ok(value)
        })
        .collect()
    }
    pub fn exists(&self, sub: &str) -> Result<bool> {
        Ok(self.db.query_row(
            "SELECT EXISTS(SELECT 1 FROM accounts WHERE sub=?)",
            [sub],
            |r| r.get(0),
        )?)
    }
    pub fn connection_status(&self, sub: &str) -> Result<String> {
        self.db
            .query_row("SELECT status FROM accounts WHERE sub=?", [sub], |r| {
                r.get(0)
            })
            .optional()?
            .ok_or_else(|| Error::new("DISCONNECTED", "This Google account is disconnected."))
    }
    pub fn generation(&self, sub: &str) -> Result<i64> {
        self.db
            .query_row("SELECT generation FROM accounts WHERE sub=?", [sub], |r| {
                r.get(0)
            })
            .optional()?
            .ok_or_else(|| Error::new("DISCONNECTED", "This Google account is disconnected."))
    }
    pub fn save_account(&self, sub: &str, identity: &Value) -> Result<()> {
        self.db.execute("INSERT INTO accounts(sub,identity) VALUES(?,?) ON CONFLICT(sub) DO UPDATE SET identity=excluded.identity, status='connected', generation=generation+1", params![sub,identity.to_string()])?;
        Ok(())
    }
    pub fn status(&self, sub: &str, status: &str) -> Result<()> {
        self.db.execute(
            "UPDATE accounts SET status=? WHERE sub=?",
            params![status, sub],
        )?;
        Ok(())
    }
    pub fn disconnect(&self, sub: &str) -> Result<()> {
        self.db.execute("DELETE FROM accounts WHERE sub=?", [sub])?;
        Ok(())
    }
    pub fn calendars(&self) -> Result<Vec<Value>> {
        let mut stmt = self
            .db
            .prepare("SELECT c.sub,c.raw,a.identity FROM calendars c JOIN accounts a ON a.sub=c.sub ORDER BY a.rowid,c.rowid")?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?;
        rows.map(|r| {
            let (sub, raw, identity) = r?;
            let mut calendar = model::calendar(&sub, &serde_json::from_str(&raw)?);
            calendar["accountEmail"] = serde_json::from_str::<Value>(&identity)?["email"].clone();
            Ok(calendar)
        })
        .collect()
    }
    pub fn raw_calendar(&self, sub: &str, cal: &str) -> Result<Value> {
        let raw: String = self
            .db
            .query_row(
                "SELECT raw FROM calendars WHERE sub=? AND id=?",
                params![sub, cal],
                |r| r.get(0),
            )
            .optional()?
            .ok_or_else(|| Error::new("NOT_FOUND", "This calendar is no longer connected."))?;
        Ok(serde_json::from_str(&raw)?)
    }
    pub fn revision(&self, sub: &str, cal: &str) -> Result<i64> {
        Ok(self.db.query_row(
            "SELECT revision FROM calendars WHERE sub=? AND id=?",
            params![sub, cal],
            |r| r.get(0),
        )?)
    }
    pub fn replace_calendars(
        &mut self,
        sub: &str,
        generation: i64,
        calendars: &[Value],
    ) -> Result<()> {
        if self.generation(sub)? != generation {
            return Err(Error::new("CANCELLED", "Account changed during refresh."));
        }
        let tx = self.db.transaction()?;
        // Stage IDs so removed calendars and their dependent cache disappear atomically.
        tx.execute_batch("CREATE TEMP TABLE IF NOT EXISTS current_calendars(id TEXT PRIMARY KEY); DELETE FROM current_calendars;")?;
        for cal in calendars {
            let id = model::string(cal, "id");
            if id.is_empty() {
                return Err(Error::new(
                    "INVALID_DATA",
                    "Google returned a calendar without an identity.",
                ));
            }
            tx.execute("INSERT INTO current_calendars(id) VALUES(?)", [id])?;
            tx.execute("INSERT INTO calendars(sub,id,raw) VALUES(?,?,?) ON CONFLICT(sub,id) DO UPDATE SET raw=excluded.raw", params![sub,id,cal.to_string()])?;
        }
        tx.execute(
            "DELETE FROM calendars WHERE sub=? AND id NOT IN (SELECT id FROM current_calendars)",
            [sub],
        )?;
        tx.commit()?;
        Ok(())
    }
    pub fn replace_bucket(
        &mut self,
        sub: &str,
        cal: &str,
        generation: i64,
        revision: i64,
        bucket: &Bucket,
        events: &[Value],
    ) -> Result<bool> {
        if self.generation(sub)? != generation || self.revision(sub, cal)? != revision {
            return Ok(false);
        }
        let tx = self.db.transaction()?;
        let now = Utc::now().timestamp();
        tx.execute("INSERT INTO buckets(sub,calendar,start,end,complete,fetched) VALUES(?,?,?,?,1,?) ON CONFLICT(sub,calendar,start) DO UPDATE SET complete=1,fetched=excluded.fetched",params![sub,cal,bucket.start_date,bucket.end_date,now])?;
        tx.execute_batch("CREATE TEMP TABLE IF NOT EXISTS fetched_events(id TEXT PRIMARY KEY); DELETE FROM fetched_events;")?;
        for event in events {
            let id = model::string(event, "id");
            if id.is_empty() {
                return Err(Error::new(
                    "INVALID_DATA",
                    "Google returned an event without an identity.",
                ));
            }
            tx.execute("INSERT OR IGNORE INTO fetched_events(id) VALUES(?)", [id])?;
        }
        // An event absent from a freshly complete bucket invalidates every older copy,
        // including a cancelled or moved occurrence spanning a neighboring bucket.
        tx.execute("DELETE FROM events WHERE sub=? AND calendar=? AND id IN (SELECT event FROM bucket_events WHERE sub=? AND calendar=? AND bucket=?) AND id NOT IN (SELECT id FROM fetched_events)",params![sub,cal,sub,cal,bucket.start_date])?;
        tx.execute(
            "DELETE FROM bucket_events WHERE sub=? AND calendar=? AND bucket=?",
            params![sub, cal, bucket.start_date],
        )?;
        for event in events {
            let id = model::string(event, "id");
            if id.is_empty() {
                return Err(Error::new(
                    "INVALID_DATA",
                    "Google returned an event without an identity.",
                ));
            }
            tx.execute("INSERT INTO events(sub,calendar,id,raw) VALUES(?,?,?,?) ON CONFLICT(sub,calendar,id) DO UPDATE SET raw=excluded.raw",params![sub,cal,id,event.to_string()])?;
            tx.execute(
                "INSERT OR IGNORE INTO bucket_events(sub,calendar,bucket,event) VALUES(?,?,?,?)",
                params![sub, cal, bucket.start_date, id],
            )?;
        }
        tx.execute("DELETE FROM events WHERE sub=? AND calendar=? AND NOT EXISTS(SELECT 1 FROM bucket_events b WHERE b.sub=events.sub AND b.calendar=events.calendar AND b.event=events.id)",params![sub,cal])?;
        tx.execute("UPDATE calendars SET last_success=?,error=NULL,failures=0,retry_at=0 WHERE sub=? AND id=?",params![now,sub,cal])?;
        tx.commit()?;
        Ok(true)
    }
    pub fn events(&self) -> Result<Vec<Value>> {
        let mut stmt = self.db.prepare("SELECT e.sub,c.raw,e.raw FROM events e JOIN calendars c ON c.sub=e.sub AND c.id=e.calendar")?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?;
        let mut events = Vec::new();
        for row in rows {
            let (sub, cal, raw) = row?;
            if let Some(event) = model::event(
                &sub,
                &serde_json::from_str(&cal)?,
                &serde_json::from_str(&raw)?,
            ) {
                events.push(event);
            }
        }
        Ok(events)
    }
    pub fn sync_status(&self) -> Result<Vec<Value>> {
        let mut stmt = self
            .db
            .prepare("SELECT sub,id,last_success,error,retry_at FROM calendars")?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<i64>>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, i64>(4)?,
            ))
        })?;
        rows.map(|r| {
            let (sub,cal,last,error,retry) = r?;
            let mut buckets = self.db.prepare("SELECT start,end,complete,fetched FROM buckets WHERE sub=? AND calendar=?")?;
            let coverage = buckets.query_map(params![sub,cal],|r| Ok(json!({"startDate":r.get::<_,String>(0)?,"endDate":r.get::<_,String>(1)?,"complete":r.get::<_,bool>(2)?,"fetchedAt":r.get::<_,Option<i64>>(3)?})))?.collect::<std::result::Result<Vec<_>,_>>()?;
            Ok(json!({"accountId":model::key(&[&sub]),"calendarId":model::key(&[&sub,&cal]),"lastSuccess":last,"error":error,"retryAt":retry,"coverage":coverage}))
        }).collect()
    }
    pub fn sync_failure(&self, sub: &str, cal: &str, message: &str) -> Result<()> {
        self.db.execute("UPDATE calendars SET error=?,failures=min(failures+1,8),retry_at=?+min(300,5*(1 << min(failures,6))) WHERE sub=? AND id=?",params![message,Utc::now().timestamp(),sub,cal])?;
        Ok(())
    }
    pub fn retry_at(&self, sub: &str, cal: &str) -> Result<i64> {
        Ok(self.db.query_row(
            "SELECT retry_at FROM calendars WHERE sub=? AND id=?",
            params![sub, cal],
            |r| r.get(0),
        )?)
    }
    pub fn invalidate(
        &mut self,
        sub: &str,
        cal: &str,
        raw: Option<&Value>,
        deleted: Option<&str>,
        series: bool,
    ) -> Result<()> {
        let tx = self.db.transaction()?;
        tx.execute(
            "UPDATE calendars SET revision=revision+1 WHERE sub=? AND id=?",
            params![sub, cal],
        )?;
        tx.execute(
            "UPDATE buckets SET complete=0 WHERE sub=? AND calendar=?",
            params![sub, cal],
        )?;
        if series {
            if let Some(parent) = deleted.or_else(|| raw.and_then(|r| r["id"].as_str())) {
                tx.execute("DELETE FROM events WHERE sub=? AND calendar=? AND (id=? OR json_extract(raw,'$.recurringEventId')=?)",params![sub,cal,parent,parent])?;
            }
        }
        if let Some(id) = deleted {
            tx.execute(
                "DELETE FROM events WHERE sub=? AND calendar=? AND id=?",
                params![sub, cal, id],
            )?;
        }
        if let Some(raw) = raw {
            tx.execute(
                "UPDATE events SET raw=? WHERE sub=? AND calendar=? AND id=?",
                params![raw.to_string(), sub, cal, model::string(raw, "id")],
            )?;
        }
        tx.commit()?;
        Ok(())
    }
    pub fn pending(&self, request: &str) -> Result<Option<Value>> {
        let row = self
            .db
            .query_row(
                "SELECT operation,event,body,etag,status,sub,calendar,scope FROM mutations WHERE request_id=?",
                [request],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, Option<String>>(3)?,
                        r.get::<_, String>(4)?,
                        r.get::<_, String>(5)?,
                        r.get::<_, String>(6)?,
                        r.get::<_, String>(7)?,
                    ))
                },
            )
            .optional()?;
        row.map(|(operation,event,body,etag,status,sub,calendar,scope)|Ok(json!({"requestId":request,"operation":operation,"event":event,"body":serde_json::from_str::<Value>(&body)?,"etag":etag,"status":status,"sub":sub,"calendar":calendar,"scope":scope}))).transpose()
    }
    pub fn all_pending(&self) -> Result<Vec<Value>> {
        let mut stmt = self
            .db
            .prepare("SELECT request_id FROM mutations ORDER BY rowid")?;
        let ids = stmt
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        ids.iter()
            .map(|id| {
                self.pending(id)?
                    .ok_or_else(|| Error::new("NOT_FOUND", "This receipt no longer exists."))
            })
            .collect()
    }
    pub fn prepare_mutation(
        &self,
        request: &str,
        target: (&str, &str, &str),
        operation: &str,
        body: &Value,
        etag: Option<&str>,
        scope: &str,
    ) -> Result<()> {
        let (sub, cal, event) = target;
        self.db.execute("INSERT OR IGNORE INTO mutations(request_id,sub,calendar,event,operation,body,etag,scope) VALUES(?,?,?,?,?,?,?,?)",params![request,sub,cal,event,operation,body.to_string(),etag,scope])?;
        Ok(())
    }
    pub fn finish_mutation(&self, request: &str) -> Result<()> {
        self.db
            .execute("DELETE FROM mutations WHERE request_id=?", [request])?;
        Ok(())
    }
    pub fn pending_count(&self) -> Result<i64> {
        Ok(self
            .db
            .query_row("SELECT count(*) FROM mutations", [], |r| r.get(0))?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn cache() -> Cache {
        let c = Cache::init(Connection::open_in_memory().unwrap()).unwrap();
        c.save_account("a", &json!({"email":"a@x"})).unwrap();
        c
    }
    fn bucket() -> Bucket {
        Bucket {
            start_date: "2026-10-01".into(),
            end_date: "2026-11-01".into(),
            time_zone: "UTC".into(),
        }
    }
    #[test]
    fn replacement_rolls_back_and_disconnect_cascades() {
        let mut c = cache();
        c.replace_calendars("a", 0, &[json!({"id":"cal"})]).unwrap();
        c.replace_bucket("a", "cal", 0, 0, &bucket(), &[json!({"id":"old"})])
            .unwrap();
        assert!(c
            .replace_bucket(
                "a",
                "cal",
                0,
                0,
                &bucket(),
                &[json!({"id":"new"}), json!({})]
            )
            .is_err());
        let count: i64 =
            c.db.query_row("SELECT count(*) FROM events WHERE id='old'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(count, 1);
        c.disconnect("a").unwrap();
        assert_eq!(
            c.db.query_row("SELECT count(*) FROM events", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert!(c.replace_bucket("a", "cal", 0, 0, &bucket(), &[]).is_err());
    }
    #[test]
    fn mutation_revision_rejects_old_sync_and_accounts_are_isolated() {
        let mut c = cache();
        c.save_account("b", &json!({"email":"b@x"})).unwrap();
        for sub in ["a", "b"] {
            c.replace_calendars(sub, 0, &[json!({"id":"same"})])
                .unwrap();
            c.replace_bucket(sub, "same", 0, 0, &bucket(), &[json!({"id":"same"})])
                .unwrap();
        }
        c.invalidate("a", "same", None, Some("same"), false)
            .unwrap();
        assert!(!c
            .replace_bucket("a", "same", 0, 0, &bucket(), &[json!({"id":"same"})])
            .unwrap());
        c.disconnect("a").unwrap();
        assert!(c.exists("b").unwrap());
        assert_eq!(
            c.db.query_row("SELECT count(*) FROM events", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn series_invalidation_preserves_unrelated_downloaded_events() {
        let mut c = cache();
        c.replace_calendars("a", 0, &[json!({"id":"cal"})]).unwrap();
        c.replace_bucket(
            "a",
            "cal",
            0,
            0,
            &bucket(),
            &[
                json!({"id":"parent_1","recurringEventId":"parent"}),
                json!({"id":"unrelated"}),
            ],
        )
        .unwrap();
        c.invalidate("a", "cal", None, Some("parent"), true)
            .unwrap();
        assert_eq!(
            c.db.query_row(
                "SELECT count(*) FROM events WHERE id='unrelated'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        assert_eq!(
            c.db.query_row("SELECT count(*) FROM events WHERE id='parent_1'", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            c.db.query_row("SELECT complete FROM buckets", [], |r| r.get::<_, bool>(0))
                .unwrap(),
            false
        );
    }
}
