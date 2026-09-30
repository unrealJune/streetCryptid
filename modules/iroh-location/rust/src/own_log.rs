//! This device's own published fixes, kept until the app is next around to read them.
//!
//! # Why this exists
//!
//! The durable replica holds ONE entry per author (`docs.rs`, last-write-wins, FORWARD-SECRECY.md
//! §4.4), so it answers "where is this device now" and never "where has it been". That is right
//! for what leaves the phone. It was also, by accident, the only way the app learned about its own
//! publishes: the own trail — and the exploration map drawn from it — was fed by reading the
//! replica back, which yields the latest fix and nothing else.
//!
//! While the JS engine published, it appended every fix to the trail itself. Once publishing moved
//! into the native drain, a stretch with no JS alive (an iOS background relaunch, an Android
//! process the OS killed) contributed exactly one point to the trail however long it lasted, and
//! the exploration map had holes wherever the phone had been in someone's pocket.
//!
//! This log is the local half of that old behaviour: every position envelope the drain puts on the
//! wire is recorded here with its `seq`, and the app drains it into the trail store when it runs.
//! It never leaves the device, and it holds nothing the app's own trail store would not hold anyway.
//!
//! # Bound
//!
//! [`MAX_ITEMS`] is two weeks of the five-minute cadence. A phone that goes longer than that
//! without anyone opening the app loses the OLDEST points, same rule and same reason as the outbox:
//! the recent past is what anyone is going to look at.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::durable::{claim_dir, write_atomic, WriterClaim};
use crate::{LocationFix, StoredFix};

const OWN_LOG_DIR: &str = "own-log";
const LOG_FILE: &str = "log";

/// Two weeks at one envelope per five minutes.
pub const MAX_ITEMS: usize = 14 * 24 * 12;

#[derive(Debug, thiserror::Error)]
pub enum OwnLogError {
    /// Another writer in this process already holds this directory (see [`crate::durable`]).
    #[error("an own-fix log is already open for this directory in this process")]
    AlreadyOpen,
    #[error("own-fix log io: {0}")]
    Io(String),
}

impl From<std::io::Error> for OwnLogError {
    fn from(e: std::io::Error) -> Self {
        OwnLogError::Io(e.to_string())
    }
}

/// One published position, as the app's trail store wants it.
#[derive(Debug, Clone, uniffi::Record)]
pub struct OwnPublished {
    pub seq: u64,
    pub fix: LocationFix,
}

/// On disk: [`StoredFix`], frozen independently of the wire type, for the reason that type exists.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Entry {
    seq: u64,
    fix: StoredFix,
}

#[derive(Debug)]
pub struct OwnLog {
    dir: PathBuf,
    path: PathBuf,
    items: Mutex<Vec<Entry>>,
    _claim: WriterClaim,
}

impl OwnLog {
    /// Claim the directory and load anything a previous process recorded and nobody took.
    ///
    /// An unreadable log reads as empty: its contents are a convenience copy of positions that
    /// already went out, and refusing to start the node over them would trade a gap in a trail for
    /// a phone that stops publishing.
    pub fn open(state_dir: &Path) -> Result<Self, OwnLogError> {
        let dir = state_dir.join(OWN_LOG_DIR);
        let claim = claim_dir(dir.clone()).ok_or(OwnLogError::AlreadyOpen)?;
        std::fs::create_dir_all(&dir)?;
        let path = dir.join(LOG_FILE);
        let items = match std::fs::read(&path) {
            Ok(raw) => postcard::from_bytes::<Vec<Entry>>(&raw).unwrap_or_else(|err| {
                tracing::warn!(error = %err, "own-log: unreadable, starting empty");
                Vec::new()
            }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(e.into()),
        };
        Ok(Self {
            dir,
            path,
            items: Mutex::new(items),
            _claim: claim,
        })
    }

    /// Record one published position. Best-effort by contract: the envelope is already on the
    /// wire, and failing to remember it locally must never fail the publish.
    pub fn record(&self, seq: u64, fix: &LocationFix) {
        let mut items = self.items.lock().unwrap_or_else(|e| e.into_inner());
        items.push(Entry {
            seq,
            fix: StoredFix::from(fix),
        });
        let over = items.len().saturating_sub(MAX_ITEMS);
        if over > 0 {
            items.drain(..over);
        }
        if let Err(err) = Self::persist(&self.dir, &self.path, &items) {
            tracing::warn!(error = %err, "own-log: could not persist");
        }
    }

    /// Hand everything recorded to the caller and forget it, oldest first.
    ///
    /// Cleared only once the empty log is durable, so a crash between the two leaves the entries
    /// to be taken again — a repeat is harmless, the trail store is keyed on `seq`.
    pub fn take(&self) -> Result<Vec<OwnPublished>, OwnLogError> {
        let mut items = self.items.lock().unwrap_or_else(|e| e.into_inner());
        if items.is_empty() {
            return Ok(Vec::new());
        }
        Self::persist(&self.dir, &self.path, &[])?;
        Ok(std::mem::take(&mut *items)
            .into_iter()
            .map(|e| OwnPublished {
                seq: e.seq,
                fix: LocationFix::from(&e.fix),
            })
            .collect())
    }

    /// How many positions are waiting to be taken.
    pub fn pending(&self) -> u32 {
        self.items.lock().unwrap_or_else(|e| e.into_inner()).len() as u32
    }

    fn persist(dir: &Path, path: &Path, items: &[Entry]) -> Result<(), OwnLogError> {
        let bytes = postcard::to_allocvec(items).map_err(|e| OwnLogError::Io(e.to_string()))?;
        write_atomic(dir, path, &bytes)?;
        Ok(())
    }
}
