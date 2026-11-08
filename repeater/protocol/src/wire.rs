//! The `streetcryptid/repeater/1` wire: what a phone (or a sibling repeater) asks a repeater, and
//! what it answers. Pure: framing, messages and proofs as bytes. The live handler is trail-stash's
//! `repeater.rs`, the client is the app core's; each brings its own iroh.
//!
//! One request per bi-stream, each a length-prefixed postcard frame, one connection per exchange.
//! The caller's identity is the iroh endpoint that dialled (authenticated by the QUIC handshake),
//! never a field in the request: every rule that asks "who is this?" reads the connection.
//!
//! | request   | who may                                     | does                                       |
//! | --------- | ------------------------------------------- | ------------------------------------------ |
//! | `Claim`   | whoever holds the console's one-time secret | binds the repeater to a roster and owner   |
//! | `Publish` | anyone; each op stands on its signature     | adds roster ops                            |
//! | `Fetch`   | the owner, carried members, sibling repeaters | returns the roster                       |
//! | `Grant`   | a carried member who owns the namespace     | starts carrying one of their namespaces    |
//! | `Have`    | anyone (reading is open)                    | says which content hashes are held         |

use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use serde::{Deserialize, Serialize};

use crate::roster::{EndpointId, OpId, RepeaterCert, SignedOp};

/// The ALPN. Bump the suffix on any change to [`Request`] or [`Response`] that an older peer would
/// misread; appending enum variants at the end is the only change that needs no bump.
pub const ALPN: &[u8] = b"streetcryptid/repeater/1";

/// The largest frame either side accepts. A full roster at `MAX_OPS` small ops fits well inside.
pub const MAX_FRAME: usize = 2 * 1024 * 1024;

/// The most ops one `Publish` may carry.
pub const MAX_PUBLISH_OPS: usize = 512;
/// The most hashes one `Have` may ask about.
pub const MAX_HAVE_HASHES: usize = 256;
/// The most namespaces one member may have a repeater carry (a phone has a trail and a profile).
pub const MAX_NAMESPACES_PER_MEMBER: usize = 4;
/// The most co-carriers one `Grant` may name.
pub const MAX_CARRIERS: usize = 8;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum Request {
    /// Bind an unclaimed repeater. `ops` is the roster it joins: a fresh `Genesis` for a first
    /// repeater, or the owner's whole roster for a second one. The caller must be its owner.
    Claim {
        secret: [u8; 32],
        ops: Vec<SignedOp>,
    },
    /// Offer roster ops. Each is verified and judged on its own.
    Publish { ops: Vec<SignedOp> },
    /// Read the roster.
    Fetch,
    /// Carry this read ticket's namespace on the caller's behalf. `proof` is [`sign_grant`]: a
    /// signature by the namespace's own key, which only its writer holds, so a member can have a
    /// repeater carry *their* trail and nobody else's. (Friends hold read tickets for each other's
    /// namespaces; without this, enrolling would let anyone volunteer a friend's trail.)
    ///
    /// `carriers` are the member's *other* repeaters carrying the same namespace, in rosters this
    /// one may know nothing about (a friend's repeater the member enrolled in). The repeater
    /// reconciles the namespace with them over iroh-docs, so two people's repeaters that carry
    /// one trail converge with each other while the phone that writes it sleeps. Re-granting
    /// replaces the list.
    Grant {
        ticket: String,
        proof: Vec<u8>,
        carriers: Vec<EndpointId>,
    },
    /// Which of these content hashes are held in full.
    Have { hashes: Vec<[u8; 32]> },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum Response {
    /// The repeater's signed attestation; the owner puts it in an `AddRepeater`.
    Claimed {
        cert: RepeaterCert,
    },
    Published {
        accepted: u32,
        pending: u32,
        refused: u32,
        heads: Vec<OpId>,
    },
    Roster {
        ops: Vec<SignedOp>,
    },
    Granted {
        namespace: [u8; 32],
    },
    Have {
        present: Vec<bool>,
    },
    Refused {
        reason: Refusal,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum Refusal {
    /// The claim secret is wrong or expired.
    BadClaimSecret,
    /// This repeater already belongs to a roster.
    AlreadyClaimed,
    /// The claim's roster is unusable, or its owner is not the caller.
    BadClaimRoster,
    /// This repeater has not been claimed yet.
    NotClaimed,
    /// The caller is not someone this roster carries (or, for `Fetch`, may read it).
    NotCarried,
    /// The grant proof is not the namespace's signature over this repeater and caller.
    BadProof,
    /// Over a per-request or per-member limit.
    TooMany,
    /// The request could not be decoded or acted on.
    Invalid,
    /// A local failure on the repeater; worth retrying later.
    Unavailable,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum FrameError {
    #[error("frame of {0} bytes exceeds the limit")]
    TooLarge(usize),
    #[error("truncated frame")]
    Truncated,
    #[error("undecodable frame")]
    Decode,
}

/// `u32` big-endian length, then the postcard body.
pub fn encode<T: Serialize>(msg: &T) -> Result<Vec<u8>, FrameError> {
    let body = postcard::to_allocvec(msg).map_err(|_| FrameError::Decode)?;
    if body.len() > MAX_FRAME {
        return Err(FrameError::TooLarge(body.len()));
    }
    let mut out = Vec::with_capacity(4 + body.len());
    out.extend_from_slice(&(body.len() as u32).to_be_bytes());
    out.extend_from_slice(&body);
    Ok(out)
}

/// The declared body length of a frame header, refused before anything is allocated for it.
pub fn declared_len(header: [u8; 4]) -> Result<usize, FrameError> {
    let len = u32::from_be_bytes(header) as usize;
    if len > MAX_FRAME {
        return Err(FrameError::TooLarge(len));
    }
    Ok(len)
}

pub fn decode_body<'a, T: Deserialize<'a>>(body: &'a [u8]) -> Result<T, FrameError> {
    postcard::from_bytes(body).map_err(|_| FrameError::Decode)
}

/// Decode a whole frame held in memory.
pub fn decode<'a, T: Deserialize<'a>>(frame: &'a [u8]) -> Result<T, FrameError> {
    let header: [u8; 4] = frame
        .get(..4)
        .and_then(|h| h.try_into().ok())
        .ok_or(FrameError::Truncated)?;
    let len = declared_len(header)?;
    let body = frame.get(4..4 + len).ok_or(FrameError::Truncated)?;
    decode_body(body)
}

/// Domain separation for grant proofs.
const GRANT_CTX: &[u8] = b"streetcryptid/repeater/grant/v1";

fn grant_input(repeater: &EndpointId, member: &EndpointId, namespace: &[u8; 32]) -> Vec<u8> {
    let mut msg = Vec::with_capacity(GRANT_CTX.len() + 96);
    msg.extend_from_slice(GRANT_CTX);
    msg.extend_from_slice(repeater);
    msg.extend_from_slice(member);
    msg.extend_from_slice(namespace);
    msg
}

/// Prove ownership of a namespace to one repeater, for one member. `namespace_secret` is the
/// namespace's write key (an iroh-docs `NamespaceSecret`'s bytes); its public key is the
/// namespace id. Bound to the repeater and the member so a proof cannot be replayed elsewhere.
pub fn sign_grant(
    namespace_secret: &SigningKey,
    repeater: &EndpointId,
    member: &EndpointId,
) -> Vec<u8> {
    let namespace = namespace_secret.verifying_key().to_bytes();
    namespace_secret
        .sign(&grant_input(repeater, member, &namespace))
        .to_bytes()
        .to_vec()
}

/// Check a [`sign_grant`] proof.
pub fn verify_grant(
    namespace: &[u8; 32],
    repeater: &EndpointId,
    member: &EndpointId,
    proof: &[u8],
) -> bool {
    let Ok(key) = VerifyingKey::from_bytes(namespace) else {
        return false;
    };
    let Ok(sig) = Signature::from_slice(proof) else {
        return false;
    };
    key.verify_strict(&grant_input(repeater, member, namespace), &sig)
        .is_ok()
}

/// Compare two secrets without an early exit.
pub fn secrets_match(a: &[u8; 32], b: &[u8; 32]) -> bool {
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// The claim link a repeater prints for its owner to scan:
/// `streetcryptid-repeater:<endpoint ticket>#<64 hex secret>`. The endpoint ticket carries the
/// repeater's full endpoint id, which is what makes scanning it as strong as an SAS check.
pub const CLAIM_SCHEME: &str = "streetcryptid-repeater:";

pub fn claim_link(endpoint_ticket: &str, secret: &[u8; 32]) -> String {
    let hex: String = secret.iter().map(|b| format!("{b:02x}")).collect();
    format!("{CLAIM_SCHEME}{endpoint_ticket}#{hex}")
}

/// Split a claim link into its endpoint ticket and secret.
pub fn parse_claim_link(link: &str) -> Option<(&str, [u8; 32])> {
    let rest = link.trim().strip_prefix(CLAIM_SCHEME)?;
    let (ticket, hex) = rest.split_once('#')?;
    if ticket.is_empty() || hex.len() != 64 {
        return None;
    }
    let mut secret = [0u8; 32];
    for (i, byte) in secret.iter_mut().enumerate() {
        *byte = u8::from_str_radix(hex.get(2 * i..2 * i + 2)?, 16).ok()?;
    }
    Some((ticket, secret))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requests_and_responses_round_trip_through_a_frame() {
        let req = Request::Have {
            hashes: vec![[1; 32], [2; 32]],
        };
        assert_eq!(decode::<Request>(&encode(&req).unwrap()).unwrap(), req);
        let resp = Response::Refused {
            reason: Refusal::NotCarried,
        };
        assert_eq!(decode::<Response>(&encode(&resp).unwrap()).unwrap(), resp);
    }

    #[test]
    fn an_oversized_declared_length_is_refused_before_allocating() {
        let header = ((MAX_FRAME + 1) as u32).to_be_bytes();
        assert_eq!(
            declared_len(header),
            Err(FrameError::TooLarge(MAX_FRAME + 1))
        );
    }

    #[test]
    fn a_truncated_frame_is_an_error_not_a_panic() {
        let frame = encode(&Request::Fetch).unwrap();
        assert_eq!(decode::<Request>(&frame[..2]), Err(FrameError::Truncated));
        let mut short = frame.clone();
        short[3] += 5;
        assert_eq!(decode::<Request>(&short), Err(FrameError::Truncated));
    }

    #[test]
    fn claim_links_round_trip_and_reject_junk() {
        let secret = [0xab; 32];
        let link = claim_link("endpointabc", &secret);
        assert_eq!(parse_claim_link(&link), Some(("endpointabc", secret)));
        assert_eq!(
            parse_claim_link("streetcryptid-repeater:endpointabc#zz"),
            None
        );
        assert_eq!(parse_claim_link("https://example.com"), None);
        assert_eq!(
            parse_claim_link(&format!("{CLAIM_SCHEME}#{}", "00".repeat(32))),
            None
        );
    }

    #[test]
    fn a_grant_proof_binds_namespace_repeater_and_member() {
        let ns_key = SigningKey::from_bytes(&[5; 32]);
        let ns = ns_key.verifying_key().to_bytes();
        let (repeater, member, other) = ([1; 32], [2; 32], [3; 32]);
        let proof = sign_grant(&ns_key, &repeater, &member);
        assert!(verify_grant(&ns, &repeater, &member, &proof));
        // Replayed by someone else, at another repeater, or for another namespace: refused.
        assert!(!verify_grant(&ns, &repeater, &other, &proof));
        assert!(!verify_grant(&ns, &other, &member, &proof));
        let not_ns = SigningKey::from_bytes(&[6; 32]).verifying_key().to_bytes();
        assert!(!verify_grant(&not_ns, &repeater, &member, &proof));
        assert!(!verify_grant(&ns, &repeater, &member, b"junk"));
    }

    #[test]
    fn secrets_compare_by_value() {
        assert!(secrets_match(&[3; 32], &[3; 32]));
        let mut other = [3; 32];
        other[31] = 4;
        assert!(!secrets_match(&[3; 32], &other));
    }
}
