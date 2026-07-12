//! Control-API pre-shared key (PSK) check — a low-grade anti-abuse gate, mirroring the iroh relay
//! auth token (`EXPO_PUBLIC_IROH_RELAY_TOKEN`). Like that token it ships in the app and is *not* a
//! real authentication boundary (a determined client can read it); it only cuts casual misuse of a
//! public control endpoint. The security of the trail data itself never rests on this — envelopes
//! are E2E encrypted and the stash is ciphertext-blind regardless.
//!
//! Pure and unit-tested: the axum middleware in [`crate::node`] just calls [`authorize`].

/// Outcome of checking a request's bearer against the configured PSK.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthOutcome {
    /// No PSK configured — the gate is disabled (dev/self-host-with-network-ACLs). Allowed.
    Disabled,
    /// Bearer matched the configured PSK.
    Ok,
    /// A PSK is configured but the request's bearer was missing or wrong.
    Denied,
}

impl AuthOutcome {
    pub fn is_allowed(&self) -> bool {
        matches!(self, AuthOutcome::Disabled | AuthOutcome::Ok)
    }
}

/// Decide whether a request may proceed. `expected` is the configured PSK (None ⇒ gate disabled);
/// `provided` is the token parsed from the request's `Authorization: Bearer …` header.
pub fn authorize(expected: Option<&str>, provided: Option<&str>) -> AuthOutcome {
    match expected {
        None => AuthOutcome::Disabled,
        Some(psk) => match provided {
            Some(tok) if ct_eq(psk.as_bytes(), tok.as_bytes()) => AuthOutcome::Ok,
            _ => AuthOutcome::Denied,
        },
    }
}

/// Extract the token from an `Authorization` header value of the form `Bearer <token>`
/// (case-insensitive scheme). Returns `None` if the header is missing or malformed.
pub fn bearer_token(header_value: Option<&str>) -> Option<&str> {
    let v = header_value?.trim();
    let (scheme, token) = v.split_once(' ')?;
    if scheme.eq_ignore_ascii_case("bearer") && !token.trim().is_empty() {
        Some(token.trim())
    } else {
        None
    }
}

/// Constant-time byte comparison — avoids leaking the PSK length/prefix via timing. Length
/// mismatch still short-circuits (lengths are not secret), but equal-length inputs are compared in
/// full regardless of where they first differ.
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disabled_when_no_psk_configured() {
        assert_eq!(authorize(None, None), AuthOutcome::Disabled);
        assert_eq!(authorize(None, Some("whatever")), AuthOutcome::Disabled);
        assert!(authorize(None, None).is_allowed());
    }

    #[test]
    fn ok_only_on_exact_match() {
        assert_eq!(authorize(Some("s3cret"), Some("s3cret")), AuthOutcome::Ok);
        assert!(authorize(Some("s3cret"), Some("s3cret")).is_allowed());
    }

    #[test]
    fn denied_on_missing_or_wrong() {
        assert_eq!(authorize(Some("s3cret"), None), AuthOutcome::Denied);
        assert_eq!(authorize(Some("s3cret"), Some("nope")), AuthOutcome::Denied);
        assert_eq!(authorize(Some("s3cret"), Some("s3cre")), AuthOutcome::Denied);
        assert!(!authorize(Some("s3cret"), Some("nope")).is_allowed());
    }

    #[test]
    fn parses_bearer_header() {
        assert_eq!(bearer_token(Some("Bearer abc123")), Some("abc123"));
        assert_eq!(bearer_token(Some("bearer abc123")), Some("abc123")); // case-insensitive
        assert_eq!(bearer_token(Some("  Bearer   abc123  ")), Some("abc123"));
        assert_eq!(bearer_token(Some("Basic abc123")), None);
        assert_eq!(bearer_token(Some("abc123")), None);
        assert_eq!(bearer_token(Some("Bearer ")), None);
        assert_eq!(bearer_token(None), None);
    }

    #[test]
    fn ct_eq_matches_only_identical() {
        assert!(ct_eq(b"", b""));
        assert!(ct_eq(b"abc", b"abc"));
        assert!(!ct_eq(b"abc", b"abd"));
        assert!(!ct_eq(b"abc", b"ab"));
    }
}
