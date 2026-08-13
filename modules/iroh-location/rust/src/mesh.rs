//! Festival-mesh **radio capsules** — the outer wrapper that lets a location envelope
//! travel over open radio (BLE / ESP-NOW) without leaking a linkable identity.
//!
//! See `docs/mesh/DESIGN.md` §3.2. The inner envelope is [`crate::crypto`]'s, unchanged;
//! but its `author` (32-byte ed25519 EndpointId) and `sig` are plaintext and *stable*, so
//! putting it on air bare would be a stalking beacon. A capsule addresses the envelope by a
//! per-epoch rotating `tag` that only the two endpoints can compute:
//!
//! ```text
//! ss_AB = X25519(A.recv_priv, B.recv_pub)                       // symmetric
//! tag   = blake3_kdf("sc-mesh-tag/v1", A.endpoint_id || epoch_le || ss)[..16]
//! K_e   = blake3_kdf("sc-mesh-key/v1", A.endpoint_id || epoch_le || ss)[..32]
//! ```
//!
//! Wire (little-endian; a 21-byte plaintext header, then the nonce, then ciphertext):
//!
//! ```text
//! v: u8 = 0x01 | epoch: u32 | tag: [u8;16] | nonce: [u8;12] | ct: bytes
//! ct = ChaCha20-Poly1305(K_e, nonce, envelope_bytes, aad = v || epoch || tag)
//! ```
//!
//! **No outer signature, ever.** Authenticity is the AEAD (only A and B hold `K_e`) plus the
//! inner envelope's existing ed25519 `sig`, verified after decryption by `crypto::open`.
//!
//! Everything here is pure: no async, no iroh, no platform. The byte layout is *normative* —
//! `tests/fixtures/mesh_vectors.json` pins it, and the antenna firmware (which parses only
//! `{v, epoch, tag}` and treats the rest as opaque) must reproduce it.

use std::collections::{HashMap, VecDeque};

use chacha20poly1305::aead::{Aead, KeyInit, Payload as AeadPayload};
use chacha20poly1305::{ChaCha20Poly1305, Nonce};
use rand::rngs::OsRng;
use rand::RngCore;
use x25519_dalek::{PublicKey as XPublicKey, StaticSecret as XStaticSecret};

/// Current capsule wire version.
pub const CAPSULE_V: u8 = 0x01;
/// Epoch length in seconds. 15 min — matches BLE MAC rotation (DESIGN §3.2).
pub const EPOCH_SECS: u64 = 900;
/// Mailbox address length.
pub const TAG_LEN: usize = 16;
/// Dedup-key length: `blake3(capsule_bytes)[..16]`.
pub const DEDUP_LEN: usize = 16;
/// Per-tag ring depth held by a mailbox — LWW head plus 3 slots of jitter tolerance (§4.1).
pub const RING_DEPTH: usize = 4;
/// Cap on tags in one BLE Query: 3 epochs x ~21 friends (§4.1).
pub const MAX_QUERY_TAGS: usize = 64;

const NONCE_LEN: usize = 12;
const KEY_LEN: usize = 32;
const AUTHOR_LEN: usize = 32;
const PUBKEY_LEN: usize = 32;
/// `v` + `epoch` + `tag` — the prefix a bare antenna parses; everything after is opaque.
pub const HEADER_LEN: usize = 1 + 4 + TAG_LEN;
/// Smallest legal capsule: header + nonce + an empty AEAD ciphertext (16-byte tag).
const MIN_CAPSULE_LEN: usize = HEADER_LEN + NONCE_LEN + 16;

const TAG_CONTEXT: &str = "sc-mesh-tag/v1";
const KEY_CONTEXT: &str = "sc-mesh-key/v1";

#[derive(Debug, thiserror::Error)]
pub enum MeshError {
    #[error("invalid key length")]
    KeyLength,
    #[error("peer receiving key is a low-order point")]
    DegenerateKey,
    #[error("capsule is truncated or malformed")]
    Malformed,
    #[error("unsupported capsule version {0}")]
    UnsupportedVersion(u8),
    #[error("capsule tag does not match this author/epoch")]
    TagMismatch,
    #[error("capsule decryption failed")]
    Cipher,
}

/// Which 15-minute epoch a unix timestamp (seconds) falls in.
pub fn epoch_at(now_secs: u64) -> u32 {
    (now_secs / EPOCH_SECS) as u32
}

/// The epochs a mailbox accepts and a phone queries: `{e-1, e, e+1}` (clock skew, §3.2).
///
/// Ordered oldest-first and saturating at 0 so epoch 0 yields `[0, 1]` rather than wrapping.
pub fn epoch_window(now_secs: u64) -> Vec<u32> {
    let e = epoch_at(now_secs);
    let mut window = Vec::with_capacity(3);
    if let Some(prev) = e.checked_sub(1) {
        window.push(prev);
    }
    window.push(e);
    window.push(e + 1);
    window
}

/// `true` when `epoch` is inside the acceptance window for `now_secs`.
pub fn epoch_in_window(epoch: u32, now_secs: u64) -> bool {
    epoch_window(now_secs).contains(&epoch)
}

/// X25519 shared secret between my receiving key and a peer's receiving public key.
///
/// Both directions compute the same value, which is what makes a tag mutually derivable:
/// `shared_secret(A.priv, B.pub) == shared_secret(B.priv, A.pub)`. The bytes are the *same*
/// receiving keypair [`crate::crypto::generate_recv_keypair`] already mints (HPKE's
/// `X25519HkdfSha256` serialises the raw scalar / raw montgomery-u point).
pub fn shared_secret(my_recv_secret: &[u8], peer_recv_pub: &[u8]) -> Result<[u8; 32], MeshError> {
    if my_recv_secret.len() != KEY_LEN || peer_recv_pub.len() != PUBKEY_LEN {
        return Err(MeshError::KeyLength);
    }
    let mut sk = [0u8; KEY_LEN];
    sk.copy_from_slice(my_recv_secret);
    let mut pk = [0u8; PUBKEY_LEN];
    pk.copy_from_slice(peer_recv_pub);
    let secret = XStaticSecret::from(sk);
    let shared = secret.diffie_hellman(&XPublicKey::from(pk));
    // A low-order peer point yields an all-zero secret that both sides "agree" on without any
    // real key agreement. Contact cards come from an in-person pairing, but a forged card must
    // not be able to pin every friend onto one predictable tag stream.
    if !shared.was_contributory() {
        return Err(MeshError::DegenerateKey);
    }
    Ok(*shared.as_bytes())
}

/// blake3 KDF over `author || epoch_le || ss` under `context`.
fn derive(context: &str, ss: &[u8; 32], author: &[u8; AUTHOR_LEN], epoch: u32) -> [u8; 32] {
    let mut hasher = blake3::Hasher::new_derive_key(context);
    hasher.update(author);
    hasher.update(&epoch.to_le_bytes());
    hasher.update(ss);
    *hasher.finalize().as_bytes()
}

/// The mailbox address for `author -> holder-of-ss` during `epoch`. Meaningless to anyone else.
pub fn tag(ss: &[u8; 32], author: &[u8; AUTHOR_LEN], epoch: u32) -> [u8; TAG_LEN] {
    let full = derive(TAG_CONTEXT, ss, author, epoch);
    let mut out = [0u8; TAG_LEN];
    out.copy_from_slice(&full[..TAG_LEN]);
    out
}

/// The per-epoch AEAD key for `author -> holder-of-ss`.
pub fn capsule_key(ss: &[u8; 32], author: &[u8; AUTHOR_LEN], epoch: u32) -> [u8; KEY_LEN] {
    derive(KEY_CONTEXT, ss, author, epoch)
}

/// `blake3(capsule_bytes)[..16]` — the dedup key every relay tier keys on (§3.2).
pub fn dedup_key(capsule: &[u8]) -> [u8; DEDUP_LEN] {
    let h = blake3::hash(capsule);
    let mut out = [0u8; DEDUP_LEN];
    out.copy_from_slice(&h.as_bytes()[..DEDUP_LEN]);
    out
}

/// The plaintext prefix of a capsule: everything a bare antenna is allowed to understand.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Header {
    pub v: u8,
    pub epoch: u32,
    pub tag: [u8; TAG_LEN],
}

/// Parse `{v, epoch, tag}` without any key material. Rejects short frames and unknown versions.
pub fn parse_header(capsule: &[u8]) -> Result<Header, MeshError> {
    if capsule.len() < MIN_CAPSULE_LEN {
        return Err(MeshError::Malformed);
    }
    let v = capsule[0];
    if v != CAPSULE_V {
        return Err(MeshError::UnsupportedVersion(v));
    }
    let epoch = u32::from_le_bytes([capsule[1], capsule[2], capsule[3], capsule[4]]);
    let mut tag = [0u8; TAG_LEN];
    tag.copy_from_slice(&capsule[5..5 + TAG_LEN]);
    Ok(Header { v, epoch, tag })
}

/// The AEAD associated data: the full plaintext header, so a capsule cannot be replayed
/// under a different epoch or re-addressed to another tag.
fn aad(epoch: u32, tag: &[u8; TAG_LEN]) -> [u8; HEADER_LEN] {
    let mut ad = [0u8; HEADER_LEN];
    ad[0] = CAPSULE_V;
    ad[1..5].copy_from_slice(&epoch.to_le_bytes());
    ad[5..].copy_from_slice(tag);
    ad
}

/// Wrap one already-sealed envelope for one recipient. `epoch` is the caller's current epoch.
///
/// `author_endpoint_id` is **the author's** 32-byte EndpointId (mine, when I am publishing) —
/// it goes into the tag derivation, not onto the wire.
pub fn seal(
    my_recv_secret: &[u8],
    author_endpoint_id: &[u8],
    recipient_recv_pub: &[u8],
    envelope: &[u8],
    epoch: u32,
) -> Result<Vec<u8>, MeshError> {
    let mut nonce = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce);
    seal_with_nonce(
        my_recv_secret,
        author_endpoint_id,
        recipient_recv_pub,
        envelope,
        epoch,
        &nonce,
    )
}

/// [`seal`] with a caller-supplied nonce. This exists **only** so `tests/mesh_vectors.rs` can
/// produce byte-reproducible capsules for the normative fixture; production callers must use
/// [`seal`] and its fresh random nonce. Not on the UniFFI surface.
#[doc(hidden)]
pub fn seal_with_nonce(
    my_recv_secret: &[u8],
    author_endpoint_id: &[u8],
    recipient_recv_pub: &[u8],
    envelope: &[u8],
    epoch: u32,
    nonce: &[u8; NONCE_LEN],
) -> Result<Vec<u8>, MeshError> {
    let author: [u8; AUTHOR_LEN] = author_endpoint_id
        .try_into()
        .map_err(|_| MeshError::KeyLength)?;
    let ss = shared_secret(my_recv_secret, recipient_recv_pub)?;
    let t = tag(&ss, &author, epoch);
    let key = capsule_key(&ss, &author, epoch);
    let ad = aad(epoch, &t);

    let cipher = ChaCha20Poly1305::new_from_slice(&key).map_err(|_| MeshError::KeyLength)?;
    let ct = cipher
        .encrypt(
            Nonce::from_slice(nonce),
            AeadPayload {
                msg: envelope,
                aad: &ad,
            },
        )
        .map_err(|_| MeshError::Cipher)?;

    let mut out = Vec::with_capacity(HEADER_LEN + NONCE_LEN + ct.len());
    out.extend_from_slice(&ad);
    out.extend_from_slice(nonce);
    out.extend_from_slice(&ct);
    Ok(out)
}

/// Unwrap a capsule addressed to me by `author_endpoint_id`, returning the inner envelope bytes.
///
/// The caller resolves *which* author a capsule belongs to by matching its `tag` against
/// [`expected_tags`]; this then re-derives the tag and refuses a mismatch before spending an
/// AEAD open. The returned bytes still need `crypto::open` — that is where the ed25519
/// signature is checked.
pub fn open(
    my_recv_secret: &[u8],
    author_endpoint_id: &[u8],
    author_recv_pub: &[u8],
    capsule: &[u8],
) -> Result<Vec<u8>, MeshError> {
    let author: [u8; AUTHOR_LEN] = author_endpoint_id
        .try_into()
        .map_err(|_| MeshError::KeyLength)?;
    let header = parse_header(capsule)?;

    let ss = shared_secret(my_recv_secret, author_recv_pub)?;
    if tag(&ss, &author, header.epoch) != header.tag {
        return Err(MeshError::TagMismatch);
    }
    let key = capsule_key(&ss, &author, header.epoch);
    let ad = aad(header.epoch, &header.tag);

    let nonce = &capsule[HEADER_LEN..HEADER_LEN + NONCE_LEN];
    let ct = &capsule[HEADER_LEN + NONCE_LEN..];
    let cipher = ChaCha20Poly1305::new_from_slice(&key).map_err(|_| MeshError::KeyLength)?;
    cipher
        .decrypt(Nonce::from_slice(nonce), AeadPayload { msg: ct, aad: &ad })
        .map_err(|_| MeshError::Cipher)
}

/// One friend as far as tag derivation is concerned.
#[derive(Debug, Clone)]
pub struct Peer {
    /// The friend's 32-byte ed25519 EndpointId (the envelope author id).
    pub endpoint_id: Vec<u8>,
    /// The friend's 32-byte X25519 receiving public key.
    pub recv_public: Vec<u8>,
}

/// A tag we expect to find in a mailbox, with the author/epoch that produced it.
#[derive(Debug, Clone)]
pub struct ExpectedTag {
    pub tag: [u8; TAG_LEN],
    pub author: Vec<u8>,
    pub epoch: u32,
}

/// Every tag addressed **to me** across the `{e-1, e, e+1}` window — the BLE Query set (§4.1).
///
/// Peers that fail key-length validation are skipped rather than failing the whole sweep: one
/// malformed contact card must not blind the phone to every other friend.
pub fn expected_tags(my_recv_secret: &[u8], peers: &[Peer], now_secs: u64) -> Vec<ExpectedTag> {
    let window = epoch_window(now_secs);
    let mut out = Vec::with_capacity(peers.len() * window.len());
    for peer in peers {
        let author: [u8; AUTHOR_LEN] = match peer.endpoint_id.as_slice().try_into() {
            Ok(a) => a,
            Err(_) => continue,
        };
        let ss = match shared_secret(my_recv_secret, &peer.recv_public) {
            Ok(ss) => ss,
            Err(_) => continue,
        };
        for &epoch in &window {
            out.push(ExpectedTag {
                tag: tag(&ss, &author, epoch),
                author: peer.endpoint_id.clone(),
                epoch,
            });
        }
    }
    out
}

// ---------------------------------------------------------------------------------------------
// LWW capsule store (§4.1 "node behavior") — shared by the phone and, later, the smart node.
// ---------------------------------------------------------------------------------------------

/// Outcome of offering a capsule to a [`Store`]. The string form is the `sc.drop_reason`
/// stamped on telemetry at this drop-decision point (`infra/otel/README.md`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Insert {
    Accepted,
    Malformed,
    BadVersion,
    StaleEpoch,
    FutureEpoch,
    Duplicate,
}

impl Insert {
    pub fn as_str(self) -> &'static str {
        match self {
            Insert::Accepted => "accepted",
            Insert::Malformed => "malformed",
            Insert::BadVersion => "bad_version",
            Insert::StaleEpoch => "stale_epoch",
            Insert::FutureEpoch => "future_epoch",
            Insert::Duplicate => "duplicate",
        }
    }

    pub fn accepted(self) -> bool {
        matches!(self, Insert::Accepted)
    }
}

#[derive(Debug, Clone)]
struct Entry {
    dedup: [u8; DEDUP_LEN],
    epoch: u32,
    bytes: Vec<u8>,
}

/// A mailbox: capsules indexed by `tag`, newest-first, bounded per tag and overall.
///
/// LWW means *arrival order*, not a timestamp — a tag already encodes author+recipient+epoch, so
/// "latest capsule seen for this tag" is the live position. The store never looks past the
/// 21-byte plaintext header; capsule interiors are opaque here exactly as in firmware.
#[derive(Debug)]
pub struct Store {
    tags: HashMap<[u8; TAG_LEN], VecDeque<Entry>>,
    /// Tags in least-recently-written-first order, for eviction once `capacity` is hit.
    lru: VecDeque<[u8; TAG_LEN]>,
    capacity: usize,
}

impl Store {
    /// `capacity` bounds the number of *tags* held (Q6's PSRAM knob); each holds up to
    /// [`RING_DEPTH`] capsules.
    pub fn new(capacity: usize) -> Self {
        Self {
            tags: HashMap::new(),
            lru: VecDeque::new(),
            capacity: capacity.max(1),
        }
    }

    /// Offer a capsule. Accepts only well-formed, in-window, not-already-held capsules.
    pub fn insert(&mut self, capsule: &[u8], now_secs: u64) -> Insert {
        let header = match parse_header(capsule) {
            Ok(h) => h,
            Err(MeshError::UnsupportedVersion(_)) => return Insert::BadVersion,
            Err(_) => return Insert::Malformed,
        };
        let current = epoch_at(now_secs);
        if header.epoch + 1 < current {
            return Insert::StaleEpoch;
        }
        if header.epoch > current + 1 {
            return Insert::FutureEpoch;
        }

        let dedup = dedup_key(capsule);
        let ring = self.tags.entry(header.tag).or_default();
        if ring.iter().any(|e| e.dedup == dedup) {
            return Insert::Duplicate;
        }
        ring.push_front(Entry {
            dedup,
            epoch: header.epoch,
            bytes: capsule.to_vec(),
        });
        while ring.len() > RING_DEPTH {
            ring.pop_back();
        }

        self.touch(header.tag);
        self.evict_to_capacity();
        Insert::Accepted
    }

    /// The live position for a tag: the most recently arrived capsule.
    pub fn latest(&self, tag: &[u8; TAG_LEN]) -> Option<&[u8]> {
        self.tags
            .get(tag)
            .and_then(|ring| ring.front())
            .map(|e| e.bytes.as_slice())
    }

    /// Dedup keys already held for `tags` — the `have` set a phone sends with its Query.
    pub fn have(&self, tags: &[[u8; TAG_LEN]]) -> Vec<[u8; DEDUP_LEN]> {
        let mut out = Vec::new();
        for tag in tags {
            if let Some(ring) = self.tags.get(tag) {
                out.extend(ring.iter().map(|e| e.dedup));
            }
        }
        out
    }

    /// Capsules matching `tags` minus everything in `have` — the Deliver set (§4.1).
    /// Newest-first within each tag, so a truncated transfer still lands the live position.
    pub fn deliver(&self, tags: &[[u8; TAG_LEN]], have: &[[u8; DEDUP_LEN]]) -> Vec<Vec<u8>> {
        let mut out = Vec::new();
        for tag in tags {
            let Some(ring) = self.tags.get(tag) else {
                continue;
            };
            for entry in ring {
                if !have.contains(&entry.dedup) {
                    out.push(entry.bytes.clone());
                }
            }
        }
        out
    }

    /// Drop everything whose epoch has fallen out of the acceptance window. History is the
    /// trail-stash's job (via egress), not the mailbox's.
    pub fn prune(&mut self, now_secs: u64) -> usize {
        let current = epoch_at(now_secs);
        let mut removed = 0;
        self.tags.retain(|_, ring| {
            let before = ring.len();
            ring.retain(|e| e.epoch + 1 >= current && e.epoch <= current + 1);
            removed += before - ring.len();
            !ring.is_empty()
        });
        self.lru.retain(|tag| self.tags.contains_key(tag));
        removed
    }

    /// `(capsules, tags)` currently held.
    pub fn stats(&self) -> (u64, u64) {
        let capsules = self.tags.values().map(|r| r.len() as u64).sum();
        (capsules, self.tags.len() as u64)
    }

    fn touch(&mut self, tag: [u8; TAG_LEN]) {
        if let Some(pos) = self.lru.iter().position(|t| *t == tag) {
            self.lru.remove(pos);
        }
        self.lru.push_back(tag);
    }

    fn evict_to_capacity(&mut self) {
        while self.tags.len() > self.capacity {
            match self.lru.pop_front() {
                Some(oldest) => {
                    self.tags.remove(&oldest);
                }
                None => break,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto;

    fn keypair() -> (Vec<u8>, Vec<u8>) {
        crypto::generate_recv_keypair()
    }

    fn author_id(byte: u8) -> [u8; 32] {
        [byte; 32]
    }

    #[test]
    fn shared_secret_is_symmetric() {
        let (a_sk, a_pk) = keypair();
        let (b_sk, b_pk) = keypair();
        assert_eq!(
            shared_secret(&a_sk, &b_pk).unwrap(),
            shared_secret(&b_sk, &a_pk).unwrap()
        );
    }

    #[test]
    fn both_sides_derive_the_same_tag() {
        let (a_sk, a_pk) = keypair();
        let (b_sk, b_pk) = keypair();
        let author = author_id(7);
        let from_a = tag(&shared_secret(&a_sk, &b_pk).unwrap(), &author, 42);
        let from_b = tag(&shared_secret(&b_sk, &a_pk).unwrap(), &author, 42);
        assert_eq!(from_a, from_b);
    }

    #[test]
    fn tags_are_unlinkable_across_epochs_and_pairs() {
        let (a_sk, _a_pk) = keypair();
        let (_b_sk, b_pk) = keypair();
        let (_c_sk, c_pk) = keypair();
        let ss_ab = shared_secret(&a_sk, &b_pk).unwrap();
        let ss_ac = shared_secret(&a_sk, &c_pk).unwrap();
        let author = author_id(7);

        assert_ne!(tag(&ss_ab, &author, 100), tag(&ss_ab, &author, 101));
        assert_ne!(tag(&ss_ab, &author, 100), tag(&ss_ac, &author, 100));
        assert_ne!(
            tag(&ss_ab, &author, 100),
            tag(&ss_ab, &author_id(8), 100),
            "a different author must not reuse a tag"
        );
        // The tag and the AEAD key must not be the same derivation truncated differently.
        assert_ne!(
            &capsule_key(&ss_ab, &author, 100)[..TAG_LEN],
            &tag(&ss_ab, &author, 100)[..]
        );
    }

    #[test]
    fn capsule_round_trips() {
        let (a_sk, a_pk) = keypair();
        let (b_sk, b_pk) = keypair();
        let author = author_id(1);
        let envelope = b"pretend this is a sealed envelope";

        let capsule = seal(&a_sk, &author, &b_pk, envelope, 12_345).unwrap();
        let header = parse_header(&capsule).unwrap();
        assert_eq!(header.v, CAPSULE_V);
        assert_eq!(header.epoch, 12_345);
        assert_eq!(capsule.len(), HEADER_LEN + NONCE_LEN + envelope.len() + 16);

        let out = open(&b_sk, &author, &a_pk, &capsule).unwrap();
        assert_eq!(out, envelope);
    }

    #[test]
    fn stranger_cannot_open_or_address() {
        let (a_sk, a_pk) = keypair();
        let (_b_sk, b_pk) = keypair();
        let (d_sk, _d_pk) = keypair(); // D is not the recipient
        let author = author_id(1);

        let capsule = seal(&a_sk, &author, &b_pk, b"secret", 9).unwrap();
        // D derives a different ss, so the tag check fires before any AEAD work.
        assert!(matches!(
            open(&d_sk, &author, &a_pk, &capsule),
            Err(MeshError::TagMismatch)
        ));
    }

    #[test]
    fn tampering_and_re_addressing_are_detected() {
        let (a_sk, a_pk) = keypair();
        let (b_sk, b_pk) = keypair();
        let author = author_id(1);
        let capsule = seal(&a_sk, &author, &b_pk, b"payload", 9).unwrap();

        let mut flipped = capsule.clone();
        let last = flipped.len() - 1;
        flipped[last] ^= 0xff;
        assert!(matches!(
            open(&b_sk, &author, &a_pk, &flipped),
            Err(MeshError::Cipher)
        ));

        // Rewriting the epoch in the header invalidates both the tag and the AEAD aad.
        let mut moved = capsule.clone();
        moved[1] ^= 0x01;
        assert!(matches!(
            open(&b_sk, &author, &a_pk, &moved),
            Err(MeshError::TagMismatch)
        ));
    }

    #[test]
    fn header_parsing_rejects_junk() {
        assert!(matches!(parse_header(&[]), Err(MeshError::Malformed)));
        assert!(matches!(
            parse_header(&[0u8; MIN_CAPSULE_LEN - 1]),
            Err(MeshError::Malformed)
        ));
        let mut bad = [0u8; MIN_CAPSULE_LEN];
        bad[0] = 0x02;
        assert!(matches!(
            parse_header(&bad),
            Err(MeshError::UnsupportedVersion(2))
        ));
    }

    #[test]
    fn epoch_window_covers_skew_and_saturates() {
        assert_eq!(epoch_at(0), 0);
        assert_eq!(epoch_at(899), 0);
        assert_eq!(epoch_at(900), 1);
        assert_eq!(epoch_window(0), vec![0, 1]);
        assert_eq!(epoch_window(900 * 10), vec![9, 10, 11]);
        assert!(epoch_in_window(9, 900 * 10));
        assert!(!epoch_in_window(8, 900 * 10));
        assert!(!epoch_in_window(12, 900 * 10));
    }

    #[test]
    fn expected_tags_covers_the_window_and_skips_bad_peers() {
        let (me_sk, _me_pk) = keypair();
        let (_f_sk, f_pk) = keypair();
        let peers = vec![
            Peer {
                endpoint_id: author_id(3).to_vec(),
                recv_public: f_pk,
            },
            Peer {
                endpoint_id: vec![0u8; 4], // malformed card — must not blind the sweep
                recv_public: vec![0u8; 32],
            },
        ];
        let tags = expected_tags(&me_sk, &peers, 900 * 10);
        assert_eq!(tags.len(), 3);
        assert_eq!(
            tags.iter().map(|t| t.epoch).collect::<Vec<_>>(),
            vec![9, 10, 11]
        );
    }

    fn stub_capsule(a_sk: &[u8], b_pk: &[u8], epoch: u32, body: &[u8]) -> Vec<u8> {
        seal(a_sk, &author_id(1), b_pk, body, epoch).unwrap()
    }

    #[test]
    fn low_order_peer_key_is_rejected() {
        let (a_sk, _a_pk) = keypair();
        assert!(matches!(
            shared_secret(&a_sk, &[0u8; 32]),
            Err(MeshError::DegenerateKey)
        ));
    }

    #[test]
    fn store_keeps_latest_dedups_and_bounds_the_ring() {
        let (a_sk, _a_pk) = keypair();
        let (_b_sk, b_pk) = keypair();
        let now = 900 * 10;
        let mut store = Store::new(64);

        let first = stub_capsule(&a_sk, &b_pk, 10, b"one");
        let tag = parse_header(&first).unwrap().tag;

        assert_eq!(store.insert(&first, now), Insert::Accepted);
        assert_eq!(store.insert(&first, now), Insert::Duplicate);
        assert_eq!(store.latest(&tag).unwrap(), first.as_slice());

        // Five more distinct capsules for the same tag: ring keeps the newest RING_DEPTH.
        let mut newest = Vec::new();
        for i in 0..5u8 {
            let c = stub_capsule(&a_sk, &b_pk, 10, &[b'x', i]);
            assert_eq!(store.insert(&c, now), Insert::Accepted);
            newest = c;
        }
        assert_eq!(store.latest(&tag).unwrap(), newest.as_slice());
        assert_eq!(store.stats(), (RING_DEPTH as u64, 1));
    }

    #[test]
    fn store_rejects_out_of_window_and_malformed() {
        let (a_sk, _a_pk) = keypair();
        let (_b_sk, b_pk) = keypair();
        let now = 900 * 10;
        let mut store = Store::new(64);

        let stale = stub_capsule(&a_sk, &b_pk, 8, b"old");
        let future = stub_capsule(&a_sk, &b_pk, 12, b"soon");
        assert_eq!(store.insert(&stale, now), Insert::StaleEpoch);
        assert_eq!(store.insert(&future, now), Insert::FutureEpoch);
        assert_eq!(store.insert(&[], now), Insert::Malformed);

        let mut wrong_v = stub_capsule(&a_sk, &b_pk, 10, b"v");
        wrong_v[0] = 0x02;
        assert_eq!(store.insert(&wrong_v, now), Insert::BadVersion);
        assert_eq!(store.stats(), (0, 0));
    }

    #[test]
    fn store_have_and_deliver_compute_the_delta() {
        let (a_sk, _a_pk) = keypair();
        let (_b_sk, b_pk) = keypair();
        let now = 900 * 10;
        let mut store = Store::new(64);

        let one = stub_capsule(&a_sk, &b_pk, 10, b"one");
        let two = stub_capsule(&a_sk, &b_pk, 10, b"two");
        store.insert(&one, now);
        store.insert(&two, now);
        let tag = parse_header(&one).unwrap().tag;

        assert_eq!(store.have(&[tag]).len(), 2);
        assert!(store.deliver(&[tag], &store.have(&[tag])).is_empty());
        // A phone that only holds `one` gets exactly `two` back.
        let delta = store.deliver(&[tag], &[dedup_key(&one)]);
        assert_eq!(delta, vec![two]);
    }

    #[test]
    fn store_prunes_the_previous_window_and_evicts_by_lru() {
        let (a_sk, _a_pk) = keypair();
        let (_b_sk, b_pk) = keypair();
        let mut store = Store::new(64);

        let c = stub_capsule(&a_sk, &b_pk, 10, b"one");
        store.insert(&c, 900 * 10);
        assert_eq!(store.prune(900 * 11), 0, "e-1 is still in window");
        assert_eq!(store.prune(900 * 12), 1);
        assert_eq!(store.stats(), (0, 0));

        // Capacity is a tag budget; oldest-written tag falls out first.
        let mut small = Store::new(2);
        let (_c_sk, c_pk) = keypair();
        let (_d_sk, d_pk) = keypair();
        let now = 900 * 10;
        let t1 = stub_capsule(&a_sk, &b_pk, 10, b"1");
        let t2 = stub_capsule(&a_sk, &c_pk, 10, b"2");
        let t3 = stub_capsule(&a_sk, &d_pk, 10, b"3");
        small.insert(&t1, now);
        small.insert(&t2, now);
        small.insert(&t3, now);
        assert_eq!(small.stats().1, 2);
        assert!(small.latest(&parse_header(&t1).unwrap().tag).is_none());
        assert!(small.latest(&parse_header(&t3).unwrap().tag).is_some());
    }
}
