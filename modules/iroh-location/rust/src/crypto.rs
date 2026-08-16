//! App-layer end-to-end crypto for the location envelope.
//!
//! See `docs/social/ARCHITECTURE.md` §4. Per fix we:
//!   1. encrypt the payload ONCE with RFC 8439 ChaCha20-Poly1305 under a fresh random 32-byte
//!      content key `K`,
//!   2. WRAP `K` per recipient with HPKE (DhKemX25519HkdfSha256 + ChaCha20Poly1305),
//!   3. SIGN the whole envelope with the author's ed25519 identity key.
//!
//! Revocation = stop emitting a recipient's wrap; because `K` is random per fix,
//! "no wrap ⇒ no key ⇒ ciphertext is useless" to a dropped recipient.

use chacha20poly1305::aead::{Aead, KeyInit, Payload as AeadPayload};
use chacha20poly1305::{ChaCha20Poly1305, Nonce};
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use hpke::aead::ChaCha20Poly1305 as HpkeAead;
use hpke::kdf::HkdfSha256 as HpkeKdf;
use hpke::kem::X25519HkdfSha256 as HpkeKem;
use hpke::{
    single_shot_open, single_shot_seal, Deserializable, Kem as _, OpModeR, OpModeS, Serializable,
};
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::ratchet::{MessageKey, RatchetHeader, KID_LEN, SESSION_ID_LEN};

/// Domain-separation string for HPKE key wrapping.
const HPKE_INFO: &[u8] = b"streetcryptid/loc/v2/keywrap";
/// Current envelope schema version.
pub const ENVELOPE_V: u8 = 2;

/// The **ratcheted** envelope schema (FORWARD-SECRECY.md §4.7).
///
/// v2 and v3 coexist deliberately rather than v3 replacing v2 outright. The fix path (gossip +
/// docs) is v3, because that is the traffic the stash archives and the traffic forward secrecy is
/// for. HPKE/v2 remains for pairing and any pre-session traffic — including the §4.6 resync
/// record, which cannot be ratchet-sealed because it is the thing that re-establishes the
/// ratchet — and for the mesh path, whose forward secrecy is left open by §8.1.
pub const ENVELOPE_V3: u8 = 3;

/// Fixed all-zero nonce for the v3 wrap AEAD.
///
/// Safe **only** because a message key is used exactly once — the normative rule of §4.2, which
/// [`ratchet::MessageKey`] enforces in the type system by being non-`Clone` and consumable only
/// through `use_once`. Nonce reuse under one key is catastrophic for ChaCha20-Poly1305, so if
/// that type ever gains a `Clone`, this constant becomes a vulnerability.
const WRAP_NONCE: [u8; NONCE_LEN] = [0u8; NONCE_LEN];

const CONTENT_KEY_LEN: usize = 32;
const NONCE_LEN: usize = 12;
const PUBKEY_LEN: usize = 32;
const AUTHOR_LEN: usize = 32;

#[derive(Debug, thiserror::Error)]
pub enum CryptoError {
    #[error("invalid key length")]
    KeyLength,
    #[error("wire decode failed")]
    Decode,
    #[error("wire encode failed")]
    Encode,
    #[error("unsupported envelope version {0}")]
    UnsupportedVersion(u8),
    #[error("signature verification failed")]
    BadSignature,
    #[error("this envelope was not encrypted for me")]
    NotARecipient,
    #[error("aead/hpke operation failed")]
    Cipher,
}

/// One per-recipient key wrap.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Wrap {
    /// blake3(recipient_recv_pub)[..8] — lets a recipient find its own wrap fast.
    kid: [u8; 8],
    /// HPKE encapsulated key (X25519, 32 bytes).
    enc: Vec<u8>,
    /// HPKE ciphertext of the 32-byte content key K.
    ct: Vec<u8>,
}

/// The signed, per-recipient-encrypted location packet as it travels on the wire.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Envelope {
    v: u8,
    author: Vec<u8>, // ed25519 EndpointId (32B)
    seq: u64,
    ts: u64,
    /// **Mesh only.** The 15-minute capsule epoch (`mesh.rs`), bound into the AAD so an envelope
    /// cannot be lifted out of one capsule epoch and replayed in another. The docs path has no
    /// use for it and always writes [`DOCS_MESH_EPOCH`](crate::DOCS_MESH_EPOCH).
    ///
    /// **Do not repurpose this for the ratchet.** The docs-path key epoch is the per-wrap `i` in
    /// the v3 ratchet header (FORWARD-SECRECY.md §4.7); reusing this field would re-merge the two
    /// meanings that §7 step 4 exists to separate, and `mesh_vectors.json` pins its bytes.
    mesh_epoch: u32,
    nonce: Vec<u8>, // RFC 8439 ChaCha20-Poly1305 nonce (12B)
    ct: Vec<u8>,    // ChaCha20-Poly1305 ciphertext of the payload
    wraps: Vec<Wrap>,
    sig: Vec<u8>, // ed25519 signature over the envelope with sig == []
}

/// Result of successfully opening an envelope.
#[derive(Debug, Clone)]
pub struct Opened {
    pub author: [u8; AUTHOR_LEN],
    pub seq: u64,
    /// The decrypted payload — a friend's coordinates. `Zeroizing` for the same reason the keys
    /// that protect it are: §5.4 treats erasure as a design surface, and a plaintext fix left in
    /// freed heap is exactly what the §1 threat model (a seized device) goes looking for.
    ///
    /// Everything downstream reads this by reference and decodes out of it, so the buffer is
    /// scrubbed when the `Opened` drops without any caller having to remember to.
    pub payload: Zeroizing<Vec<u8>>,
}

// ── envelope v3: the ratcheted wrap (FORWARD-SECRECY.md §4.7) ─────────────────────────────────

/// One per-recipient wrap, keyed by a Double Ratchet message key instead of HPKE.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct WrapV3 {
    /// `KDF_kid(CK at this position)[..8]` — **rotating**, unlike v2's stable
    /// `blake3(recv_pub)[..8]`. It changes every message, so the archive can no longer cluster
    /// a recipient across envelopes or across authors (§1.1).
    kid: [u8; KID_LEN],
    /// The sender's ratchet position for this recipient. Plaintext because the receiver needs
    /// `sender_ratchet_pub` to perform the DH ratchet that derives the key opening this very
    /// wrap — encrypting it would be circular. Authenticated by the envelope signature and
    /// bound into this wrap's AAD.
    header: RatchetHeader,
    /// `AEAD(MK, nonce = 0, plaintext = K, aad = envelope_aad ‖ wrap_header ‖ session_id)`.
    ct: Vec<u8>,
}

/// The v3 envelope. Same shape as v2 except for the wrap layer.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct EnvelopeV3 {
    v: u8,
    author: Vec<u8>,
    seq: u64,
    ts: u64,
    mesh_epoch: u32,
    nonce: Vec<u8>,
    ct: Vec<u8>,
    wraps: Vec<WrapV3>,
    sig: Vec<u8>,
}

/// Everything [`seal_v3`] needs for one recipient, produced by that peer's
/// [`RatchetState::next_send`](ratchet::RatchetState::next_send).
///
/// The message key is moved in and consumed, so a slot cannot be sealed twice.
pub struct SealWrap {
    pub kid: [u8; KID_LEN],
    pub header: RatchetHeader,
    pub session_id: [u8; SESSION_ID_LEN],
    pub key: MessageKey,
}

impl std::fmt::Debug for SealWrap {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SealWrap")
            .field("kid", &self.kid)
            .field("header", &self.header)
            .finish_non_exhaustive()
    }
}

/// A v3 envelope whose signature has been checked, before any session state has been touched.
///
/// The split exists to preserve the ordering §4.2 makes normative: **signature verification
/// precedes state mutation**. Locating our wrap and accepting its ratchet position are separate
/// steps the caller performs against its own session state, and neither can run on bytes that
/// have not already been authenticated as coming from this author.
#[derive(Debug, Clone)]
pub struct VerifiedEnvelope {
    pub author: [u8; AUTHOR_LEN],
    pub seq: u64,
    pub ts: u64,
    pub mesh_epoch: u32,
    wraps: Vec<WrapV3>,
    nonce: Vec<u8>,
    ct: Vec<u8>,
}

/// A wrap's plaintext locator: what the caller matches against its session before committing.
#[derive(Debug, Clone, Copy)]
pub struct WrapLocator {
    pub kid: [u8; KID_LEN],
    pub header: RatchetHeader,
}

impl VerifiedEnvelope {
    /// The plaintext locators, in wrap order. The caller asks each of its sessions whether one is
    /// theirs (`RatchetState::matches`), which mutates nothing.
    pub fn locators(&self) -> Vec<WrapLocator> {
        self.wraps
            .iter()
            .map(|w| WrapLocator {
                kid: w.kid,
                header: w.header,
            })
            .collect()
    }

    /// Open wrap `index` with the message key its position derives, then decrypt the payload.
    ///
    /// `session_id` is bound into the wrap's AAD, so a wrap cannot be lifted from one session
    /// into another even between the same two devices — which is what stops a resync (§4.6) from
    /// being a channel for replaying the session it replaced.
    pub fn open_wrap(
        &self,
        index: usize,
        session_id: &[u8; SESSION_ID_LEN],
        key: MessageKey,
    ) -> Result<Opened, CryptoError> {
        let wrap = self.wraps.get(index).ok_or(CryptoError::NotARecipient)?;
        let ad = aad(
            ENVELOPE_V3,
            &self.author,
            self.seq,
            self.ts,
            self.mesh_epoch,
        );
        let wrap_ad = wrap_aad(&ad, &wrap.header, session_id);

        // `Zeroizing` because this is the key that protects the fix, and §5.4 makes erasure
        // hygiene an explicit design surface. `RatchetState` and `MessageKey` already scrub
        // themselves; a content key left in freed heap would be the one link in the chain that
        // does not, and it is the link that decrypts a friend's coordinates.
        let content_key = Zeroizing::new(key.use_once(|mk| {
            let cipher =
                ChaCha20Poly1305::new_from_slice(mk).map_err(|_| CryptoError::KeyLength)?;
            cipher
                .decrypt(
                    Nonce::from_slice(&WRAP_NONCE),
                    AeadPayload {
                        msg: &wrap.ct,
                        aad: &wrap_ad,
                    },
                )
                .map_err(|_| CryptoError::Cipher)
        })?);
        if content_key.len() != CONTENT_KEY_LEN {
            return Err(CryptoError::KeyLength);
        }

        let cipher =
            ChaCha20Poly1305::new_from_slice(&content_key).map_err(|_| CryptoError::KeyLength)?;
        let payload = cipher
            .decrypt(
                Nonce::from_slice(&self.nonce),
                AeadPayload {
                    msg: &self.ct,
                    aad: &ad,
                },
            )
            .map_err(|_| CryptoError::Cipher)?;

        Ok(Opened {
            author: self.author,
            seq: self.seq,
            payload: Zeroizing::new(payload),
        })
    }
}

/// The wrap's associated data: `envelope_aad ‖ wrap_header ‖ session_id` (§4.7).
///
/// Hand-encoded rather than postcard'd so the bytes are pinned by this function alone — the AAD
/// is a security boundary, and a serializer's framing decisions should not be able to move it.
fn wrap_aad(
    envelope_aad: &[u8],
    header: &RatchetHeader,
    session_id: &[u8; SESSION_ID_LEN],
) -> Vec<u8> {
    let mut ad = Vec::with_capacity(envelope_aad.len() + 40 + SESSION_ID_LEN);
    ad.extend_from_slice(envelope_aad);
    ad.extend_from_slice(&header.sender_ratchet_pub);
    ad.extend_from_slice(&header.epoch.to_le_bytes());
    ad.extend_from_slice(&header.counter.to_le_bytes());
    ad.extend_from_slice(session_id);
    ad
}

/// Encode a v3 envelope with an empty signature — the exact bytes that get signed.
fn signing_bytes_v3(env: &EnvelopeV3) -> Result<Vec<u8>, CryptoError> {
    let mut unsigned = env.clone();
    unsigned.sig = Vec::new();
    postcard::to_allocvec(&unsigned).map_err(|_| CryptoError::Encode)
}

/// Seal a payload under envelope v3: one random content key `K`, wrapped per recipient with that
/// peer's ratchet message key rather than with HPKE.
///
/// Revocation still works the same way — no wrap, no key, and `K` is fresh per fix. What changes
/// is that a wrap is no longer openable by a long-term secret a seized device still holds.
#[allow(clippy::too_many_arguments)]
pub fn seal_v3(
    signing_seed: &[u8],
    author: &[u8],
    seq: u64,
    ts: u64,
    mesh_epoch: u32,
    payload: &[u8],
    wraps: Vec<SealWrap>,
) -> Result<Vec<u8>, CryptoError> {
    if signing_seed.len() != 32 || author.len() != AUTHOR_LEN {
        return Err(CryptoError::KeyLength);
    }
    let seed: [u8; 32] = signing_seed
        .try_into()
        .map_err(|_| CryptoError::KeyLength)?;
    let signing_key = SigningKey::from_bytes(&seed);

    // The one key every wrap in this envelope protects. `Zeroizing` rather than a bare array
    // because it outlives the loop below and is copied into each wrap's plaintext — leaving it in
    // freed stack after `seal_v3` returns would undo, for the content key, the erasure discipline
    // `MessageKey` and `RatchetState` enforce for everything around it (§5.4).
    let mut key = Zeroizing::new([0u8; CONTENT_KEY_LEN]);
    OsRng.fill_bytes(key.as_mut());
    let mut nonce = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce);

    let ad = aad(ENVELOPE_V3, author, seq, ts, mesh_epoch);

    let cipher =
        ChaCha20Poly1305::new_from_slice(key.as_ref()).map_err(|_| CryptoError::KeyLength)?;
    let ct = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            AeadPayload {
                msg: payload,
                aad: &ad,
            },
        )
        .map_err(|_| CryptoError::Cipher)?;

    let mut out_wraps = Vec::with_capacity(wraps.len());
    for w in wraps {
        let wrap_ad = wrap_aad(&ad, &w.header, &w.session_id);
        let header = w.header;
        let kid = w.kid;
        let wrap_ct = w.key.use_once(|mk| {
            let c = ChaCha20Poly1305::new_from_slice(mk).map_err(|_| CryptoError::KeyLength)?;
            c.encrypt(
                Nonce::from_slice(&WRAP_NONCE),
                AeadPayload {
                    msg: key.as_ref(),
                    aad: &wrap_ad,
                },
            )
            .map_err(|_| CryptoError::Cipher)
        })?;
        out_wraps.push(WrapV3 {
            kid,
            header,
            ct: wrap_ct,
        });
    }

    let mut env = EnvelopeV3 {
        v: ENVELOPE_V3,
        author: author.to_vec(),
        seq,
        ts,
        mesh_epoch,
        nonce: nonce.to_vec(),
        ct,
        wraps: out_wraps,
        sig: Vec::new(),
    };
    let signature = signing_key.sign(&signing_bytes_v3(&env)?);
    env.sig = signature.to_bytes().to_vec();

    postcard::to_allocvec(&env).map_err(|_| CryptoError::Encode)
}

/// Decode a v3 envelope and verify the author's signature. **Touches no session state.**
///
/// Everything downstream — locating our wrap, accepting a ratchet position, opening the payload —
/// runs on the returned value, so no unauthenticated byte can reach the ratchet (§4.2).
pub fn verify_v3(envelope_bytes: &[u8]) -> Result<VerifiedEnvelope, CryptoError> {
    // Version before layout. The two schemas differ in wrap shape, so decoding first would report
    // a v2 envelope as "wire decode failed" — true but useless. A receiver that logs
    // "unsupported envelope version 2" can act on it.
    match envelope_version(envelope_bytes) {
        Some(ENVELOPE_V3) => {}
        Some(other) => return Err(CryptoError::UnsupportedVersion(other)),
        None => return Err(CryptoError::Decode),
    }
    let env: EnvelopeV3 = postcard::from_bytes(envelope_bytes).map_err(|_| CryptoError::Decode)?;
    if env.v != ENVELOPE_V3 {
        return Err(CryptoError::UnsupportedVersion(env.v));
    }
    if env.author.len() != AUTHOR_LEN || env.nonce.len() != NONCE_LEN {
        return Err(CryptoError::Decode);
    }
    let author: [u8; AUTHOR_LEN] = env
        .author
        .clone()
        .try_into()
        .map_err(|_| CryptoError::Decode)?;
    let vk = VerifyingKey::from_bytes(&author).map_err(|_| CryptoError::BadSignature)?;
    let sig = Signature::from_slice(&env.sig).map_err(|_| CryptoError::BadSignature)?;
    vk.verify_strict(&signing_bytes_v3(&env)?, &sig)
        .map_err(|_| CryptoError::BadSignature)?;

    Ok(VerifiedEnvelope {
        author,
        seq: env.seq,
        ts: env.ts,
        mesh_epoch: env.mesh_epoch,
        wraps: env.wraps,
        nonce: env.nonce,
        ct: env.ct,
    })
}

/// The schema version an encoded envelope declares, without verifying anything.
///
/// Lets a receiver route bytes to the v2 or v3 path on the declared version rather than trying
/// both and treating the first failure as noise. Unverified by construction — the version is
/// read before any signature check, so it may only be used to *choose a parser*, never to decide
/// anything about trust.
pub fn envelope_version(envelope_bytes: &[u8]) -> Option<u8> {
    #[derive(Deserialize)]
    struct VersionOnly {
        v: u8,
    }
    postcard::take_from_bytes::<VersionOnly>(envelope_bytes)
        .ok()
        .map(|(peek, _)| peek.v)
}

/// The signed, plaintext header of an envelope — **either wire version** — without decrypting.
///
/// `author`/`seq`/`ts` ride outside the ciphertext (they are inputs to the AAD, so they cannot be
/// tampered with without breaking the signature) and every one of them is metadata, not location.
/// That makes them readable by any holder of the bytes, which is what lets a device report what
/// its replica can serve — including for authors whose payloads are not addressed to it — with no
/// key material involved. See `LocationNode::trail_replica_status`.
///
/// The signature is still checked: this is cheap, and a caller reporting "we hold author X's fix"
/// on the strength of unverified bytes would be reporting something it does not know.
#[derive(Debug, Clone, Copy)]
pub struct EnvelopeHeader {
    pub author: [u8; AUTHOR_LEN],
    pub seq: u64,
    pub ts: u64,
}

/// Read + signature-check an envelope's [`EnvelopeHeader`], routing on the declared version.
pub fn envelope_header(envelope_bytes: &[u8]) -> Result<EnvelopeHeader, CryptoError> {
    match envelope_version(envelope_bytes) {
        Some(ENVELOPE_V3) => {
            let env = verify_v3(envelope_bytes)?;
            Ok(EnvelopeHeader {
                author: env.author,
                seq: env.seq,
                ts: env.ts,
            })
        }
        Some(ENVELOPE_V) => {
            let env: Envelope =
                postcard::from_bytes(envelope_bytes).map_err(|_| CryptoError::Decode)?;
            if env.author.len() != AUTHOR_LEN {
                return Err(CryptoError::Decode);
            }
            let author: [u8; AUTHOR_LEN] = env
                .author
                .clone()
                .try_into()
                .map_err(|_| CryptoError::Decode)?;
            let vk = VerifyingKey::from_bytes(&author).map_err(|_| CryptoError::BadSignature)?;
            let sig = Signature::from_slice(&env.sig).map_err(|_| CryptoError::BadSignature)?;
            vk.verify_strict(&signing_bytes(&env)?, &sig)
                .map_err(|_| CryptoError::BadSignature)?;
            Ok(EnvelopeHeader {
                author,
                seq: env.seq,
                ts: env.ts,
            })
        }
        Some(other) => Err(CryptoError::UnsupportedVersion(other)),
        None => Err(CryptoError::Decode),
    }
}

/// blake3(pubkey)[..8] — stable short id for a recipient's receiving key.
pub fn recv_kid(recv_pub: &[u8]) -> [u8; 8] {
    let h = blake3::hash(recv_pub);
    let mut kid = [0u8; 8];
    kid.copy_from_slice(&h.as_bytes()[..8]);
    kid
}

/// Generate a device "receiving key" (X25519) keypair -> (secret, public), 32B each.
pub fn generate_recv_keypair() -> (Vec<u8>, Vec<u8>) {
    let (sk, pk) = HpkeKem::gen_keypair(&mut OsRng);
    (sk.to_bytes().to_vec(), pk.to_bytes().to_vec())
}

/// A fresh signing identity -> (32-byte ed25519 seed, 32-byte public key / author id).
///
/// Test-only, but shared with `lib.rs`'s own test modules, which is why it lives here rather
/// than in the `tests` module below.
#[cfg(test)]
pub fn test_identity() -> ([u8; 32], [u8; 32]) {
    let sk = SigningKey::generate(&mut OsRng);
    (sk.to_bytes(), sk.verifying_key().to_bytes())
}

/// Bind the per-message context into both AEAD and HPKE as associated data so a wrap /
/// ciphertext cannot be replayed under a different header.
fn aad(version: u8, author: &[u8], seq: u64, ts: u64, mesh_epoch: u32) -> Vec<u8> {
    let mut a = Vec::with_capacity(author.len() + 21);
    a.push(version);
    a.extend_from_slice(author);
    a.extend_from_slice(&seq.to_le_bytes());
    a.extend_from_slice(&ts.to_le_bytes());
    a.extend_from_slice(&mesh_epoch.to_le_bytes());
    a
}

/// Encode the envelope with an empty signature — the exact bytes that get signed.
fn signing_bytes(env: &Envelope) -> Result<Vec<u8>, CryptoError> {
    let mut unsigned = env.clone();
    unsigned.sig = Vec::new();
    postcard::to_allocvec(&unsigned).map_err(|_| CryptoError::Encode)
}

/// Seal a payload for the given recipients.
///
/// * `signing_seed` — 32-byte ed25519 seed (the iroh SecretKey bytes).
/// * `author`       — 32-byte ed25519 public key (the EndpointId).
/// * `recipients`   — each recipient's 32-byte X25519 receiving public key.
///
/// Returns the postcard-encoded [`Envelope`] bytes.
#[allow(clippy::too_many_arguments)]
pub fn seal(
    signing_seed: &[u8],
    author: &[u8],
    seq: u64,
    ts: u64,
    mesh_epoch: u32,
    payload: &[u8],
    recipients: &[Vec<u8>],
) -> Result<Vec<u8>, CryptoError> {
    if signing_seed.len() != 32 || author.len() != AUTHOR_LEN {
        return Err(CryptoError::KeyLength);
    }
    let seed: [u8; 32] = signing_seed
        .try_into()
        .map_err(|_| CryptoError::KeyLength)?;
    let signing_key = SigningKey::from_bytes(&seed);

    // Fresh random content key + nonce for this fix.
    let mut key = [0u8; CONTENT_KEY_LEN];
    OsRng.fill_bytes(&mut key);
    let mut nonce = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce);

    let ad = aad(ENVELOPE_V, author, seq, ts, mesh_epoch);

    // 1) encrypt the payload ONCE.
    let cipher = ChaCha20Poly1305::new_from_slice(&key).map_err(|_| CryptoError::KeyLength)?;
    let ct = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            AeadPayload {
                msg: payload,
                aad: &ad,
            },
        )
        .map_err(|_| CryptoError::Cipher)?;

    // 2) wrap the content key per recipient with HPKE.
    let mut wraps = Vec::with_capacity(recipients.len());
    for recip_pub in recipients {
        if recip_pub.len() != PUBKEY_LEN {
            return Err(CryptoError::KeyLength);
        }
        let pk = <HpkeKem as hpke::Kem>::PublicKey::from_bytes(recip_pub)
            .map_err(|_| CryptoError::KeyLength)?;
        let (encapped, hpke_ct) = single_shot_seal::<HpkeAead, HpkeKdf, HpkeKem, _>(
            &OpModeS::Base,
            &pk,
            HPKE_INFO,
            &key,
            &ad,
            &mut OsRng,
        )
        .map_err(|_| CryptoError::Cipher)?;
        wraps.push(Wrap {
            kid: recv_kid(recip_pub),
            enc: encapped.to_bytes().to_vec(),
            ct: hpke_ct,
        });
    }

    // 3) sign the whole thing.
    let mut env = Envelope {
        v: ENVELOPE_V,
        author: author.to_vec(),
        seq,
        ts,
        mesh_epoch,
        nonce: nonce.to_vec(),
        ct,
        wraps,
        sig: Vec::new(),
    };
    let signature = signing_key.sign(&signing_bytes(&env)?);
    env.sig = signature.to_bytes().to_vec();

    postcard::to_allocvec(&env).map_err(|_| CryptoError::Encode)
}

/// Verify + decrypt an envelope with my receiving secret key. Returns the payload iff a
/// wrap addressed to me is present and the author's signature checks out.
pub fn open(my_recv_secret: &[u8], envelope_bytes: &[u8]) -> Result<Opened, CryptoError> {
    // Version before layout, for the same reason as `verify_v3`: a v3 wrap is shaped enough like
    // a v2 one that postcard could plausibly decode it into nonsense rather than failing.
    match envelope_version(envelope_bytes) {
        Some(ENVELOPE_V) => {}
        Some(other) => return Err(CryptoError::UnsupportedVersion(other)),
        None => return Err(CryptoError::Decode),
    }
    let env: Envelope = postcard::from_bytes(envelope_bytes).map_err(|_| CryptoError::Decode)?;
    if env.v != ENVELOPE_V {
        return Err(CryptoError::UnsupportedVersion(env.v));
    }
    if env.author.len() != AUTHOR_LEN || env.nonce.len() != NONCE_LEN {
        return Err(CryptoError::Decode);
    }

    // verify signature first (authenticity/integrity).
    let author_arr: [u8; AUTHOR_LEN] = env
        .author
        .clone()
        .try_into()
        .map_err(|_| CryptoError::Decode)?;
    let vk = VerifyingKey::from_bytes(&author_arr).map_err(|_| CryptoError::BadSignature)?;
    let sig = Signature::from_slice(&env.sig).map_err(|_| CryptoError::BadSignature)?;
    vk.verify_strict(&signing_bytes(&env)?, &sig)
        .map_err(|_| CryptoError::BadSignature)?;

    // find my wrap.
    let sk = <HpkeKem as hpke::Kem>::PrivateKey::from_bytes(my_recv_secret)
        .map_err(|_| CryptoError::KeyLength)?;
    let my_pub = <HpkeKem as hpke::Kem>::sk_to_pk(&sk);
    let my_kid = recv_kid(&my_pub.to_bytes());
    let wrap = env
        .wraps
        .iter()
        .find(|w| w.kid == my_kid)
        .ok_or(CryptoError::NotARecipient)?;

    let ad = aad(env.v, &env.author, env.seq, env.ts, env.mesh_epoch);

    // unwrap the content key with HPKE.
    let encapped = <HpkeKem as hpke::Kem>::EncappedKey::from_bytes(&wrap.enc)
        .map_err(|_| CryptoError::Cipher)?;
    let key = single_shot_open::<HpkeAead, HpkeKdf, HpkeKem>(
        &OpModeR::Base,
        &sk,
        &encapped,
        HPKE_INFO,
        &wrap.ct,
        &ad,
    )
    .map_err(|_| CryptoError::Cipher)?;

    // decrypt the payload.
    let cipher = ChaCha20Poly1305::new_from_slice(&key).map_err(|_| CryptoError::KeyLength)?;
    let payload = cipher
        .decrypt(
            Nonce::from_slice(&env.nonce),
            AeadPayload {
                msg: &env.ct,
                aad: &ad,
            },
        )
        .map_err(|_| CryptoError::Cipher)?;

    Ok(Opened {
        author: author_arr,
        seq: env.seq,
        payload: Zeroizing::new(payload),
    })
}

#[cfg(test)]
mod v3_tests {
    use super::*;
    use crate::ratchet::{RatchetKeySource, RatchetState, DEFAULT_ACCEPT_WINDOW, KEY_LEN};
    use x25519_dalek::{PublicKey as XPublicKey, StaticSecret as XStaticSecret};

    const W: u32 = DEFAULT_ACCEPT_WINDOW;

    /// Deterministic ratchet keys, so a whole session is reproducible (mirrors tests/ratchet.rs).
    struct FixedKeys {
        seed: u8,
        n: u32,
    }

    impl RatchetKeySource for FixedKeys {
        fn next_ratchet_secret(&mut self) -> XStaticSecret {
            let mut raw = [0u8; KEY_LEN];
            raw[0] = self.seed;
            raw[1..5].copy_from_slice(&self.n.to_le_bytes());
            self.n += 1;
            XStaticSecret::from(raw)
        }
    }

    /// A bootstrapped session pair sharing `sid`: `.0` is the initiator and can send at once.
    fn session(
        sid: [u8; SESSION_ID_LEN],
        rk0: u8,
        seed: u8,
    ) -> (RatchetState, FixedKeys, RatchetState, FixedKeys) {
        let boot = XStaticSecret::from([seed; KEY_LEN]);
        let boot_pub = XPublicKey::from(&boot).to_bytes();
        let mut ka = FixedKeys { seed, n: 0 };
        let kb = FixedKeys {
            seed: seed.wrapping_add(1),
            n: 0,
        };
        let a =
            RatchetState::bootstrap_initiator(sid, [rk0; KEY_LEN], boot_pub, 0, &mut ka).unwrap();
        let b = RatchetState::bootstrap_responder(sid, [rk0; KEY_LEN], boot, 0);
        (a, ka, b, kb)
    }

    /// Seal `payload` from `author` to every `(session_id, state)` given, one wrap each.
    fn seal_to(
        seed: &[u8; 32],
        author: &[u8; 32],
        seq: u64,
        payload: &[u8],
        peers: &mut [(&[u8; SESSION_ID_LEN], &mut RatchetState)],
    ) -> Vec<u8> {
        let wraps = peers
            .iter_mut()
            .map(|(sid, state)| {
                let slot = state.next_send().expect("a sending chain");
                SealWrap {
                    kid: slot.kid,
                    header: slot.header,
                    session_id: **sid,
                    key: slot.key,
                }
            })
            .collect();
        seal_v3(seed, author, seq, 1000, 0, payload, wraps).unwrap()
    }

    /// The receive path exactly as `lib.rs` must drive it: verify, locate without mutating,
    /// accept, open.
    fn receive(
        bytes: &[u8],
        sid: &[u8; SESSION_ID_LEN],
        state: &mut RatchetState,
        keys: &mut impl RatchetKeySource,
    ) -> Result<Opened, CryptoError> {
        let verified = verify_v3(bytes)?;
        let found = verified
            .locators()
            .into_iter()
            .enumerate()
            .find(|(_, loc)| state.matches(&loc.header, &loc.kid, W));
        let (index, loc) = found.ok_or(CryptoError::NotARecipient)?;
        let mk = state
            .accept(&loc.header, 0, W, keys)
            .map_err(|_| CryptoError::NotARecipient)?;
        verified.open_wrap(index, sid, mk)
    }

    #[test]
    fn a_ratcheted_envelope_round_trips() {
        let (seed, author) = test_identity();
        let sid = [9u8; SESSION_ID_LEN];
        let (mut a, _ka, mut b, mut kb) = session(sid, 7, 0xB0);

        let env = seal_to(&seed, &author, 1, b"hello", &mut [(&sid, &mut a)]);
        let opened = receive(&env, &sid, &mut b, &mut kb).unwrap();

        assert_eq!(opened.payload.as_slice(), b"hello");
        assert_eq!(opened.author, author);
        assert_eq!(opened.seq, 1);
    }

    /// One envelope, N wraps: each recipient finds exactly its own and can open nothing else.
    #[test]
    fn each_recipient_opens_only_its_own_wrap() {
        let (seed, author) = test_identity();
        let sid_b = [1u8; SESSION_ID_LEN];
        let sid_c = [2u8; SESSION_ID_LEN];
        let (mut a_b, _k1, mut b, mut kb) = session(sid_b, 7, 0xB0);
        let (mut a_c, _k2, mut c, mut kc) = session(sid_c, 8, 0xC0);

        let env = seal_to(
            &seed,
            &author,
            1,
            b"two recipients",
            &mut [(&sid_b, &mut a_b), (&sid_c, &mut a_c)],
        );

        assert_eq!(
            receive(&env, &sid_b, &mut b, &mut kb)
                .unwrap()
                .payload
                .as_slice(),
            b"two recipients"
        );
        assert_eq!(
            receive(&env, &sid_c, &mut c, &mut kc)
                .unwrap()
                .payload
                .as_slice(),
            b"two recipients"
        );

        // B's session must not match C's wrap. Both wraps are present and B has already consumed
        // its own, so a second pass finds nothing rather than finding C's.
        let verified = verify_v3(&env).unwrap();
        assert!(!verified
            .locators()
            .iter()
            .any(|loc| b.matches(&loc.header, &loc.kid, W)));
    }

    /// The §1.1 leak this format exists to close: v2's `kid` was a stable hash of the recipient's
    /// long-term key, identical across every author, so the archive could cluster friend graphs.
    #[test]
    fn wrap_ids_rotate_every_message() {
        let (seed, author) = test_identity();
        let sid = [9u8; SESSION_ID_LEN];
        let (mut a, _ka, _b, _kb) = session(sid, 7, 0xB0);

        let mut seen = std::collections::HashSet::new();
        for seq in 0..16 {
            let env = seal_to(&seed, &author, seq, b"x", &mut [(&sid, &mut a)]);
            let loc = verify_v3(&env).unwrap().locators()[0];
            assert!(seen.insert(loc.kid), "a wrap id repeated at seq {seq}");
        }
    }

    /// A byte-identical replay out of the stash archive. `matches` refuses it before `accept`
    /// runs, so nothing mutates — the §4.2 ordering, tested at the layer that enforces it.
    #[test]
    fn a_replayed_envelope_is_refused_without_touching_state() {
        let (seed, author) = test_identity();
        let sid = [9u8; SESSION_ID_LEN];
        let (mut a, _ka, mut b, mut kb) = session(sid, 7, 0xB0);

        let env = seal_to(&seed, &author, 1, b"once", &mut [(&sid, &mut a)]);
        assert!(receive(&env, &sid, &mut b, &mut kb).is_ok());

        let before = b.to_bytes();
        assert!(matches!(
            receive(&env, &sid, &mut b, &mut kb),
            Err(CryptoError::NotARecipient)
        ));
        assert_eq!(before, b.to_bytes(), "a refused replay mutated state");
    }

    #[test]
    fn a_tampered_ratchet_header_fails_the_signature() {
        let (seed, author) = test_identity();
        let sid = [9u8; SESSION_ID_LEN];
        let (mut a, _ka, _b, _kb) = session(sid, 7, 0xB0);

        let env = seal_to(&seed, &author, 1, b"hello", &mut [(&sid, &mut a)]);
        let mut decoded: EnvelopeV3 = postcard::from_bytes(&env).unwrap();
        decoded.wraps[0].header.counter += 1;
        let tampered = postcard::to_allocvec(&decoded).unwrap();

        assert!(matches!(
            verify_v3(&tampered),
            Err(CryptoError::BadSignature)
        ));
    }

    /// `session_id` is in the wrap's AAD, so a wrap cannot be lifted into a different session
    /// between the same two devices — what stops a resync (§4.6) from replaying the session it
    /// replaced.
    #[test]
    fn a_wrap_is_bound_to_its_session_id() {
        let (seed, author) = test_identity();
        let sid = [9u8; SESSION_ID_LEN];
        let other = [10u8; SESSION_ID_LEN];
        let (mut a, _ka, mut b, mut kb) = session(sid, 7, 0xB0);

        let env = seal_to(&seed, &author, 1, b"hello", &mut [(&sid, &mut a)]);
        let verified = verify_v3(&env).unwrap();
        let loc = verified.locators()[0];
        let mk = b.accept(&loc.header, 0, W, &mut kb).unwrap();

        assert!(matches!(
            verified.open_wrap(0, &other, mk),
            Err(CryptoError::Cipher)
        ));
    }

    /// Revocation is unchanged from v2: no wrap, no key, and `K` is fresh per fix.
    #[test]
    fn a_revoked_recipient_finds_no_wrap() {
        let (seed, author) = test_identity();
        let sid_b = [1u8; SESSION_ID_LEN];
        let sid_c = [2u8; SESSION_ID_LEN];
        let (mut a_b, _k1, _b, _kb) = session(sid_b, 7, 0xB0);
        let (_a_c, _k2, mut c, mut kc) = session(sid_c, 8, 0xC0);

        // Sealed for B only.
        let env = seal_to(&seed, &author, 1, b"private", &mut [(&sid_b, &mut a_b)]);

        assert!(matches!(
            receive(&env, &sid_c, &mut c, &mut kc),
            Err(CryptoError::NotARecipient)
        ));
    }

    /// A v2 envelope handed to the v3 path is a version error, not a silent "not for me" — the
    /// receiver routes on the declared version instead of guessing.
    #[test]
    fn the_two_schemas_do_not_masquerade_as_each_other() {
        let (seed, author) = test_identity();
        let (_, recv_pub) = generate_recv_keypair();
        let v2 = seal(&seed, &author, 1, 1000, 0, b"legacy", &[recv_pub]).unwrap();

        assert_eq!(envelope_version(&v2), Some(ENVELOPE_V));
        assert!(matches!(
            verify_v3(&v2),
            Err(CryptoError::UnsupportedVersion(ENVELOPE_V))
        ));

        let sid = [9u8; SESSION_ID_LEN];
        let (mut a, _ka, _b, _kb) = session(sid, 7, 0xB0);
        let v3 = seal_to(&seed, &author, 1, b"ratcheted", &mut [(&sid, &mut a)]);
        assert_eq!(envelope_version(&v3), Some(ENVELOPE_V3));
        assert!(matches!(
            open(&generate_recv_keypair().0, &v3),
            Err(CryptoError::UnsupportedVersion(ENVELOPE_V3))
        ));
    }

    /// Both sides talking, across a DH ratchet: the reply carries a ratchet key the initiator has
    /// not adopted, which is the case `matches` needs its trial derivation for.
    #[test]
    fn a_reply_across_a_dh_ratchet_is_located_and_opened() {
        let (a_seed, a_author) = test_identity();
        let (b_seed, b_author) = test_identity();
        let sid = [9u8; SESSION_ID_LEN];
        let (mut a, mut ka, mut b, mut kb) = session(sid, 7, 0xB0);

        let first = seal_to(&a_seed, &a_author, 1, b"ping", &mut [(&sid, &mut a)]);
        assert_eq!(
            receive(&first, &sid, &mut b, &mut kb)
                .unwrap()
                .payload
                .as_slice(),
            b"ping"
        );

        // B now has a sending chain, on a fresh ratchet key A has never seen.
        let reply = seal_to(&b_seed, &b_author, 1, b"pong", &mut [(&sid, &mut b)]);
        assert_eq!(
            receive(&reply, &sid, &mut a, &mut ka)
                .unwrap()
                .payload
                .as_slice(),
            b"pong"
        );
    }

    /// Loss: the sender runs ahead while the receiver hears nothing, then one envelope lands.
    /// The receiver fast-forwards to it, and the skipped positions stay unopenable — no
    /// skipped-key table, by design (§9).
    #[test]
    fn a_fast_forward_leaves_the_skipped_envelopes_unopenable() {
        let (seed, author) = test_identity();
        let sid = [9u8; SESSION_ID_LEN];
        let (mut a, _ka, mut b, mut kb) = session(sid, 7, 0xB0);

        let lost_first = seal_to(&seed, &author, 1, b"lost 1", &mut [(&sid, &mut a)]);
        let lost_second = seal_to(&seed, &author, 2, b"lost 2", &mut [(&sid, &mut a)]);
        let arrives = seal_to(&seed, &author, 3, b"arrives", &mut [(&sid, &mut a)]);

        assert_eq!(
            receive(&arrives, &sid, &mut b, &mut kb)
                .unwrap()
                .payload
                .as_slice(),
            b"arrives"
        );
        for lost in [&lost_first, &lost_second] {
            assert!(
                matches!(
                    receive(lost, &sid, &mut b, &mut kb),
                    Err(CryptoError::NotARecipient)
                ),
                "a skipped envelope was still openable"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode_hex(input: &str) -> Vec<u8> {
        (0..input.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&input[i..i + 2], 16).unwrap())
            .collect()
    }

    fn identity() -> ([u8; 32], [u8; 32]) {
        super::test_identity()
    }

    #[test]
    fn round_trip_multi_recipient() {
        let (seed, author) = identity();
        let (b_sk, b_pk) = generate_recv_keypair();
        let (c_sk, c_pk) = generate_recv_keypair();
        let payload = b"hello from A";

        let env = seal(
            &seed,
            &author,
            1,
            1000,
            0,
            payload,
            &[b_pk.clone(), c_pk.clone()],
        )
        .unwrap();

        let ob = open(&b_sk, &env).unwrap();
        let oc = open(&c_sk, &env).unwrap();
        assert_eq!(ob.payload.as_slice(), payload);
        assert_eq!(oc.payload.as_slice(), payload);
        assert_eq!(ob.author, author);
        assert_eq!(ob.seq, 1);
    }

    #[test]
    fn seals_rfc_8439_envelope_v2() {
        let (seed, author) = identity();
        let (_recv_sk, recv_pk) = generate_recv_keypair();
        let bytes = seal(&seed, &author, 1, 1000, 0, b"payload", &[recv_pk]).unwrap();
        let env: Envelope = postcard::from_bytes(&bytes).unwrap();

        assert_eq!(env.v, 2);
        assert_eq!(env.nonce.len(), 12);
    }

    #[test]
    fn matches_rfc_8439_aead_test_vector() {
        let key = decode_hex("808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f");
        let nonce = decode_hex("070000004041424344454647");
        let aad = decode_hex("50515253c0c1c2c3c4c5c6c7");
        let plaintext = b"Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.";
        let expected = decode_hex(concat!(
            "d31a8d34648e60db7b86afbc53ef7ec2a4aded51296e08fea9e2b5a736ee62d",
            "63dbea45e8ca9671282fafb69da92728b1a71de0a9e060b2905d6a5b67ecd3b",
            "3692ddbd7f2d778b8c9803aee328091b58fab324e4fad675945585808b4831d7",
            "bc3ff4def08e4b7a9de576d26586cec64b61161ae10b594f09e26a7e902ecbd",
            "0600691"
        ));

        let cipher = ChaCha20Poly1305::new_from_slice(&key).unwrap();
        let ciphertext = cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                AeadPayload {
                    msg: plaintext,
                    aad: &aad,
                },
            )
            .unwrap();

        assert_eq!(ciphertext, expected);
    }

    #[test]
    fn rejects_pre_release_v1_envelopes() {
        let (seed, author) = identity();
        let (recv_sk, recv_pk) = generate_recv_keypair();
        let bytes = seal(&seed, &author, 1, 1000, 0, b"payload", &[recv_pk]).unwrap();
        let mut env: Envelope = postcard::from_bytes(&bytes).unwrap();
        env.v = 1;
        let legacy = postcard::to_allocvec(&env).unwrap();

        assert!(matches!(
            open(&recv_sk, &legacy),
            Err(CryptoError::UnsupportedVersion(1))
        ));
    }

    #[test]
    fn non_recipient_cannot_open() {
        let (seed, author) = identity();
        let (_b_sk, b_pk) = generate_recv_keypair();
        let (d_sk, _d_pk) = generate_recv_keypair(); // D is NOT a recipient

        let env = seal(&seed, &author, 1, 1000, 0, b"secret", &[b_pk]).unwrap();
        assert!(matches!(open(&d_sk, &env), Err(CryptoError::NotARecipient)));
    }

    #[test]
    fn revocation_drops_access() {
        // A shares fix #1 with B and C, then revokes C for fix #2.
        let (seed, author) = identity();
        let (b_sk, b_pk) = generate_recv_keypair();
        let (c_sk, c_pk) = generate_recv_keypair();

        let e1 = seal(
            &seed,
            &author,
            1,
            1,
            0,
            b"one",
            &[b_pk.clone(), c_pk.clone()],
        )
        .unwrap();
        assert!(open(&c_sk, &e1).is_ok());

        // fix #2: C dropped from the wrap list.
        let e2 = seal(&seed, &author, 2, 2, 0, b"two", &[b_pk.clone()]).unwrap();
        assert!(open(&b_sk, &e2).is_ok());
        assert!(matches!(open(&c_sk, &e2), Err(CryptoError::NotARecipient)));
    }

    #[test]
    fn tamper_is_detected() {
        let (seed, author) = identity();
        let (b_sk, b_pk) = generate_recv_keypair();
        let mut env = seal(&seed, &author, 1, 1, 0, b"payload", &[b_pk]).unwrap();
        // flip a byte in the middle (ciphertext / wrap region).
        let mid = env.len() / 2;
        env[mid] ^= 0xff;
        assert!(open(&b_sk, &env).is_err());
    }

    #[test]
    fn forged_author_is_rejected() {
        // Attacker re-signs with their own key but claims A's author id.
        let (_a_seed, a_author) = identity();
        let (att_seed, _att_author) = identity();
        let (b_sk, b_pk) = generate_recv_keypair();
        // seal with attacker's seed but stamp A's author -> signature won't verify.
        let env = seal(&att_seed, &a_author, 1, 1, 0, b"lies", &[b_pk]).unwrap();
        assert!(matches!(open(&b_sk, &env), Err(CryptoError::BadSignature)));
    }
}
