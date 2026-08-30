//! Crash-safety and single-writer primitives shared by everything that persists publish state.
//!
//! Three stores now depend on the same two properties, and they depend on them for the same
//! reason: [`session_store`](crate::session_store) holds sequential ratchet state,
//! [`seq_store`](crate::seq_store) holds the publish counter, and [`outbox`](crate::outbox) holds
//! fixes that have been captured but not yet sealed. In all three a torn write is not a stale
//! value but an unreadable one, and a second writer is not a clobber but a correctness failure.
//!
//! # Why the writer claim is process-wide and lives in Rust
//!
//! expo-task-manager hands every headless callback a **fresh JS context**. Each gets its own copy
//! of every JS module, so a guard written in JS is duplicated along with the thing it guards and
//! two contexts each conclude they are the only writer — while the native node they all talk to is
//! process-wide. The claim therefore lives in the one place they genuinely share: a static here.
//!
//! Scope, so it is not mistaken for more than it is: this is process-wide, and both platforms run
//! headless callbacks in the app process today. An Android task service configured into a separate
//! process would need a file lock as well.

use std::collections::HashSet;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// Directories with a live writer in this process.
fn claimed() -> &'static Mutex<HashSet<PathBuf>> {
    static CLAIMED: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    CLAIMED.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Releases the process-wide claim when the store is dropped, so a legitimate re-open after a
/// clean shutdown succeeds.
#[derive(Debug)]
pub(crate) struct WriterClaim(PathBuf);

impl Drop for WriterClaim {
    fn drop(&mut self) {
        if let Ok(mut set) = claimed().lock() {
            set.remove(&self.0);
        }
    }
}

/// Take the process-wide writer claim on `dir`, or `None` when one is already held.
///
/// ONE registry across every store, deliberately: two registries would let two stores rooted at
/// the same directory each conclude they were the only writer, which is the failure this exists
/// to prevent rather than a detail of how it is implemented.
pub(crate) fn claim_dir(dir: PathBuf) -> Option<WriterClaim> {
    let mut set = claimed().lock().ok()?;
    if !set.insert(dir.clone()) {
        return None;
    }
    Some(WriterClaim(dir))
}

/// fsync a directory, so a `rename` into it is durable and not just visible.
///
/// POSIX only. On Windows a directory handle is not something `File::open` will give us, and
/// NTFS orders the metadata write itself; the mobile targets this actually protects are both
/// POSIX, and desktop Windows is a development host rather than a device holding real state.
pub(crate) fn sync_dir(dir: &Path) -> std::io::Result<()> {
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

/// Write `bytes` to `path` so that a crash leaves either the previous contents or the new ones,
/// never a prefix of the new ones.
///
/// Write-then-rename with both halves fsynced. Skipping the file sync can leave the rename
/// pointing at a file whose data never landed; skipping the directory sync can lose the rename
/// after the data is safe, which silently rolls back to the previous contents. Every caller here
/// treats a rollback as a correctness failure, not merely a stale read, so both are required.
pub(crate) fn write_atomic(dir: &Path, path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    {
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        // The data, before anything points at it.
        file.sync_all()?;
    }
    std::fs::rename(&tmp, path)?;
    // The rename itself.
    sync_dir(dir)
}
