// SPDX-License-Identifier: AGPL-3.0-only
use super::{
    lock,
    model::{self, Error, Result},
    Google,
};
use chrono::{DateTime, NaiveDate};
use reqwest::Method;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use tauri::State;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Mutation {
    operation: String,
    calendar_id: String,
    event_id: Option<String>,
    request_id: String,
    expected_etag: Option<String>,
    scope: String,
    input: Option<Value>,
    changes: Option<Value>,
}

fn recurrence(value: &Value) -> Result<Value> {
    if value.is_null() {
        return Ok(json!([]));
    }
    let rules = value.as_array().filter(|v| v.len() == 1).ok_or_else(|| {
        Error::new(
            "UNSUPPORTED_RECURRENCE",
            "Use a common recurrence rule, or open this series in Google Calendar.",
        )
    })?;
    let text = rules[0]
        .as_str()
        .and_then(|v| v.strip_prefix("RRULE:"))
        .ok_or_else(|| Error::new("INVALID_EVENT", "Invalid recurrence rule."))?;
    let mut fields = std::collections::HashMap::new();
    for field in text.split(';') {
        let (k, v) = field
            .split_once('=')
            .ok_or_else(|| Error::new("INVALID_EVENT", "Invalid recurrence rule."))?;
        if fields.insert(k, v).is_some() {
            return Err(Error::new("INVALID_EVENT", "Repeated recurrence field."));
        }
    }
    let freq = fields.get("FREQ").copied().unwrap_or("");
    if !matches!(freq, "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY")
        || fields.keys().any(|k| {
            !matches!(
                *k,
                "FREQ" | "INTERVAL" | "BYDAY" | "BYMONTHDAY" | "BYMONTH" | "COUNT" | "UNTIL"
            )
        })
    {
        return Err(Error::new(
            "UNSUPPORTED_RECURRENCE",
            "This recurrence pattern must be edited in Google Calendar.",
        ));
    }
    for (key, max) in [
        ("INTERVAL", 999),
        ("COUNT", 9999),
        ("BYMONTHDAY", 31),
        ("BYMONTH", 12),
    ] {
        if let Some(value) = fields.get(key) {
            if value
                .parse::<u32>()
                .ok()
                .filter(|v| *v > 0 && *v <= max)
                .is_none()
            {
                return Err(Error::new(
                    "INVALID_EVENT",
                    "Invalid recurrence interval or ending.",
                ));
            }
        }
    }
    if fields.contains_key("COUNT") && fields.contains_key("UNTIL") {
        return Err(Error::new("INVALID_EVENT", "Choose one recurrence ending."));
    }
    if let Some(until) = fields.get("UNTIL") {
        let valid = NaiveDate::parse_from_str(until, "%Y%m%d").is_ok()
            || chrono::NaiveDateTime::parse_from_str(until, "%Y%m%dT%H%M%SZ").is_ok();
        if !valid {
            return Err(Error::new("INVALID_EVENT", "Invalid recurrence end date."));
        }
    }
    if let Some(days) = fields.get("BYDAY") {
        if freq != "WEEKLY"
            || days
                .split(',')
                .any(|v| !matches!(v, "SU" | "MO" | "TU" | "WE" | "TH" | "FR" | "SA"))
        {
            return Err(Error::new(
                "UNSUPPORTED_RECURRENCE",
                "Choose weekdays for a weekly recurrence.",
            ));
        }
    }
    if fields.contains_key("BYMONTHDAY") && !matches!(freq, "MONTHLY" | "YEARLY")
        || fields.contains_key("BYMONTH") && freq != "YEARLY"
    {
        return Err(Error::new(
            "UNSUPPORTED_RECURRENCE",
            "This recurrence pattern must be edited in Google Calendar.",
        ));
    }
    Ok(value.clone())
}
fn patch(changes: &Value) -> Result<Value> {
    let changes = changes
        .as_object()
        .ok_or_else(|| Error::new("INVALID_EVENT", "Supply explicit changed fields."))?;
    let mut body = json!({});
    for (field, value) in changes {
        match field.as_str() {
            "title" => {
                let title = value
                    .as_str()
                    .filter(|v| !v.trim().is_empty() && v.len() <= 1200)
                    .ok_or_else(|| Error::new("INVALID_EVENT", "Give the event a title."))?;
                body["summary"] = json!(title.trim());
            }
            "description" | "location" => {
                if !value.is_null() && value.as_str().is_none() {
                    return Err(Error::new(
                        "INVALID_EVENT",
                        "Description and location must be text or null to clear.",
                    ));
                }
                body[field] = value.clone();
            }
            "timing" => {
                let (start, end) = model::timing(value)?;
                body["start"] = start;
                body["end"] = end;
            }
            "recurrence" => body["recurrence"] = recurrence(value)?,
            _ => {
                return Err(Error::new(
                    "INVALID_EVENT",
                    "Unsupported event field. Reload the event before editing.",
                ))
            }
        }
    }
    if body.as_object().unwrap().is_empty() {
        return Err(Error::new(
            "INVALID_EVENT",
            "No changed fields were supplied.",
        ));
    }
    Ok(body)
}
fn same_time(a: &Value, b: &Value) -> bool {
    if a["date"].is_string() || b["date"].is_string() {
        return a["date"] == b["date"];
    }
    let a = a["dateTime"]
        .as_str()
        .and_then(|v| DateTime::parse_from_rfc3339(v).ok());
    let b = b["dateTime"]
        .as_str()
        .and_then(|v| DateTime::parse_from_rfc3339(v).ok());
    a.is_some() && a == b
}
fn contains_patch(remote: &Value, body: &Value) -> bool {
    body.as_object().is_some_and(|body| {
        body.iter().all(|(field, value)| {
            if matches!(field.as_str(), "start" | "end") {
                same_time(&remote[field], value)
            } else if field == "recurrence" && value.as_array().is_some_and(Vec::is_empty) {
                remote[field].is_null() || remote[field].as_array().is_some_and(Vec::is_empty)
            } else if value.is_null() {
                remote[field].is_null() || remote[field] == ""
            } else {
                remote[field] == *value
            }
        })
    })
}
impl Google {
    pub(super) async fn recover_pending(&self) -> Result<Value> {
        let receipts = lock(&self.cache)?.all_pending()?;
        for receipt in receipts {
            let (sub, cal, id, operation, request) = (
                model::string(&receipt, "sub"),
                model::string(&receipt, "calendar"),
                model::string(&receipt, "event"),
                model::string(&receipt, "operation"),
                model::string(&receipt, "requestId"),
            );
            let work = self.account_work(sub)?;
            let _write = work.writes.lock().await;
            work.cancel.check()?;
            let reconciled = self
                .reconcile(sub, cal, id, operation, &receipt["body"])
                .await;
            if let Ok(Some(result)) = &reconciled {
                let _ = self.finish_write(
                    request,
                    (sub, cal, id),
                    operation,
                    result,
                    receipt["scope"] == "series",
                );
            } else if matches!(reconciled, Ok(None)) && receipt["status"] == "committed" {
                // A persisted success receipt remains authoritative after external edits.
                // Reload current resources instead of replaying an already committed write.
                let mut cache = lock(&self.cache)?;
                cache.invalidate(sub, cal, None, None, false)?;
                cache.finish_mutation(request)?;
            }
        }
        self.snapshot()
    }
    async fn retry_pending(&self, request: &str) -> Result<Value> {
        self.recover_pending().await?;
        let Some(receipt) = lock(&self.cache)?.pending(request)? else {
            return self.snapshot();
        };
        let body = &receipt["body"];
        let mut changes = json!({});
        for (native, field) in [
            ("summary", "title"),
            ("description", "description"),
            ("location", "location"),
            ("recurrence", "recurrence"),
        ] {
            if let Some(value) = body.get(native) {
                changes[field] = value.clone();
            }
        }
        if body.get("start").is_some() {
            let all_day = body["start"]["date"].is_string();
            let field = if all_day { "date" } else { "dateTime" };
            changes["timing"] = json!({"start":body["start"][field],"end":body["end"][field],"allDay":all_day,"timeZone":body["start"]["timeZone"].as_str().unwrap_or("UTC")});
        }
        let mut input = changes["timing"].clone();
        if !input.is_object() {
            input = json!({});
        }
        for field in ["title", "description", "location", "recurrence"] {
            if let Some(value) = changes.get(field) {
                input[field] = value.clone();
            }
        }
        let creating = receipt["operation"] == "create";
        let mutation = Mutation {
            operation: model::string(&receipt, "operation").into(),
            calendar_id: model::key(&[
                model::string(&receipt, "sub"),
                model::string(&receipt, "calendar"),
            ]),
            event_id: Some(model::key(&[
                model::string(&receipt, "sub"),
                model::string(&receipt, "calendar"),
                model::string(&receipt, "event"),
            ])),
            request_id: if creating {
                body["extendedProperties"]["private"]["multiCalendarAttempt"]
                    .as_str()
                    .ok_or_else(|| {
                        Error::new("INVALID_DATA", "The creation receipt is incomplete.")
                    })?
                    .into()
            } else {
                "recover-pending-attempt".into()
            },
            expected_etag: receipt["etag"].as_str().map(str::to_owned),
            scope: model::string(&receipt, "scope").into(),
            input: if creating { Some(input) } else { None },
            changes: if creating { None } else { Some(changes) },
        };
        self.mutate(mutation).await?;
        self.snapshot()
    }
    async fn inspect_series(
        &self,
        sub: &str,
        cal: &str,
        id: &str,
    ) -> Result<(Value, bool, Option<String>)> {
        let raw = self
            .api(
                sub,
                Method::GET,
                &["calendars", cal, "events", id],
                &[],
                None,
                None,
            )
            .await?;
        let parent = model::string(&raw, "recurringEventId");
        let parent = if parent.is_empty() {
            model::string(&raw, "id")
        } else {
            parent
        };
        let family = self
            .pages(
                sub,
                &["calendars", cal, "events"],
                vec![
                    ("singleEvents", "false".into()),
                    ("showDeleted", "true".into()),
                    ("maxResults", "2500".into()),
                ],
            )
            .await?;
        let parent_raw=family.iter().find(|e|model::string(e,"id")==parent).ok_or_else(||Error::new("READ_ONLY","The complete recurring family could not be verified. Open it in Google Calendar."))?.clone();
        let calendar = lock(&self.cache)?.raw_calendar(sub, cal)?;
        let mut has_exceptions = false;
        let mut reason = None;
        for member in family.iter().filter(|e| {
            model::string(e, "id") == parent || model::string(e, "recurringEventId") == parent
        }) {
            if model::string(member, "id") != parent {
                has_exceptions = true;
            }
            if let Some(why) = model::read_only_reason(member, &calendar) {
                reason = Some(format!("This series is read-only: {why}"));
            }
        }
        Ok((parent_raw, has_exceptions, reason))
    }
    pub(super) async fn series(&self, event_id: &str) -> Result<Value> {
        let p = model::parts(event_id, 3)?;
        let (raw, exceptions, reason) = self.inspect_series(&p[0], &p[1], &p[2]).await?;
        let cal = lock(&self.cache)?.raw_calendar(&p[0], &p[1])?;
        let mut event = model::event(&p[0], &cal, &raw)
            .ok_or_else(|| Error::new("READ_ONLY", "This series cannot be edited here."))?;
        if let Some(reason) = &reason {
            event["capabilities"] = json!({"edit":false,"delete":false,"reason":reason});
        }
        event["seriesScheduleEditable"] = json!(!exceptions && reason.is_none());
        event["seriesScheduleReason"] = json!(if exceptions {
            Some("This series has exceptions. Its schedule and recurrence must be edited in Google Calendar.")
        } else {
            None
        });
        Ok(event)
    }
    async fn reconcile(
        &self,
        sub: &str,
        cal: &str,
        id: &str,
        operation: &str,
        body: &Value,
    ) -> Result<Option<Value>> {
        match self.api(sub,Method::GET,&["calendars",cal,"events",id],&[],None,None).await {
            Ok(raw) if operation=="delete" && raw["status"]=="cancelled"=>Ok(Some(Value::Null)),
            Ok(raw) if operation=="create" && body["extendedProperties"]["private"]["multiCalendarAttempt"].as_str().is_some_and(|attempt|raw["extendedProperties"]["private"]["multiCalendarAttempt"]==attempt)=>Ok(Some(raw)),
            Ok(raw) if operation!="delete" && contains_patch(&raw,body)=>Ok(Some(raw)),
            Ok(_)=>Ok(None),
            Err(error) if error.code=="NOT_FOUND" && operation=="delete"=>Ok(Some(Value::Null)),
            Err(error) if error.code=="NOT_FOUND"=>Ok(None),
            Err(_)=>Err(Error::new("UNCERTAIN_WRITE","Google may have received this change. Refresh or retry this same attempt when online; do not create a second copy."))
        }
    }
    fn finish_write(
        &self,
        request: &str,
        target: (&str, &str, &str),
        operation: &str,
        result: &Value,
        series: bool,
    ) -> Result<Value> {
        let (sub, cal, id) = target;
        let mut cache = lock(&self.cache)?;
        if !cache.exists(sub)? {
            return Err(Error::new(
                "DISCONNECTED",
                "The account was disconnected. Google may already have applied this change.",
            ));
        }
        let saved = cache
            .invalidate(
                sub,
                cal,
                if operation == "delete" {
                    None
                } else {
                    Some(result)
                },
                if operation == "delete" {
                    Some(id)
                } else {
                    None
                },
                series,
            )
            .and_then(|_| cache.finish_mutation(request));
        if saved.is_err() {
            return Err(Error::new("REMOTE_COMMITTED","Google saved this change, but the local cache could not be updated. Refresh the calendar; do not create another copy."));
        }
        let calendar = cache.raw_calendar(sub, cal)?;
        Ok(if operation == "delete" {
            Value::Null
        } else {
            model::event(sub, &calendar, result).unwrap_or(Value::Null)
        })
    }
    pub(super) async fn mutate(&self, mutation: Mutation) -> Result<Value> {
        let p = model::parts(&mutation.calendar_id, 2)?;
        let (sub, cal) = (&p[0], &p[1]);
        let work = self.account_work(sub)?;
        let _write = work.writes.lock().await;
        work.cancel.check()?;
        if !matches!(mutation.scope.as_str(), "occurrence" | "series")
            || !matches!(mutation.operation.as_str(), "create" | "update" | "delete")
        {
            return Err(Error::new(
                "INVALID_EVENT",
                "Choose an explicit mutation operation and scope.",
            ));
        }
        if mutation.request_id.len() < 16
            || mutation.request_id.len() > 128
            || !mutation
                .request_id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-')
        {
            return Err(Error::new(
                "INVALID_EVENT",
                "Invalid creation attempt identity.",
            ));
        }
        let calendar = lock(&self.cache)?.raw_calendar(sub, cal)?;
        if !model::writable(&calendar) {
            return Err(Error::new("READ_ONLY", "Choose a writable calendar."));
        }
        let creating = mutation.operation == "create";
        let mut id = if creating {
            mutation.request_id.replace('-', "").to_lowercase()
        } else {
            let id = mutation
                .event_id
                .as_deref()
                .ok_or_else(|| Error::new("INVALID_EVENT", "Choose an event."))?;
            let ep = model::parts(id, 3)?;
            if ep[0] != *sub || ep[1] != *cal {
                return Err(Error::new(
                    "INVALID_EVENT",
                    "Moving events between Google calendars is not supported.",
                ));
            }
            ep[2].clone()
        };
        if creating && !id.bytes().all(|c| matches!(c,b'0'..=b'9'|b'a'..=b'v')) {
            return Err(Error::new(
                "INVALID_EVENT",
                "Creation attempt IDs must use Google-compatible base32hex characters.",
            ));
        }
        let body =
            if creating {
                let input = mutation
                    .input
                    .as_ref()
                    .ok_or_else(|| Error::new("INVALID_EVENT", "Supply the new event."))?;
                let mut changes = json!({"title":input["title"],"timing":input});
                for field in ["description", "location", "recurrence"] {
                    if input.get(field).is_some() {
                        changes[field] = input[field].clone();
                    }
                }
                let mut body = patch(&changes)?;
                body["id"] = json!(id);
                body["extendedProperties"] =
                    json!({"private":{"multiCalendarAttempt":mutation.request_id}});
                body
            } else if mutation.operation == "update" {
                patch(mutation.changes.as_ref().ok_or_else(|| {
                    Error::new("INVALID_EVENT", "Supply explicit changed fields.")
                })?)?
            } else {
                json!({})
            };
        let etag = mutation.expected_etag.as_deref();
        if !creating && etag.is_none_or(str::is_empty) {
            return Err(Error::new(
                "CONFLICT",
                "Reload the event before editing so its version can be checked.",
            ));
        }
        let digest = format!(
            "{:x}",
            Sha256::digest(
                format!(
                    "{}:{}:{}:{}:{}",
                    mutation.calendar_id,
                    id,
                    mutation.operation,
                    etag.unwrap_or(""),
                    body
                )
                .as_bytes()
            )
        );
        let request = if creating {
            format!("{}:{}", mutation.calendar_id, mutation.request_id)
        } else {
            digest
        };
        let prior = lock(&self.cache)?.pending(&request)?;
        if let Some(prior) = prior {
            if prior["body"] != body {
                return Err(Error::new("UNCERTAIN_WRITE","This attempt is awaiting reconciliation. Retry its original values or refresh before changing it."));
            }
            if let Some(result) = self
                .reconcile(sub, cal, &id, &mutation.operation, &body)
                .await?
            {
                return self.finish_write(
                    &request,
                    (sub, cal, &id),
                    &mutation.operation,
                    &result,
                    mutation.scope == "series",
                );
            }
            if prior["status"] == "committed" {
                return Err(Error::new(
                    "REMOTE_COMMITTED",
                    "Google saved this change. Refresh the calendar before editing again.",
                ));
            }
        }
        if !creating {
            let raw = if mutation.scope == "series" {
                let (raw, exceptions, reason) = self.inspect_series(sub, cal, &id).await?;
                if let Some(reason) = reason {
                    return Err(Error::new("READ_ONLY", &reason));
                }
                if exceptions && (body.get("start").is_some() || body.get("recurrence").is_some()) {
                    return Err(Error::new(
                        "READ_ONLY",
                        "This series has exceptions. Change its schedule in Google Calendar.",
                    ));
                }
                raw
            } else {
                self.api(
                    sub,
                    Method::GET,
                    &["calendars", cal, "events", &id],
                    &[],
                    None,
                    None,
                )
                .await?
            };
            model::require_writable(&raw, &calendar)?;
            if mutation.scope == "series"
                && (body.get("start").is_some() || body.get("recurrence").is_some())
                && raw["recurrence"]
                    .as_array()
                    .is_some_and(|rules| !rules.is_empty())
                && recurrence(&raw["recurrence"]).is_err()
            {
                return Err(Error::new("UNSUPPORTED_RECURRENCE","This imported pattern must keep its original schedule. Open it in Google Calendar to change recurrence or timing."));
            }
            if model::string(&raw, "etag") != etag.unwrap_or("") {
                return Err(Error::new("CONFLICT","This event changed in Google Calendar. Close the editor and refresh before editing again."));
            }
            if mutation.scope == "occurrence"
                && raw["recurrence"].as_array().is_some_and(|v| !v.is_empty())
            {
                return Err(Error::new(
                    "INVALID_EVENT",
                    "Choose whole-series editing for a recurrence parent.",
                ));
            }
            if mutation.scope == "occurrence"
                && raw["recurringEventId"].is_string()
                && body.get("recurrence").is_some()
            {
                return Err(Error::new(
                    "INVALID_EVENT",
                    "Recurrence rules belong to the whole series.",
                ));
            }
            id = model::string(&raw, "id").into();
        }
        work.cancel.check()?;
        {
            let cache = lock(&self.cache)?;
            cache.prepare_mutation(
                &request,
                (sub, cal, &id),
                &mutation.operation,
                &body,
                etag,
                &mutation.scope,
            )?;
            cache.db.execute(
                "UPDATE calendars SET revision=revision+1 WHERE sub=? AND id=?",
                rusqlite::params![sub, cal],
            )?;
        }
        let method = if creating {
            Method::POST
        } else if mutation.operation == "delete" {
            Method::DELETE
        } else {
            Method::PATCH
        };
        let path = if creating {
            vec!["calendars", cal, "events"]
        } else {
            vec!["calendars", cal, "events", &id]
        };
        let result = self
            .api(
                sub,
                method,
                &path,
                &[("sendUpdates", "none".into())],
                if mutation.operation == "delete" {
                    None
                } else {
                    Some(&body)
                },
                etag,
            )
            .await;
        let result=match result {
            Ok(result)=>result,
            Err(error) if matches!(error.code.as_str(),"OFFLINE"|"GOOGLE_UNAVAILABLE"|"INVALID_DATA"|"ALREADY_EXISTS")=>match self.reconcile(sub,cal,&id,&mutation.operation,&body).await? {Some(result)=>result,None=>return Err(Error::new("UNCERTAIN_WRITE","The result of this change is uncertain. Retry this same attempt when online; its stable identity prevents duplicate creation."))},
            Err(error)=>{if !matches!(error.code.as_str(),"DISCONNECTED"|"CANCELLED"){lock(&self.cache)?.finish_mutation(&request)?;}return Err(error);}
        };
        work.cancel.check()?;
        lock(&self.cache)?.db.execute("UPDATE mutations SET status='committed' WHERE request_id=?",[&request]).map_err(|_|Error::new("REMOTE_COMMITTED","Google saved this change, but its local receipt could not be stored. Refresh the calendar."))?;
        self.finish_write(
            &request,
            (sub, cal, &id),
            &mutation.operation,
            &result,
            mutation.scope == "series",
        )
    }
}
#[tauri::command]
pub async fn google_mutate(google: State<'_, Arc<Google>>, mutation: Mutation) -> Result<Value> {
    google.mutate(mutation).await
}
#[tauri::command]
pub async fn google_series(google: State<'_, Arc<Google>>, event_id: String) -> Result<Value> {
    google.series(&event_id).await
}

#[tauri::command]
pub async fn google_recover_pending(google: State<'_, Arc<Google>>) -> Result<Value> {
    google.recover_pending().await
}
#[tauri::command]
pub async fn google_retry_pending(
    google: State<'_, Arc<Google>>,
    request_id: String,
) -> Result<Value> {
    google.retry_pending(&request_id).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn patch_clears_fields_and_omits_untouched_metadata() {
        assert_eq!(
            patch(&json!({"description":null,"title":"New title"})).unwrap(),
            json!({"summary":"New title","description":null})
        );
        assert!(patch(&json!({"attendees":[]})).is_err());
        assert!(contains_patch(
            &json!({"description":"","summary":"Title","reminders":{"useDefault":true}}),
            &json!({"description":null})
        ));
    }
    #[test]
    fn recurrence_rejects_complex_rules_and_multiple_endings() {
        assert!(recurrence(&json!([
            "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=12"
        ]))
        .is_ok());
        assert!(recurrence(&json!(["RRULE:FREQ=MONTHLY;BYDAY=2MO"])).is_err());
        assert!(recurrence(&json!(["RRULE:FREQ=DAILY;COUNT=2;UNTIL=20261031"])).is_err());
    }
    #[test]
    fn recovery_compares_instant_values_without_overwriting_other_fields() {
        assert!(contains_patch(
            &json!({"start":{"dateTime":"2026-10-26T09:00:00-05:00","timeZone":"America/Chicago"}}),
            &json!({"start":{"dateTime":"2026-10-26T14:00:00Z","timeZone":"America/Chicago"}})
        ));
        assert!(!contains_patch(
            &json!({"summary":"External edit"}),
            &json!({"summary":"Mine"})
        ));
    }
}
