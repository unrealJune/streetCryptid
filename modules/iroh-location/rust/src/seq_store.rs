//! Single-writer, crash-safe persistence for this device's monotonic publish counter.
//!
//! `seq` names an envelope: every durable entry this device writes is keyed `author/seq`, so two
//! envelopes sharing a value are two different payloads under one key. Last-write-wins then
//! silently keeps whichever reconciled second, and a rejoining peer backfills a fix that never
//! happened at a position that did. The counter is therefore persisted **before** the value it
//! hands out reaches the wire — a lagging file is recoverable, a reused value is not.
//!
//! # Why this moved out of JS
//!
//! It used to live in `expo-secure-store` (`state-store.ts`), read into a `LocationSharingService`
//! instance and incremented there. That is the same shape `session_store.rs` refuses for ratchet
//! state, and it fails for the same reason: expo-task-manager hands every headless callback a
//! **fresh JS context**, so each gets its own module instance, its own cached counter, and its own
//! belief that it is the only writer — while the native node they all talk to is process-wide. Two
//! contexts running at once each read the same persisted value and each hand out `n + 1`.
//!
//! No JS-side guard can close that, because the thing that would hold the guard is the thing being
//! duplicated. So the counter lives where the single writer can be structural: here, behind the
//! same process-wide directory claim the session store uses.
//!
//! # Why the file is plaintext
//!
//! Unlike ratchet state, the counter is not a secret: it is already on the wire in the clear as
//! half of every docs key, and any pool member — and the stash — reads it there. Encrypting it
//! would imply a confidentiality property it does not have, and cost a KDF on the publish path to
//! protect a number the recipient is about to be told anyway. Durability is the property that
//! matters here, and that is what the write path buys.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::durable::{claim_dir, write_atomic, WriterClaim};

/// Subdirectory under the node's state dir. A directory rather than a bare file so the claim is
/// taken on something this store alone owns, exactly as `sessions/` is.
const SEQ_DIR: &str = "seq";
const COUNTER_FILE: &str = "counter";

#[derive(Debug, thiserror::Error)]
pub enum SeqError {
    /// Another writer in this process already holds this directory (see the module docs).
    #[error("a sequence store is already open for this directory in this process")]
    AlreadyOpen,
    #[error("sequence store io: {0}")]
    Io(String),
    /// The file exists but is not a counter this build can read.
    ///
    /// Deliberately **not** treated as "start at zero": that would re-issue every value this
    /// device has ever published. Recovery is [`SeqStore::seed`] from the highest `seq` in the
    /// local replica, which is a floor we can always re-derive.
    #[error("sequence file is malformed")]
    Malformed,
}

impl From<std::io::Error> for SeqError {
    fn from(e: std::io::Error) -> Self {
        SeqError::Io(e.to_string())
    }
}

/// The single writer of this device's publish counter.
#[derive(Debug)]
pub struct SeqStore {
    dir: PathBuf,
    path: PathBuf,
    /// Guards read-modify-write. Native callers reach this from the OS location callback and from
    /// a mounted foreground engine, which are different threads on both platforms.
    current: Mutex<u64>,
    _claim: WriterClaim,
}

impl SeqStore {
    /// Claim this device's counter directory and read the persisted value.
    ///
    /// A missing file reads as 0 — that is a device that has never published, which is genuinely
    /// indistinguishable from a fresh install and safe to start from. A file that exists but does
    /// not parse is [`SeqError::Malformed`]; see the note there for why that is not the same case.
    pub fn open(state_dir: &Path) -> Result<Self, SeqError> {
        let dir = state_dir.join(SEQ_DIR);
        let claim = claim_dir(dir.clone()).ok_or(SeqError::AlreadyOpen)?;
        // From here on the claim is held, so every early return must drop it — which it does,
        // because `claim` is a local and `WriterClaim` releases on drop.
        std::fs::create_dir_all(&dir)?;
        let path = dir.join(COUNTER_FILE);
        let current = match std::fs::read_to_string(&path) {
            Ok(raw) => raw.trim().parse::<u64>().map_err(|_| SeqError::Malformed)?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => 0,
            Err(e) => return Err(e.into()),
        };
        Ok(Self {
            dir,
            path,
            current: Mutex::new(current),
            _claim: claim,
        })
    }

    /// The last value handed out, without advancing.
    pub fn current(&self) -> u64 {
        *self.current.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Advance and return the next value, durable before it returns.
    ///
    /// The counter is only advanced in memory once the write has landed, so a failed save leaves
    /// the store where it was and the caller retries the same value rather than skipping one.
    /// Skipping would be harmless; the ordering matters because the reverse — advancing in memory
    /// and failing to persist — is what re-issues a value after a restart.
    pub fn next(&self) -> Result<u64, SeqError> {
        let mut guard = self.current.lock().unwrap_or_else(|e| e.into_inner());
        let candidate = guard.saturating_add(1);
        self.persist(candidate)?;
        *guard = candidate;
        Ok(candidate)
    }

    /// Raise the counter to at least `floor`, and report whether it moved.
    ///
    /// Monotone and idempotent by construction, which is what makes it safe as both the one-time
    /// migration from the old SecureStore value and the recovery path from a malformed file: a
    /// floor that is already below us is a no-op, and one that is above us can only ever skip
    /// values, never re-issue them.
    pub fn seed(&self, floor: u64) -> Result<bool, SeqError> {
        let mut guard = self.current.lock().unwrap_or_else(|e| e.into_inner());
        if floor <= *guard {
            return Ok(false);
        }
        self.persist(floor)?;
        *guard = floor;
        Ok(true)
    }

    /// Write-then-rename, with both the data and the directory entry fsynced.
    ///
    /// Identical discipline to `SessionStore::save`, for an identical reason: a torn write here is
    /// not a stale counter but an unparseable one, and the recovery for that costs a replica scan.
    fn persist(&self, value: u64) -> Result<(), SeqError> {
        write_atomic(&self.dir, &self.path, value.to_string().as_bytes())?;
        Ok(())
    }
}

impl From<SeqError> for crate::publish::StoreError {
    fn from(e: SeqError) -> Self {
        match e {
            SeqError::Malformed => crate::publish::StoreError::Malformed,
            other => crate::publish::StoreError::Io(other.to_string()),
        }
    }
}

impl crate::publish::SeqCounter for SeqStore {
    fn next(&self) -> Result<u64, crate::publish::StoreError> {
        SeqStore::next(self).map_err(Into::into)
    }

    fn current(&self) -> u64 {
        SeqStore::current(self)
    }

    fn seed(&self, floor: u64) -> Result<bool, crate::publish::StoreError> {
        SeqStore::seed(self, floor).map_err(Into::into)
    }
}
