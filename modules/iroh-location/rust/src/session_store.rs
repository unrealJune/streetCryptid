//! Encrypted, single-writer persistence for ratchet sessions (`ratchet.rs`).
//!
//! See `docs/social/FORWARD-SECRECY.md` §4.2. One file per peer, each holding a
//! [`RatchetState`] blob sealed with ChaCha20-Poly1305:
//!
//! ```text
//! key   = blake3_kdf("sc-dr/v1/store", identity_secret)
//! file  = nonce[12] || ChaCha20-Poly1305(key, nonce, state_bytes, aad)
//! aad   = "sc-dr/v1/store-aad" || peer_endpoint_id || STATE_V
//! ```
//!
//! # Why the key comes from the identity secret
//!
//! It is already persisted under `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY` (step 0), so the session
//! store inherits that protection class for free and there is no second secret to provision,
//! migrate, or lose. The blake3 context domain-separates it from every other use of that secret,
//! so this derivation cannot collide with the envelope, mesh, or topic derivations.
//!
//! Consequence, stated plainly: identity compromise implies session-store compromise. Against the
//! §1 threat model — a seized device — that costs nothing, because an adversary holding the device
//! has both. It would matter against an adversary who somehow extracted only the identity secret.
//!
//! # Why the writer guard lives here
//!
//! `native-runtime-owner.ts` cannot close this race. expo-task-manager hands every headless
//! callback a **fresh JS context**, so each gets its own copy of that module and its own `claimed`
//! flag, while the native node is process-wide. Two contexts each believe they hold the claim.
//!
//! With sequential ratchet state that is not a node clobber, it is **key reuse** — which is why
//! §4.2 requires the guard be structural rather than behavioural before any of this ships. So the
//! claim lives in the one place both contexts genuinely share: a static in this crate. A second
//! [`SessionStore::open`] on a directory that already has a live writer fails, rather than quietly
//! becoming a second writer.
//!
//! Scope, so it is not mistaken for more than it is: this is process-wide, and both platforms run
//! headless callbacks in the app process today. An Android task service configured into a separate
//! process would need a file lock as well.

use std::collections::HashSet;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use chacha20poly1305::aead::{Aead, KeyInit, Payload as AeadPayload};
use chacha20poly1305::{ChaCha20Poly1305, Nonce};
use rand::rngs::OsRng;
use rand::RngCore;
use zeroize::Zeroize;

use crate::ratchet::{RatchetState, STATE_V};

const STORE_KEY_CONTEXT: &str = "sc-dr/v1/store";
const STORE_AAD_PREFIX: &[u8] = b"sc-dr/v1/store-aad";
const NONCE_LEN: usize = 12;
const KEY_LEN: usize = 32;
/// Subdirectory under the node's data dir.
const SESSIONS_DIR: &str = "sessions";

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    /// Another writer in this process already holds this directory (see the module docs).
    #[error("a ratchet session store is already open for this directory in this process")]
    AlreadyOpen,
    #[error("session store io: {0}")]
    Io(String),
    /// The blob did not authenticate: wrong key, wrong peer, or tampering.
    #[error("session blob failed to authenticate")]
    Cipher,
    /// The plaintext was not a session this build understands.
    #[error("session blob is malformed")]
    Malformed,
}

impl From<std::io::Error> for StoreError {
    fn from(e: std::io::Error) -> Self {
        StoreError::Io(e.to_string())
    }
}

/// Directories with a live writer in this process.
fn claimed() -> &'static Mutex<HashSet<PathBuf>> {
    static CLAIMED: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    CLAIMED.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Releases the process-wide claim when the store is dropped, so a legitimate re-open after a
/// clean shutdown succeeds.
struct WriterClaim(PathBuf);

impl Drop for WriterClaim {
    fn drop(&mut self) {
        if let Ok(mut set) = claimed().lock() {
            set.remove(&self.0);
        }
    }
}

/// fsync a directory, so a `rename` into it is durable and not just visible.
///
/// POSIX only. On Windows a directory handle is not something `File::open` will give us, and
/// NTFS orders the metadata write itself; the mobile targets this actually protects are both
/// POSIX, and desktop Windows is a development host rather than a device holding real sessions.
fn sync_dir(dir: &Path) -> Result<(), StoreError> {
    #[cfg(unix)]
    {
        std::fs::File::open(dir)?.sync_all()?;
    }
    #[cfg(not(unix))]
    {
        let _ = dir;
    }
    Ok(())
}

/// The single writer of this device's ratchet sessions.
pub struct SessionStore {
    dir: PathBuf,
    key: [u8; KEY_LEN],
    _claim: WriterClaim,
}

impl Drop for SessionStore {
    fn drop(&mut self) {
        self.key.zeroize();
    }
}

impl std::fmt::Debug for SessionStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SessionStore")
            .field("dir", &self.dir)
            .finish_non_exhaustive()
    }
}

impl SessionStore {
    /// Claim this device's session directory and derive the store key.
    ///
    /// Fails with [`StoreError::AlreadyOpen`] if this process already has a live writer for
    /// `data_dir` — that refusal is the guard, not an inconvenience to retry around.
    pub fn open(data_dir: &Path, identity_secret: &[u8]) -> Result<Self, StoreError> {
        let dir = data_dir.join(SESSIONS_DIR);
        let canonical_claim = dir.clone();
        {
            let mut set = claimed().lock().map_err(|_| StoreError::AlreadyOpen)?;
            if !set.insert(canonical_claim.clone()) {
                return Err(StoreError::AlreadyOpen);
            }
        }
        // From here on the claim is held, so any early return must release it — `WriterClaim` is
        // constructed immediately for exactly that reason.
        let claim = WriterClaim(canonical_claim);
        std::fs::create_dir_all(&dir)?;

        let mut hasher = blake3::Hasher::new_derive_key(STORE_KEY_CONTEXT);
        hasher.update(identity_secret);
        let key = *hasher.finalize().as_bytes();

        Ok(Self {
            dir,
            key,
            _claim: claim,
        })
    }

    fn path_for(&self, peer: &[u8]) -> PathBuf {
        let mut name = String::with_capacity(peer.len() * 2 + 4);
        for byte in peer {
            name.push_str(&format!("{byte:02x}"));
        }
        name.push_str(".bin");
        self.dir.join(name)
    }

    /// Bind the blob to this peer and state version, so a file cannot be renamed onto another
    /// friend's session and still open.
    fn aad(peer: &[u8]) -> Vec<u8> {
        let mut aad = Vec::with_capacity(STORE_AAD_PREFIX.len() + peer.len() + 1);
        aad.extend_from_slice(STORE_AAD_PREFIX);
        aad.extend_from_slice(peer);
        aad.push(STATE_V);
        aad
    }

    /// Read the session held for `peer`, or `None` when there is none.
    ///
    /// A present-but-unreadable blob is an **error**, never `None`. Treating corruption as "no
    /// session" would start a fresh one at counter zero and reuse values the peer has already
    /// seen; the caller must run §4.6 resync instead.
    pub fn load(&self, peer: &[u8]) -> Result<Option<RatchetState>, StoreError> {
        let path = self.path_for(peer);
        let raw = match std::fs::read(&path) {
            Ok(raw) => raw,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.into()),
        };
        if raw.len() <= NONCE_LEN {
            return Err(StoreError::Malformed);
        }
        let (nonce, ct) = raw.split_at(NONCE_LEN);
        let cipher = ChaCha20Poly1305::new_from_slice(&self.key).map_err(|_| StoreError::Cipher)?;
        let aad = Self::aad(peer);
        let mut plaintext = cipher
            .decrypt(Nonce::from_slice(nonce), AeadPayload { msg: ct, aad: &aad })
            .map_err(|_| StoreError::Cipher)?;
        let state = RatchetState::from_bytes(&plaintext).map_err(|_| StoreError::Malformed);
        plaintext.zeroize();
        state.map(Some)
    }

    /// Write `state` for `peer`, durably enough that **power loss** cannot roll it back.
    ///
    /// **Fail-stop.** Every error propagates; there is no best-effort path. §4.2 is explicit that a
    /// silent persist no-op *is* key reuse, so a caller that cannot persist must not publish.
    ///
    /// Write-then-rename alone is not enough here, and the difference is a cryptographic one.
    /// Rename gives atomicity against a *torn* file; it gives nothing against the page cache
    /// losing the data behind a rename that already landed. `next_wraps` treats this function
    /// returning `Ok` as "the counter is on disk, it is now safe to seal" — so a save that returns
    /// `Ok` and then evaporates lets the next boot re-derive an already-used `(epoch, counter)`,
    /// and that message key seals a different content key under the same zero nonce. Repeated
    /// (key, nonce) in ChaCha20-Poly1305 leaks the XOR of both plaintexts and reuses the Poly1305
    /// one-time key. Hence: fsync the data, rename, then fsync the directory that holds the
    /// rename.
    ///
    /// The cost is one fsync per recipient per publish. At the 5-minute cold cadence that is
    /// noise; if the hot cadence ever moves onto this path, the answer is counter *reservation*
    /// (persist `ns + N` once, hand out `N` from RAM, burn the remainder on restart), not a
    /// weaker save. Burned counters are free under the sender-liveness invariant; reused ones
    /// are not.
    pub fn save(&self, peer: &[u8], state: &RatchetState) -> Result<(), StoreError> {
        let mut plaintext = state.to_bytes();

        let mut nonce = [0u8; NONCE_LEN];
        OsRng.fill_bytes(&mut nonce);
        let cipher = ChaCha20Poly1305::new_from_slice(&self.key).map_err(|_| StoreError::Cipher)?;
        let aad = Self::aad(peer);
        let sealed = cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                AeadPayload {
                    msg: &plaintext,
                    aad: &aad,
                },
            )
            .map_err(|_| StoreError::Cipher);
        plaintext.zeroize();
        let sealed = sealed?;

        let mut blob = Vec::with_capacity(NONCE_LEN + sealed.len());
        blob.extend_from_slice(&nonce);
        blob.extend_from_slice(&sealed);

        // Write-then-rename: a crash mid-write leaves the previous session intact rather than a
        // truncated one. A truncated session is unrecoverable — it cannot be parsed, and parsing
        // failure is (correctly) fatal — so a torn write would cost a resync every time.
        let final_path = self.path_for(peer);
        let tmp_path = final_path.with_extension("tmp");
        {
            let mut file = std::fs::File::create(&tmp_path)?;
            file.write_all(&blob)?;
            // The data, before anything points at it.
            file.sync_all()?;
        }
        std::fs::rename(&tmp_path, &final_path)?;
        // The rename itself. Without this the directory entry can still be lost after the data
        // is safe, which lands us back on the previous blob — the rollback described above.
        sync_dir(&self.dir)?;
        Ok(())
    }

    /// Forget a peer's session — revocation, or removal.
    pub fn remove(&self, peer: &[u8]) -> Result<(), StoreError> {
        match std::fs::remove_file(self.path_for(peer)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        }
    }
}
