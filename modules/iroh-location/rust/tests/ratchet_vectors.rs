//! **Frozen** vectors for the Double Ratchet schedule (`src/ratchet.rs`).
//!
//! Unlike `mesh_vectors.json` this fixture is not a cross-language wire contract — the schedule
//! runs only in this crate. It exists because there is **no published Signal DR vector file** to
//! check a schedule against (see `tests/ratchet.rs` for that finding), so without a pinned
//! transcript the schedule could be changed silently and every test would still pass by
//! construction. This file makes a change to the key derivation show up as a diff.
//!
//! **Do not edit the fixture by hand.** Regenerate with
//!
//! ```text
//! cargo test --test ratchet_vectors -- --ignored --nocapture print_fixture
//! ```
//!
//! and say in the commit message *why* the schedule changed. A diff here means every existing
//! session on every device is invalidated.
//!
//! The transcript deliberately includes a skip (A sends three, B receives only the third), so the
//! fixture pins the fast-forward path and not merely the happy one.

use iroh_location::ratchet::{
    kdf_ck, kdf_kid, kdf_mk, kdf_rk, MessageKey, RatchetKeySource, RatchetState,
    DEFAULT_ACCEPT_WINDOW, KEY_LEN, SESSION_ID_LEN,
};
use x25519_dalek::{PublicKey as XPublicKey, StaticSecret as XStaticSecret};

// --- fixed inputs (the fixture's provenance) --------------------------------------------------

/// Session root. In production this comes from the §4.6 bootstrap over the SAS bump; pinned here.
const RK0: [u8; KEY_LEN] = [7u8; KEY_LEN];
const SID: [u8; SESSION_ID_LEN] = [1u8; SESSION_ID_LEN];
/// B's bootstrap ratchet secret — the one contributed during the bump.
const B_BOOT_SEED: u8 = 0xB0;

struct FixedKeys {
    seed: u8,
    n: u32,
}

impl RatchetKeySource for FixedKeys {
    fn next_ratchet_secret(&mut self) -> XStaticSecret {
        let mut raw = [0u8; KEY_LEN];
        raw[0] = self.seed;
        raw[1..5].copy_from_slice(&self.n.to_le_bytes());
        self.n += 1;
        XStaticSecret::from(raw)
    }
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn key_hex(key: MessageKey) -> String {
    key.use_once(|k| hex_encode(k))
}

/// One recorded step of the scripted exchange.
struct Step {
    label: &'static str,
    epoch: u32,
    counter: u32,
    kid: String,
    mk: String,
}

/// The scripted session. Deterministic given the fixed inputs above.
///
/// A sends three (two of which are lost), B receives the third, B replies twice, A receives both,
/// A sends twice more — covering a skip, two DH ratchets, and both directions.
fn transcript() -> Vec<Step> {
    let b_boot = XStaticSecret::from([B_BOOT_SEED; KEY_LEN]);
    let b_pub = XPublicKey::from(&b_boot).to_bytes();
    let mut ka = FixedKeys { seed: 0xA0, n: 0 };
    let mut kb = FixedKeys { seed: 0xB1, n: 0 };
    let mut a = RatchetState::bootstrap_initiator(SID, RK0, b_pub, 0, &mut ka).unwrap();
    let mut b = RatchetState::bootstrap_responder(SID, RK0, b_boot, 0);
    let w = DEFAULT_ACCEPT_WINDOW;

    let mut out = Vec::new();
    let mut record =
        |label, slot: iroh_location::ratchet::SendSlot| -> iroh_location::ratchet::RatchetHeader {
            let header = slot.header;
            out.push(Step {
                label,
                epoch: header.epoch,
                counter: header.counter,
                kid: hex_encode(&slot.kid),
                mk: key_hex(slot.key),
            });
            header
        };

    // A sends three; the first two never arrive.
    let _lost_0 = record("a_send_0_lost", a.next_send().unwrap());
    let _lost_1 = record("a_send_1_lost", a.next_send().unwrap());
    let h2 = record("a_send_2_delivered", a.next_send().unwrap());
    // B fast-forwards past the two it never saw.
    drop(b.accept(&h2, 0, w, &mut kb).unwrap());

    // B replies twice on its new chain.
    let h3 = record("b_send_0", b.next_send().unwrap());
    drop(a.accept(&h3, 0, w, &mut ka).unwrap());
    let h4 = record("b_send_1", b.next_send().unwrap());
    drop(a.accept(&h4, 0, w, &mut ka).unwrap());

    // A sends again, now an epoch later.
    let h5 = record("a_send_after_ratchet_0", a.next_send().unwrap());
    drop(b.accept(&h5, 0, w, &mut kb).unwrap());
    let _h6 = record("a_send_after_ratchet_1", a.next_send().unwrap());

    out
}

/// Primitive derivations over fixed inputs, pinned independently of the session.
fn primitives() -> Vec<(&'static str, String)> {
    let ck = [9u8; KEY_LEN];
    let (rk_next, rk_chain) = kdf_rk(&[3u8; KEY_LEN], &[4u8; KEY_LEN]);
    vec![
        ("kdf_rk_root", hex_encode(&rk_next)),
        ("kdf_rk_chain", hex_encode(&rk_chain)),
        ("kdf_ck", hex_encode(&kdf_ck(&ck))),
        ("kdf_mk", hex_encode(&kdf_mk(&ck))),
        ("kdf_kid", hex_encode(&kdf_kid(&ck))),
    ]
}

fn fixture_json() -> String {
    let mut s = String::from("{\n  \"comment\": \"Frozen Double Ratchet schedule vectors — regenerate with `cargo test --test ratchet_vectors -- --ignored --nocapture print_fixture`. See docs/social/FORWARD-SECRECY.md §4.2.\",\n");
    s.push_str(&format!("  \"rk0\": \"{}\",\n", hex_encode(&RK0)));
    s.push_str(&format!("  \"session_id\": \"{}\",\n", hex_encode(&SID)));
    s.push_str("  \"primitives\": {\n");
    let prims = primitives();
    for (i, (k, v)) in prims.iter().enumerate() {
        let comma = if i + 1 == prims.len() { "" } else { "," };
        s.push_str(&format!("    \"{k}\": \"{v}\"{comma}\n"));
    }
    s.push_str("  },\n  \"transcript\": [\n");
    let steps = transcript();
    for (i, st) in steps.iter().enumerate() {
        let comma = if i + 1 == steps.len() { "" } else { "," };
        s.push_str(&format!(
            "    {{ \"label\": \"{}\", \"epoch\": {}, \"counter\": {}, \"kid\": \"{}\", \"mk\": \"{}\" }}{}\n",
            st.label, st.epoch, st.counter, st.kid, st.mk, comma
        ));
    }
    s.push_str("  ]\n}\n");
    s
}

#[test]
fn schedule_matches_the_frozen_fixture() {
    let expected = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/ratchet_vectors.json"),
    )
    .expect("fixture is missing — regenerate it (see this file's module docs)");

    assert_eq!(
        fixture_json().replace("\r\n", "\n"),
        expected.replace("\r\n", "\n"),
        "the ratchet schedule no longer reproduces the frozen vectors — if that was deliberate, \
         regenerate the fixture and say in the commit why every existing session is invalidated"
    );
}

#[test]
fn the_transcript_actually_exercises_a_skip_and_a_ratchet() {
    // Guards the fixture's value: if the script were reduced to a happy path, the vectors would
    // still pass while covering far less.
    let steps = transcript();
    assert!(
        steps.iter().any(|s| s.label.contains("lost")),
        "transcript must cover the fast-forward path"
    );
    assert!(
        steps.iter().any(|s| s.epoch > 0),
        "transcript must cross at least one DH ratchet"
    );
    let mut keys: Vec<&String> = steps.iter().map(|s| &s.mk).collect();
    keys.sort();
    let before = keys.len();
    keys.dedup();
    assert_eq!(
        before,
        keys.len(),
        "a message key repeated inside the transcript"
    );
}

#[test]
#[ignore = "regenerates the fixture; run explicitly"]
fn print_fixture() {
    println!("{}", fixture_json());
}
