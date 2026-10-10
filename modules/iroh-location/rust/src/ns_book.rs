//! The docs namespaces a node must reopen on every start, kept where a cache purge cannot reach.
//!
//! # Why this exists
//!
//! Every namespace a node reads or writes used to be held only in memory. `TrailDocs` and
//! `ProfileDocs` knew their OWN namespace from a 32-byte id file next to the replica, and knew a
//! friend's namespace only because JS called `importDocTicket` / `importProfileTicket` on that run.
//! Two things followed, and on 2026-10-05 a Pixel 10 hit both at 16:26:
//!
//! * **A node started without JS had no friends.** The native background runtime builds and starts
//!   the node itself, nothing imported a friend ticket into it, and `sync_all` reconciled our own
//!   namespace and nobody else's. The phone published on time and received nothing — including the
//!   restart its leader sent at 17:38, so the pair stayed broken until it was re-paired at 00:37.
//! * **A failed open minted a new identity.** `Docs::open` reports a missing namespace as an
//!   `Err`, the same as any other failure, and `init` answered every `Err` by creating a namespace
//!   and overwriting the id file. Every friend kept the old read ticket and read a namespace nobody
//!   wrote again. Nothing tells friends about a new one, so only a re-pair recovers.
//!
//! The replica lives in the cache directory on Android (`cacheDir`) because it is large and
//! re-fetchable, and it is — but only if the node still knows WHICH namespaces to fetch, and holds
//! the secret that makes its own one writable. That is this file, in `state_dir`.
//!
//! # What it holds
//!
//! * The node's own namespace **secret**, so a wiped replica comes back as the SAME namespace:
//!   friends' tickets stay valid, and a stash that re-registers it refills it.
//! * Each imported friend namespace with the read ticket it came from. The ticket is what the stash
//!   grant sends (`stash::register`), so a node with no JS can re-grant after a stash restart.
//!
//! The secret is the namespace's write capability. It grants no read access to anything (envelopes
//! are sealed to recipients), and the replica in `data_dir` already holds the same secret, so
//! keeping it in `state_dir` too adds no exposure: both are app-private, and `state_dir` is the one
//! excluded from backup.
//!
//! Self-contained (std, serde, postcard, iroh-docs) because the wasm crate includes `docs.rs` by
//! path and therefore this file with it. The web build passes no book and keeps its in-memory store.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{anyhow, Result};
use iroh_docs::{
    api::protocol::{AddrInfoOptions, ShareMode},
    api::Doc,
    protocol::Docs,
    Capability, NamespaceId, NamespaceSecret,
};
use n0_future::StreamExt;
use serde::{Deserialize, Serialize};

/// The trail store's book.
pub const TRAIL_BOOK_FILE: &str = "trail-namespaces.bin";
/// The profile store's book.
pub const PROFILE_BOOK_FILE: &str = "profile-namespaces.bin";

const BOOK_V: u8 = 1;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
struct BookState {
    v: u8,
    own_secret: Option<[u8; 32]>,
    friends: Vec<FriendNamespace>,
}

/// An imported friend namespace and the read ticket it was imported from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FriendNamespace {
    pub namespace: [u8; 32],
    pub ticket: String,
}

#[derive(Debug)]
pub struct NamespaceBook {
    path: PathBuf,
    state: Mutex<BookState>,
}

impl NamespaceBook {
    /// Open (or start) the book at `dir/file`. An unreadable book is an error, not an empty one:
    /// treating it as empty would mint a new own namespace, which is the failure this exists for.
    pub fn open(dir: &Path, file: &str) -> Result<Self> {
        std::fs::create_dir_all(dir)?;
        let path = dir.join(file);
        let state = match std::fs::read(&path) {
            Ok(raw) => {
                let state: BookState = postcard::from_bytes(&raw)
                    .map_err(|e| anyhow!("namespace book {}: {e}", path.display()))?;
                if state.v != BOOK_V {
                    return Err(anyhow!(
                        "namespace book {}: version {}",
                        path.display(),
                        state.v
                    ));
                }
                state
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => BookState {
                v: BOOK_V,
                ..BookState::default()
            },
            Err(e) => return Err(e.into()),
        };
        Ok(Self {
            path,
            state: Mutex::new(state),
        })
    }

    pub fn own_secret(&self) -> Option<[u8; 32]> {
        self.lock().own_secret
    }

    /// Record our own namespace secret. Persisted before the namespace is used, so there is no
    /// window in which it exists only in the replica.
    pub fn set_own_secret(&self, secret: [u8; 32]) -> Result<()> {
        let mut state = self.lock();
        let mut next = state.clone();
        next.own_secret = Some(secret);
        self.save(&next)?;
        *state = next;
        Ok(())
    }

    pub fn friends(&self) -> Vec<FriendNamespace> {
        self.lock().friends.clone()
    }

    /// Remember an imported friend namespace, replacing any older ticket for the same namespace
    /// (a newer one carries fresher addresses). Returns whether the book changed.
    pub fn add_friend(&self, namespace: [u8; 32], ticket: &str) -> Result<bool> {
        let mut state = self.lock();
        if state
            .friends
            .iter()
            .any(|f| f.namespace == namespace && f.ticket == ticket)
        {
            return Ok(false);
        }
        let mut next = state.clone();
        next.friends.retain(|f| f.namespace != namespace);
        next.friends.push(FriendNamespace {
            namespace,
            ticket: ticket.to_owned(),
        });
        self.save(&next)?;
        *state = next;
        Ok(true)
    }

    /// Forget a friend namespace. Returns whether it was there.
    pub fn remove_friend(&self, namespace: [u8; 32]) -> Result<bool> {
        let mut state = self.lock();
        if !state.friends.iter().any(|f| f.namespace == namespace) {
            return Ok(false);
        }
        let mut next = state.clone();
        next.friends.retain(|f| f.namespace != namespace);
        self.save(&next)?;
        *state = next;
        Ok(true)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, BookState> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Write-to-temp, fsync, rename: a torn book would be unreadable, and an unreadable book
    /// refuses to start the node rather than mint a namespace.
    fn save(&self, state: &BookState) -> Result<()> {
        use std::io::Write;
        let bytes = postcard::to_allocvec(state)?;
        let tmp = self.path.with_extension("tmp");
        {
            let mut file = std::fs::File::create(&tmp)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
        }
        std::fs::rename(&tmp, &self.path)?;
        Ok(())
    }
}

/// Open our own namespace, never minting one over a namespace that merely failed to open.
///
/// In order:
/// 1. The book has our secret: import it. `import_namespace` is idempotent, so this both reopens a
///    replica that is there and recreates the SAME namespace in one that was wiped.
/// 2. An older build left only the id file (`legacy_id`): open it and copy its secret into the
///    book. If the open fails, mint only when the store demonstrably does not list it — the store
///    was wiped before any build saved the secret, and nothing can recover that namespace. Any
///    other failure fails the start; the caller retries, and nothing is overwritten.
/// 3. A fresh install: mint, saving the secret to the book before the namespace exists.
///
/// The id file is still written, so a downgrade to an older binary finds the same namespace.
pub async fn open_own_namespace(
    docs: &Docs,
    book: &NamespaceBook,
    legacy_id: Option<[u8; 32]>,
) -> Result<Doc> {
    if let Some(secret) = book.own_secret() {
        let secret = NamespaceSecret::from_bytes(&secret);
        return docs.import_namespace(Capability::Write(secret)).await;
    }
    if let Some(id) = legacy_id {
        let ns = NamespaceId::from(id);
        match docs.open(ns).await {
            Ok(Some(doc)) => {
                let secret = write_secret(&doc).await?;
                book.set_own_secret(secret.to_bytes())?;
                return Ok(doc);
            }
            Ok(None) => {}
            Err(err) => {
                if is_listed(docs, ns).await? {
                    return Err(err.context("own namespace is in the store but failed to open"));
                }
            }
        }
        tracing::warn!(
            sc.namespace = %short(&id),
            "own namespace is gone from the replica and no secret was saved; minting a new one"
        );
    }
    mint(docs, book).await
}

/// Reopen every friend namespace the book lists. `Capability::Read` is enough to rebuild an empty
/// replica after a wipe, and the next sync refills it. One that fails is logged and skipped:
/// a single bad entry must not keep the rest unreachable, which is the failure being fixed.
pub async fn reopen_friends(docs: &Docs, book: &NamespaceBook) -> Vec<Doc> {
    let mut out = Vec::new();
    for friend in book.friends() {
        let ns = NamespaceId::from(friend.namespace);
        match docs.import_namespace(Capability::Read(ns)).await {
            Ok(doc) => out.push(doc),
            Err(err) => tracing::warn!(
                sc.namespace = %short(&friend.namespace),
                error = %err,
                "could not reopen a friend namespace"
            ),
        }
    }
    out
}

/// The namespace id a docs ticket names.
pub fn ticket_namespace(ticket: &str) -> Result<[u8; 32]> {
    let ticket: iroh_docs::DocTicket = ticket.parse().map_err(|e| anyhow!("{e}"))?;
    Ok(ticket.capability.id().to_bytes())
}

async fn mint(docs: &Docs, book: &NamespaceBook) -> Result<Doc> {
    let mut bytes = [0u8; 32];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut bytes);
    book.set_own_secret(bytes)?;
    docs.import_namespace(Capability::Write(NamespaceSecret::from_bytes(&bytes)))
        .await
}

async fn write_secret(doc: &Doc) -> Result<NamespaceSecret> {
    let ticket = doc.share(ShareMode::Write, AddrInfoOptions::Id).await?;
    match ticket.capability {
        Capability::Write(secret) => Ok(secret),
        Capability::Read(_) => Err(anyhow!("own namespace is read-only in this replica")),
    }
}

async fn is_listed(docs: &Docs, ns: NamespaceId) -> Result<bool> {
    let mut stream = docs.list().await?;
    while let Some(item) = stream.next().await {
        if item?.0 == ns {
            return Ok(true);
        }
    }
    Ok(false)
}

fn short(bytes: &[u8]) -> String {
    bytes.iter().take(5).map(|b| format!("{b:02x}")).collect()
}
