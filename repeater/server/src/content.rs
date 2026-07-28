//! Content presence — the invariant iroh-docs does **not** give you.
//!
//! Range reconciliation transfers *entry records* (key, author, content hash, length, signature).
//! The bytes those hashes name are a separate iroh-blobs transfer. For an ordinary peer that split
//! is harmless: it fetches content from the author, who is online because they just sent it. For a
//! **store-and-forward** node it is the whole ballgame — the stash exists precisely to serve a
//! reader when the author is gone, so an entry whose bytes never arrived is a promise it cannot
//! keep. A reader syncing through such a stash gets `Unable to download <hash>`.
//!
//! The docs engine does try to fetch content, but only once per entry, against an author that is
//! usually about to be frozen by the OS — and a failed attempt parks the hash awaiting a gossip
//! `ContentReady` that a sleeping phone never sends. So this index turns "do we have the bytes?"
//! from an accident into tracked state:
//!
//! * **Convergence.** Anything still `Wanted` is work the settle loop retries, so a fetch that
//!   missed while the author slept succeeds the moment it is reachable again.
//! * **Memory.** `referenced` is the blob-GC liveness set. Retention drops references; the sweep
//!   then reclaims the ciphertext, which is the only thing here big enough to matter.
//! * **Visibility.** `missing_count` is the health signal whose absence let a blobless stash look
//!   perfectly healthy for weeks: entries replicated, wakes fired, logs clean, zero payloads.
//!
//! Pure and iroh-free (hashes are plain `[u8; 32]`) so it unit-tests without a live node.

use std::collections::{HashMap, HashSet};

/// A 32-byte iroh-blobs content hash.
pub type ContentHash = [u8; 32];
/// A 32-byte iroh-docs namespace id.
pub type NamespaceId = [u8; 32];

/// What the stash knows about one referenced blob.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    /// An entry references it; the bytes are not here yet.
    Wanted,
    /// The bytes are in the local store.
    Present,
}

/// Tracks, per namespace, the content hashes entries reference and whether the bytes have landed.
///
/// Hashes are refcounted across namespaces: two namespaces referencing identical ciphertext (an
/// unlikely but legal collision) must not have one's prune free bytes the other still needs.
#[derive(Debug, Default)]
pub struct ContentIndex {
    state: HashMap<ContentHash, State>,
    by_namespace: HashMap<NamespaceId, HashSet<ContentHash>>,
}

impl ContentIndex {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record that an entry in `ns` references `hash`. Idempotent, and never downgrades a hash
    /// that is already present (re-reconciling an old entry must not resurrect it as missing).
    pub fn want(&mut self, ns: NamespaceId, hash: ContentHash) {
        self.by_namespace.entry(ns).or_default().insert(hash);
        self.state.entry(hash).or_insert(State::Wanted);
    }

    /// Record that the bytes for `hash` are now in the local store. Ignores hashes nobody asked
    /// for, so a stray blob can never register itself as wanted.
    pub fn mark_present(&mut self, hash: ContentHash) {
        if let Some(state) = self.state.get_mut(&hash) {
            *state = State::Present;
        }
    }

    /// Whether an entry references this hash at all.
    pub fn is_tracked(&self, hash: &ContentHash) -> bool {
        self.state.contains_key(hash)
    }

    /// Whether the bytes have landed — i.e. whether the stash can actually serve this entry.
    pub fn is_present(&self, hash: &ContentHash) -> bool {
        matches!(self.state.get(hash), Some(State::Present))
    }

    /// Drop `hash` from `ns` (retention expired the entry). The hash stays referenced while any
    /// other namespace still names it. Returns true when the last reference went away, i.e. the
    /// bytes are now collectable.
    pub fn forget(&mut self, ns: &NamespaceId, hash: &ContentHash) -> bool {
        if let Some(hashes) = self.by_namespace.get_mut(ns) {
            hashes.remove(hash);
            if hashes.is_empty() {
                self.by_namespace.remove(ns);
            }
        }
        let still_referenced = self
            .by_namespace
            .values()
            .any(|hashes| hashes.contains(hash));
        if !still_referenced {
            self.state.remove(hash);
        }
        !still_referenced
    }

    /// How many referenced blobs are still missing their bytes. **Non-zero and not falling is the
    /// symptom of a blobless stash** — entries arriving, payloads not.
    pub fn missing_count(&self) -> usize {
        self.state
            .values()
            .filter(|state| **state == State::Wanted)
            .count()
    }

    /// Total referenced blobs, present or not.
    pub fn tracked_count(&self) -> usize {
        self.state.len()
    }

    /// Every hash still referenced by an unpruned entry — the blob-GC liveness set.
    ///
    /// Anything absent from this is unreachable ciphertext the sweep may reclaim. Wanted-but-absent
    /// hashes are included: a push or download for them may still be in flight, and un-protecting a
    /// blob mid-transfer would let GC race the writer.
    pub fn referenced(&self) -> Vec<ContentHash> {
        self.state.keys().copied().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NS_A: NamespaceId = [1u8; 32];
    const NS_B: NamespaceId = [2u8; 32];
    const HASH: ContentHash = [9u8; 32];
    const OTHER: ContentHash = [8u8; 32];

    #[test]
    fn an_unreferenced_hash_is_not_tracked() {
        let index = ContentIndex::new();
        assert!(!index.is_tracked(&HASH));
        assert!(index.referenced().is_empty());
    }

    #[test]
    fn wanting_a_hash_tracks_it_and_counts_it_as_missing() {
        let mut index = ContentIndex::new();
        index.want(NS_A, HASH);
        assert!(index.is_tracked(&HASH));
        assert!(!index.is_present(&HASH));
        assert_eq!(index.missing_count(), 1);
        assert_eq!(
            index.referenced(),
            vec![HASH],
            "a blob still being fetched must stay protected from the GC sweep"
        );
    }

    #[test]
    fn arrival_clears_the_missing_count() {
        let mut index = ContentIndex::new();
        index.want(NS_A, HASH);
        index.mark_present(HASH);
        assert!(index.is_present(&HASH));
        assert_eq!(index.missing_count(), 0);
        assert_eq!(index.tracked_count(), 1);
    }

    #[test]
    fn marking_an_unwanted_hash_present_is_ignored() {
        let mut index = ContentIndex::new();
        index.mark_present(HASH);
        assert!(
            !index.is_tracked(&HASH),
            "a stray blob must not become tracked"
        );
        assert_eq!(index.tracked_count(), 0);
    }

    #[test]
    fn re_wanting_a_present_hash_does_not_resurrect_it_as_missing() {
        let mut index = ContentIndex::new();
        index.want(NS_A, HASH);
        index.mark_present(HASH);
        // The same entry reconciles again from another peer.
        index.want(NS_A, HASH);
        assert_eq!(index.missing_count(), 0);
    }

    #[test]
    fn forgetting_the_last_reference_reports_the_blob_is_deletable() {
        let mut index = ContentIndex::new();
        index.want(NS_A, HASH);
        index.mark_present(HASH);
        assert!(index.forget(&NS_A, &HASH));
        assert!(!index.is_tracked(&HASH));
        assert_eq!(index.tracked_count(), 0);
    }

    #[test]
    fn a_hash_shared_by_two_namespaces_survives_one_prune() {
        let mut index = ContentIndex::new();
        index.want(NS_A, HASH);
        index.want(NS_B, HASH);
        index.mark_present(HASH);

        assert!(
            !index.forget(&NS_A, &HASH),
            "the blob is still referenced by NS_B and must not be deleted"
        );
        assert!(index.is_tracked(&HASH));
        assert!(
            index.is_present(&HASH),
            "presence must survive a partial prune"
        );

        assert!(index.forget(&NS_B, &HASH));
        assert!(!index.is_tracked(&HASH));
    }

    #[test]
    fn forgetting_is_idempotent_and_scoped_to_one_hash() {
        let mut index = ContentIndex::new();
        index.want(NS_A, HASH);
        index.want(NS_A, OTHER);
        assert!(index.forget(&NS_A, &HASH));
        assert!(
            index.forget(&NS_A, &HASH),
            "double prune must stay deletable"
        );
        assert!(index.is_tracked(&OTHER), "pruning one entry kept the other");
        assert_eq!(index.tracked_count(), 1);
    }
}
