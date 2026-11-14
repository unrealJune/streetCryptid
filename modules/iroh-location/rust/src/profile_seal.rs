//! Sealed profiles: what a profile namespace holds is ciphertext only friends can open
//! (docs/social/ARCHITECTURE.md §9a.1).
//!
//! A profile namespace is replicated by whoever holds its read ticket: friends, the repeaters
//! that carry its owner, and the hosted stash. Its records were only *signed* — readable by every
//! one of those holders, the stash included, and they say a great deal: a handle, a sigil, and
//! (on the repeater card) who is in which roster and who invited whom. Sealing makes every holder
//! that is not a friend a blind relay, which is what lets the stash and the repeaters serve a
//! profile while its owner's phone is away, the same way they serve the trail.
//!
//! ## Shape
//! * Every record under a key `k` is stored under `s/k` as a [`Sealed`] entry: XChaCha20-Poly1305
//!   under the owner's **profile key**, with the namespace and `k` as associated data, so an entry
//!   cannot be replayed under another key or into another namespace. The signed bytes inside are
//!   exactly what was stored in the clear before, and readers verify them exactly as before.
//! * The profile key is handed to each friend in the **keyring** (`keyring`): one HPKE wrap per
//!   friend, to the X25519 receiving key their profile already publishes, found by the same 8-byte
//!   key id a location envelope uses. A friend opens their wrap with the receiving secret the
//!   location path already holds; nothing new is exchanged at pairing.
//! * The key is derived from the identity seed and a **generation**, so nothing secret is stored:
//!   only the generation, who it was wrapped for, and when. Removing a friend moves to the next
//!   generation and seals everything again, so what is written after the removal is closed to
//!   them. What they already read stays read; nothing can change that.
//! * Everything is sealed again well inside the stash's retention window
//!   ([`RESEAL_AFTER_MS`]), because the stash releases every entry older than it, not only fixes.
//!
//! Pure except for the small state file ([`KeyState`]); the docs half is in `crate::profile`.

use std::path::{Path, PathBuf};

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use hpke::aead::ChaCha20Poly1305 as HpkeAead;
use hpke::kdf::HkdfSha256 as HpkeKdf;
use hpke::kem::X25519HkdfSha256 as HpkeKem;
use hpke::{single_shot_open, single_shot_seal, Deserializable, OpModeR, OpModeS, Serializable};
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};

use crate::crypto::recv_kid;

/// Where a sealed copy of the record under `key` lives.
pub const SEALED_PREFIX: &[u8] = b"s/";
/// The keyring: the profile key, wrapped for each friend.
pub const KEYRING_KEY: &[u8] = b"keyring";
/// The state file, beside the namespace book.
pub const KEY_STATE_FILE: &str = "profile-key.bin";
/// Seal everything again after this long, inside the stash's 48 h retention window with room for
/// a phone that is rarely woken.
pub const RESEAL_AFTER_MS: u64 = 12 * 60 * 60 * 1000;

const SEALED_V: u8 = 1;
const KEYRING_V: u8 = 1;
const KEY_STATE_V: u8 = 1;
const ENTRY_CTX: &[u8] = b"streetcryptid/profile-seal/v1";
const KEYRING_CTX: &[u8] = b"streetcryptid/profile-keyring/v1";
const KEY_DERIVE_CTX: &str = "streetcryptid profile key v1";
const KID_DERIVE_CTX: &str = "streetcryptid profile key id v1";

/// A profile key's short id: what a sealed entry names so a reader knows which key opens it.
pub type KeyId = [u8; 8];

/// The key sealed copies are stored under.
pub fn sealed_key(key: &[u8]) -> Vec<u8> {
    [SEALED_PREFIX, key].concat()
}

/// The owner's profile key for `generation`. Derived, never stored.
pub fn derive_key(identity_seed: &[u8; 32], generation: u32) -> [u8; 32] {
    let mut material = [0u8; 36];
    material[..32].copy_from_slice(identity_seed);
    material[32..].copy_from_slice(&generation.to_le_bytes());
    blake3::derive_key(KEY_DERIVE_CTX, &material)
}

pub fn key_id(key: &[u8; 32]) -> KeyId {
    let full = blake3::derive_key(KID_DERIVE_CTX, key);
    let mut kid = [0u8; 8];
    kid.copy_from_slice(&full[..8]);
    kid
}

#[derive(Debug, Serialize, Deserialize)]
struct Sealed {
    v: u8,
    kid: KeyId,
    nonce: [u8; 24],
    ct: Vec<u8>,
}

fn entry_aad(namespace: &[u8; 32], key: &[u8]) -> Vec<u8> {
    [ENTRY_CTX, namespace.as_slice(), key].concat()
}

/// Seal `plaintext`, the record stored under `key` in `namespace`.
pub fn seal_entry(
    profile_key: &[u8; 32],
    namespace: &[u8; 32],
    key: &[u8],
    plaintext: &[u8],
) -> anyhow::Result<Vec<u8>> {
    let mut nonce = [0u8; 24];
    OsRng.fill_bytes(&mut nonce);
    let cipher = XChaCha20Poly1305::new_from_slice(profile_key)
        .map_err(|_| anyhow::anyhow!("profile key length"))?;
    let ct = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad: &entry_aad(namespace, key),
            },
        )
        .map_err(|_| anyhow::anyhow!("could not seal a profile entry"))?;
    Ok(postcard::to_allocvec(&Sealed {
        v: SEALED_V,
        kid: key_id(profile_key),
        nonce,
        ct,
    })?)
}

/// Which key a sealed entry needs, or `None` if the bytes are not one.
pub fn entry_kid(bytes: &[u8]) -> Option<KeyId> {
    let sealed: Sealed = postcard::from_bytes(bytes).ok()?;
    (sealed.v == SEALED_V).then_some(sealed.kid)
}

/// Open a sealed entry read from `key` in `namespace`. `None` if it is not one, names another
/// key, or does not authenticate.
pub fn open_entry(
    profile_key: &[u8; 32],
    namespace: &[u8; 32],
    key: &[u8],
    bytes: &[u8],
) -> Option<Vec<u8>> {
    let sealed: Sealed = postcard::from_bytes(bytes).ok()?;
    if sealed.v != SEALED_V || sealed.kid != key_id(profile_key) {
        return None;
    }
    let cipher = XChaCha20Poly1305::new_from_slice(profile_key).ok()?;
    cipher
        .decrypt(
            XNonce::from_slice(&sealed.nonce),
            Payload {
                msg: &sealed.ct,
                aad: &entry_aad(namespace, key),
            },
        )
        .ok()
}

#[derive(Debug, Serialize, Deserialize)]
struct KeyWrap {
    /// [`recv_kid`] of the friend's receiving key, as a location envelope names its recipients.
    rkid: [u8; 8],
    enc: Vec<u8>,
    ct: Vec<u8>,
}

#[derive(Debug, Serialize, Deserialize)]
struct Keyring {
    v: u8,
    kid: KeyId,
    wraps: Vec<KeyWrap>,
}

fn keyring_info(namespace: &[u8; 32], kid: &KeyId) -> Vec<u8> {
    [KEYRING_CTX, namespace.as_slice(), kid.as_slice()].concat()
}

/// Wrap `profile_key` for every receiving key in `recipients` (32-byte X25519 public keys). A key
/// that is not one is skipped: one friend's bad key must not close the profile to everyone else.
pub fn build_keyring(
    profile_key: &[u8; 32],
    namespace: &[u8; 32],
    recipients: &[Vec<u8>],
) -> anyhow::Result<Vec<u8>> {
    let kid = key_id(profile_key);
    let info = keyring_info(namespace, &kid);
    let mut wraps = Vec::with_capacity(recipients.len());
    for recv_pub in recipients {
        let Ok(pk) = <HpkeKem as hpke::Kem>::PublicKey::from_bytes(recv_pub) else {
            continue;
        };
        let Ok((encapped, ct)) = single_shot_seal::<HpkeAead, HpkeKdf, HpkeKem, _>(
            &OpModeS::Base,
            &pk,
            &info,
            profile_key,
            &[],
            &mut OsRng,
        ) else {
            continue;
        };
        wraps.push(KeyWrap {
            rkid: recv_kid(recv_pub),
            enc: encapped.to_bytes().to_vec(),
            ct,
        });
    }
    Ok(postcard::to_allocvec(&Keyring {
        v: KEYRING_V,
        kid,
        wraps,
    })?)
}

/// The profile key a keyring holds for the owner of `recv_secret`, with its id. `None` when the
/// keyring has no wrap for us: we are not, or no longer, the owner's friend.
pub fn open_keyring(
    bytes: &[u8],
    namespace: &[u8; 32],
    recv_secret: &[u8],
) -> Option<(KeyId, [u8; 32])> {
    let keyring: Keyring = postcard::from_bytes(bytes).ok()?;
    if keyring.v != KEYRING_V {
        return None;
    }
    let sk = <HpkeKem as hpke::Kem>::PrivateKey::from_bytes(recv_secret).ok()?;
    let mine = recv_kid(&<HpkeKem as hpke::Kem>::sk_to_pk(&sk).to_bytes());
    let info = keyring_info(namespace, &keyring.kid);
    keyring
        .wraps
        .iter()
        .filter(|wrap| wrap.rkid == mine)
        .find_map(|wrap| {
            let encapped = <HpkeKem as hpke::Kem>::EncappedKey::from_bytes(&wrap.enc).ok()?;
            let key = single_shot_open::<HpkeAead, HpkeKdf, HpkeKem>(
                &OpModeR::Base,
                &sk,
                &encapped,
                &info,
                &wrap.ct,
                &[],
            )
            .ok()?;
            let key: [u8; 32] = key.try_into().ok()?;
            (key_id(&key) == keyring.kid).then_some((keyring.kid, key))
        })
}

/// What the owner remembers about its keyring: which generation is current, who it was wrapped
/// for, and when everything was last sealed. The key itself is derived ([`derive_key`]).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct KeyState {
    v: u8,
    pub generation: u32,
    /// Endpoint ids the current keyring wraps the key for, sorted.
    pub members: Vec<[u8; 32]>,
    /// The receiving keys those wraps were made to, in the same order.
    pub keys: Vec<Vec<u8>>,
    /// When the keyring and every entry were last sealed (ms); 0 before the first time.
    pub sealed_at_ms: u64,
}

/// What [`KeyState::plan`] decided.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    /// Move to the next generation: someone who held the key no longer may.
    pub rotate: bool,
    /// Write the keyring and seal every entry again.
    pub reseal: bool,
}

impl KeyState {
    pub fn path(state_dir: &Path) -> PathBuf {
        state_dir.join(KEY_STATE_FILE)
    }

    /// The saved state, or a fresh one (generation 0, nothing sealed) when there is none. An
    /// unreadable file is a fresh start too: the only cost is one rotation, and a friend who held
    /// the old key keeps it only until then.
    pub fn load(state_dir: &Path) -> Self {
        std::fs::read(Self::path(state_dir))
            .ok()
            .and_then(|bytes| postcard::from_bytes::<KeyState>(&bytes).ok())
            .filter(|state| state.v == KEY_STATE_V)
            .unwrap_or(KeyState {
                v: KEY_STATE_V,
                ..KeyState::default()
            })
    }

    pub fn save(&self, state_dir: &Path) -> anyhow::Result<()> {
        use std::io::Write;
        let path = Self::path(state_dir);
        let tmp = path.with_extension("tmp");
        {
            let mut file = std::fs::File::create(&tmp)?;
            file.write_all(&postcard::to_allocvec(self)?)?;
            file.sync_all()?;
        }
        std::fs::rename(&tmp, &path)?;
        Ok(())
    }

    /// Given everyone who should hold the key now (endpoint id → receiving key), what to do.
    pub fn plan(&self, friends: &[([u8; 32], Vec<u8>)], now_ms: u64) -> Plan {
        let (members, keys) = sorted(friends);
        let rotate = self.members.iter().any(|m| !members.contains(m))
            // A friend's receiving key changed: the old key's holder is not them any more.
            || self
                .members
                .iter()
                .zip(&self.keys)
                .any(|(m, k)| members.iter().zip(&keys).any(|(n, l)| n == m && l != k));
        let reseal = rotate
            || members != self.members
            || self.sealed_at_ms == 0
            || now_ms.saturating_sub(self.sealed_at_ms) >= RESEAL_AFTER_MS;
        Plan { rotate, reseal }
    }

    /// The state after carrying out `plan` for `friends`.
    pub fn after(&self, plan: &Plan, friends: &[([u8; 32], Vec<u8>)], now_ms: u64) -> Self {
        let (members, keys) = sorted(friends);
        KeyState {
            v: KEY_STATE_V,
            generation: self.generation + u32::from(plan.rotate),
            members,
            keys,
            sealed_at_ms: now_ms,
        }
    }
}

fn sorted(friends: &[([u8; 32], Vec<u8>)]) -> (Vec<[u8; 32]>, Vec<Vec<u8>>) {
    let mut friends = friends.to_vec();
    friends.sort();
    friends.dedup_by(|a, b| a.0 == b.0);
    friends.into_iter().unzip()
}

#[cfg(test)]
mod tests {
    use super::*;

    const NS: [u8; 32] = [9; 32];

    fn friend() -> (Vec<u8>, Vec<u8>) {
        crate::crypto::generate_recv_keypair()
    }

    #[test]
    fn an_entry_opens_only_under_its_key_namespace_and_name() {
        let key = derive_key(&[1; 32], 0);
        let sealed = seal_entry(&key, &NS, b"profile", b"signed bytes").unwrap();
        assert_eq!(entry_kid(&sealed), Some(key_id(&key)));
        assert_eq!(
            open_entry(&key, &NS, b"profile", &sealed).as_deref(),
            Some(&b"signed bytes"[..])
        );
        assert!(open_entry(&key, &NS, b"repeaters", &sealed).is_none());
        assert!(open_entry(&key, &[8; 32], b"profile", &sealed).is_none());
        assert!(open_entry(&derive_key(&[1; 32], 1), &NS, b"profile", &sealed).is_none());
        assert!(open_entry(&key, &NS, b"profile", b"signed bytes").is_none());
    }

    #[test]
    fn a_keyring_opens_for_its_friends_only() {
        let key = derive_key(&[1; 32], 3);
        let (sam_secret, sam_pub) = friend();
        let (mara_secret, mara_pub) = friend();
        let (stranger_secret, _) = friend();
        let ring = build_keyring(&key, &NS, &[sam_pub, mara_pub, vec![1, 2, 3]]).unwrap();
        assert_eq!(
            open_keyring(&ring, &NS, &sam_secret),
            Some((key_id(&key), key))
        );
        assert_eq!(
            open_keyring(&ring, &NS, &mara_secret),
            Some((key_id(&key), key))
        );
        assert_eq!(open_keyring(&ring, &NS, &stranger_secret), None);
        // Bound to the namespace it was written for.
        assert_eq!(open_keyring(&ring, &[8; 32], &sam_secret), None);
    }

    #[test]
    fn the_key_is_derived_per_generation() {
        assert_eq!(derive_key(&[1; 32], 0), derive_key(&[1; 32], 0));
        assert_ne!(derive_key(&[1; 32], 0), derive_key(&[1; 32], 1));
        assert_ne!(derive_key(&[1; 32], 0), derive_key(&[2; 32], 0));
    }

    #[test]
    fn removing_a_friend_rotates_and_adding_one_does_not() {
        let a = ([1; 32], vec![10; 32]);
        let b = ([2; 32], vec![20; 32]);
        let fresh = KeyState::load(Path::new("/nonexistent"));
        let first = fresh.plan(&[a.clone()], 1);
        assert_eq!(
            first,
            Plan {
                rotate: false,
                reseal: true
            }
        );
        let one = fresh.after(&first, &[a.clone()], 1);
        // Adding a friend wraps the same key for them too.
        let add = one.plan(&[a.clone(), b.clone()], 2);
        assert_eq!(
            add,
            Plan {
                rotate: false,
                reseal: true
            }
        );
        let two = one.after(&add, &[b.clone(), a.clone()], 2);
        assert_eq!(two.generation, 0);
        // Nothing changed and it is fresh: nothing to do.
        assert!(!two.plan(&[a.clone(), b.clone()], 3).reseal);
        // Stale: seal again, same generation.
        let stale = two.plan(&[a.clone(), b.clone()], 2 + RESEAL_AFTER_MS);
        assert_eq!(
            stale,
            Plan {
                rotate: false,
                reseal: true
            }
        );
        // Removing a friend moves to the next generation.
        let removed = two.plan(&[a.clone()], 4);
        assert!(removed.rotate);
        assert_eq!(two.after(&removed, &[a.clone()], 4).generation, 1);
        // So does a friend's receiving key changing under them.
        assert!(two.plan(&[a.clone(), ([2; 32], vec![21; 32])], 4).rotate);
    }

    #[test]
    fn the_state_survives_a_reopen() {
        let dir = std::env::temp_dir().join(format!("profile-seal-{}", rand::random::<u64>()));
        std::fs::create_dir_all(&dir).unwrap();
        let friends = [([1; 32], vec![10; 32])];
        let fresh = KeyState::load(&dir);
        let state = fresh.after(&fresh.plan(&friends, 5), &friends, 5);
        state.save(&dir).unwrap();
        assert_eq!(KeyState::load(&dir), state);
        let _ = std::fs::remove_dir_all(dir);
    }
}
