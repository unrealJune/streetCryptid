//! Repeater integration tests: a persistent node against real iroh endpoints.
//!
//! These are the phase-0 claims of streetCryptid's `docs/social/REPEATERS.md`, each one a test:
//!
//! * a repeater keeps serving a trail **across its own restart**, after the phone that wrote it has
//!   gone — the property the RAM-only stash cannot have;
//! * two **sibling repeaters** converge with no phone in between, so a reader can pull from one
//!   that never saw the writer;
//! * a repeater whose grant book is unreadable **refuses to start** rather than coming back empty.
//!
//! The writer and reader here are plain iroh-docs nodes doing exactly what the phone's `docs.rs`
//! does: the writer dials out (`start_sync` with the repeater's address), and the reader imports
//! the read capability and syncs against one peer. Neither ever dials the other.

use super::*;
use std::time::Duration;

use iroh_docs::api::protocol::{AddrInfoOptions, ShareMode};

/// A fresh directory per test (no tempdir crate in the dependency tree).
fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "trail-stash-repeater-{name}-{}-{}",
        std::process::id(),
        now_ms()
    ));
    std::fs::create_dir_all(&dir).expect("create scratch dir");
    dir
}

async fn spawn_repeater(dir: &std::path::Path, seed: u8) -> Result<Arc<StashNode>> {
    StashNode::spawn_with(
        Storage::Persistent(dir.to_path_buf()),
        SecretKey::from_bytes(&[seed; 32]),
        RetentionPolicy::from_hours(48),
        &[],
        None,
        default_delivery(),
        default_waker(),
    )
    .await
}

/// Reopen a repeater's directory. The previous instance's stores close asynchronously after its
/// router shuts down, so a reopen in the same process may briefly find them still held.
async fn reopen_repeater(dir: &std::path::Path, seed: u8) -> Result<Arc<StashNode>> {
    let mut last = None;
    for _ in 0..40 {
        match spawn_repeater(dir, seed).await {
            Ok(node) => return Ok(node),
            Err(e) => last = Some(e),
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    Err(last.expect("at least one attempt"))
}

/// A phone stand-in that owns a namespace with one sealed entry keyed to its own endpoint id.
struct Phone {
    ticket: String,
    doc: Doc,
    endpoint: Endpoint,
    router: Router,
}

impl Phone {
    async fn spawn(seed: u8, payload: &[u8]) -> Result<Self> {
        let endpoint = Endpoint::builder(iroh::endpoint::presets::N0)
            .secret_key(SecretKey::from_bytes(&[seed; 32]))
            .bind()
            .await?;
        let gossip = Gossip::builder().spawn(endpoint.clone());
        let mem = MemStore::new();
        let docs = Docs::memory()
            .spawn(endpoint.clone(), (*mem).clone(), gossip.clone())
            .await?;
        let router = Router::builder(endpoint.clone())
            .accept(iroh_gossip::ALPN, gossip.clone())
            .accept(iroh_docs::ALPN, docs.clone())
            .accept(iroh_blobs::ALPN, BlobsProtocol::new(&mem, None))
            .spawn();
        let author = docs.author_default().await?;
        let doc = docs.create().await?;
        let author_hex: String = endpoint
            .id()
            .as_bytes()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        doc.set_bytes(
            author,
            format!("{author_hex}/{:020}", 1u64).into_bytes(),
            payload.to_vec(),
        )
        .await?;
        let ticket = doc
            .share(ShareMode::Read, AddrInfoOptions::RelayAndAddresses)
            .await?
            .to_string();
        Ok(Self {
            ticket,
            doc,
            endpoint,
            router,
        })
    }

    /// The phone goes away for good: nothing it held can be fetched from it after this.
    async fn vanish(self) {
        let _ = self.router.shutdown().await;
        let _ = self.endpoint.close().await;
    }
}

/// A reader that has the read capability and pulls from exactly one peer. Returns the bytes of the
/// first entry once both the record and its content have arrived.
async fn read_through(seed: u8, ticket: &str, from: iroh::EndpointAddr) -> Result<Vec<u8>> {
    let endpoint = Endpoint::builder(iroh::endpoint::presets::N0)
        .secret_key(SecretKey::from_bytes(&[seed; 32]))
        .bind()
        .await?;
    let gossip = Gossip::builder().spawn(endpoint.clone());
    let mem = MemStore::new();
    let docs = Docs::memory()
        .spawn(endpoint.clone(), (*mem).clone(), gossip.clone())
        .await?;
    let router = Router::builder(endpoint.clone())
        .accept(iroh_gossip::ALPN, gossip.clone())
        .accept(iroh_docs::ALPN, docs.clone())
        .accept(iroh_blobs::ALPN, BlobsProtocol::new(&mem, None))
        .spawn();

    let ticket: DocTicket = ticket.parse()?;
    // The capability only: the ticket's own addresses are the writer's, and the point is that the
    // reader never reaches it.
    let doc = docs.import_namespace(ticket.capability).await?;
    doc.start_sync(vec![from.clone()]).await?;

    let mut hash = None;
    for attempt in 0..300 {
        let stream = doc.get_many(Query::all().build()).await?;
        tokio::pin!(stream);
        if let Some(entry) = stream.next().await {
            hash = Some(entry?.content_hash());
            break;
        }
        // Re-dial now and then: one sync attempt can lose a race with the peer's own startup.
        if attempt % 50 == 49 {
            doc.start_sync(vec![from.clone()]).await?;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let hash = hash.ok_or_else(|| anyhow!("the reader never received the entry record"))?;

    let mut bytes = None;
    for _ in 0..300 {
        if let Ok(found) = mem.blobs().get_bytes(hash).await {
            bytes = Some(found.to_vec());
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let _ = router.shutdown().await;
    bytes.ok_or_else(|| {
        anyhow!("the reader holds the record but never got its content — 'Unable to download'")
    })
}

/// Poll until the node holds `tracked` entries and every one of them has its bytes.
async fn wait_servable(node: &StashNode, tracked: usize, what: &str) {
    for _ in 0..300 {
        if node.content_stats() == (0, tracked) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!(
        "{what}: expected {tracked} servable entries, have (missing, tracked) = {:?}",
        node.content_stats()
    );
}

#[tokio::test]
async fn a_repeater_serves_a_trail_after_restarting_with_the_writer_gone() -> Result<()> {
    let dir = scratch("restart");
    let payload = b"sealed-envelope-held-across-a-restart";

    let repeater = spawn_repeater(&dir, 51).await?;
    let phone = Phone::spawn(52, payload).await?;
    repeater.register(&phone.ticket, None).await?;
    // Production topology: the phone dials the repeater, never the other way round.
    phone.doc.start_sync(vec![repeater.endpoint_addr()]).await?;
    wait_servable(&repeater, 1, "before the restart").await;

    let ticket = phone.ticket.clone();
    phone.vanish().await;
    repeater.shutdown().await;
    drop(repeater);

    // Same directory, same identity — a laptop that rebooted. No phone grants anything again.
    let repeater = reopen_repeater(&dir, 51).await?;
    assert_eq!(
        repeater.content_stats(),
        (0, 1),
        "the restarted repeater did not adopt the entry it already held on disk"
    );

    let bytes = read_through(53, &ticket, repeater.endpoint_addr()).await?;
    assert_eq!(bytes, payload);
    repeater.shutdown().await;
    Ok(())
}

#[tokio::test]
async fn sibling_repeaters_converge_without_the_writer() -> Result<()> {
    let payload = b"sealed-envelope-carried-between-siblings";
    let first = spawn_repeater(&scratch("sibling-a"), 61).await?;
    let second = spawn_repeater(&scratch("sibling-b"), 62).await?;

    let phone = Phone::spawn(63, payload).await?;
    // Both hold the grant (in the full design the pool roster carries it); only the first was
    // awake when the phone published.
    first.register(&phone.ticket, None).await?;
    second.register(&phone.ticket, None).await?;
    phone.doc.start_sync(vec![first.endpoint_addr()]).await?;
    wait_servable(&first, 1, "the repeater the phone reached").await;

    let ticket = phone.ticket.clone();
    phone.vanish().await;

    // The second repeater comes up to date from its sibling alone.
    let mut converged = false;
    for _ in 0..30 {
        second.sync_peers(&[first.endpoint_addr()]).await;
        for _ in 0..20 {
            if second.content_stats() == (0, 1) {
                converged = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        if converged {
            break;
        }
    }
    assert!(
        converged,
        "the second repeater never got the entry and its content from its sibling: {:?}",
        second.content_stats()
    );

    // A reader that only ever talks to the repeater that never saw the phone.
    let bytes = read_through(64, &ticket, second.endpoint_addr()).await?;
    assert_eq!(bytes, payload);
    first.shutdown().await;
    second.shutdown().await;
    Ok(())
}

#[tokio::test]
async fn a_repeater_with_an_unreadable_book_refuses_to_start() {
    let dir = scratch("corrupt-book");
    std::fs::write(dir.join("namespaces.json"), b"{ torn").unwrap();
    assert!(
        spawn_repeater(&dir, 71).await.is_err(),
        "starting over would silently drop every grant the repeater acknowledged"
    );
}
