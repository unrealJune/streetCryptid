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
//!
//! # Why receiving keys live here too
//!
//! §4.6 session recovery seals its record to each peer's X25519 receiving key, and the native
//! drain is the only thing left that runs recovery. The ratchet session does not carry that key and
//! a headless wake has no JS pool to ask, so JS mirrors it next to the endpoint lists. It is a
//! cache of the pool, not an authority: a missing entry costs one recovery attempt, never a leak,
//! because the record carries only an ephemeral public key.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

use crate::durable::write_atomic;

/// Subdirectory under the node's state dir.
const RECIPIENTS_DIR: &str = "recipients";
const LIST_FILE: &str = "sharing";
const WATCHERS_FILE: &str = "watchers";
const KEYS_FILE: &str = "recv_keys";
const SEAL_REPORT_FILE: &str = "last_seal";

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
    keys_path: PathBuf,
    /// Endpoint id → receiving public key, both lowercase hex. See the module note.
    keys: RwLock<BTreeMap<String, String>>,
    seal_path: PathBuf,
    /// Who the most recent envelope was sealed for and who it left out. See [`SealReport`].
    last_seal: RwLock<Option<SealReport>>,
}

/// Who the most recent fix envelope was sealed for and who it had to leave out, and why.
///
/// `device.health` used to get this from a JS-side row that only the JS publish path wrote. The
/// native drain replaced that path and the row stopped moving — so through a week-long mutual
/// lapse the one attribute built to show "publishing to nobody" was simply absent. This is the same
/// fact, recorded where the sealing happens.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, uniffi::Record)]
pub struct SealReport {
    /// When the envelope was sealed (ms since epoch).
    pub at: u64,
    pub recipients: u32,
    pub dropped: u32,
    pub lapsed: u32,
    pub no_session: u32,
    /// `state_unavailable` + `no_sending_chain`: transient, telemetered, never shown to a human.
    pub other: u32,
}

impl SealReport {
    fn encode(&self) -> String {
        format!(
            "{} {} {} {} {} {}",
            self.at, self.recipients, self.dropped, self.lapsed, self.no_session, self.other
        )
    }

    fn decode(raw: &str) -> Option<Self> {
        let mut it = raw.split_whitespace().map(|p| p.parse::<u64>().ok());
        let mut next = || it.next().flatten();
        Some(Self {
            at: next()?,
            recipients: next()? as u32,
            dropped: next()? as u32,
            lapsed: next()? as u32,
            no_session: next()? as u32,
            other: next()? as u32,
        })
    }
}

/// Parse `endpoint recv_pub` lines, skipping anything malformed.
fn read_keys(path: &Path) -> Result<BTreeMap<String, String>, RecipientsError> {
    match std::fs::read_to_string(path) {
        Ok(raw) => Ok(raw
            .lines()
            .filter_map(|line| {
                let (endpoint, key) = line.split_once(' ')?;
                Some((normalise(endpoint).ok()?, normalise(key).ok()?))
            })
            .collect()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
        Err(e) => Err(e.into()),
    }
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
        let keys_path = dir.join(KEYS_FILE);
        let seal_path = dir.join(SEAL_REPORT_FILE);
        // A report that cannot be read is a missing report, never a failed open: it is a cache
        // for `device.health`, and nothing about sealing depends on it.
        let last_seal = std::fs::read_to_string(&seal_path)
            .ok()
            .and_then(|raw| SealReport::decode(&raw));
        Ok(Self {
            current: RwLock::new(read_list(&path)?),
            watchers: RwLock::new(read_list(&watchers_path)?),
            keys: RwLock::new(read_keys(&keys_path)?),
            last_seal: RwLock::new(last_seal),
            dir,
            path,
            watchers_path,
            keys_path,
            seal_path,
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

impl RecipientStore {
    /// Replace the receiving-key map, durable before returning. Whole-map replacement for the same
    /// reason [`Self::set`] replaces the whole list: the caller always knows the complete set.
    pub fn set_keys(&self, entries: &[(String, String)]) -> Result<(), RecipientsError> {
        let mut map = BTreeMap::new();
        for (endpoint, key) in entries {
            map.insert(normalise(endpoint)?, normalise(key)?);
        }
        let body = map
            .iter()
            .map(|(e, k)| format!("{e} {k}"))
            .collect::<Vec<_>>()
            .join(
                "
",
            );
        write_atomic(&self.dir, &self.keys_path, body.as_bytes())?;
        *self.keys.write().unwrap_or_else(|e| e.into_inner()) = map;
        Ok(())
    }

    /// The receiving public key JS last mirrored for `endpoint` (lowercase hex), if any.
    pub fn key_for(&self, endpoint: &str) -> Option<String> {
        let endpoint = normalise(endpoint).ok()?;
        self.keys
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .get(&endpoint)
            .cloned()
    }

    /// Remember what the latest envelope was sealed for. Best-effort: the in-memory copy always
    /// advances, and a failed write costs one stale health attribute after a restart.
    pub fn record_seal(&self, report: SealReport) {
        let _ = write_atomic(&self.dir, &self.seal_path, report.encode().as_bytes());
        *self.last_seal.write().unwrap_or_else(|e| e.into_inner()) = Some(report);
    }

    /// The latest [`SealReport`], or `None` if this install has never sealed a fix envelope.
    pub fn last_seal(&self) -> Option<SealReport> {
        *self.last_seal.read().unwrap_or_else(|e| e.into_inner())
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

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "sc-recipients-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn receiving_keys_survive_a_reopen_and_normalise_case() {
        let dir = scratch();
        let store = RecipientStore::open(&dir).unwrap();
        store
            .set_keys(&[
                ("AA11".into(), "BEEF".into()),
                ("bb22".into(), "cafe".into()),
            ])
            .unwrap();
        assert_eq!(store.key_for("aa11").as_deref(), Some("beef"));

        let reopened = RecipientStore::open(&dir).unwrap();
        assert_eq!(reopened.key_for("AA11").as_deref(), Some("beef"));
        assert_eq!(reopened.key_for("bb22").as_deref(), Some("cafe"));
        assert_eq!(reopened.key_for("cc33"), None);
    }

    #[test]
    fn a_malformed_key_is_refused_and_leaves_the_previous_map() {
        let dir = scratch();
        let store = RecipientStore::open(&dir).unwrap();
        store.set_keys(&[("aa11".into(), "beef".into())]).unwrap();
        assert!(store
            .set_keys(&[("aa11".into(), "not hex".into())])
            .is_err());
        assert_eq!(store.key_for("aa11").as_deref(), Some("beef"));
    }

    #[test]
    fn the_seal_report_survives_a_reopen() {
        let dir = scratch();
        let store = RecipientStore::open(&dir).unwrap();
        assert_eq!(
            store.last_seal(),
            None,
            "never sealed is not 'sealed for nobody'"
        );
        let report = SealReport {
            at: 1_790_000_000_000,
            recipients: 4,
            dropped: 3,
            lapsed: 2,
            no_session: 1,
            other: 0,
        };
        store.record_seal(report);
        assert_eq!(
            RecipientStore::open(&dir).unwrap().last_seal(),
            Some(report)
        );
    }
}
