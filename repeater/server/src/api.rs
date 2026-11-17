//! Control-API request shapes + **pure validation**. The HTTP transport (axum) lives in
//! [`crate::node`] behind the `live` feature; everything here is deserialize + validate logic so
//! it is unit-testable without a server. The grant model is opt-in: presenting a read-ticket IS
//! the grant, so there is no separate auth step to replicate a namespace.

use serde::Deserialize;

use crate::subscriptions::{NamespaceId, Platform, PushSubscription};

/// Upper bound on an iroh-docs read-ticket string (base32; real ones are a few hundred chars).
pub const MAX_TICKET_LEN: usize = 4096;
/// Upper bound on a push token (APNs ~64 hex; FCM tokens are longer — leave headroom).
pub const MAX_TOKEN_LEN: usize = 512;
/// Minimum plausible ticket length; anything shorter is obviously junk.
pub const MIN_TICKET_LEN: usize = 16;

/// `POST /v1/namespaces` body. `push_token` + `platform` are optional but must appear together;
/// a ticket-only registration replicates the namespace without arranging a wake for this device.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RegisterRequest {
    pub read_ticket: String,
    #[serde(default)]
    pub push_token: Option<String>,
    #[serde(default)]
    pub platform: Option<String>,
}

/// A validated registration ready for the node to act on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidRegister {
    pub read_ticket: String,
    pub subscription: Option<PushSubscription>,
}

/// Validation failures, each mapping to a `400 Bad Request`.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ApiError {
    #[error("read ticket missing or malformed")]
    BadTicket,
    #[error("push token missing or too long")]
    BadToken,
    #[error("platform must be 'apns' or 'fcm'")]
    BadPlatform,
    #[error("push token and platform must be provided together")]
    IncompletePush,
    #[error("namespace id must be 64 lowercase hex characters")]
    BadNamespace,
}

/// Parse the wire platform string.
pub fn parse_platform(s: &str) -> Option<Platform> {
    match s {
        "apns" => Some(Platform::Apns),
        "fcm" => Some(Platform::Fcm),
        _ => None,
    }
}

/// Validate a registration. The authoritative ticket parse happens later in the node when the
/// ticket is actually imported (`DocTicket::from_str`); here we only reject obvious junk so the
/// server never even attempts to import garbage.
pub fn validate_register(req: &RegisterRequest) -> Result<ValidRegister, ApiError> {
    let ticket = req.read_ticket.trim();
    if !looks_like_ticket(ticket) {
        return Err(ApiError::BadTicket);
    }

    let subscription = match (req.push_token.as_deref(), req.platform.as_deref()) {
        (None, None) => None,
        (Some(token), Some(platform)) => {
            let token = token.trim();
            if token.is_empty() || token.len() > MAX_TOKEN_LEN {
                return Err(ApiError::BadToken);
            }
            let platform = parse_platform(platform).ok_or(ApiError::BadPlatform)?;
            Some(PushSubscription {
                platform,
                token: token.to_string(),
            })
        }
        _ => return Err(ApiError::IncompletePush),
    };

    Ok(ValidRegister {
        read_ticket: ticket.to_string(),
        subscription,
    })
}

/// Light structural guard on a ticket string: bounded length, base32-ish (ASCII alphanumeric).
fn looks_like_ticket(s: &str) -> bool {
    (MIN_TICKET_LEN..=MAX_TICKET_LEN).contains(&s.len())
        && s.chars().all(|c| c.is_ascii_alphanumeric())
}

/// Parse a `{namespaceId}` path segment (from `DELETE /v1/namespaces/{id}/subscription`) into raw
/// bytes. Requires exactly 64 lowercase hex chars, matching how `docs.rs` encodes namespaces.
pub fn parse_namespace_hex(s: &str) -> Result<NamespaceId, ApiError> {
    if s.len() != 64 {
        return Err(ApiError::BadNamespace);
    }
    let bytes = s.as_bytes();
    let mut out = [0u8; 32];
    for i in 0..32 {
        let hi = lower_hex_val(bytes[2 * i]).ok_or(ApiError::BadNamespace)?;
        let lo = lower_hex_val(bytes[2 * i + 1]).ok_or(ApiError::BadNamespace)?;
        out[i] = (hi << 4) | lo;
    }
    Ok(out)
}

/// Hex value of a single byte, rejecting uppercase (we canonicalize on lowercase hex).
fn lower_hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(ticket: &str, token: Option<&str>, platform: Option<&str>) -> RegisterRequest {
        RegisterRequest {
            read_ticket: ticket.to_string(),
            push_token: token.map(String::from),
            platform: platform.map(String::from),
        }
    }

    const OK_TICKET: &str = "docaaaabbbbccccdddd1234"; // alnum, > MIN_TICKET_LEN

    #[test]
    fn ticket_only_registration_is_valid() {
        let v = validate_register(&req(OK_TICKET, None, None)).unwrap();
        assert_eq!(v.read_ticket, OK_TICKET);
        assert!(v.subscription.is_none());
    }

    #[test]
    fn ticket_with_push_is_valid() {
        let v = validate_register(&req(OK_TICKET, Some("tok123"), Some("fcm"))).unwrap();
        assert_eq!(
            v.subscription,
            Some(PushSubscription {
                platform: Platform::Fcm,
                token: "tok123".to_string(),
            })
        );
    }

    #[test]
    fn trims_ticket_and_token() {
        let v = validate_register(&req("  docaaaabbbbccccdddd  ", Some(" tok "), Some("apns")))
            .unwrap();
        assert_eq!(v.read_ticket, "docaaaabbbbccccdddd");
        assert_eq!(v.subscription.unwrap().token, "tok");
    }

    #[test]
    fn rejects_junk_ticket() {
        assert_eq!(
            validate_register(&req("short", None, None)),
            Err(ApiError::BadTicket)
        );
        assert_eq!(
            validate_register(&req("has spaces and!!!", None, None)),
            Err(ApiError::BadTicket)
        );
        assert_eq!(
            validate_register(&req("", None, None)),
            Err(ApiError::BadTicket)
        );
    }

    #[test]
    fn rejects_partial_push() {
        assert_eq!(
            validate_register(&req(OK_TICKET, Some("tok"), None)),
            Err(ApiError::IncompletePush)
        );
        assert_eq!(
            validate_register(&req(OK_TICKET, None, Some("apns"))),
            Err(ApiError::IncompletePush)
        );
    }

    #[test]
    fn rejects_bad_platform_and_empty_token() {
        assert_eq!(
            validate_register(&req(OK_TICKET, Some("tok"), Some("sms"))),
            Err(ApiError::BadPlatform)
        );
        assert_eq!(
            validate_register(&req(OK_TICKET, Some("   "), Some("apns"))),
            Err(ApiError::BadToken)
        );
    }

    #[test]
    fn rejects_oversized_token() {
        let big = "a".repeat(MAX_TOKEN_LEN + 1);
        assert_eq!(
            validate_register(&req(OK_TICKET, Some(&big), Some("apns"))),
            Err(ApiError::BadToken)
        );
    }

    #[test]
    fn namespace_hex_round_trips() {
        let ns = [0xabu8; 32];
        let hex: String = ns.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(parse_namespace_hex(&hex).unwrap(), ns);
    }

    #[test]
    fn namespace_hex_rejects_bad_input() {
        assert_eq!(
            parse_namespace_hex("abc").unwrap_err(),
            ApiError::BadNamespace
        );
        let upper = "A".repeat(64);
        assert_eq!(
            parse_namespace_hex(&upper).unwrap_err(),
            ApiError::BadNamespace
        );
        let non_hex = "g".repeat(64);
        assert_eq!(
            parse_namespace_hex(&non_hex).unwrap_err(),
            ApiError::BadNamespace
        );
    }
}
