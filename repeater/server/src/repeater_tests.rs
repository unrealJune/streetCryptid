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
//! And the phase-1 claims, over the real `streetcryptid/repeater/1` protocol:
//!
//! * a repeater is claimed only by the phone holding its console secret, which must also be the
//!   roster's owner, and it attests exactly that owner and roster in a cert it signs;
//! * only a carried member can have a namespace carried, and only a namespace they own (its own
//!   key signs the grant); removing the member releases it;
//! * sibling repeaters converge on the roster with no phone in between;
//! * two repeaters in *different* people's rosters that carry one trail converge on it with each
//!   other, through plain iroh-docs sync, while the phone that writes it is gone.
//!
//! The writer and reader here are plain iroh-docs nodes doing exactly what the phone's `docs.rs`
//! does: the writer dials out (`start_sync` with the repeater's address), and the reader imports
//! the read capability and syncs against one peer. Neither ever dials the other.

use super::*;
use std::time::Duration;

use ed25519_dalek::SigningKey;
use iroh_docs::api::protocol::{AddrInfoOptions, ShareMode};

use crate::repeater::call;
use streetcryptid_repeater::roster::{Action, OpBody, Policy, Roster, SignedOp};
use streetcryptid_repeater::wire::{sign_grant, Refusal, Request, Response};

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
    spawn_stored(Storage::MemoryRepeater(dir.to_path_buf()), seed).await
}

async fn spawn_stored(storage: Storage, seed: u8) -> Result<Arc<StashNode>> {
    StashNode::spawn_with(
        storage,
        SecretKey::from_bytes(&[seed; 32]),
        RetentionPolicy::from_hours(48),
        &[],
        None,
        default_delivery(),
        default_waker(),
    )
    .await
}

#[tokio::test]
async fn desktop_activity_requires_new_fix_content() -> Result<()> {
    StashNode::test_activity_transitions().await
}

#[tokio::test]
async fn desktop_activity_requires_admission_even_when_content_is_already_present() -> Result<()> {
    struct RejectTagged;
    impl DeliveryService for RejectTagged {
        fn admit(&self, envelope: &EnvelopeRef<'_>) -> Admission {
            if envelope.bytes == b"rejected-ciphertext" {
                Admission::Reject("test rejection".into())
            } else {
                Admission::Accept
            }
        }
    }

    struct CountWakes(std::sync::atomic::AtomicUsize);
    impl Waker for CountWakes {
        fn wake(&self, _ns: &NsBytes, _targets: &[PushSubscription]) {
            self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
    }

    let wakes = Arc::new(CountWakes(std::sync::atomic::AtomicUsize::new(0)));
    let node = StashNode::spawn(
        SecretKey::from_bytes(&[181; 32]),
        RetentionPolicy::from_hours(48),
        &[],
        None,
        Arc::new(RejectTagged),
        wakes.clone(),
    )
    .await?;
    let phone = Phone::spawn(182, b"rejected-ciphertext").await?;
    let _rejected = node
        .blobs
        .blobs()
        .add_bytes(Bytes::from_static(b"rejected-ciphertext"))
        .await?;
    node.register(
        &phone.ticket,
        Some(PushSubscription {
            platform: crate::subscriptions::Platform::Fcm,
            token: "test".into(),
        }),
    )
    .await?;
    let mut arrivals = node.subscribe_arrivals();
    phone.doc.start_sync(vec![node.endpoint_addr()]).await?;
    wait_servable(&node, 1, "rejected cached content").await;
    assert!(
        tokio::time::timeout(Duration::from_millis(500), arrivals.recv())
            .await
            .is_err()
    );
    assert_eq!(wakes.0.load(std::sync::atomic::Ordering::SeqCst), 0);

    let _accepted = node
        .blobs
        .blobs()
        .add_bytes(Bytes::from_static(b"accepted-ciphertext"))
        .await?;
    phone.write_fix(b"accepted-ciphertext").await?;
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), arrivals.recv()).await??,
        1
    );
    tokio::time::timeout(Duration::from_secs(5), async {
        while wakes.0.load(std::sync::atomic::Ordering::SeqCst) != 1 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await?;
    phone.vanish().await;
    node.shutdown().await;
    Ok(())
}

#[tokio::test]
async fn desktop_repeater_keeps_its_roster_and_grants_but_never_content_across_restart(
) -> Result<()> {
    let dir = scratch("desktop-memory");
    let node = spawn_repeater(&dir, 151).await?;
    let (owner, mut roster) = claim(&node, 152, None, Policy::Open).await?;
    let phone = Phone::spawn(153, b"desktop-memory-ciphertext").await?;
    let member = *phone.endpoint.id().as_bytes();
    let enroll = sign_onto(&mut roster, 153, Action::Enroll { invite: None });
    call(
        &phone.endpoint,
        node.endpoint_addr(),
        &Request::Publish { ops: vec![enroll] },
    )
    .await?;
    let granted = call(
        &phone.endpoint,
        node.endpoint_addr(),
        &Request::Grant {
            ticket: phone.ticket.clone(),
            proof: sign_grant(
                &phone.ns_secret,
                node.endpoint_addr().id.as_bytes(),
                &member,
            ),
            carriers: vec![],
        },
    )
    .await?;
    let Response::Granted { namespace } = granted else {
        return Err(anyhow!("expected a grant"));
    };
    let mut arrivals = node.subscribe_arrivals();
    phone.doc.start_sync(vec![node.endpoint_addr()]).await?;
    wait_servable(&node, 1, "desktop memory content").await;
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), arrivals.recv()).await??,
        1
    );
    phone.doc.start_sync(vec![node.endpoint_addr()]).await?;
    assert!(
        tokio::time::timeout(Duration::from_millis(750), arrivals.recv())
            .await
            .is_err()
    );
    assert_eq!(
        read_through(154, &phone.ticket, node.endpoint_addr()).await?,
        b"desktop-memory-ciphertext"
    );
    phone
        .doc
        .set_bytes(
            phone.author,
            b"control/shared".to_vec(),
            b"desktop-memory-ciphertext".to_vec(),
        )
        .await?;
    phone.write_fix(b"second-ciphertext").await?;
    wait_servable(&node, 2, "the replacement and shared content").await;
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), arrivals.recv()).await??,
        2
    );
    assert_eq!(
        node.prune_once(now_ms()).await?,
        0,
        "a control entry still references the first ciphertext"
    );
    phone.write_fix(b"third-ciphertext").await?;
    wait_servable(&node, 3, "the next replacement").await;
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), arrivals.recv()).await??,
        3
    );
    assert_eq!(
        node.prune_once(now_ms()).await?,
        1,
        "the overwritten second ciphertext must no longer be protected"
    );
    assert_eq!(node.content_stats(), (0, 2));
    assert!(
        tokio::time::timeout(Duration::from_millis(750), arrivals.recv())
            .await
            .is_err(),
        "a control entry and repeated sync must not create fix activity"
    );
    assert!(
        !dir.join("docs").exists(),
        "a repeater keeps no replica on disk"
    );
    assert!(
        !dir.join("blobs").exists(),
        "a repeater keeps no ciphertext on disk"
    );
    node.shutdown().await;
    drop(node);
    // The same repeater comes back — claimed, carrying the same namespace — holding nothing.
    let reopened = reopen_repeater(&dir, 151).await?;
    assert!(reopened.repeater().unwrap().claim_secret().is_none());
    assert!(reopened.handle(namespace).await.is_some());
    assert_eq!(reopened.content_stats(), (0, 0));
    // Until the writer syncs again, and then without a second grant.
    let mut arrivals = reopened.subscribe_arrivals();
    phone.doc.start_sync(vec![reopened.endpoint_addr()]).await?;
    wait_servable(
        &reopened,
        2,
        "the writer's newest fix and control entry after the restart",
    )
    .await;
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), arrivals.recv()).await??,
        1
    );
    phone.vanish().await;
    let remove = sign_onto(&mut roster, 152, Action::Remove { member });
    call(
        &owner,
        reopened.endpoint_addr(),
        &Request::Publish { ops: vec![remove] },
    )
    .await?;
    assert!(reopened.handle(namespace).await.is_none());
    assert_eq!(reopened.content_stats(), (0, 0));
    owner.close().await;
    reopened.shutdown().await;
    let _ = std::fs::remove_dir_all(&dir);
    Ok(())
}

#[tokio::test]
async fn desktop_fix_activity_is_not_hidden_by_a_control_entry_with_the_same_bytes() -> Result<()> {
    let dir = scratch("desktop-shared-activity");
    let node = spawn_repeater(&dir, 171).await?;
    let (owner, mut roster) = claim(&node, 172, None, Policy::Open).await?;
    let phone = Phone::spawn(173, b"first-fix").await?;
    let member = *phone.endpoint.id().as_bytes();
    let enroll = sign_onto(&mut roster, 173, Action::Enroll { invite: None });
    call(
        &phone.endpoint,
        node.endpoint_addr(),
        &Request::Publish { ops: vec![enroll] },
    )
    .await?;
    call(
        &phone.endpoint,
        node.endpoint_addr(),
        &Request::Grant {
            ticket: phone.ticket.clone(),
            proof: sign_grant(
                &phone.ns_secret,
                node.endpoint_addr().id.as_bytes(),
                &member,
            ),
            carriers: vec![],
        },
    )
    .await?;
    phone
        .doc
        .set_bytes(phone.author, b"control/shared".to_vec(), b"shared".to_vec())
        .await?;
    let mut arrivals = node.subscribe_arrivals();
    phone.doc.start_sync(vec![node.endpoint_addr()]).await?;
    wait_servable(&node, 2, "initial fix and shared control").await;
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), arrivals.recv()).await??,
        1
    );

    phone.write_fix(b"shared").await?;
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), arrivals.recv()).await??,
        2,
        "a new fix still pings when its content hash was first seen on a control key"
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(750), arrivals.recv())
            .await
            .is_err()
    );
    phone.vanish().await;
    owner.close().await;
    node.shutdown().await;
    let _ = std::fs::remove_dir_all(&dir);
    Ok(())
}

/// Reopen a repeater's directory. The previous instance's stores close asynchronously after its
/// router shuts down, so a reopen in the same process may briefly find them still held.
async fn reopen_repeater(dir: &std::path::Path, seed: u8) -> Result<Arc<StashNode>> {
    reopen(Storage::MemoryRepeater(dir.to_path_buf()), seed).await
}

async fn reopen(storage: Storage, seed: u8) -> Result<Arc<StashNode>> {
    let mut last = None;
    for _ in 0..40 {
        match spawn_stored(storage.clone(), seed).await {
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
    author: iroh_docs::AuthorId,
    fix_key: Vec<u8>,
    endpoint: Endpoint,
    router: Router,
    /// The namespace's write key — what proves this phone owns the trail it grants.
    ns_secret: SigningKey,
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
        let fix_key = format!("{author_hex}/fix").into_bytes();
        doc.set_bytes(author, fix_key.clone(), payload.to_vec())
            .await?;
        let ticket = doc
            .share(ShareMode::Read, AddrInfoOptions::RelayAndAddresses)
            .await?
            .to_string();
        let write = doc
            .share(ShareMode::Write, AddrInfoOptions::RelayAndAddresses)
            .await?;
        let ns_secret = match write.capability {
            iroh_docs::Capability::Write(secret) => SigningKey::from_bytes(&secret.to_bytes()),
            iroh_docs::Capability::Read(_) => return Err(anyhow!("a write share without the key")),
        };
        Ok(Self {
            ticket,
            doc,
            author,
            fix_key,
            endpoint,
            router,
            ns_secret,
        })
    }

    async fn write_fix(&self, payload: &[u8]) -> Result<()> {
        self.doc
            .set_bytes(self.author, self.fix_key.clone(), payload.to_vec())
            .await?;
        Ok(())
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

#[tokio::test]
async fn desktop_multiple_writers_forward_to_multiple_readers_after_all_writers_go_offline(
) -> Result<()> {
    let dir = scratch("desktop-multi-offline");
    let node = spawn_repeater(&dir, 201).await?;
    let (owner, mut roster) = claim(&node, 202, None, Policy::Open).await?;
    let mut tickets = Vec::new();
    let mut phones = Vec::new();
    for seed in 203..206 {
        let payload = vec![seed; 8192];
        let phone = Phone::spawn(seed, &payload).await?;
        enrol_and_grant(&node, &mut roster, &phone, seed, vec![]).await?;
        tickets.push((phone.ticket.clone(), payload));
        phone.doc.start_sync(vec![node.endpoint_addr()]).await?;
        phones.push(phone);
    }
    wait_servable(&node, 3, "three concurrent senders").await;
    assert_eq!(node.arrival_count(), 3);
    // The source endpoints are actually closed, not just omitted from the readers' ticket.
    for phone in phones {
        phone.vanish().await;
    }
    owner.close().await;
    let before = node.endpoint().metrics().socket.send_ipv4.get()
        + node.endpoint().metrics().socket.send_ipv6.get()
        + node.endpoint().metrics().socket.send_relay.get();
    for (index, (ticket, payload)) in tickets.iter().enumerate() {
        let (first, second) = tokio::join!(
            read_through(210 + index as u8 * 2, ticket, node.endpoint_addr()),
            read_through(211 + index as u8 * 2, ticket, node.endpoint_addr())
        );
        assert_eq!(&first?, payload);
        assert_eq!(&second?, payload);
    }
    let after = node.endpoint().metrics().socket.send_ipv4.get()
        + node.endpoint().metrics().socket.send_ipv6.get()
        + node.endpoint().metrics().socket.send_relay.get();
    assert!(
        after > before,
        "serving cached content must count outbound traffic"
    );
    node.shutdown().await;
    let _ = std::fs::remove_dir_all(dir);
    Ok(())
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
async fn a_persistent_node_serves_a_trail_after_restarting_with_the_writer_gone() -> Result<()> {
    // Repeaters keep content in RAM now; `Storage::Persistent` still promises this.
    let dir = scratch("restart");
    let payload = b"sealed-envelope-held-across-a-restart";

    let repeater = spawn_stored(Storage::Persistent(dir.clone()), 51).await?;
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
    let repeater = reopen(Storage::Persistent(dir.clone()), 51).await?;
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

// ---- phase 1: claim, roster, grants ---------------------------------------------------------

/// A phone's signing key: the same seed as its endpoint, so its endpoint id is its roster identity.
fn signer(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}

async fn bare_endpoint(seed: u8) -> Result<Endpoint> {
    Ok(Endpoint::builder(iroh::endpoint::presets::N0)
        .secret_key(SecretKey::from_bytes(&[seed; 32]))
        .bind()
        .await?)
}

fn genesis(owner: u8, policy: Policy) -> SignedOp {
    SignedOp::sign(
        &signer(owner),
        &OpBody {
            roster: None,
            parents: vec![],
            ts_ms: now_ms(),
            action: Action::Genesis {
                owner: signer(owner).verifying_key().to_bytes(),
                policy,
                nonce: [owner; 16],
            },
        },
    )
}

/// Sign an op on the heads of the caller's copy of the roster, and add it to that copy.
fn sign_onto(roster: &mut Roster, seed: u8, action: Action) -> SignedOp {
    let op = SignedOp::sign(
        &signer(seed),
        &OpBody {
            roster: Some(roster.id()),
            parents: roster.heads(),
            ts_ms: now_ms(),
            action,
        },
    );
    roster
        .insert(op.clone())
        .expect("the caller's own op is valid");
    op
}

fn id_of(seed: u8) -> [u8; 32] {
    signer(seed).verifying_key().to_bytes()
}

/// Claim a fresh repeater for `owner` and list it in the roster. Returns the owner's endpoint and
/// the owner's copy of the roster.
async fn claim(
    node: &StashNode,
    owner: u8,
    roster: Option<Roster>,
    policy: Policy,
) -> Result<(Endpoint, Roster)> {
    let endpoint = bare_endpoint(owner).await?;
    let mut roster = match roster {
        Some(roster) => roster,
        None => Roster::from_genesis(genesis(owner, policy))?,
    };
    let secret = node
        .repeater()
        .expect("persistent")
        .claim_secret()
        .expect("unclaimed");
    let cert = match call(
        &endpoint,
        node.endpoint_addr(),
        &Request::Claim {
            secret,
            ops: roster.export(),
        },
    )
    .await?
    {
        Response::Claimed { cert } => cert,
        other => return Err(anyhow!("claim refused: {other:?}")),
    };
    let add = sign_onto(&mut roster, owner, Action::AddRepeater { cert });
    let published = call(
        &endpoint,
        node.endpoint_addr(),
        &Request::Publish { ops: vec![add] },
    )
    .await?;
    assert!(
        matches!(published, Response::Published { accepted: 1, .. }),
        "{published:?}"
    );
    Ok((endpoint, roster))
}

fn refused(response: &Response) -> Option<&Refusal> {
    match response {
        Response::Refused { reason } => Some(reason),
        _ => None,
    }
}

#[tokio::test]
async fn a_repeater_is_claimed_by_the_phone_at_its_console_and_attests_it() -> Result<()> {
    let dir = scratch("claim");
    let node = spawn_repeater(&dir, 81).await?;
    let repeater = node.repeater().expect("persistent").clone();
    let owner = bare_endpoint(82).await?;
    let ops = vec![genesis(82, Policy::Open)];

    // A wrong secret is refused, and does not spend the real one.
    let secret = repeater.claim_secret().expect("unclaimed");
    let wrong = call(
        &owner,
        node.endpoint_addr(),
        &Request::Claim {
            secret: [0; 32],
            ops: ops.clone(),
        },
    )
    .await?;
    assert_eq!(refused(&wrong), Some(&Refusal::BadClaimSecret));
    assert_eq!(repeater.claim_secret(), Some(secret));

    // The right secret from a phone that is not the roster's owner is refused — and the secret
    // is spent, so a leaked console code cannot be retried.
    let impostor = bare_endpoint(83).await?;
    let stolen = call(
        &impostor,
        node.endpoint_addr(),
        &Request::Claim {
            secret,
            ops: ops.clone(),
        },
    )
    .await?;
    assert_eq!(refused(&stolen), Some(&Refusal::BadClaimRoster));
    let fresh = repeater.claim_secret().expect("still unclaimed");
    assert_ne!(fresh, secret, "a refused claim spends the secret");

    // The owner, with the fresh secret.
    let claimed = call(
        &owner,
        node.endpoint_addr(),
        &Request::Claim {
            secret: fresh,
            ops: ops.clone(),
        },
    )
    .await?;
    let Response::Claimed { cert } = claimed else {
        return Err(anyhow!("owner's claim refused: {claimed:?}"));
    };
    let attested = cert.verify()?;
    assert_eq!(attested.repeater, *node.endpoint_addr().id.as_bytes());
    assert_eq!(attested.owner, id_of(82));
    assert_eq!(attested.roster, ops[0].id());
    assert_eq!(
        repeater.claim_secret(),
        None,
        "a claimed repeater offers no code"
    );

    // Nobody claims it again, secret or not.
    let again = call(
        &impostor,
        node.endpoint_addr(),
        &Request::Claim {
            secret: fresh,
            ops: vec![genesis(83, Policy::Open)],
        },
    )
    .await?;
    assert_eq!(refused(&again), Some(&Refusal::AlreadyClaimed));

    // The owner lists it; the owner can read the roster back, a stranger cannot.
    let mut roster = Roster::from_ops(ops)?;
    let add = sign_onto(&mut roster, 82, Action::AddRepeater { cert });
    call(
        &owner,
        node.endpoint_addr(),
        &Request::Publish { ops: vec![add] },
    )
    .await?;
    let Response::Roster { ops } = call(&owner, node.endpoint_addr(), &Request::Fetch).await?
    else {
        return Err(anyhow!("owner could not fetch the roster"));
    };
    let state = Roster::from_ops(ops)?.state();
    assert!(state
        .repeaters
        .contains_key(node.endpoint_addr().id.as_bytes()));
    let stranger = call(&impostor, node.endpoint_addr(), &Request::Fetch).await?;
    assert_eq!(refused(&stranger), Some(&Refusal::NotCarried));

    // The claim survives a restart.
    node.shutdown().await;
    drop(node);
    drop(repeater);
    let node = reopen_repeater(&dir, 81).await?;
    let state = node
        .repeater()
        .expect("persistent")
        .roster_state()
        .expect("still claimed after a restart");
    assert_eq!(state.owner, id_of(82));
    assert!(state
        .repeaters
        .contains_key(node.endpoint_addr().id.as_bytes()));
    node.shutdown().await;
    Ok(())
}

#[tokio::test]
async fn only_a_carried_member_can_have_their_own_namespace_carried() -> Result<()> {
    let node = spawn_repeater(&scratch("grant"), 91).await?;
    let (owner, mut roster) = claim(&node, 92, None, Policy::Open).await?;
    let repeater_id = *node.endpoint_addr().id.as_bytes();

    let payload = b"sealed-envelope-of-a-carried-member";
    let phone = Phone::spawn(93, payload).await?;
    let member = *phone.endpoint.id().as_bytes();
    let proof = sign_grant(&phone.ns_secret, &repeater_id, &member);
    let grant = Request::Grant {
        ticket: phone.ticket.clone(),
        proof: proof.clone(),
        carriers: vec![],
    };

    // Not enrolled yet.
    let early = call(&phone.endpoint, node.endpoint_addr(), &grant).await?;
    assert_eq!(refused(&early), Some(&Refusal::NotCarried));

    // Enrol (signed by the phone itself), on the heads the owner's card would name.
    let enroll = sign_onto(&mut roster, 93, Action::Enroll { invite: None });
    call(
        &phone.endpoint,
        node.endpoint_addr(),
        &Request::Publish { ops: vec![enroll] },
    )
    .await?;

    // A proof by any key but the namespace's own is refused: a friend holding this read ticket
    // cannot volunteer it.
    let forged = sign_grant(&signer(94), &repeater_id, &member);
    let bad = call(
        &phone.endpoint,
        node.endpoint_addr(),
        &Request::Grant {
            ticket: phone.ticket.clone(),
            proof: forged,
            carriers: vec![],
        },
    )
    .await?;
    assert_eq!(refused(&bad), Some(&Refusal::BadProof));

    // The real proof.
    let granted = call(&phone.endpoint, node.endpoint_addr(), &grant).await?;
    let Response::Granted { namespace } = granted else {
        return Err(anyhow!("grant refused: {granted:?}"));
    };
    assert_eq!(namespace, ticket_namespace(&phone.ticket)?);

    // Carried for real: the phone pushes, the repeater holds the content and says so.
    phone.doc.start_sync(vec![node.endpoint_addr()]).await?;
    wait_servable(&node, 1, "the granted namespace").await;
    let doc = node.handle(namespace).await.expect("carried");
    let stream = doc.get_many(Query::all().build()).await?;
    tokio::pin!(stream);
    let hash = *stream
        .next()
        .await
        .expect("an entry")?
        .content_hash()
        .as_bytes();
    let have = call(
        &phone.endpoint,
        node.endpoint_addr(),
        &Request::Have {
            hashes: vec![hash, [0; 32]],
        },
    )
    .await?;
    assert_eq!(
        have,
        Response::Have {
            present: vec![true, false]
        }
    );

    // The owner removes the member: the repeater stops carrying their namespace.
    let remove = sign_onto(&mut roster, 92, Action::Remove { member });
    call(
        &owner,
        node.endpoint_addr(),
        &Request::Publish { ops: vec![remove] },
    )
    .await?;
    assert!(node.handle(namespace).await.is_none(), "still carried");
    assert_eq!(node.content_stats(), (0, 0));
    assert!(node
        .book
        .as_ref()
        .expect("persistent")
        .lock()
        .unwrap()
        .get(&full_hex(&namespace))
        .is_none());
    let after = call(&phone.endpoint, node.endpoint_addr(), &grant).await?;
    assert_eq!(refused(&after), Some(&Refusal::NotCarried));

    phone.vanish().await;
    node.shutdown().await;
    Ok(())
}

#[tokio::test]
async fn a_repeater_its_owner_removed_stops_carrying_and_a_re_add_brings_it_back() -> Result<()> {
    let node = spawn_repeater(&scratch("removed"), 121).await?;
    let (owner, mut roster) = claim(&node, 122, None, Policy::Open).await?;
    let repeater = node.repeater().expect("persistent").clone();
    let repeater_id = *node.endpoint_addr().id.as_bytes();
    let phone = Phone::spawn(123, b"sealed-envelope-on-a-removed-repeater").await?;
    enrol_and_grant(&node, &mut roster, &phone, 123, vec![]).await?;
    let namespace = ticket_namespace(&phone.ticket)?;
    assert!(node.handle(namespace).await.is_some());
    assert!(!repeater.is_removed());

    // The owner removes the machine. The member is still carried by the roster, but not here.
    let cert_op = roster
        .export()
        .into_iter()
        .find(|op| {
            matches!(
                op.verify().map(|b| b.action),
                Ok(Action::AddRepeater { .. })
            )
        })
        .expect("listed");
    let Ok(Action::AddRepeater { cert }) = cert_op.verify().map(|b| b.action) else {
        unreachable!()
    };
    let remove = sign_onto(
        &mut roster,
        122,
        Action::RemoveRepeater {
            repeater: repeater_id,
        },
    );
    call(
        &owner,
        node.endpoint_addr(),
        &Request::Publish { ops: vec![remove] },
    )
    .await?;
    assert!(repeater.is_removed());
    assert!(node.handle(namespace).await.is_none(), "still carried");
    assert!(repeater.siblings().is_empty());
    let grant = Request::Grant {
        ticket: phone.ticket.clone(),
        proof: sign_grant(
            &phone.ns_secret,
            &repeater_id,
            phone.endpoint.id().as_bytes(),
        ),
        carriers: vec![],
    };
    let refused_grant = call(&phone.endpoint, node.endpoint_addr(), &grant).await?;
    assert_eq!(refused(&refused_grant), Some(&Refusal::NotCarried));

    // The owner lists it again (an AddRepeater that has seen the removal): it carries again.
    let readd = sign_onto(&mut roster, 122, Action::AddRepeater { cert });
    call(
        &owner,
        node.endpoint_addr(),
        &Request::Publish { ops: vec![readd] },
    )
    .await?;
    assert!(!repeater.is_removed());
    let granted = call(&phone.endpoint, node.endpoint_addr(), &grant).await?;
    assert!(matches!(granted, Response::Granted { .. }), "{granted:?}");

    phone.vanish().await;
    node.shutdown().await;
    Ok(())
}

#[tokio::test]
async fn sibling_repeaters_share_the_roster() -> Result<()> {
    let first = spawn_repeater(&scratch("roster-a"), 101).await?;
    let second = spawn_repeater(&scratch("roster-b"), 102).await?;
    let (owner, roster) = claim(&first, 103, None, Policy::Open).await?;
    // The second repeater joins the same roster: the owner claims it with the roster so far, then
    // lists it — on the first repeater only.
    let (_, mut roster) = claim(&second, 103, Some(roster), Policy::Open).await?;
    let ops = roster.export();
    call(&owner, first.endpoint_addr(), &Request::Publish { ops }).await?;

    // A member enrols through the first repeater alone.
    let member = bare_endpoint(104).await?;
    let enroll = sign_onto(&mut roster, 104, Action::Enroll { invite: None });
    call(
        &member,
        first.endpoint_addr(),
        &Request::Publish { ops: vec![enroll] },
    )
    .await?;
    let carried = |node: &StashNode| {
        node.repeater()
            .expect("persistent")
            .roster_state()
            .is_some_and(|state| state.carried.contains(&id_of(104)))
    };
    assert!(carried(&first));
    assert!(!carried(&second));

    // The second catches up from its sibling, with no phone involved.
    let second_repeater = second.repeater().expect("persistent").clone();
    assert!(
        second_repeater
            .sync_roster_with(second.endpoint(), first.endpoint_addr())
            .await
    );
    assert!(carried(&second));
    assert_eq!(
        second_repeater.roster_state().map(|s| s.repeaters.len()),
        Some(2)
    );

    first.shutdown().await;
    second.shutdown().await;
    Ok(())
}

/// Enrol `phone` in `node`'s roster and have the node carry its namespace, naming `carriers`.
async fn enrol_and_grant(
    node: &StashNode,
    roster: &mut Roster,
    phone: &Phone,
    seed: u8,
    carriers: Vec<[u8; 32]>,
) -> Result<()> {
    let enroll = sign_onto(roster, seed, Action::Enroll { invite: None });
    call(
        &phone.endpoint,
        node.endpoint_addr(),
        &Request::Publish { ops: vec![enroll] },
    )
    .await?;
    let repeater_id = *node.endpoint_addr().id.as_bytes();
    let member = *phone.endpoint.id().as_bytes();
    let granted = call(
        &phone.endpoint,
        node.endpoint_addr(),
        &Request::Grant {
            ticket: phone.ticket.clone(),
            proof: sign_grant(&phone.ns_secret, &repeater_id, &member),
            carriers,
        },
    )
    .await?;
    match granted {
        Response::Granted { .. } => Ok(()),
        other => Err(anyhow!("grant refused: {other:?}")),
    }
}

#[tokio::test]
async fn repeaters_in_different_rosters_converge_on_a_trail_they_both_carry() -> Result<()> {
    // Two people's repeaters, each in its owner's own roster; neither roster knows the other.
    let a = spawn_repeater(&scratch("cross-a"), 111).await?;
    let b = spawn_repeater(&scratch("cross-b"), 112).await?;
    let (_owner_a, mut roster_a) = claim(&a, 113, None, Policy::Open).await?;
    let (_owner_b, mut roster_b) = claim(&b, 114, None, Policy::Open).await?;
    let (a_id, b_id) = (
        *a.endpoint_addr().id.as_bytes(),
        *b.endpoint_addr().id.as_bytes(),
    );

    // One phone enrols in both, and names each repeater to the other as a co-carrier.
    let payload = b"sealed-envelope-carried-across-rosters";
    let phone = Phone::spawn(115, payload).await?;
    enrol_and_grant(&a, &mut roster_a, &phone, 115, vec![b_id]).await?;
    enrol_and_grant(&b, &mut roster_b, &phone, 115, vec![a_id]).await?;

    // The phone reaches only the first, then is gone.
    phone.doc.start_sync(vec![a.endpoint_addr()]).await?;
    wait_servable(&a, 1, "the repeater the phone reached").await;
    let ticket = phone.ticket.clone();
    phone.vanish().await;

    // The second repeater's own carrier sync fetches it — no sibling list, no phone.
    let mut converged = false;
    for _ in 0..30 {
        assert_eq!(b.sync_carriers().await, 1);
        for _ in 0..20 {
            if b.content_stats() == (0, 1) {
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
        "the co-carrier never got the trail: {:?}",
        b.content_stats()
    );

    let bytes = read_through(116, &ticket, b.endpoint_addr()).await?;
    assert_eq!(bytes, payload);
    a.shutdown().await;
    b.shutdown().await;
    Ok(())
}
