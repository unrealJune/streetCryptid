//! MLS integration seam — **interface + passthrough stub only** (RFC 9420).
//!
//! In MLS terms the stash is an untrusted **Delivery Service (DS)**: it stores and forwards
//! opaque group messages between members without the keys to read them. Today the durable path
//! ships per-recipient HPKE-wrapped envelopes (ARCHITECTURE §4) and the stash replicates them
//! blind. If group confidentiality later moves to MLS, the stash would gain awareness of MLS
//! message *framing* — handshake vs application messages, epoch/Commit ordering, Welcome routing —
//! but **never** the group secrets.
//!
//! This module is that seam. The default [`PassthroughDelivery`] admits every envelope unchanged,
//! exactly matching today's ciphertext-blind replication, so a real MLS-aware delivery service can
//! be dropped in later where the replica admits a reconciled entry, with no other plumbing change.

/// A reconciled/incoming envelope the replica is about to accept, described without decrypting it.
/// Everything here is already public metadata on the docs entry (namespace, key `author/seq`) plus
/// the opaque bytes.
#[derive(Debug, Clone, Copy)]
pub struct EnvelopeRef<'a> {
    /// The docs namespace the entry belongs to.
    pub namespace: &'a [u8; 32],
    /// The envelope author (the writer's EndpointId, encoded into the key).
    pub author: &'a [u8],
    /// The author's monotonic sequence number.
    pub seq: u64,
    /// The opaque, sealed envelope bytes. A delivery service MUST treat these as uninterpreted
    /// unless/until it is an MLS-aware implementation acting on MLS framing only.
    pub bytes: &'a [u8],
}

/// The delivery service's verdict on an envelope.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Admission {
    /// Store/replicate the envelope as-is.
    Accept,
    /// Refuse it, with a short machine-facing reason for logs/metrics.
    Reject(String),
}

/// The Delivery Service seam. Implementors decide whether an incoming envelope is admitted into
/// the replica. Kept intentionally minimal: the stash never mutates envelope bytes and never has
/// group secrets, so the only decision is admit/refuse.
pub trait DeliveryService: Send + Sync {
    fn admit(&self, envelope: &EnvelopeRef<'_>) -> Admission;
}

/// Current behavior: treat every envelope as an opaque blob and admit it unchanged. Holds no MLS
/// state, preserving the stash's ciphertext-blindness. This is the stub to replace when MLS lands.
#[derive(Debug, Default, Clone, Copy)]
pub struct PassthroughDelivery;

impl DeliveryService for PassthroughDelivery {
    fn admit(&self, _envelope: &EnvelopeRef<'_>) -> Admission {
        Admission::Accept
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passthrough_admits_any_envelope() {
        let ds = PassthroughDelivery;
        let ns = [9u8; 32];
        let author = [7u8; 32];
        let env = EnvelopeRef {
            namespace: &ns,
            author: &author,
            seq: 42,
            bytes: b"\x00\x01\x02opaque-ciphertext",
        };
        assert_eq!(ds.admit(&env), Admission::Accept);
    }

    #[test]
    fn passthrough_admits_empty_bytes() {
        let ds = PassthroughDelivery;
        let ns = [0u8; 32];
        let author = [0u8; 32];
        let env = EnvelopeRef {
            namespace: &ns,
            author: &author,
            seq: 0,
            bytes: &[],
        };
        assert_eq!(ds.admit(&env), Admission::Accept);
    }

    // A hand-rolled "future MLS" impl compiles against the same trait — proves the seam is real
    // and drop-in, without pulling any MLS dependency now.
    struct RejectHandshakeStub;
    impl DeliveryService for RejectHandshakeStub {
        fn admit(&self, env: &EnvelopeRef<'_>) -> Admission {
            if env.bytes.first() == Some(&0xff) {
                Admission::Reject("example: unexpected handshake framing".to_string())
            } else {
                Admission::Accept
            }
        }
    }

    #[test]
    fn seam_supports_a_selective_delivery_service() {
        let ds = RejectHandshakeStub;
        let ns = [1u8; 32];
        let author = [2u8; 32];
        let ok = EnvelopeRef {
            namespace: &ns,
            author: &author,
            seq: 1,
            bytes: b"\x01app",
        };
        let bad = EnvelopeRef {
            namespace: &ns,
            author: &author,
            seq: 2,
            bytes: b"\xffhandshake",
        };
        assert_eq!(ds.admit(&ok), Admission::Accept);
        assert!(matches!(ds.admit(&bad), Admission::Reject(_)));
    }
}
