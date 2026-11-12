//! Golden vectors: what every released version of this crate put on the wire.
//!
//! Until the import into the streetCryptid repository the phone pinned this crate by git tag, and
//! that pin was also a compatibility checkpoint: a phone in the field links whatever version it
//! shipped with, while the hosted stash moves on every merge. In one repository the two change
//! together, so this test is that checkpoint instead (docs/MONOREPO.md, "The Cargo workspace").
//!
//! `tests/fixtures/<version>.txt` holds one vector per line, `<kind> <name> <hex>`, built from
//! fixed keys so every signature is deterministic. Two rules:
//!
//! * **Every file, forever, must decode, verify and re-encode byte for byte** with today's code.
//!   Changing an existing variant, inserting one anywhere but the end, or adding a field breaks
//!   it -- postcard tags enum variants by position and has no field names. Same rule as the
//!   location wire: append-only, end-only.
//! * **The newest file must equal what today's code produces.** Appending a variant makes it
//!   differ: run `cargo test -p streetcryptid-repeater --test golden -- --ignored --nocapture
//!   print_vectors` and save the output as a NEW file named for the release that ships it. Never
//!   edit an old one.

use std::fmt::Write as _;
use std::path::PathBuf;

use ed25519_dalek::SigningKey;
use streetcryptid_repeater::roster::{
    Action, CertBody, OpBody, OpId, Policy, RepeaterCert, Role, SignedOp,
};
use streetcryptid_repeater::wire::{self, Refusal, Request, Response};

const TS_MS: u64 = 1_731_283_200_000;

fn key(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}

fn owner() -> SigningKey {
    key(1)
}
fn repeater() -> SigningKey {
    key(2)
}
fn member() -> SigningKey {
    key(3)
}
/// An iroh-docs namespace's write key; its public half is the namespace id.
fn namespace() -> SigningKey {
    key(4)
}

fn hex(bytes: &[u8]) -> String {
    bytes
        .iter()
        .fold(String::with_capacity(bytes.len() * 2), |mut out, b| {
            let _ = write!(out, "{b:02x}");
            out
        })
}

fn unhex(text: &str) -> Vec<u8> {
    assert!(text.len() % 2 == 0, "odd-length hex");
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).expect("hex"))
        .collect()
}

fn op(signer: &SigningKey, roster: Option<OpId>, parents: Vec<OpId>, action: Action) -> SignedOp {
    SignedOp::sign(
        signer,
        &OpBody {
            roster,
            parents,
            ts_ms: TS_MS,
            action,
        },
    )
}

/// Every vector, in a fixed order. Grows only at the end of each section.
fn vectors() -> Vec<(&'static str, String, Vec<u8>)> {
    let owner_id = owner().verifying_key().to_bytes();
    let repeater_id = repeater().verifying_key().to_bytes();
    let member_id = member().verifying_key().to_bytes();
    let namespace_id = namespace().verifying_key().to_bytes();

    let genesis = op(
        &owner(),
        None,
        vec![],
        Action::Genesis {
            owner: owner_id,
            policy: Policy::Invite,
            nonce: [7; 16],
        },
    );
    let roster = Some(genesis.id());
    let after = vec![genesis.id()];

    let cert = RepeaterCert::issue(
        &repeater(),
        &CertBody {
            roster: genesis.id(),
            owner: owner_id,
            repeater: repeater_id,
            issued_ms: TS_MS,
            // Unnamed, so the cert is byte-identical to v0.3.0's; a named one is
            // `roster::tests::a_named_cert_*`.
            name: None,
        },
    );
    let invite = op(
        &owner(),
        roster,
        after.clone(),
        Action::Invite { member: member_id },
    );

    let ops: Vec<(&str, SignedOp)> = vec![
        ("genesis", genesis.clone()),
        (
            "set_policy_open",
            op(
                &owner(),
                roster,
                after.clone(),
                Action::SetPolicy {
                    policy: Policy::Open,
                },
            ),
        ),
        (
            "add_repeater",
            op(
                &owner(),
                roster,
                after.clone(),
                Action::AddRepeater { cert: cert.clone() },
            ),
        ),
        (
            "remove_repeater",
            op(
                &owner(),
                roster,
                after.clone(),
                Action::RemoveRepeater {
                    repeater: repeater_id,
                },
            ),
        ),
        ("invite", invite.clone()),
        (
            "enroll_invited",
            op(
                &member(),
                roster,
                vec![invite.id()],
                Action::Enroll {
                    invite: Some(invite.id()),
                },
            ),
        ),
        (
            "enroll_open",
            op(
                &member(),
                roster,
                after.clone(),
                Action::Enroll { invite: None },
            ),
        ),
        (
            "grant_inviter",
            op(
                &owner(),
                roster,
                after.clone(),
                Action::Grant {
                    member: member_id,
                    role: Role::Inviter,
                },
            ),
        ),
        (
            "revoke_inviter",
            op(
                &owner(),
                roster,
                after.clone(),
                Action::Revoke {
                    member: member_id,
                    role: Role::Inviter,
                },
            ),
        ),
        (
            "remove",
            op(
                &owner(),
                roster,
                after.clone(),
                Action::Remove { member: member_id },
            ),
        ),
        (
            "withdraw",
            op(&member(), roster, after.clone(), Action::Withdraw),
        ),
    ];

    let requests: Vec<(&str, Request)> = vec![
        (
            "claim",
            Request::Claim {
                secret: [9; 32],
                ops: vec![genesis.clone()],
            },
        ),
        (
            "publish",
            Request::Publish {
                ops: vec![invite.clone()],
            },
        ),
        ("fetch", Request::Fetch),
        (
            "grant",
            Request::Grant {
                ticket: "docaaagolden".to_string(),
                proof: wire::sign_grant(&namespace(), &repeater_id, &member_id),
                carriers: vec![[5; 32]],
            },
        ),
        (
            "have",
            Request::Have {
                hashes: vec![[6; 32]],
            },
        ),
    ];

    let mut responses: Vec<(&str, Response)> = vec![
        ("claimed", Response::Claimed { cert: cert.clone() }),
        (
            "published",
            Response::Published {
                accepted: 1,
                pending: 2,
                refused: 3,
                heads: vec![genesis.id()],
            },
        ),
        (
            "roster",
            Response::Roster {
                ops: vec![genesis.clone(), invite.clone()],
            },
        ),
        (
            "granted",
            Response::Granted {
                namespace: namespace_id,
            },
        ),
        (
            "have",
            Response::Have {
                present: vec![true, false],
            },
        ),
    ];
    for (name, reason) in [
        ("refused_bad_claim_secret", Refusal::BadClaimSecret),
        ("refused_already_claimed", Refusal::AlreadyClaimed),
        ("refused_bad_claim_roster", Refusal::BadClaimRoster),
        ("refused_not_claimed", Refusal::NotClaimed),
        ("refused_not_carried", Refusal::NotCarried),
        ("refused_bad_proof", Refusal::BadProof),
        ("refused_too_many", Refusal::TooMany),
        ("refused_invalid", Refusal::Invalid),
        ("refused_unavailable", Refusal::Unavailable),
    ] {
        responses.push((name, Response::Refused { reason }));
    }

    let mut out = Vec::new();
    for (name, op) in ops {
        out.push(("op", name.to_string(), postcard::to_allocvec(&op).unwrap()));
    }
    out.push((
        "cert",
        "repeater".to_string(),
        postcard::to_allocvec(&cert).unwrap(),
    ));
    for (name, request) in requests {
        out.push(("request", name.to_string(), wire::encode(&request).unwrap()));
    }
    for (name, response) in responses {
        out.push((
            "response",
            name.to_string(),
            wire::encode(&response).unwrap(),
        ));
    }
    out
}

fn render(vectors: &[(&'static str, String, Vec<u8>)]) -> String {
    vectors
        .iter()
        .map(|(kind, name, bytes)| format!("{kind} {name} {}\n", hex(bytes)))
        .collect()
}

fn fixtures() -> Vec<(String, String)> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    let mut files: Vec<_> = std::fs::read_dir(&dir)
        .expect("tests/fixtures")
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "txt"))
        .collect();
    // v0.3.0 < v0.10.0: compare the numeric parts, not the text.
    files.sort_by_key(|path| {
        path.file_stem()
            .unwrap()
            .to_string_lossy()
            .trim_start_matches('v')
            .split('.')
            .map(|part| part.parse::<u32>().unwrap_or(0))
            .collect::<Vec<_>>()
    });
    files
        .into_iter()
        .map(|path| {
            let text = std::fs::read_to_string(&path)
                .unwrap()
                .replace("\r\n", "\n");
            (
                path.file_name().unwrap().to_string_lossy().into_owned(),
                text,
            )
        })
        .collect()
}

#[test]
fn every_released_vector_still_decodes_verifies_and_reencodes() {
    let files = fixtures();
    assert!(!files.is_empty(), "no golden vectors in tests/fixtures");
    let namespace_id = namespace().verifying_key().to_bytes();
    let repeater_id = repeater().verifying_key().to_bytes();
    let member_id = member().verifying_key().to_bytes();

    for (file, text) in files {
        for line in text.lines().filter(|line| !line.trim().is_empty()) {
            let mut parts = line.split(' ');
            let (kind, name, data) = (
                parts.next().unwrap(),
                parts.next().unwrap(),
                parts.next().unwrap(),
            );
            let at = format!("{file}: {kind} {name}");
            let bytes = unhex(data);
            let again = match kind {
                "op" => {
                    let op: SignedOp =
                        postcard::from_bytes(&bytes).unwrap_or_else(|e| panic!("{at}: {e}"));
                    let body = op.verify().unwrap_or_else(|e| panic!("{at}: {e}"));
                    if let Action::AddRepeater { cert } = &body.action {
                        cert.verify().unwrap_or_else(|e| panic!("{at}: cert: {e}"));
                    }
                    postcard::to_allocvec(&op).unwrap()
                }
                "cert" => {
                    let cert: RepeaterCert =
                        postcard::from_bytes(&bytes).unwrap_or_else(|e| panic!("{at}: {e}"));
                    cert.verify().unwrap_or_else(|e| panic!("{at}: {e}"));
                    postcard::to_allocvec(&cert).unwrap()
                }
                "request" => {
                    let request: Request =
                        wire::decode(&bytes).unwrap_or_else(|e| panic!("{at}: {e}"));
                    match &request {
                        Request::Claim { ops, .. } | Request::Publish { ops } => {
                            for op in ops {
                                op.verify().unwrap_or_else(|e| panic!("{at}: {e}"));
                            }
                        }
                        Request::Grant { proof, .. } => assert!(
                            wire::verify_grant(&namespace_id, &repeater_id, &member_id, proof),
                            "{at}: grant proof"
                        ),
                        _ => {}
                    }
                    wire::encode(&request).unwrap()
                }
                "response" => {
                    let response: Response =
                        wire::decode(&bytes).unwrap_or_else(|e| panic!("{at}: {e}"));
                    match &response {
                        Response::Claimed { cert } => {
                            cert.verify().unwrap_or_else(|e| panic!("{at}: {e}"));
                        }
                        Response::Roster { ops } => {
                            for op in ops {
                                op.verify().unwrap_or_else(|e| panic!("{at}: {e}"));
                            }
                        }
                        _ => {}
                    }
                    wire::encode(&response).unwrap()
                }
                other => panic!("{at}: unknown kind {other}"),
            };
            assert_eq!(hex(&again), data, "{at}: re-encodes differently");
        }
    }
}

#[test]
fn todays_code_writes_the_newest_vectors() {
    let (file, newest) = fixtures()
        .pop()
        .expect("no golden vectors in tests/fixtures");
    let today = render(&vectors());
    assert!(
        today == newest,
        "today's encoding differs from {file}. If this is a new release's wire, save the output \
         of `print_vectors` as a new fixture file; never edit an old one.\n\n{today}"
    );
}

/// The claim link formats the console QR and the phone both read.
#[test]
fn claim_links_keep_their_shape() {
    let secret = [0xab; 32];
    let link = wire::claim_link("endpointabc", &secret);
    assert_eq!(
        link,
        format!("streetcryptid-repeater:endpointabc#{}", "ab".repeat(32))
    );
    assert_eq!(wire::parse_claim_link(&link), Some(("endpointabc", secret)));

    let url = wire::claim_url("endpointabc", &secret);
    assert_eq!(
        url,
        format!(
            "https://streetcrypt.id/repeater#t=endpointabc&s={}",
            "ab".repeat(32)
        )
    );
    assert_eq!(wire::parse_claim_link(&url), Some(("endpointabc", secret)));
}

#[test]
#[ignore = "prints the vectors for a new fixture file"]
fn print_vectors() {
    print!("{}", render(&vectors()));
}
