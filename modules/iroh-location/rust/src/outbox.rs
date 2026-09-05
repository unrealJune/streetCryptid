//! The durable queue between "the OS handed us a location" and "the envelope is on the wire".
//!
//! The JS original (`fix-outbox.ts`) survives for the mounted path; this is the copy the native
//! drain uses, and it exists because of what the JS one could not do. On 2026-08-29 a Pixel
//! captured continuously for eleven and a half hours while `expo-task-manager` spooled every
//! location event, because it never managed to start a headless JS context to hand them to. The
//! fixes were real and the foreground service was healthy; the only thing missing was a JS runtime
//! to own the queue. A queue that lives here can be filled and drained by the OS callback itself.
//!
//! # Bound
//!
//! [`MAX_ITEMS`] matches the JS default, and the number is not academic: that same Pixel reached
//! 445 pending. A blackout fifteen percent longer would have begun discarding, so the choice of
//! *which end* to discard is a real one. We drop the OLDEST, because the queue exists to answer
//! "where is my friend" and the newest fix answers it best — losing the front of a long backlog
//! costs trail resolution, losing the back would cost the current position.
//!
//! # Ordering
//!
//! Strict capture order, and the drain stops at the first failure rather than skipping past it.
//! `seq` is assigned at publish time, so draining out of order would put a later capture under an
//! earlier sequence number and a receiver reconstructing a trail would see the device jump
//! backwards. Stopping also means a transient publish failure retries the same fix rather than
//! stranding it behind newer ones.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::durable::{claim_dir, write_atomic, WriterClaim};
use crate::publish::EnqueueOutcome;
use crate::{LocationFix, StoredFix};

/// Subdirectory under the node's state dir.
const OUTBOX_DIR: &str = "outbox";
const QUEUE_FILE: &str = "queue";

/// Bounded ring size; oldest fixes are dropped past this. Matches `fix-outbox.ts`'s default.
pub const MAX_ITEMS: usize = 500;

#[derive(Debug, thiserror::Error)]
pub enum OutboxError {
    /// Another writer in this process already holds this directory (see [`crate::durable`]).
    #[error("an outbox is already open for this directory in this process")]
    AlreadyOpen,
    #[error("outbox io: {0}")]
    Io(String),
    #[error("outbox encode: {0}")]
    Encode(String),
}

impl From<std::io::Error> for OutboxError {
    fn from(e: std::io::Error) -> Self {
        OutboxError::Io(e.to_string())
    }
}

/// The single writer of this device's pending-fix queue.
///
/// Stores [`StoredFix`], not [`LocationFix`]: see that type for why the on-disk shape is frozen
/// independently of the wire. The envelope stamps a fix carries are assigned at seal time in
/// `DrainEngine::drain`, so a queued fix has nothing to lose by not carrying them.
#[derive(Debug)]
pub struct Outbox {
    dir: PathBuf,
    path: PathBuf,
    items: Mutex<Vec<StoredFix>>,
    _claim: WriterClaim,
}

impl Outbox {
    /// Claim the outbox directory and load anything left from a previous run.
    ///
    /// A queue that cannot be decoded reads as **empty** rather than failing the node. That is the
    /// opposite of the seq counter's rule and for the opposite reason: unreadable pending fixes
    /// are already lost whatever we do, and refusing to start would turn a handful of dropped
    /// positions into a device that never publishes again.
    pub fn open(state_dir: &Path) -> Result<Self, OutboxError> {
        let dir = state_dir.join(OUTBOX_DIR);
        let claim = claim_dir(dir.clone()).ok_or(OutboxError::AlreadyOpen)?;
        std::fs::create_dir_all(&dir)?;
        let path = dir.join(QUEUE_FILE);
        let items = match std::fs::read(&path) {
            Ok(raw) => postcard::from_bytes::<Vec<StoredFix>>(&raw).unwrap_or_else(|err| {
                tracing::warn!(error = %err, "outbox: unreadable queue, starting empty");
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

    /// How many fixes are waiting.
    pub fn pending(&self) -> u32 {
        self.items.lock().unwrap_or_else(|e| e.into_inner()).len() as u32
    }

    /// Append a captured fix, enforcing the bound. Durable before it returns.
    pub fn enqueue(&self, fix: LocationFix) -> Result<EnqueueOutcome, OutboxError> {
        let mut items = self.items.lock().unwrap_or_else(|e| e.into_inner());
        items.push(StoredFix::from(&fix));
        let overflow_dropped = items.len().saturating_sub(MAX_ITEMS);
        if overflow_dropped > 0 {
            items.drain(..overflow_dropped);
        }
        Self::persist(&self.dir, &self.path, &items)?;
        Ok(EnqueueOutcome {
            pending: items.len() as u32,
            overflow_dropped: overflow_dropped as u32,
        })
    }

    /// The oldest queued fix, without removing it.
    ///
    /// Peek-then-[`commit`](Self::commit) rather than a `drain(callback)`: publishing is async and
    /// reaches the network, and holding the queue lock across it would block every concurrent
    /// enqueue for the duration of a relay round-trip. The fix stays queued until the publish has
    /// actually succeeded, which is the property that makes a crash mid-publish cost a duplicate
    /// rather than a loss — and a duplicate is invisible, because the durable slot is
    /// last-write-wins on `(author, seq)`.
    pub fn peek(&self) -> Option<LocationFix> {
        self.items
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .first()
            .map(LocationFix::from)
    }

    /// Remove the oldest fix after it has been published. Durable before it returns.
    ///
    /// Returns the remaining depth. A no-op on an empty queue, so a double-commit — which a
    /// retried drain can produce — cannot remove a fix that was never published.
    pub fn commit(&self) -> Result<u32, OutboxError> {
        let mut items = self.items.lock().unwrap_or_else(|e| e.into_inner());
        if items.is_empty() {
            return Ok(0);
        }
        items.remove(0);
        Self::persist(&self.dir, &self.path, &items)?;
        Ok(items.len() as u32)
    }

    /// Drop everything (sign-out, or the user turning sharing off for good).
    pub fn clear(&self) -> Result<(), OutboxError> {
        let mut items = self.items.lock().unwrap_or_else(|e| e.into_inner());
        items.clear();
        Self::persist(&self.dir, &self.path, &items)
    }

    fn persist(dir: &Path, path: &Path, items: &[StoredFix]) -> Result<(), OutboxError> {
        let bytes = postcard::to_allocvec(items).map_err(|e| OutboxError::Encode(e.to_string()))?;
        write_atomic(dir, path, &bytes)?;
        Ok(())
    }
}

impl From<OutboxError> for crate::publish::StoreError {
    fn from(e: OutboxError) -> Self {
        crate::publish::StoreError::Io(e.to_string())
    }
}

impl crate::publish::FixQueue for Outbox {
    fn enqueue(&self, fix: LocationFix) -> Result<EnqueueOutcome, crate::publish::StoreError> {
        Outbox::enqueue(self, fix).map_err(Into::into)
    }

    fn peek(&self) -> Option<LocationFix> {
        Outbox::peek(self)
    }

    fn commit(&self) -> Result<u32, crate::publish::StoreError> {
        Outbox::commit(self).map_err(Into::into)
    }

    fn pending(&self) -> u32 {
        Outbox::pending(self)
    }

    fn clear(&self) -> Result<(), crate::publish::StoreError> {
        Outbox::clear(self).map_err(Into::into)
    }
}
