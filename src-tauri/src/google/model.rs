// SPDX-License-Identifier: AGPL-3.0-only
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Error {
    pub code: String,
    pub message: String,
}
impl Error {
    pub fn new(code: &str, message: &str) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}
impl From<rusqlite::Error> for Error {
    fn from(_: rusqlite::Error) -> Self {
        Self::new("CACHE_FAILED", "The local Google cache could not be read or saved. Check disk space and restart the app.")
    }
}
impl From<serde_json::Error> for Error {
    fn from(_: serde_json::Error) -> Self {
        Self::new(
            "INVALID_DATA",
            "Google returned an incomplete or unsupported response.",
        )
    }
}

pub fn key(parts: &[&str]) -> String {
    std::iter::once("google".to_owned())
        .chain(parts.iter().map(|p| URL_SAFE_NO_PAD.encode(p)))
        .collect::<Vec<_>>()
        .join(":")
}
pub fn parts(value: &str, length: usize) -> Result<Vec<String>> {
    let pieces: Vec<_> = value.split(':').collect();
    if pieces.len() != length + 1 || pieces[0] != "google" {
        return Err(Error::new(
            "INVALID_EVENT",
            "Invalid Google resource identity.",
        ));
    }
    pieces[1..]
        .iter()
        .map(|p| {
            URL_SAFE_NO_PAD
                .decode(p)
                .ok()
                .and_then(|v| String::from_utf8(v).ok())
                .filter(|v| !v.is_empty())
                .ok_or_else(|| Error::new("INVALID_EVENT", "Invalid Google resource identity."))
        })
        .collect()
}
pub fn string<'a>(value: &'a Value, field: &str) -> &'a str {
    value[field].as_str().unwrap_or("")
}
pub fn writable(calendar: &Value) -> bool {
    matches!(string(calendar, "accessRole"), "owner" | "writer")
}
pub fn read_only_reason(event: &Value, calendar: &Value) -> Option<&'static str> {
    if !writable(calendar) {
        return Some("This calendar does not allow event editing.");
    }
    if event["status"] == "cancelled" {
        return Some("This event has been cancelled.");
    }
    if event["attendees"].as_array().is_some_and(|v| !v.is_empty())
        || event["attendeesOmitted"] == true
    {
        return Some("Meetings with guests are read-only.");
    }
    if event["organizer"]["self"] != true {
        return Some("Only events organized by this calendar can be edited.");
    }
    if !matches!(string(event, "eventType"), "" | "default") {
        return Some("This Google event type is read-only.");
    }
    if event["locked"] == true
        || event["privateCopy"] == true
        || event["visibility"] == "private"
        || event["visibility"] == "confidential"
        || event["summary"].as_str().is_none()
        || event["etag"].as_str().is_none()
    {
        return Some("Private, redacted, or locked events are read-only.");
    }
    None
}
pub fn require_writable(event: &Value, calendar: &Value) -> Result<()> {
    if let Some(reason) = read_only_reason(event, calendar) {
        return Err(Error::new("READ_ONLY", reason));
    }
    Ok(())
}

pub fn account(sub: &str, identity: &Value) -> Value {
    let name = identity["name"]
        .as_str()
        .or(identity["email"].as_str())
        .unwrap_or("Google account");
    let initials: String = name
        .split_whitespace()
        .take(2)
        .filter_map(|word| word.chars().next())
        .collect();
    json!({"id": key(&[sub]), "provider": "google", "name": name, "email": identity["email"], "initials": initials.to_uppercase(), "color": "#1a73e8"})
}
pub fn calendar(sub: &str, raw: &Value) -> Value {
    let id = string(raw, "id");
    json!({"id": key(&[sub, id]), "accountId": key(&[sub]), "provider": "google", "name": raw["summaryOverride"].as_str().or(raw["summary"].as_str()).unwrap_or(id), "color": raw["backgroundColor"].as_str().unwrap_or("#1a73e8"), "timeZone": raw["timeZone"].as_str().unwrap_or("UTC"), "accessRole": raw["accessRole"], "primary": raw["primary"] == true})
}
pub fn event(sub: &str, cal: &Value, raw: &Value) -> Option<Value> {
    if raw["status"] == "cancelled" {
        return None;
    }
    let all_day = raw["start"]["date"].is_string();
    let field = if all_day { "date" } else { "dateTime" };
    let start = raw["start"][field].as_str()?;
    let end = raw["end"][field].as_str()?;
    let cal_id = string(cal, "id");
    let reason = read_only_reason(raw, cal);
    let zone = raw["start"]["timeZone"]
        .as_str()
        .or(cal["timeZone"].as_str())
        .unwrap_or("UTC");
    Some(
        json!({"id": key(&[sub, cal_id, raw["id"].as_str()?]), "provider": "google", "accountId": key(&[sub]), "calendarId": key(&[sub, cal_id]), "title": raw["summary"].as_str().unwrap_or("Busy"), "start": start, "end": end, "allDay": all_day, "timeZone": zone, "location": raw["location"].as_str(), "description": raw["description"].as_str(), "etag": raw["etag"], "recurringEventId": raw["recurringEventId"].as_str().map(|id| key(&[sub, cal_id, id])), "originalStart": raw["originalStartTime"][field].as_str(), "htmlLink": raw["htmlLink"].as_str(), "recurrence": raw["recurrence"].as_array(), "capabilities": {"edit": reason.is_none(), "delete": reason.is_none(), "reason": reason}}),
    )
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Bucket {
    pub start_date: String,
    pub end_date: String,
    pub time_zone: String,
}
impl Bucket {
    pub fn validate(&self) -> Result<()> {
        let start = NaiveDate::parse_from_str(&self.start_date, "%Y-%m-%d").ok();
        let end = NaiveDate::parse_from_str(&self.end_date, "%Y-%m-%d").ok();
        if self.time_zone != "UTC"
            || start.is_none()
            || end.is_none()
            || start >= end
            || end
                .unwrap()
                .signed_duration_since(start.unwrap())
                .num_days()
                > 31
        {
            return Err(Error::new(
                "INVALID_RANGE",
                "Sync requires a complete UTC month bucket.",
            ));
        }
        use chrono::Datelike;
        let (start, end) = (start.unwrap(), end.unwrap());
        if start.day() != 1
            || end.day() != 1
            || start.checked_add_months(chrono::Months::new(1)) != Some(end)
        {
            return Err(Error::new(
                "INVALID_RANGE",
                "Sync requires a complete UTC month bucket.",
            ));
        }
        Ok(())
    }
}

pub fn timing(input: &Value) -> Result<(Value, Value)> {
    let zone = string(input, "timeZone");
    zone.parse::<chrono_tz::Tz>()
        .map_err(|_| Error::new("INVALID_EVENT", "Choose an IANA time zone."))?;
    let (start, end) = (string(input, "start"), string(input, "end"));
    if input["allDay"] == true {
        let a = NaiveDate::parse_from_str(start, "%Y-%m-%d")
            .map_err(|_| Error::new("INVALID_EVENT", "Choose valid dates."))?;
        let b = NaiveDate::parse_from_str(end, "%Y-%m-%d")
            .map_err(|_| Error::new("INVALID_EVENT", "Choose valid dates."))?;
        if a >= b {
            return Err(Error::new(
                "INVALID_EVENT",
                "The end must be after the start.",
            ));
        }
        Ok((json!({"date":start}), json!({"date":end})))
    } else {
        let a = DateTime::parse_from_rfc3339(start)
            .map_err(|_| Error::new("INVALID_EVENT", "Choose valid event times."))?;
        let b = DateTime::parse_from_rfc3339(end)
            .map_err(|_| Error::new("INVALID_EVENT", "Choose valid event times."))?;
        if a >= b {
            return Err(Error::new(
                "INVALID_EVENT",
                "The end must be after the start.",
            ));
        }
        Ok((
            json!({"dateTime": a.with_timezone(&Utc).to_rfc3339(), "timeZone":zone}),
            json!({"dateTime":b.with_timezone(&Utc).to_rfc3339(), "timeZone":zone}),
        ))
    }
}
