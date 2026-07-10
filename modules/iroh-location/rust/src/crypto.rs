//! App-layer end-to-end crypto for the location envelope.
//!
//! See `docs/social/ARCHITECTURE.md` §4. Per fix we:
//!   1. encrypt the payload ONCE with XChaCha20-Poly1305 under a fresh random 32-byte
//!      content key `K`,
//!   2. WRAP `K` per recipient with HPKE (DhKemX25519HkdfSha256 + ChaCha20Poly1305),
//!   3. SIGN the whole envelope with the author's ed25519 identity key.
//!
//! Revocation = stop emitting a recipient's wrap; because `K` is random per fix,
//! "no wrap ⇒ no key ⇒ ciphertext is useless" to a dropped recipient.

use chacha20poly1305::aead::{Aead, KeyInit, Payload as AeadPayload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
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

/// Domain-separation string for HPKE key wrapping.
const HPKE_INFO: &[u8] = b"streetcryptid/loc/v1/keywrap";
/// Current envelope schema version.
pub const ENVELOPE_V: u8 = 1;

const CONTENT_KEY_LEN: usize = 32;
const XNONCE_LEN: usize = 24;
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
    epoch: u32,
    nonce: Vec<u8>, // XChaCha20-Poly1305 nonce (24B)
    ct: Vec<u8>,    // XChaCha20-Poly1305 ciphertext of the payload
    wraps: Vec<Wrap>,
    sig: Vec<u8>, // ed25519 signature over the envelope with sig == []
}

/// Result of successfully opening an envelope.
#[derive(Debug, Clone)]
pub struct Opened {
    pub author: [u8; AUTHOR_LEN],
    pub seq: u64,
    pub payload: Vec<u8>,
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

/// Bind the per-message context into both AEAD and HPKE as associated data so a wrap /
/// ciphertext cannot be replayed under a different header.
fn aad(author: &[u8], seq: u64, ts: u64, epoch: u32) -> Vec<u8> {
    let mut a = Vec::with_capacity(author.len() + 20);
    a.extend_from_slice(author);
    a.extend_from_slice(&seq.to_le_bytes());
    a.extend_from_slice(&ts.to_le_bytes());
    a.extend_from_slice(&epoch.to_le_bytes());
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
    epoch: u32,
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
    let mut nonce = [0u8; XNONCE_LEN];
    OsRng.fill_bytes(&mut nonce);

    let ad = aad(author, seq, ts, epoch);

    // 1) encrypt the payload ONCE.
    let cipher = XChaCha20Poly1305::new_from_slice(&key).map_err(|_| CryptoError::KeyLength)?;
    let ct = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
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
        epoch,
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
    let env: Envelope = postcard::from_bytes(envelope_bytes).map_err(|_| CryptoError::Decode)?;
    if env.author.len() != AUTHOR_LEN || env.nonce.len() != XNONCE_LEN {
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

    let ad = aad(&env.author, env.seq, env.ts, env.epoch);

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
    let cipher = XChaCha20Poly1305::new_from_slice(&key).map_err(|_| CryptoError::KeyLength)?;
    let payload = cipher
        .decrypt(
            XNonce::from_slice(&env.nonce),
            AeadPayload {
                msg: &env.ct,
                aad: &ad,
            },
        )
        .map_err(|_| CryptoError::Cipher)?;

    Ok(Opened {
        author: author_arr,
        seq: env.seq,
        payload,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity() -> ([u8; 32], [u8; 32]) {
        let sk = SigningKey::generate(&mut OsRng);
        (sk.to_bytes(), sk.verifying_key().to_bytes())
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
        assert_eq!(ob.payload, payload);
        assert_eq!(oc.payload, payload);
        assert_eq!(ob.author, author);
        assert_eq!(ob.seq, 1);
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
