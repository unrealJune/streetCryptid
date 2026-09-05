//! **Normative** wire vectors for the festival-mesh radio capsule (`docs/mesh/DESIGN.md` §3.2).
//!
//! `tests/fixtures/mesh_vectors.json` is the contract every implementation must satisfy —
//! this Rust core, the ESP-IDF antenna firmware (W2, which parses `{v, epoch, tag}` and the
//! dedup key only), and any host simulator. Fields are hex strings so C and TS can consume the
//! same file. **Do not edit the fixture by hand**: change the format here, regenerate with
//!
//! ```text
//! cargo test --test mesh_vectors -- --ignored --nocapture print_fixture
//! ```
//!
//! and say in the commit message why the wire format changed.
//!
//! The composed values are pinned by this crate, but the *primitives* are anchored to published
//! vectors so the fixture is not merely "whatever the code happened to produce":
//! [`x25519_matches_rfc_7748`] checks the shared secret against RFC 7748 §6.1, and
//! [`recv_keypair_is_plain_x25519`] proves the receiving keypair the app already mints is a
//! standard X25519 pair (the assumption that lets a capsule tag be derived from both sides).

use iroh_location::mesh;

// --- fixed inputs (the fixture's provenance) --------------------------------------------------

/// RFC 7748 §6.1 "Alice" — reused as author A's receiving keypair so the fixture carries a
/// shared secret that is independently verifiable against the RFC.
const A_RECV_SECRET: &str = "77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a";
const A_RECV_PUBLIC: &str = "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a";
/// RFC 7748 §6.1 "Bob" — recipient B.
const B_RECV_SECRET: &str = "5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb";
const B_RECV_PUBLIC: &str = "de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f";
const RFC_7748_SHARED: &str = "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742";

/// Author A's ed25519 EndpointId. Never on the wire — it only seeds the tag/key derivation.
const AUTHOR_A: &str = "a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebf";
/// A second author over the same friend pair, to show tags do not collide across authors.
const AUTHOR_C: &str = "c0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedf";

/// Fixed AEAD nonces. Production seals draw these from `OsRng`; the fixture pins them so the
/// capsule bytes are reproducible.
const NONCE_1: &str = "000102030405060708090a0b";
const NONCE_2: &str = "0b0a09080706050403020100";

/// A wall-clock instant inside the fixture's epoch (2025-07-20T09:46:40Z).
const NOW_SECS: u64 = 1_753_004_800;

fn hex_decode(s: &str) -> Vec<u8> {
    assert!(s.len() % 2 == 0, "odd-length hex: {s}");
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("valid hex"))
        .collect()
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// A deterministic stand-in for a sealed envelope. The capsule treats its payload as opaque, so
/// the fixture does not need a real envelope — only bytes of a realistic size (DESIGN §8 puts a
/// fix capsule at ~300-450 B, so 320 B of body lands in range).
fn synthetic_envelope() -> Vec<u8> {
    let mut out = vec![0u8; 320];
    let mut reader = blake3::Hasher::new_derive_key("sc-mesh-vector-envelope/v1")
        .update(b"streetCryptid festival mesh")
        .finalize_xof();
    reader.fill(&mut out);
    out
}

fn nonce_array(hex: &str) -> [u8; 12] {
    hex_decode(hex).try_into().expect("12-byte nonce")
}

fn author_array(hex: &str) -> [u8; 32] {
    hex_decode(hex).try_into().expect("32-byte author id")
}

/// The three capsules the fixture pins: (name, author, epoch offset from the base epoch, nonce).
fn capsule_plan() -> Vec<(&'static str, &'static str, u32, &'static str)> {
    let base = mesh::epoch_at(NOW_SECS);
    vec![
        ("a-to-b-current-epoch", AUTHOR_A, base, NONCE_1),
        ("a-to-b-next-epoch", AUTHOR_A, base + 1, NONCE_2),
        ("c-to-b-current-epoch", AUTHOR_C, base, NONCE_1),
    ]
}

fn fixture() -> serde_json::Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/mesh_vectors.json"
    );
    let raw = std::fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("missing normative fixture {path}: {e}"));
    serde_json::from_str(&raw).expect("fixture is valid JSON")
}

fn field<'a>(v: &'a serde_json::Value, key: &str) -> &'a str {
    v.get(key)
        .and_then(|x| x.as_str())
        .unwrap_or_else(|| panic!("fixture entry missing string field `{key}`: {v}"))
}

// --- primitive anchors ------------------------------------------------------------------------

#[test]
fn x25519_matches_rfc_7748() {
    let a_sk = hex_decode(A_RECV_SECRET);
    let b_pk = hex_decode(B_RECV_PUBLIC);
    let b_sk = hex_decode(B_RECV_SECRET);
    let a_pk = hex_decode(A_RECV_PUBLIC);

    let from_a = mesh::shared_secret(&a_sk, &b_pk).unwrap();
    let from_b = mesh::shared_secret(&b_sk, &a_pk).unwrap();
    assert_eq!(hex_encode(&from_a), RFC_7748_SHARED);
    assert_eq!(from_a, from_b, "the DH must be symmetric");
}

#[test]
fn recv_keypair_is_plain_x25519() {
    // The capsule reuses the app's existing receiving keypair. If HPKE's serialisation were not
    // raw X25519, every tag derivation in this file would be built on sand.
    let pair = iroh_location::generate_recv_keypair();
    let (secret, public) = (&pair[0], &pair[1]);
    let derived = x25519_public_from(secret);
    assert_eq!(
        hex_encode(&derived),
        hex_encode(public),
        "recv keypair is not a standard X25519 pair"
    );
}

/// Independent public-key derivation: `pub = X25519(secret, basepoint)`, done through the same
/// `shared_secret` path the capsule uses rather than the HPKE one that produced the key.
fn x25519_public_from(secret: &[u8]) -> Vec<u8> {
    const BASEPOINT: [u8; 32] = {
        let mut b = [0u8; 32];
        b[0] = 9;
        b
    };
    mesh::shared_secret(secret, &BASEPOINT).unwrap().to_vec()
}

// --- the fixture itself -----------------------------------------------------------------------

#[test]
fn fixture_constants_match_the_implementation() {
    let f = fixture();
    let c = &f["constants"];
    assert_eq!(c["capsule_v"].as_u64().unwrap(), mesh::CAPSULE_V as u64);
    assert_eq!(c["epoch_secs"].as_u64().unwrap(), mesh::EPOCH_SECS);
    assert_eq!(c["tag_len"].as_u64().unwrap(), mesh::TAG_LEN as u64);
    assert_eq!(c["dedup_len"].as_u64().unwrap(), mesh::DEDUP_LEN as u64);
    assert_eq!(c["header_len"].as_u64().unwrap(), mesh::HEADER_LEN as u64);
    assert_eq!(c["ring_depth"].as_u64().unwrap(), mesh::RING_DEPTH as u64);
    assert_eq!(
        c["max_query_tags"].as_u64().unwrap(),
        mesh::MAX_QUERY_TAGS as u64
    );
}

#[test]
fn fixture_epoch_math_matches() {
    let f = fixture();
    for case in f["epochs"].as_array().unwrap() {
        let now = case["unix_secs"].as_u64().unwrap();
        let expected: Vec<u32> = case["window"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_u64().unwrap() as u32)
            .collect();
        assert_eq!(
            mesh::epoch_at(now) as u64,
            case["epoch"].as_u64().unwrap(),
            "epoch_at({now})"
        );
        assert_eq!(mesh::epoch_window(now), expected, "epoch_window({now})");
    }
}

#[test]
fn fixture_derivations_match() {
    let f = fixture();
    for case in f["derivations"].as_array().unwrap() {
        let name = field(case, "name");
        let recv_secret = hex_decode(field(case, "recv_secret"));
        let peer_public = hex_decode(field(case, "peer_recv_public"));
        let author = author_array(field(case, "author_endpoint_id"));
        let epoch = case["epoch"].as_u64().unwrap() as u32;

        let ss = mesh::shared_secret(&recv_secret, &peer_public).unwrap();
        assert_eq!(hex_encode(&ss), field(case, "shared_secret"), "{name}: ss");
        assert_eq!(
            hex_encode(&mesh::tag(&ss, &author, epoch)),
            field(case, "tag"),
            "{name}: tag"
        );
        assert_eq!(
            hex_encode(&mesh::capsule_key(&ss, &author, epoch)),
            field(case, "capsule_key"),
            "{name}: capsule_key"
        );
    }
}

#[test]
fn fixture_capsules_are_byte_exact_and_open_both_ways() {
    let f = fixture();
    let envelope = hex_decode(field(&f, "envelope"));
    assert_eq!(
        hex_encode(&synthetic_envelope()),
        field(&f, "envelope"),
        "the fixture's opaque envelope body drifted from its generator"
    );

    let a_sk = hex_decode(A_RECV_SECRET);
    let a_pk = hex_decode(A_RECV_PUBLIC);
    let b_sk = hex_decode(B_RECV_SECRET);
    let b_pk = hex_decode(B_RECV_PUBLIC);

    let cases = f["capsules"].as_array().unwrap();
    assert_eq!(cases.len(), capsule_plan().len());

    for (case, (name, author_hex, epoch, nonce_hex)) in cases.iter().zip(capsule_plan()) {
        assert_eq!(field(case, "name"), name);
        let author = author_array(author_hex);

        let capsule = mesh::seal_with_nonce(
            &a_sk,
            &author,
            &b_pk,
            &envelope,
            epoch,
            &nonce_array(nonce_hex),
        )
        .unwrap();
        assert_eq!(
            hex_encode(&capsule),
            field(case, "capsule"),
            "{name}: bytes"
        );
        assert_eq!(
            hex_encode(&mesh::dedup_key(&capsule)),
            field(case, "dedup_key"),
            "{name}: dedup key"
        );

        // What a bare antenna is allowed to see, and nothing more.
        let header = mesh::parse_header(&capsule).unwrap();
        assert_eq!(header.v, mesh::CAPSULE_V);
        assert_eq!(header.epoch, epoch);
        assert_eq!(hex_encode(&header.tag), field(case, "tag"));

        // B opens it; A (the author) can too, since the shared secret is symmetric.
        assert_eq!(
            mesh::open(&b_sk, &author, &a_pk, &capsule).unwrap(),
            envelope,
            "{name}: recipient open"
        );
        assert_eq!(
            mesh::open(&a_sk, &author, &b_pk, &capsule).unwrap(),
            envelope,
            "{name}: author open"
        );
    }

    // The two epochs of the same A->B stream share no tag: that is the unlinkability claim.
    let t0 = field(&cases[0], "tag");
    let t1 = field(&cases[1], "tag");
    let t2 = field(&cases[2], "tag");
    assert_ne!(t0, t1, "tags must rotate per epoch");
    assert_ne!(t0, t2, "tags must not collide across authors");
}

#[test]
fn fixture_rejects_are_rejected() {
    let f = fixture();
    for case in f["rejects"].as_array().unwrap() {
        let name = field(case, "name");
        let bytes = hex_decode(field(case, "capsule"));
        let reason = field(case, "reason");

        let mut store = mesh::Store::new(16);
        assert_eq!(
            store.insert(&bytes, NOW_SECS).as_str(),
            reason,
            "{name}: store drop_reason"
        );
        // Everything the store drops here is dropped on header inspection alone — the check a
        // bare antenna performs, with no key material.
        assert!(
            mesh::parse_header(&bytes).is_err(),
            "{name}: header parse should have failed"
        );
    }
}

// --- end to end through the exported surface --------------------------------------------------

#[test]
fn seal_fix_produces_one_capsule_per_recipient_and_opens_back_to_the_fix() {
    // A fixed ed25519 identity: seed in, EndpointId out (what `LocationNode` holds at runtime).
    let signing = ed25519_dalek::SigningKey::from_bytes(&[0x42u8; 32]);
    let identity = signing.to_bytes().to_vec();
    let author = signing.verifying_key().to_bytes().to_vec();
    let a_pair = iroh_location::generate_recv_keypair();
    let b_pair = iroh_location::generate_recv_keypair();
    let c_pair = iroh_location::generate_recv_keypair();

    let fix = iroh_location::LocationFix {
        lat: 51.5074,
        lon: -0.1278,
        accuracy_m: 8.0,
        heading_deg: 271.0,
        ts: NOW_SECS * 1000,
        state: None,
        published_delta_s: None,
    };
    let epoch = mesh::epoch_at(NOW_SECS);
    let recipients = vec![
        iroh_location::MeshPeer {
            endpoint_id: author.clone(),
            recv_public: b_pair[1].clone(),
        },
        iroh_location::MeshPeer {
            endpoint_id: author.clone(),
            recv_public: c_pair[1].clone(),
        },
    ];

    let capsules = iroh_location::mesh_seal_fix(
        identity,
        a_pair[0].clone(),
        author.clone(),
        7,
        epoch,
        fix.clone(),
        recipients,
    )
    .unwrap();
    assert_eq!(capsules.len(), 2, "one capsule per recipient");
    assert_ne!(capsules[0], capsules[1]);

    let a_as_author = iroh_location::MeshPeer {
        endpoint_id: author.clone(),
        recv_public: a_pair[1].clone(),
    };

    // B opens capsule 0; C opens capsule 1. Neither can touch the other's.
    let got =
        iroh_location::mesh_open_fix(b_pair[0].clone(), a_as_author.clone(), capsules[0].clone())
            .unwrap();
    assert_eq!(got.author, author);
    assert_eq!(got.seq, 7);
    assert_eq!(got.fix.lat, fix.lat);
    assert_eq!(got.fix.ts, fix.ts);

    assert!(
        iroh_location::mesh_open_fix(c_pair[0].clone(), a_as_author.clone(), capsules[0].clone())
            .is_err(),
        "a capsule addressed to B must be inert for C"
    );
    assert!(
        iroh_location::mesh_open_fix(c_pair[0].clone(), a_as_author, capsules[1].clone()).is_ok()
    );
}

#[test]
fn store_round_trips_the_query_deliver_exchange() {
    // The §4.1 exchange, with no radio: phone computes tags, node answers with the delta.
    let a_sk = hex_decode(A_RECV_SECRET);
    let b_sk = hex_decode(B_RECV_SECRET);
    let b_pk = hex_decode(B_RECV_PUBLIC);
    let a_pk = hex_decode(A_RECV_PUBLIC);
    let author = hex_decode(AUTHOR_A);
    let epoch = mesh::epoch_at(NOW_SECS);

    let node = iroh_location::MeshCapsuleStore::new(1024);
    let phone = iroh_location::MeshCapsuleStore::new(1024);

    let first = mesh::seal(&a_sk, &author, &b_pk, b"envelope one", epoch).unwrap();
    let second = mesh::seal(&a_sk, &author, &b_pk, b"envelope two", epoch).unwrap();
    assert!(node.insert(first.clone(), NOW_SECS).accepted);
    assert!(node.insert(second.clone(), NOW_SECS).accepted);
    assert!(!node.insert(second.clone(), NOW_SECS).accepted, "dedup");

    // B sweeps its friends into a Query.
    let peer = iroh_location::MeshPeer {
        endpoint_id: author.clone(),
        recv_public: a_pk,
    };
    let tags = iroh_location::mesh_expected_tags(b_sk.clone(), vec![peer], NOW_SECS);
    assert_eq!(tags.len(), 3, "e-1, e, e+1");
    let tag_bytes: Vec<Vec<u8>> = tags.iter().map(|t| t.tag.clone()).collect();

    // First sync: phone holds nothing, so it gets both.
    let delivered = node.deliver(tag_bytes.clone(), phone.have(tag_bytes.clone()));
    assert_eq!(delivered.len(), 2);
    for capsule in &delivered {
        assert!(phone.insert(capsule.clone(), NOW_SECS).accepted);
    }

    // Second sync: nothing new on the wire.
    assert!(node
        .deliver(tag_bytes.clone(), phone.have(tag_bytes.clone()))
        .is_empty());

    let stats = phone.stats(NOW_SECS);
    assert_eq!((stats.capsules, stats.tags, stats.epoch), (2, 1, epoch));

    // A fresh capsule for the same tag arrives; only that one crosses.
    let third = mesh::seal(&a_sk, &author, &b_pk, b"envelope three", epoch).unwrap();
    node.insert(third.clone(), NOW_SECS);
    assert_eq!(
        node.deliver(tag_bytes.clone(), phone.have(tag_bytes.clone())),
        vec![third.clone()]
    );

    // The live position is the newest arrival, and prune clears the window.
    let live_tag = tags.iter().find(|t| t.epoch == epoch).unwrap().tag.clone();
    assert_eq!(node.latest(live_tag).unwrap(), third);
    assert_eq!(phone.prune(NOW_SECS + mesh::EPOCH_SECS * 2), 2);
    assert_eq!(phone.stats(NOW_SECS).capsules, 0);
}

// --- fixture generator ------------------------------------------------------------------------

/// Regenerates `tests/fixtures/mesh_vectors.json` on stdout. Ignored by default — running it is
/// an explicit act, because the fixture is the wire contract other implementations are held to.
#[test]
#[ignore = "regenerates the normative fixture; run deliberately"]
fn print_fixture() {
    let envelope = synthetic_envelope();
    let a_sk = hex_decode(A_RECV_SECRET);
    let b_pk = hex_decode(B_RECV_PUBLIC);
    let base = mesh::epoch_at(NOW_SECS);

    let derivations: Vec<serde_json::Value> = capsule_plan()
        .iter()
        .map(|(name, author_hex, epoch, _)| {
            let author = author_array(author_hex);
            let ss = mesh::shared_secret(&a_sk, &b_pk).unwrap();
            serde_json::json!({
                "name": name,
                "recv_secret": A_RECV_SECRET,
                "peer_recv_public": B_RECV_PUBLIC,
                "author_endpoint_id": author_hex,
                "epoch": epoch,
                "shared_secret": hex_encode(&ss),
                "tag": hex_encode(&mesh::tag(&ss, &author, *epoch)),
                "capsule_key": hex_encode(&mesh::capsule_key(&ss, &author, *epoch)),
            })
        })
        .collect();

    let capsules: Vec<serde_json::Value> = capsule_plan()
        .iter()
        .map(|(name, author_hex, epoch, nonce_hex)| {
            let author = author_array(author_hex);
            let capsule = mesh::seal_with_nonce(
                &a_sk,
                &author,
                &b_pk,
                &envelope,
                *epoch,
                &nonce_array(nonce_hex),
            )
            .unwrap();
            let header = mesh::parse_header(&capsule).unwrap();
            serde_json::json!({
                "name": name,
                "author_endpoint_id": author_hex,
                "epoch": epoch,
                "nonce": nonce_hex,
                "tag": hex_encode(&header.tag),
                "capsule": hex_encode(&capsule),
                "dedup_key": hex_encode(&mesh::dedup_key(&capsule)),
            })
        })
        .collect();

    // Two rejects a firmware parser must also reject, expressed as store drop_reasons.
    let good = hex_decode(field(&capsules[0], "capsule"));
    let mut bad_version = good.clone();
    bad_version[0] = 0x02;
    let truncated = good[..mesh::HEADER_LEN + 4].to_vec();

    let doc = serde_json::json!({
        "$comment": "NORMATIVE festival-mesh capsule vectors — see docs/mesh/DESIGN.md §3.2 and \
                     modules/iroh-location/rust/tests/mesh_vectors.rs. Generated; do not hand-edit.",
        "constants": {
            "capsule_v": mesh::CAPSULE_V,
            "epoch_secs": mesh::EPOCH_SECS,
            "tag_len": mesh::TAG_LEN,
            "dedup_len": mesh::DEDUP_LEN,
            "header_len": mesh::HEADER_LEN,
            "nonce_len": 12,
            "ring_depth": mesh::RING_DEPTH,
            "max_query_tags": mesh::MAX_QUERY_TAGS,
            "tag_context": "sc-mesh-tag/v1",
            "key_context": "sc-mesh-key/v1",
        },
        "keys": {
            "$comment": "RFC 7748 §6.1 Alice/Bob, so the shared secret is independently checkable.",
            "a_recv_secret": A_RECV_SECRET,
            "a_recv_public": A_RECV_PUBLIC,
            "b_recv_secret": B_RECV_SECRET,
            "b_recv_public": B_RECV_PUBLIC,
            "rfc_7748_shared_secret": RFC_7748_SHARED,
        },
        "now_secs": NOW_SECS,
        "base_epoch": base,
        "envelope": hex_encode(&envelope),
        "epochs": [
            { "unix_secs": 0, "epoch": 0, "window": [0, 1] },
            { "unix_secs": 899, "epoch": 0, "window": [0, 1] },
            { "unix_secs": 900, "epoch": 1, "window": [0, 1, 2] },
            { "unix_secs": NOW_SECS, "epoch": base, "window": [base - 1, base, base + 1] },
        ],
        "derivations": derivations,
        "capsules": capsules,
        "rejects": [
            { "name": "unknown-version", "reason": "bad_version", "capsule": hex_encode(&bad_version) },
            { "name": "truncated-header", "reason": "malformed", "capsule": hex_encode(&truncated) },
            { "name": "empty", "reason": "malformed", "capsule": "" },
        ],
    });

    println!("{}", serde_json::to_string_pretty(&doc).unwrap());
}
