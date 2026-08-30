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
//!
//! # Why watchers live here too
//!
//! Every friend is in exactly one of the two lists, and they change together — moving someone from
//! sharing to watch-only is one edit, not two. Storing them apart would let a friend end up in both
//! or neither, and "neither" is the dangerous one: a watch-only edge that stops receiving our null
//! envelopes lapses at `T_lapse` (FORWARD-SECRECY.md §4.1), which is the mutual-lapse failure that
//! took a day to find the first time.

use std::path::{Path, PathBuf};
use std::sync::RwLock;

use crate::durable::write_atomic;

/// Subdirectory under the node's state dir.
const RECIPIENTS_DIR: &str = "recipients";
const LIST_FILE: &str = "sharing";
const WATCHERS_FILE: &str = "watchers";

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
    watchers_path: PathBuf,
    /// Read on every publish and written only when the user changes who they share with, so the
    /// asymmetry of `RwLock` is the right one here.
    current: RwLock<Vec<String>>,
    /// Friends we do NOT share position with. They still receive a null envelope on the same
    /// cadence, which is what carries our ratchet contribution to a watch-only edge.
    watchers: RwLock<Vec<String>>,
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

/// Read one persisted list. An unreadable entry is skipped rather than failing the load — see
/// [`RecipientStore::open`] for why this side fails closed rather than loud.
fn read_list(path: &Path) -> Result<Vec<String>, RecipientsError> {
    match std::fs::read_to_string(path) {
        Ok(raw) => Ok(raw.lines().filter_map(|l| normalise(l).ok()).collect()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(e.into()),
    }
}

/// Validate, lowercase, sort and dedupe — so the same set never persists two different ways.
fn normalise_all(endpoints: &[String]) -> Result<Vec<String>, RecipientsError> {
    let mut out = Vec::with_capacity(endpoints.len());
    for raw in endpoints {
        out.push(normalise(raw)?);
    }
    out.sort();
    out.dedup();
    Ok(out)
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
        let watchers_path = dir.join(WATCHERS_FILE);
        Ok(Self {
            current: RwLock::new(read_list(&path)?),
            watchers: RwLock::new(read_list(&watchers_path)?),
            dir,
            path,
            watchers_path,
        })
    }

    /// Who to seal the next envelope for.
    pub fn get(&self) -> Vec<String> {
        self.current
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// Friends we owe a null envelope: watch-only edges (FORWARD-SECRECY.md §4.1).
    pub fn watchers(&self) -> Vec<String> {
        self.watchers
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// Replace both lists together, durable before returning.
    ///
    /// Together, not separately: a friend belongs to exactly one of them, and two writes leave a
    /// window where they are in both or in neither. "Neither" silently stops their ratchet
    /// contribution and lapses the edge.
    pub fn set_all(&self, sharing: &[String], watching: &[String]) -> Result<(), RecipientsError> {
        let sharing = normalise_all(sharing)?;
        let watching = normalise_all(watching)?;
        // Both validated before either is written, so a bad entry in the second list cannot leave
        // the first one replaced and the second stale.
        write_atomic(&self.dir, &self.path, sharing.join("\n").as_bytes())?;
        write_atomic(
            &self.dir,
            &self.watchers_path,
            watching.join("\n").as_bytes(),
        )?;
        *self.current.write().unwrap_or_else(|e| e.into_inner()) = sharing;
        *self.watchers.write().unwrap_or_else(|e| e.into_inner()) = watching;
        Ok(())
    }

    /// Replace the sharing set, durable before it returns.
    ///
    /// Whole-list replacement rather than add/remove: the caller always knows the complete set,
    /// and a diff-based API would let the two sides disagree about what the set currently is —
    /// which is precisely the class of bug that made a removed friend keep receiving fixes.
    /// Validation happens before the write, so a rejected list leaves the previous one intact.
    pub fn set(&self, endpoints: &[String]) -> Result<(), RecipientsError> {
        let normalised = normalise_all(endpoints)?;
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

    fn watchers(&self) -> Vec<String> {
        RecipientStore::watchers(self)
    }

    fn set(&self, endpoints: &[String]) -> Result<(), crate::publish::StoreError> {
        RecipientStore::set(self, endpoints).map_err(Into::into)
    }
}
