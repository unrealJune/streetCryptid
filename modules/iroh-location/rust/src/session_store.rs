//! Encrypted, single-writer persistence for ratchet sessions (`ratchet.rs`).
//!
//! See `docs/social/FORWARD-SECRECY.md` §4.2 and §4.6. One file per peer, each holding a
//! [`SessionRecord`] — the session in use plus a short archive of the ones it replaced — sealed
//! with ChaCha20-Poly1305:
//!
//! ```text
//! key   = blake3_kdf("sc-dr/v1/store", identity_secret)
//! file  = nonce[12] || ChaCha20-Poly1305(key, nonce, record_bytes, aad)
//! aad   = "sc-dr/v1/store-aad" || peer_endpoint_id || RECORD_V
//! ```
//!
//! plus one `control.bin` holding this device's own restart material — its published prekeys and
//! the restart requests it has outstanding — under the same key and a different AAD.
//!
//! # Why a record and not a session
//!
//! A restart (§4.6) replaces the session in use, but the peer can still have envelopes in flight
//! that were sealed under the one it replaced — they were written before the peer learned of the
//! restart, and on a last-write-wins channel the newest of them IS the peer's current position.
//! Discarding the old session would make that position unreadable until the peer catches up. So
//! the record keeps the last [`MAX_PREVIOUS_SESSIONS`] sessions for decryption only — the
//! "inactive sessions" of Signal's Sesame. Chain keys only move forward, so an archived session
//! exposes nothing already received; it only lets us read what the peer still sends on it.
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
//! # Why the writer guard lives elsewhere
//!
//! The process-wide directory claim moved to [`crate::durable`] once the publish counter and the
//! outbox needed the same guarantee. The reasoning is unchanged and is recorded there: a JS-side
//! guard is duplicated along with every other JS module on each headless callback, so it cannot be
//! the thing that makes a single writer true. With sequential ratchet state a second writer is
//! **key reuse**, not a clobber, which is why §4.2 requires the guard be structural.

use std::path::{Path, PathBuf};

use chacha20poly1305::aead::{Aead, KeyInit, Payload as AeadPayload};
use chacha20poly1305::{ChaCha20Poly1305, Nonce};
use rand::rngs::OsRng;
use rand::RngCore;
use zeroize::Zeroize;

use crate::durable::{claim_dir, write_atomic, WriterClaim};
use crate::ratchet::{BootHeader, RatchetState, STATE_LEN, STATE_V};

const STORE_KEY_CONTEXT: &str = "sc-dr/v1/store";
const STORE_AAD_PREFIX: &[u8] = b"sc-dr/v1/store-aad";
const CONTROL_AAD_PREFIX: &[u8] = b"sc-dr/v1/control-aad";
const NONCE_LEN: usize = 12;
const KEY_LEN: usize = 32;
/// Subdirectory under the node's data dir.
const SESSIONS_DIR: &str = "sessions";
/// This device's restart material. Not a peer file: peer files are 64 hex characters.
const CONTROL_FILE: &str = "control.bin";

/// Version of the per-peer [`SessionRecord`] blob. Distinct from [`STATE_V`] on purpose: the AAD
/// carries it, so a record and a legacy single-session blob can never be mistaken for each other.
pub const RECORD_V: u8 = 3;
/// Version of the [`ControlState`] blob.
pub const CONTROL_V: u8 = 1;

/// How many replaced sessions a record keeps for decryption. Two covers a restart that is itself
/// restarted before the peer answers, with the pairing session still readable behind both.
pub const MAX_PREVIOUS_SESSIONS: usize = 2;

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

/// One session and what the restart protocol needs to know about it.
pub struct SessionEntry {
    pub state: RatchetState,
    /// When this device installed the session (ms). Drives the follower's "stuck without a
    /// sending chain" verdict and the leader's settle interval.
    pub created_ms: u64,
    /// Leader only: the restart header to attach to every wrap for this peer until they answer on
    /// this session. Cleared the first time we open an envelope from them under it.
    pub pending_boot: Option<BootHeader>,
}

impl std::fmt::Debug for SessionEntry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SessionEntry")
            .field("state", &self.state)
            .field("created_ms", &self.created_ms)
            .field("pending_boot", &self.pending_boot.is_some())
            .finish()
    }
}

/// Everything held for one peer: the session in use, and the ones it replaced.
#[derive(Debug, Default)]
pub struct SessionRecord {
    /// The session we seal with. `None` only transiently, after a damaged blob.
    pub current: Option<SessionEntry>,
    /// Replaced sessions, newest first, kept for decryption only. Never sealed with.
    pub previous: Vec<SessionEntry>,
    /// Leader only: the `ts` of the newest restart request from this peer we have acted on. Both
    /// values come from the peer's clock, so comparing them needs no clock agreement.
    pub answered_request_ts: u64,
}

impl SessionRecord {
    /// A record holding exactly `entry` as the session in use.
    pub fn with_current(entry: SessionEntry) -> Self {
        Self {
            current: Some(entry),
            previous: Vec::new(),
            answered_request_ts: 0,
        }
    }

    /// Make `entry` the session in use, archiving the one it replaces.
    pub fn install(&mut self, entry: SessionEntry) {
        if let Some(old) = self.current.take() {
            self.previous.insert(0, old);
        }
        self.previous.truncate(MAX_PREVIOUS_SESSIONS);
        self.current = Some(entry);
    }
}

/// One of this device's published restart prekeys (FORWARD-SECRECY.md §4.6). Its private half is
/// what lets a follower derive a restarted session from a header alone, hours after the leader
/// made it — nothing about the restart waits in memory on either side.
pub struct Prekey {
    pub id: u32,
    secret: [u8; KEY_LEN],
    pub created_ms: u64,
}

impl Prekey {
    pub fn new(id: u32, secret: [u8; KEY_LEN], created_ms: u64) -> Self {
        Self {
            id,
            secret,
            created_ms,
        }
    }

    pub fn secret(&self) -> x25519_dalek::StaticSecret {
        x25519_dalek::StaticSecret::from(self.secret)
    }

    pub fn public(&self) -> [u8; KEY_LEN] {
        x25519_dalek::PublicKey::from(&self.secret()).to_bytes()
    }
}

impl Drop for Prekey {
    fn drop(&mut self) {
        self.secret.zeroize();
    }
}

impl std::fmt::Debug for Prekey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Prekey")
            .field("id", &self.id)
            .field("created_ms", &self.created_ms)
            .finish_non_exhaustive()
    }
}

/// A follower's outstanding request that its leader restart their session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RestartRequest {
    pub peer: [u8; 32],
    /// Our clock. The leader answers any request newer than the last one it answered.
    pub ts: u64,
    /// The origin of the session we were on when we asked. A session with a different origin
    /// means the leader has answered.
    pub origin_at_request: u64,
}

/// This device's own restart material.
#[derive(Debug, Default)]
pub struct ControlState {
    /// Newest last.
    pub prekeys: Vec<Prekey>,
    pub requests: Vec<RestartRequest>,
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
        // From here on the claim is held, so any early return must release it — which it does,
        // because `claim` is a local and `WriterClaim` releases on drop.
        let claim = claim_dir(dir.clone()).ok_or(StoreError::AlreadyOpen)?;
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

    /// Bind the blob to this peer and blob version, so a file cannot be renamed onto another
    /// friend's session and still open.
    fn aad(peer: &[u8], version: u8) -> Vec<u8> {
        let mut aad = Vec::with_capacity(STORE_AAD_PREFIX.len() + peer.len() + 1);
        aad.extend_from_slice(STORE_AAD_PREFIX);
        aad.extend_from_slice(peer);
        aad.push(version);
        aad
    }

    fn seal(&self, plaintext: &[u8], aad: &[u8]) -> Result<Vec<u8>, StoreError> {
        let mut nonce = [0u8; NONCE_LEN];
        OsRng.fill_bytes(&mut nonce);
        let cipher = ChaCha20Poly1305::new_from_slice(&self.key).map_err(|_| StoreError::Cipher)?;
        let sealed = cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                AeadPayload {
                    msg: plaintext,
                    aad,
                },
            )
            .map_err(|_| StoreError::Cipher)?;
        let mut blob = Vec::with_capacity(NONCE_LEN + sealed.len());
        blob.extend_from_slice(&nonce);
        blob.extend_from_slice(&sealed);
        Ok(blob)
    }

    fn unseal(&self, raw: &[u8], aad: &[u8]) -> Result<Vec<u8>, StoreError> {
        if raw.len() <= NONCE_LEN {
            return Err(StoreError::Malformed);
        }
        let (nonce, ct) = raw.split_at(NONCE_LEN);
        let cipher = ChaCha20Poly1305::new_from_slice(&self.key).map_err(|_| StoreError::Cipher)?;
        cipher
            .decrypt(Nonce::from_slice(nonce), AeadPayload { msg: ct, aad })
            .map_err(|_| StoreError::Cipher)
    }

    /// Read everything held for `peer`, or `None` when there is nothing.
    ///
    /// A present-but-unreadable blob is an **error**, never `None`. Treating corruption as "no
    /// session" would start a fresh one at counter zero and reuse values the peer has already
    /// seen; the caller must run §4.6 recovery instead.
    ///
    /// A blob written by a build that predates records (a bare session under `STATE_V`) is read
    /// as a record holding just that session; the next save upgrades it.
    pub fn load_record(&self, peer: &[u8]) -> Result<Option<SessionRecord>, StoreError> {
        let raw = match std::fs::read(self.path_for(peer)) {
            Ok(raw) => raw,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.into()),
        };
        match self.unseal(&raw, &Self::aad(peer, RECORD_V)) {
            Ok(mut plaintext) => {
                let record = decode_record(&plaintext);
                plaintext.zeroize();
                record.map(Some)
            }
            Err(StoreError::Cipher) => {
                let mut plaintext = self.unseal(&raw, &Self::aad(peer, STATE_V))?;
                let state = RatchetState::from_bytes(&plaintext).map_err(|_| StoreError::Malformed);
                plaintext.zeroize();
                let state = state?;
                // A pre-record session has no install time on disk; the last time the peer moved
                // the ratchet is the closest durable stand-in, and the "stuck" verdict it feeds
                // only ever errs toward asking for a restart.
                let created_ms = state.peer_advanced_ms();
                Ok(Some(SessionRecord::with_current(SessionEntry {
                    state,
                    created_ms,
                    pending_boot: None,
                })))
            }
            Err(e) => Err(e),
        }
    }

    /// Write `record` for `peer`, durably enough that **power loss** cannot roll it back.
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
    pub fn save_record(&self, peer: &[u8], record: &SessionRecord) -> Result<(), StoreError> {
        let mut plaintext = encode_record(record);
        let sealed = self.seal(&plaintext, &Self::aad(peer, RECORD_V));
        plaintext.zeroize();
        // Write-then-rename: a crash mid-write leaves the previous record intact rather than a
        // truncated one. A truncated record is unrecoverable — it cannot be parsed, and parsing
        // failure is (correctly) fatal — so a torn write would cost a restart every time.
        write_atomic(&self.dir, &self.path_for(peer), &sealed?)?;
        Ok(())
    }

    /// The session in use for `peer`, if any. A convenience over [`Self::load_record`].
    pub fn load(&self, peer: &[u8]) -> Result<Option<RatchetState>, StoreError> {
        Ok(self
            .load_record(peer)?
            .and_then(|record| record.current)
            .map(|entry| entry.state))
    }

    /// Replace everything held for `peer` with `state` as the only session. A convenience over
    /// [`Self::save_record`] for callers that hold no archive; it does not preserve one.
    pub fn save(&self, peer: &[u8], state: &RatchetState) -> Result<(), StoreError> {
        let state =
            RatchetState::from_bytes(&state.to_bytes()).map_err(|_| StoreError::Malformed)?;
        self.save_record(
            peer,
            &SessionRecord::with_current(SessionEntry {
                state,
                created_ms: 0,
                pending_boot: None,
            }),
        )
    }

    /// Forget a peer's sessions — revocation, or removal.
    pub fn remove(&self, peer: &[u8]) -> Result<(), StoreError> {
        match std::fs::remove_file(self.path_for(peer)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        }
    }

    fn control_aad() -> Vec<u8> {
        let mut aad = CONTROL_AAD_PREFIX.to_vec();
        aad.push(CONTROL_V);
        aad
    }

    /// This device's prekeys and outstanding requests. Absent is empty; unreadable is an error —
    /// the caller decides whether to start over, and starting over is safe here (new prekeys are
    /// simply published) in a way it is not for a session.
    pub fn load_control(&self) -> Result<ControlState, StoreError> {
        let raw = match std::fs::read(self.dir.join(CONTROL_FILE)) {
            Ok(raw) => raw,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(ControlState::default())
            }
            Err(e) => return Err(e.into()),
        };
        let mut plaintext = self.unseal(&raw, &Self::control_aad())?;
        let control = decode_control(&plaintext);
        plaintext.zeroize();
        control
    }

    /// Persist this device's prekeys and requests. Must land before a prekey is published: a
    /// published prekey whose secret is not on disk is a restart nobody can complete.
    pub fn save_control(&self, control: &ControlState) -> Result<(), StoreError> {
        let mut plaintext = encode_control(control);
        let sealed = self.seal(&plaintext, &Self::control_aad());
        plaintext.zeroize();
        write_atomic(&self.dir, &self.dir.join(CONTROL_FILE), &sealed?)?;
        Ok(())
    }
}

// ── encoding ──────────────────────────────────────────────────────────────────────────────────
//
// Hand-written for the same reason `RatchetState::to_bytes` is: these bytes are key material, and
// the only way out of the types should be through a function whose single caller is the sealed
// store.

fn put_entry(out: &mut Vec<u8>, entry: &SessionEntry) {
    let mut state = entry.state.to_bytes();
    out.extend_from_slice(&state);
    state.zeroize();
    out.extend_from_slice(&entry.created_ms.to_le_bytes());
    match &entry.pending_boot {
        Some(boot) => {
            out.push(1);
            out.extend_from_slice(&boot.base);
            out.extend_from_slice(&boot.prekey_id.to_le_bytes());
            out.extend_from_slice(&boot.ts.to_le_bytes());
        }
        None => out.push(0),
    }
}

fn encode_record(record: &SessionRecord) -> Vec<u8> {
    let mut out = Vec::with_capacity(1 + 8 + 1 + (STATE_LEN + 53) * 3 + 1);
    out.push(RECORD_V);
    out.extend_from_slice(&record.answered_request_ts.to_le_bytes());
    match &record.current {
        Some(entry) => {
            out.push(1);
            put_entry(&mut out, entry);
        }
        None => out.push(0),
    }
    let previous = &record.previous[..record.previous.len().min(MAX_PREVIOUS_SESSIONS)];
    out.push(previous.len() as u8);
    for entry in previous {
        put_entry(&mut out, entry);
    }
    out
}

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], StoreError> {
        let end = self.at.checked_add(n).ok_or(StoreError::Malformed)?;
        let out = self.bytes.get(self.at..end).ok_or(StoreError::Malformed)?;
        self.at = end;
        Ok(out)
    }
    fn u8(&mut self) -> Result<u8, StoreError> {
        Ok(self.take(1)?[0])
    }
    fn u32(&mut self) -> Result<u32, StoreError> {
        Ok(u32::from_le_bytes(
            self.take(4)?
                .try_into()
                .map_err(|_| StoreError::Malformed)?,
        ))
    }
    fn u64(&mut self) -> Result<u64, StoreError> {
        Ok(u64::from_le_bytes(
            self.take(8)?
                .try_into()
                .map_err(|_| StoreError::Malformed)?,
        ))
    }
    fn key(&mut self) -> Result<[u8; 32], StoreError> {
        self.take(32)?.try_into().map_err(|_| StoreError::Malformed)
    }
    fn done(&self) -> Result<(), StoreError> {
        if self.at == self.bytes.len() {
            Ok(())
        } else {
            Err(StoreError::Malformed)
        }
    }
}

fn take_entry(r: &mut Reader<'_>) -> Result<SessionEntry, StoreError> {
    let state = RatchetState::from_bytes(r.take(STATE_LEN)?).map_err(|_| StoreError::Malformed)?;
    let created_ms = r.u64()?;
    let pending_boot = match r.u8()? {
        0 => None,
        1 => Some(BootHeader {
            base: r.key()?,
            prekey_id: r.u32()?,
            ts: r.u64()?,
        }),
        _ => return Err(StoreError::Malformed),
    };
    Ok(SessionEntry {
        state,
        created_ms,
        pending_boot,
    })
}

fn decode_record(bytes: &[u8]) -> Result<SessionRecord, StoreError> {
    let mut r = Reader { bytes, at: 0 };
    if r.u8()? != RECORD_V {
        return Err(StoreError::Malformed);
    }
    let answered_request_ts = r.u64()?;
    let current = match r.u8()? {
        0 => None,
        1 => Some(take_entry(&mut r)?),
        _ => return Err(StoreError::Malformed),
    };
    let count = r.u8()? as usize;
    if count > MAX_PREVIOUS_SESSIONS {
        return Err(StoreError::Malformed);
    }
    let mut previous = Vec::with_capacity(count);
    for _ in 0..count {
        previous.push(take_entry(&mut r)?);
    }
    r.done()?;
    Ok(SessionRecord {
        current,
        previous,
        answered_request_ts,
    })
}

fn encode_control(control: &ControlState) -> Vec<u8> {
    let mut out = vec![CONTROL_V];
    let prekeys = &control.prekeys[control.prekeys.len().saturating_sub(u8::MAX as usize)..];
    out.push(prekeys.len() as u8);
    for prekey in prekeys {
        out.extend_from_slice(&prekey.id.to_le_bytes());
        out.extend_from_slice(&prekey.secret);
        out.extend_from_slice(&prekey.created_ms.to_le_bytes());
    }
    let requests = &control.requests[..control.requests.len().min(u8::MAX as usize)];
    out.push(requests.len() as u8);
    for request in requests {
        out.extend_from_slice(&request.peer);
        out.extend_from_slice(&request.ts.to_le_bytes());
        out.extend_from_slice(&request.origin_at_request.to_le_bytes());
    }
    out
}

fn decode_control(bytes: &[u8]) -> Result<ControlState, StoreError> {
    let mut r = Reader { bytes, at: 0 };
    if r.u8()? != CONTROL_V {
        return Err(StoreError::Malformed);
    }
    let mut control = ControlState::default();
    for _ in 0..r.u8()? {
        let id = r.u32()?;
        let secret = r.key()?;
        let created_ms = r.u64()?;
        control.prekeys.push(Prekey::new(id, secret, created_ms));
    }
    for _ in 0..r.u8()? {
        control.requests.push(RestartRequest {
            peer: r.key()?,
            ts: r.u64()?,
            origin_at_request: r.u64()?,
        });
    }
    r.done()?;
    Ok(control)
}
