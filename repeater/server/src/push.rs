//! Silent push-payload construction for APNs and FCM — **pure and unit-tested**.
//!
//! These build the request URL, headers, and JSON body for a *silent, data-only* wake: no alert,
//! no sound, just enough to bring the app's headless runtime up so it runs `syncTrail`. The
//! correctness-critical bits (content-available, background push type, high priority, the sync
//! namespace hint) are tested here; the actual network send + credential minting live in the
//! `live`-feature sender in [`crate::waker`].
//!
//! The push carries only `{ type: "trail-sync", ns: "<hex namespace>" }` — never a location.

use serde_json::{json, Value};

use crate::subscriptions::NamespaceId;

/// The custom data both platforms carry: a sync hint naming the namespace that changed.
pub const PUSH_TYPE: &str = "trail-sync";

/// A fully-built push request minus the `Authorization` header (added by the sender, which owns
/// the short-lived credential).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PushRequest {
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Value,
}

/// Lowercase-hex a namespace id (used both in the APNs path-independent body and FCM data).
pub fn namespace_hex(ns: &NamespaceId) -> String {
    let mut s = String::with_capacity(64);
    for b in ns {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// Build an APNs (HTTP/2) background-push request for one device token.
///
/// * `host` is `api.push.apple.com` (prod) or `api.sandbox.push.apple.com` (dev).
/// * `bundle_id` is the app's bundle id, sent as `apns-topic`.
pub fn apns_request(
    host: &str,
    bundle_id: &str,
    device_token: &str,
    ns: &NamespaceId,
) -> PushRequest {
    PushRequest {
        url: format!("https://{host}/3/device/{device_token}"),
        headers: vec![
            // Silent background delivery: type=background REQUIRES content-available and forbids
            // alert/sound; priority 5 is mandatory for background pushes.
            ("apns-push-type".into(), "background".into()),
            ("apns-priority".into(), "5".into()),
            ("apns-topic".into(), bundle_id.into()),
            ("apns-expiration".into(), "0".into()), // don't store-and-retry; a later sync catches up
        ],
        body: json!({
            "aps": { "content-available": 1 },
            "type": PUSH_TYPE,
            "ns": namespace_hex(ns),
        }),
    }
}

/// Build an FCM v1 (`.../messages:send`) data-only message for one device token.
///
/// * `project_id` is the Firebase project id.
pub fn fcm_request(project_id: &str, device_token: &str, ns: &NamespaceId) -> PushRequest {
    let ns_hex = namespace_hex(ns);
    PushRequest {
        url: format!("https://fcm.googleapis.com/v1/projects/{project_id}/messages:send"),
        // content-type is set by the JSON sender; auth bearer is added at send time.
        headers: Vec::new(),
        body: json!({
            "message": {
                "token": device_token,
                // data-only so Android delivers it to the app's messaging service even in the
                // background, rather than the system tray.
                "data": { "type": PUSH_TYPE, "ns": ns_hex },
                "android": { "priority": "high" },
                // If this FCM token fronts an iOS device, mirror the silent-background contract.
                "apns": {
                    "headers": { "apns-push-type": "background", "apns-priority": "5" },
                    "payload": { "aps": { "content-available": 1 } }
                }
            }
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NS: NamespaceId = [0xabu8; 32];

    fn header<'a>(r: &'a PushRequest, key: &str) -> Option<&'a str> {
        r.headers
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    }

    #[test]
    fn namespace_hex_is_64_lowercase() {
        let h = namespace_hex(&NS);
        assert_eq!(h.len(), 64);
        assert_eq!(h, "ab".repeat(32));
    }

    #[test]
    fn apns_is_silent_background() {
        let r = apns_request(
            "api.push.apple.com",
            "com.unrealjune.streetcryptid",
            "TOKEN",
            &NS,
        );
        assert_eq!(r.url, "https://api.push.apple.com/3/device/TOKEN");
        assert_eq!(header(&r, "apns-push-type"), Some("background"));
        assert_eq!(header(&r, "apns-priority"), Some("5"));
        assert_eq!(
            header(&r, "apns-topic"),
            Some("com.unrealjune.streetcryptid")
        );
        assert_eq!(r.body["aps"]["content-available"], json!(1));
        // silent: no alert/sound keys
        assert!(r.body["aps"].get("alert").is_none());
        assert!(r.body["aps"].get("sound").is_none());
        assert_eq!(r.body["type"], json!(PUSH_TYPE));
        assert_eq!(r.body["ns"], json!("ab".repeat(32)));
    }

    #[test]
    fn fcm_is_data_only_high_priority() {
        let r = fcm_request("street-cryptid", "TOKEN", &NS);
        assert_eq!(
            r.url,
            "https://fcm.googleapis.com/v1/projects/street-cryptid/messages:send"
        );
        assert_eq!(r.body["message"]["token"], json!("TOKEN"));
        assert_eq!(r.body["message"]["data"]["type"], json!(PUSH_TYPE));
        assert_eq!(r.body["message"]["data"]["ns"], json!("ab".repeat(32)));
        assert_eq!(r.body["message"]["android"]["priority"], json!("high"));
        assert_eq!(
            r.body["message"]["apns"]["payload"]["aps"]["content-available"],
            json!(1)
        );
        // data-only: no notification block (which would route to the tray, not the app)
        assert!(r.body["message"].get("notification").is_none());
    }
}
