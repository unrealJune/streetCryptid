//! The set of friends this device is currently sharing position with.
//!
//! This is the smallest piece of the JS friend pool the native publish path actually needs. It is
//! deliberately *not* the pool: the pool carries tickets, display names, colours, watch-only edges
//! and pairing history, all of which belong to the UI and none of which the sealing step reads.
//! Sealing needs one thing — the list of endpoint ids to wrap an envelope for — so that is the
//! only thing that crosses the boundary and the only thing that can go stale.
//!
//! # Why it is persisted here rather than passed in
//!
//! The whole point of the native drain path is that it runs when no JS context exists to ask. A
//! phone woken by the OS with a location has to know who to seal for before any JS module has
//! loaded, so the answer has to already be on disk, written the last time the user changed it.
//!
//! # Staleness, and why it is safe in the direction that matters
//!
//! JS pushes the list on every pool change, so between a change and the next push the native path
//! can hold an old set. The failure modes are asymmetric and both acceptable:
//!
//! - **A removed friend still listed.** They receive one more envelope. The ratchet still gates it
//!   — a friend whose session is gone is dropped by `next_wraps` rather than sealed for — and the
//!   pool change that removed them is what tears the session down. Bounded to the fixes published
//!   between the removal and the push, and the push is the first thing the removal does.
//! - **An added friend not yet listed.** They miss envelopes until the push lands. A gap, not a
//!   leak, and the mounted app is by definition running at the moment a friend is added.
//!
//! Revocation is therefore never weaker than it was: the authority for "can this person read my
//! location" remains the ratchet session, and this list only ever narrows who we attempt to seal
//! for.

use std::path::{Path, PathBuf};
use std::sync::RwLock;

use crate::durable::write_atomic;

/// Subdirectory under the node's state dir.
const RECIPIENTS_DIR: &str = "recipients";
const LIST_FILE: &str = "sharing";

#[derive(Debug, thiserror::Error)]
pub enum RecipientsError {
    #[error("recipient store io: {0}")]
    Io(String),
    /// An entry was not a hex endpoint id. Rejected on the way IN, so a bad value can never be
    /// persisted and every later read is known-good.
    #[error("recipient list contains a non-hex endpoint id")]
    Malformed,
}

impl From<std::io::Error> for RecipientsError {
    fn from(e: std::io::Error) -> Self {
        RecipientsError::Io(e.to_string())
    }
}

/// This device's current sharing set, cached in memory and mirrored to disk.
#[derive(Debug)]
pub struct RecipientStore {
    dir: PathBuf,
    path: PathBuf,
    /// Read on every publish and written only when the user changes who they share with, so the
    /// asymmetry of `RwLock` is the right one here.
    current: RwLock<Vec<String>>,
}

/// Endpoint ids are lowercase hex. Normalising on the way in means the native path never has to
/// care which case JS happened to send, and a comparison against a session key cannot miss.
fn normalise(raw: &str) -> Result<String, RecipientsError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || !trimmed.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(RecipientsError::Malformed);
    }
    Ok(trimmed.to_ascii_lowercase())
}

impl RecipientStore {
    /// Load the persisted sharing set, or an empty one when there is none.
    ///
    /// An unreadable or malformed file reads as **empty**, unlike the seq counter's malformed
    /// file. The two are opposites on purpose: an unknown counter must not be guessed because
    /// guessing low re-issues keys, whereas an unknown sharing set must not be guessed because
    /// guessing *wide* would seal for someone the user may have removed. Empty publishes to
    /// nobody until JS pushes the real list, which is a visible gap rather than a silent leak.
    pub fn open(state_dir: &Path) -> Result<Self, RecipientsError> {
        let dir = state_dir.join(RECIPIENTS_DIR);
        std::fs::create_dir_all(&dir)?;
        let path = dir.join(LIST_FILE);
        let current = match std::fs::read_to_string(&path) {
            Ok(raw) => raw.lines().filter_map(|l| normalise(l).ok()).collect(),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(e.into()),
        };
        Ok(Self {
            dir,
            path,
            current: RwLock::new(current),
        })
    }

    /// Who to seal the next envelope for.
    pub fn get(&self) -> Vec<String> {
        self.current
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// Replace the sharing set, durable before it returns.
    ///
    /// Whole-list replacement rather than add/remove: the caller always knows the complete set,
    /// and a diff-based API would let the two sides disagree about what the set currently is —
    /// which is precisely the class of bug that made a removed friend keep receiving fixes.
    /// Validation happens before the write, so a rejected list leaves the previous one intact.
    pub fn set(&self, endpoints: &[String]) -> Result<(), RecipientsError> {
        let mut normalised = Vec::with_capacity(endpoints.len());
        for raw in endpoints {
            normalised.push(normalise(raw)?);
        }
        normalised.sort();
        normalised.dedup();

        write_atomic(&self.dir, &self.path, normalised.join("\n").as_bytes())?;
        *self.current.write().unwrap_or_else(|e| e.into_inner()) = normalised;
        Ok(())
    }
}

impl From<RecipientsError> for crate::publish::StoreError {
    fn from(e: RecipientsError) -> Self {
        match e {
            RecipientsError::Malformed => crate::publish::StoreError::Malformed,
            other => crate::publish::StoreError::Io(other.to_string()),
        }
    }
}

impl crate::publish::Recipients for RecipientStore {
    fn get(&self) -> Vec<String> {
        RecipientStore::get(self)
    }

    fn set(&self, endpoints: &[String]) -> Result<(), crate::publish::StoreError> {
        RecipientStore::set(self, endpoints).map_err(Into::into)
    }
}
