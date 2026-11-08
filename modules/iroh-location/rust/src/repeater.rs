//! Repeaters, the phone's half. Design of record: `docs/social/REPEATERS.md`.
//!
//! A repeater is the trail stash run on someone's own machine: it holds ciphertext for whoever its
//! owner's **roster** says it carries, and anyone may pull from it, as from any replica. The rules
//! — the roster, the cert that links a repeater to its owner, the grant proof, the
//! `streetcryptid/repeater/1` wire — live in `streetcryptid-repeater`, the crate the repeater
//! itself is built on, so a phone signs with exactly the code that judges it there. This module
//! is what only a phone does with them:
//!
//! * keep every roster it has seen ([`RosterBook`], in `state_dir`, judged by signature alone);
//! * **claim** a repeater from the link its console printed, and check the cert it hands back
//!   names this phone, this roster and the machine that answered ([`claim`]);
//! * **enrol or withdraw** — the one opt-in there is, which is having one's own trail carried;
//! * ask every repeater that carries it to hold its own namespaces, naming each repeater to the
//!   others as co-carriers so they converge between themselves ([`grant_plan`], [`grant`]);
//! * publish a **card** of the rosters it owns or is carried by, in its own profile namespace,
//!   and read its friends' ([`build_card`], [`ingest_cards`]). That is how a roster reaches
//!   people who never claimed one of its machines.
//!
//! Everything here is one request per connection on the node's own endpoint. The trail itself
//! never moves over this protocol: it moves by plain iroh-docs sync, between phones and repeaters
//! and between repeaters, exactly as it does with the stash.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use anyhow::anyhow;
use ed25519_dalek::SigningKey;
use iroh::endpoint::RecvStream;
use iroh::{Endpoint, EndpointAddr};
use serde::{Deserialize, Serialize};
use streetcryptid_repeater::roster::{
    Action, EndpointId, Inserted, OpBody, OpId, Policy, Roster, RosterError, RosterId, RosterState,
    SignedOp,
};
use streetcryptid_repeater::wire::{
    self, declared_len, decode_body, encode, Refusal, Request, Response, ALPN, MAX_CARRIERS,
};

/// The roster book's file in `state_dir`.
pub const BOOK_FILE: &str = "repeaters.bin";
const BOOK_V: u32 = 1;

/// How long one request may take, dial included. Nothing a user waits on is bounded by this
/// except a claim, which they started at a repeater's console and are watching.
pub const CALL_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, thiserror::Error)]
pub enum RepeaterError {
    #[error("not a repeater claim link")]
    BadLink,
    #[error("the repeater refused: {0:?}")]
    Refused(Refusal),
    #[error("the repeater answered something unexpected")]
    Unexpected,
    #[error("the repeater's attestation does not match: {0}")]
    Attestation(&'static str),
    #[error("no such roster")]
    UnknownRoster,
    #[error("only the roster's owner can change it")]
    NotOwner,
    #[error("a repeater card that does not verify")]
    BadCard,
    #[error("roster: {0}")]
    Roster(#[from] RosterError),
    #[error("{0}")]
    Other(#[from] anyhow::Error),
}

// ---- the roster book --------------------------------------------------------------------------

#[derive(Default, Serialize, Deserialize)]
struct BookState {
    v: u32,
    /// Each roster as its ops, in an order where parents come first.
    rosters: Vec<Vec<SignedOp>>,
}

/// Every roster this phone knows: its own, the ones it is enrolled in, and the ones it has seen.
///
/// A roster is only ever its signed ops, so nothing here trusts whoever handed them over — a
/// repeater, a friend's card or our own earlier self. An unreadable book fails the open rather
/// than starting empty, for the same reason as [`crate::ns_book`]: an empty book would claim a new
/// roster over the one this phone owns.
pub struct RosterBook {
    path: PathBuf,
    rosters: Mutex<BTreeMap<RosterId, Roster>>,
}

impl RosterBook {
    pub fn open(dir: &Path) -> anyhow::Result<Self> {
        std::fs::create_dir_all(dir)?;
        let path = dir.join(BOOK_FILE);
        let mut rosters = BTreeMap::new();
        match std::fs::read(&path) {
            Ok(raw) => {
                let state: BookState = postcard::from_bytes(&raw)
                    .map_err(|e| anyhow!("roster book {}: {e}", path.display()))?;
                if state.v != BOOK_V {
                    return Err(anyhow!(
                        "roster book {}: version {}",
                        path.display(),
                        state.v
                    ));
                }
                for ops in state.rosters {
                    let roster = Roster::from_ops(ops)
                        .map_err(|e| anyhow!("roster book {}: {e}", path.display()))?;
                    rosters.insert(roster.id(), roster);
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
        Ok(Self {
            path,
            rosters: Mutex::new(rosters),
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, BTreeMap<RosterId, Roster>> {
        self.rosters.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Write-to-temp, fsync, rename. Called with the lock held, so two writers cannot interleave.
    fn save(&self, rosters: &BTreeMap<RosterId, Roster>) -> anyhow::Result<()> {
        use std::io::Write;
        let state = BookState {
            v: BOOK_V,
            rosters: rosters.values().map(Roster::export).collect(),
        };
        let bytes = postcard::to_allocvec(&state)?;
        let tmp = self.path.with_extension("tmp");
        {
            let mut file = std::fs::File::create(&tmp)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
        }
        std::fs::rename(&tmp, &self.path)?;
        Ok(())
    }

    /// Take ops from anywhere. Each is judged on its signature and its own causal past; a
    /// `Genesis` starts a roster, anything else joins the roster it names if that one is held.
    /// Returns the rosters that changed.
    pub fn ingest(&self, ops: Vec<SignedOp>) -> anyhow::Result<BTreeSet<RosterId>> {
        let mut rosters = self.lock();
        let mut changed = BTreeSet::new();
        let (geneses, rest): (Vec<_>, Vec<_>) = ops
            .into_iter()
            .filter_map(|op| op.verify().ok().map(|body| (op, body)))
            .partition(|(_, body)| matches!(body.action, Action::Genesis { .. }));
        for (op, _) in geneses {
            let id = op.id();
            if !rosters.contains_key(&id) {
                if let Ok(roster) = Roster::from_genesis(op) {
                    rosters.insert(id, roster);
                    changed.insert(id);
                }
            }
        }
        for (op, body) in rest {
            let Some(id) = body.roster else { continue };
            let Some(roster) = rosters.get_mut(&id) else {
                continue;
            };
            if matches!(
                roster.insert(op),
                Ok(Inserted::Accepted | Inserted::Pending)
            ) {
                changed.insert(id);
            }
        }
        if !changed.is_empty() {
            self.save(&rosters)?;
        }
        Ok(changed)
    }

    /// Start a roster owned by `key`.
    pub fn create(
        &self,
        key: &SigningKey,
        policy: Policy,
        now_ms: u64,
    ) -> anyhow::Result<RosterId> {
        let genesis = SignedOp::sign(
            key,
            &OpBody {
                roster: None,
                parents: vec![],
                ts_ms: now_ms,
                action: Action::Genesis {
                    owner: key.verifying_key().to_bytes(),
                    policy,
                    nonce: rand::random(),
                },
            },
        );
        let id = genesis.id();
        let mut rosters = self.lock();
        rosters.insert(id, Roster::from_genesis(genesis)?);
        self.save(&rosters)?;
        Ok(id)
    }

    /// Sign `action` on the heads of our copy of `roster`, keep it, and return it to send.
    pub fn sign(
        &self,
        roster: &RosterId,
        key: &SigningKey,
        action: Action,
        now_ms: u64,
    ) -> Result<SignedOp, RepeaterError> {
        let mut rosters = self.lock();
        let held = rosters
            .get_mut(roster)
            .ok_or(RepeaterError::UnknownRoster)?;
        let op = SignedOp::sign(
            key,
            &OpBody {
                roster: Some(*roster),
                parents: held.heads(),
                ts_ms: now_ms,
                action,
            },
        );
        held.insert(op.clone())?;
        self.save(&rosters)?;
        Ok(op)
    }

    pub fn export(&self, roster: &RosterId) -> Option<Vec<SignedOp>> {
        self.lock().get(roster).map(Roster::export)
    }

    /// The roster `me` owns, if any. A phone owns at most one; every repeater it claims joins it.
    pub fn owned_by(&self, me: &EndpointId) -> Option<RosterId> {
        self.lock()
            .values()
            .find(|roster| roster.owner() == *me)
            .map(Roster::id)
    }

    pub fn state(&self, roster: &RosterId) -> Option<RosterState> {
        self.lock().get(roster).map(Roster::state)
    }

    pub fn states(&self) -> Vec<RosterState> {
        self.lock().values().map(Roster::state).collect()
    }
}

// ---- the card (pure) --------------------------------------------------------------------------

/// The key a card lives under in its publisher's profile namespace. Its own key and signing
/// context, never a field of `ProfileRecord`: that record is signed over a re-encode, so a new
/// field would break every older reader (REPEATERS.md §4.2). Older readers look up `profile` only.
pub const CARD_KEY: &[u8] = b"repeaters";
const CARD_CTX: &[u8] = b"streetcryptid/repeater-card/1";
const CARD_V: u32 = 1;
/// Rosters on one card. A person is in few; this bounds what a friend can make us verify.
pub const MAX_CARD_ROSTERS: usize = 16;
/// The whole signed card. A roster op is at most 1 KiB and a real roster a few dozen ops.
pub const MAX_CARD_BYTES: usize = 256 * 1024;

#[derive(Debug, Serialize, Deserialize)]
struct CardBody {
    v: u32,
    /// Each roster as its whole signed log, so a reader needs nothing else to check it, to label
    /// it, or to sign an `Enroll` that cites it.
    rosters: Vec<Vec<SignedOp>>,
}

/// A card as it is stored: the exact signed bytes, decoded only after the signature checks out
/// (the roster's own rule; see `streetcryptid_repeater::roster`).
#[derive(Debug, Serialize, Deserialize)]
struct SignedCard {
    signer: EndpointId,
    body: Vec<u8>,
    sig: Vec<u8>,
}

/// The rosters `me` vouches for: those it owns and those that carry it. A roster it merely saw on
/// someone else's card is not repeated, so a card says "I am in this", never "I heard of this".
pub fn card_rosters(states: &[RosterState], me: &EndpointId) -> Vec<RosterId> {
    let mut ids: Vec<RosterId> = states
        .iter()
        .filter(|state| state.owner == *me || state.carried.contains(me))
        .map(|state| state.id)
        .collect();
    ids.sort_unstable();
    ids.truncate(MAX_CARD_ROSTERS);
    ids
}

/// Sign this phone's card. Deterministic (ed25519 signatures are), so an unchanged card is the
/// same bytes and republishing it writes nothing. An empty card is still a card: it is how
/// friends learn we left the last roster.
pub fn build_card(key: &SigningKey, book: &RosterBook) -> anyhow::Result<Vec<u8>> {
    let me = key.verifying_key().to_bytes();
    let rosters = card_rosters(&book.states(), &me)
        .iter()
        .filter_map(|id| book.export(id))
        .collect();
    let body = postcard::to_allocvec(&CardBody { v: CARD_V, rosters })?;
    let sig = ed25519_dalek::Signer::sign(key, &card_signing_input(&body));
    let card = postcard::to_allocvec(&SignedCard {
        signer: me,
        body,
        sig: sig.to_bytes().to_vec(),
    })?;
    if card.len() > MAX_CARD_BYTES {
        return Err(anyhow!("repeater card is {} bytes", card.len()));
    }
    Ok(card)
}

/// Check a card and return who signed it and the roster logs it carries. Each log is still only a
/// claim until [`RosterBook::ingest`] has checked every op's own signature.
pub fn open_card(bytes: &[u8]) -> Result<(EndpointId, Vec<Vec<SignedOp>>), RepeaterError> {
    if bytes.len() > MAX_CARD_BYTES {
        return Err(RepeaterError::BadCard);
    }
    let card: SignedCard = postcard::from_bytes(bytes).map_err(|_| RepeaterError::BadCard)?;
    let key = ed25519_dalek::VerifyingKey::from_bytes(&card.signer)
        .map_err(|_| RepeaterError::BadCard)?;
    let sig =
        ed25519_dalek::Signature::from_slice(&card.sig).map_err(|_| RepeaterError::BadCard)?;
    key.verify_strict(&card_signing_input(&card.body), &sig)
        .map_err(|_| RepeaterError::BadCard)?;
    let body: CardBody = postcard::from_bytes(&card.body).map_err(|_| RepeaterError::BadCard)?;
    if body.v != CARD_V || body.rosters.len() > MAX_CARD_ROSTERS {
        return Err(RepeaterError::BadCard);
    }
    Ok((card.signer, body.rosters))
}

fn card_signing_input(body: &[u8]) -> Vec<u8> {
    let mut msg = Vec::with_capacity(CARD_CTX.len() + body.len());
    msg.extend_from_slice(CARD_CTX);
    msg.extend_from_slice(body);
    msg
}

/// Take in friends' cards: every roster log into the book (judged op by op, as anything else
/// there), and for each roster, who vouched for it. Our own card is skipped; a card that does not
/// verify is ignored, never an error, since it came from a namespace we only read.
pub fn ingest_cards(
    book: &RosterBook,
    cards: &[Vec<u8>],
    me: &EndpointId,
) -> BTreeMap<RosterId, BTreeSet<EndpointId>> {
    let mut vouchers: BTreeMap<RosterId, BTreeSet<EndpointId>> = BTreeMap::new();
    for bytes in cards {
        let Ok((signer, rosters)) = open_card(bytes) else {
            continue;
        };
        if signer == *me {
            continue;
        }
        for ops in rosters {
            // Every roster the log names, known already or not: `ingest` reports only changes,
            // and a card we have read before still vouches.
            let ids: BTreeSet<RosterId> = ops
                .iter()
                .filter_map(|op| {
                    let body = op.verify().ok()?;
                    match body.action {
                        Action::Genesis { .. } => Some(op.id()),
                        _ => body.roster,
                    }
                })
                .collect();
            if book.ingest(ops).is_err() {
                continue;
            }
            for id in ids {
                // A voucher must actually be in what it vouches for, by the log itself.
                if book
                    .state(&id)
                    .is_some_and(|s| s.owner == signer || s.carried.contains(&signer))
                {
                    vouchers.entry(id).or_default().insert(signer);
                }
            }
        }
    }
    vouchers
}

/// The newest invite naming `member` in `roster`, if any: what an `Enroll` cites in an
/// invite-only roster. Whether it still stands is the roster's call when the op is inserted.
pub fn invite_for(book: &RosterBook, roster: &RosterId, member: &EndpointId) -> Option<OpId> {
    book.export(roster)?
        .iter()
        .filter(|op| {
            op.verify().is_ok_and(
                |body| matches!(body.action, Action::Invite { member: m } if m == *member),
            )
        })
        .map(SignedOp::id)
        .last()
}

// ---- planning (pure) --------------------------------------------------------------------------

/// Every repeater that carries `me`, across every roster that carries `me`.
pub fn carriers(states: &[RosterState], me: &EndpointId) -> BTreeSet<EndpointId> {
    states
        .iter()
        .filter(|state| state.carried.contains(me))
        .flat_map(|state| state.repeaters.keys().copied())
        .collect()
}

/// The grants to ask for: each repeater carrying `me`, with the others as its co-carriers, so a
/// trail carried in two people's rosters converges between their repeaters while we sleep.
pub fn grant_plan(states: &[RosterState], me: &EndpointId) -> Vec<(EndpointId, Vec<EndpointId>)> {
    let all = carriers(states, me);
    all.iter()
        .map(|repeater| {
            let others = all
                .iter()
                .copied()
                .filter(|other| other != repeater)
                .take(MAX_CARRIERS)
                .collect();
            (*repeater, others)
        })
        .collect()
}

// ---- the wire ---------------------------------------------------------------------------------

async fn read_frame(recv: &mut RecvStream) -> anyhow::Result<Vec<u8>> {
    let mut header = [0u8; 4];
    recv.read_exact(&mut header)
        .await
        .map_err(|e| anyhow!("read frame header: {e}"))?;
    let len = declared_len(header)?;
    let mut body = vec![0u8; len];
    recv.read_exact(&mut body)
        .await
        .map_err(|e| anyhow!("read frame body: {e}"))?;
    Ok(body)
}

/// One request, one response, one connection.
pub async fn call(
    endpoint: &Endpoint,
    addr: impl Into<EndpointAddr>,
    request: &Request,
) -> anyhow::Result<Response> {
    let addr = addr.into();
    tokio::time::timeout(CALL_TIMEOUT, async {
        let conn = endpoint
            .connect(addr, ALPN)
            .await
            .map_err(|e| anyhow!("dial repeater: {e}"))?;
        let (mut send, mut recv) = conn
            .open_bi()
            .await
            .map_err(|e| anyhow!("open stream: {e}"))?;
        send.write_all(&encode(request)?)
            .await
            .map_err(|e| anyhow!("send request: {e}"))?;
        send.finish().map_err(|e| anyhow!("finish request: {e}"))?;
        let body = read_frame(&mut recv).await?;
        let response: Response = decode_body(&body)?;
        conn.close(0u32.into(), b"done");
        Ok(response)
    })
    .await
    .map_err(|_| anyhow!("repeater call timed out"))?
}

fn endpoint_addr(id: &EndpointId) -> anyhow::Result<EndpointAddr> {
    Ok(EndpointAddr::from(iroh::EndpointId::from_bytes(id)?))
}

fn refusal(response: Response) -> RepeaterError {
    match response {
        Response::Refused { reason } => RepeaterError::Refused(reason),
        _ => RepeaterError::Unexpected,
    }
}

// ---- what a phone does ------------------------------------------------------------------------

/// What a successful claim produced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Claimed {
    pub roster: RosterId,
    pub repeater: EndpointId,
}

/// Claim the repeater whose console printed `link`, into the roster this phone owns (started
/// here if there is none), and list it there. `carry_me` enrols this phone too — the same opt-in
/// every other member makes, offered at the moment it is most obviously wanted.
///
/// The link carries the repeater's full endpoint id, and the dial authenticates the machine that
/// answers as that id; the cert it hands back must then name that machine, this phone and this
/// roster, or nothing is listed. That chain is the whole of the MITM argument: no SAS is needed
/// because the link was read off the repeater's own screen.
pub async fn claim(
    endpoint: &Endpoint,
    key: &SigningKey,
    book: &RosterBook,
    link: &str,
    policy: Policy,
    carry_me: bool,
    now_ms: u64,
) -> Result<Claimed, RepeaterError> {
    let (ticket, secret) = wire::parse_claim_link(link).ok_or(RepeaterError::BadLink)?;
    // A ticket's relay is history, not an address (`relay::scrub_addr`).
    let addr = crate::relay::scrub_addr(
        ticket
            .parse::<iroh_tickets::endpoint::EndpointTicket>()
            .map_err(|_| RepeaterError::BadLink)?
            .endpoint_addr()
            .clone(),
    );
    let repeater = *addr.id.as_bytes();
    let me = key.verifying_key().to_bytes();
    let roster = match book.owned_by(&me) {
        Some(id) => id,
        None => book.create(key, policy, now_ms)?,
    };
    let ops = book.export(&roster).ok_or(RepeaterError::UnknownRoster)?;

    let cert = match call(endpoint, addr.clone(), &Request::Claim { secret, ops }).await? {
        Response::Claimed { cert } => cert,
        other => return Err(refusal(other)),
    };
    let attested = cert.verify()?;
    if attested.repeater != repeater {
        return Err(RepeaterError::Attestation("signed by another machine"));
    }
    if attested.owner != me {
        return Err(RepeaterError::Attestation("names another owner"));
    }
    if attested.roster != roster {
        return Err(RepeaterError::Attestation("names another roster"));
    }

    book.sign(&roster, key, Action::AddRepeater { cert }, now_ms)?;
    let carried = book
        .state(&roster)
        .is_some_and(|state| state.carried.contains(&me));
    if carry_me && !carried {
        book.sign(&roster, key, Action::Enroll { invite: None }, now_ms)?;
    }
    publish_everywhere(endpoint, book, &roster).await;
    Ok(Claimed { roster, repeater })
}

/// Enrol in (`carry = true`) or withdraw from a roster this phone holds, and tell its repeaters.
/// Returns whether the roster now carries us, by our own copy.
pub async fn set_carried(
    endpoint: &Endpoint,
    key: &SigningKey,
    book: &RosterBook,
    roster: &RosterId,
    carry: bool,
    now_ms: u64,
) -> Result<bool, RepeaterError> {
    let me = key.verifying_key().to_bytes();
    let state = book.state(roster).ok_or(RepeaterError::UnknownRoster)?;
    if state.carried.contains(&me) != carry {
        let action = if carry {
            Action::Enroll {
                invite: invite_for(book, roster, &me),
            }
        } else {
            Action::Withdraw
        };
        book.sign(roster, key, action, now_ms)?;
        publish_everywhere(endpoint, book, roster).await;
    }
    Ok(book
        .state(roster)
        .is_some_and(|state| state.carried.contains(&me)))
}

/// What an owner may change about their roster from the phone.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OwnerChange {
    /// Who may enrol from now on. Never retroactive: nobody already carried is dropped.
    Policy(Policy),
    /// Stop carrying a member. Sticky: they cannot enrol again, even in an open roster, until
    /// someone invites them after this.
    RemoveMember(EndpointId),
    /// Take a machine out of the roster.
    RemoveRepeater(EndpointId),
}

/// Sign `change` into a roster this phone owns, and return every repeater to tell: the roster's
/// machines from BEFORE the change, so a machine being removed hears it too.
pub fn sign_owner_change(
    key: &SigningKey,
    book: &RosterBook,
    roster: &RosterId,
    change: OwnerChange,
    now_ms: u64,
) -> Result<BTreeSet<EndpointId>, RepeaterError> {
    let before = book.state(roster).ok_or(RepeaterError::UnknownRoster)?;
    if before.owner != key.verifying_key().to_bytes() {
        return Err(RepeaterError::NotOwner);
    }
    let action = match change {
        OwnerChange::Policy(policy) => Action::SetPolicy { policy },
        OwnerChange::RemoveMember(member) => Action::Remove { member },
        OwnerChange::RemoveRepeater(repeater) => Action::RemoveRepeater { repeater },
    };
    book.sign(roster, key, action, now_ms)?;
    Ok(before.repeaters.into_keys().collect())
}

/// [`sign_owner_change`], then hand the roster to every repeater it names. A removal takes effect
/// on each repeater the moment the op reaches it (the daemon releases a removed member's grants
/// then); one asleep hears it from a sibling, or from us on the next grant pass.
pub async fn change_roster(
    endpoint: &Endpoint,
    key: &SigningKey,
    book: &RosterBook,
    roster: &RosterId,
    change: OwnerChange,
    now_ms: u64,
) -> Result<usize, RepeaterError> {
    let targets = sign_owner_change(key, book, roster, change, now_ms)?;
    Ok(publish_to(endpoint, book, roster, &targets).await)
}

/// Hand our whole copy of `roster` to each of its repeaters. Best-effort: a repeater that is
/// asleep catches up from its siblings, or from us next time.
pub async fn publish_everywhere(
    endpoint: &Endpoint,
    book: &RosterBook,
    roster: &RosterId,
) -> usize {
    let Some(state) = book.state(roster) else {
        return 0;
    };
    let targets: BTreeSet<EndpointId> = state.repeaters.into_keys().collect();
    publish_to(endpoint, book, roster, &targets).await
}

async fn publish_to(
    endpoint: &Endpoint,
    book: &RosterBook,
    roster: &RosterId,
    targets: &BTreeSet<EndpointId>,
) -> usize {
    let Some(ops) = book.export(roster) else {
        return 0;
    };
    let mut reached = 0;
    for repeater in targets {
        let Ok(addr) = endpoint_addr(repeater) else {
            continue;
        };
        let request = Request::Publish { ops: ops.clone() };
        match call(endpoint, addr, &request).await {
            Ok(Response::Published { .. }) => reached += 1,
            Ok(other) => tracing::warn!(response = ?other, "repeater: publish refused"),
            Err(e) => tracing::debug!(error = %e, "repeater: publish failed"),
        }
    }
    reached
}

/// Bring every roster we hold up to date from its repeaters. Only owners, carried members and
/// siblings may fetch, so a roster we merely saw stays as we saw it.
pub async fn refresh(endpoint: &Endpoint, book: &RosterBook) -> usize {
    let mut fetched = 0;
    for state in book.states() {
        for repeater in state.repeaters.keys() {
            let Ok(addr) = endpoint_addr(repeater) else {
                continue;
            };
            if let Ok(Response::Roster { ops }) = call(endpoint, addr, &Request::Fetch).await {
                if book.ingest(ops).is_ok() {
                    fetched += 1;
                }
                break;
            }
        }
    }
    fetched
}

/// One namespace of ours to have carried: its read ticket, and its write key, which signs the
/// proof that it is ours. The key never leaves the phone.
pub struct OwnNamespace {
    pub ticket: String,
    pub secret: [u8; 32],
}

/// What one grant pass achieved.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct GrantReport {
    pub granted: u32,
    pub failed: u32,
}

/// Ask every repeater carrying us to carry each of our namespaces. Best-effort and idempotent:
/// it runs on every start, and a repeater that is asleep is asked again next time.
pub async fn grant(
    endpoint: &Endpoint,
    me: &EndpointId,
    book: &RosterBook,
    namespaces: &[OwnNamespace],
) -> GrantReport {
    let mut report = GrantReport::default();
    for (repeater, carriers) in grant_plan(&book.states(), me) {
        let Ok(addr) = endpoint_addr(&repeater) else {
            continue;
        };
        for ns in namespaces {
            let proof = wire::sign_grant(&SigningKey::from_bytes(&ns.secret), &repeater, me);
            let request = Request::Grant {
                ticket: ns.ticket.clone(),
                proof,
                carriers: carriers.clone(),
            };
            match call(endpoint, addr.clone(), &request).await {
                Ok(Response::Granted { .. }) => report.granted += 1,
                Ok(other) => {
                    tracing::warn!(response = ?other, "repeater: grant refused");
                    report.failed += 1;
                }
                Err(e) => {
                    tracing::debug!(error = %e, "repeater: grant failed");
                    report.failed += 1;
                }
            }
        }
    }
    report
}

#[cfg(test)]
mod tests {
    use super::*;
    use streetcryptid_repeater::roster::{CertBody, RepeaterCert};

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "iroh-location-repeater-{name}-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn key(seed: u8) -> SigningKey {
        SigningKey::from_bytes(&[seed; 32])
    }

    fn id(seed: u8) -> EndpointId {
        key(seed).verifying_key().to_bytes()
    }

    /// A roster owned by `owner` with each of `repeaters` claimed into it and `members` enrolled.
    fn roster_with(book: &RosterBook, owner: u8, repeaters: &[u8], members: &[u8]) -> RosterId {
        let roster = book.create(&key(owner), Policy::Open, 1).unwrap();
        for r in repeaters {
            let cert = RepeaterCert::issue(
                &key(*r),
                &CertBody {
                    roster,
                    owner: id(owner),
                    repeater: id(*r),
                    issued_ms: 1,
                },
            );
            book.sign(&roster, &key(owner), Action::AddRepeater { cert }, 2)
                .unwrap();
        }
        for m in members {
            book.sign(&roster, &key(*m), Action::Enroll { invite: None }, 3)
                .unwrap();
        }
        roster
    }

    #[test]
    fn the_book_survives_a_reopen_and_refuses_a_torn_file() {
        let dir = scratch("reopen");
        let book = RosterBook::open(&dir).unwrap();
        let roster = roster_with(&book, 1, &[10], &[1, 2]);
        drop(book);
        let book = RosterBook::open(&dir).unwrap();
        let state = book.state(&roster).unwrap();
        assert_eq!(state.owner, id(1));
        assert!(state.carried.contains(&id(2)));
        assert_eq!(book.owned_by(&id(1)), Some(roster));
        assert_eq!(book.owned_by(&id(2)), None);

        std::fs::write(dir.join(BOOK_FILE), b"torn").unwrap();
        assert!(RosterBook::open(&dir).is_err());
    }

    #[test]
    fn ingest_takes_signed_ops_from_anyone_and_judges_them() {
        let theirs = RosterBook::open(&scratch("theirs")).unwrap();
        let roster = roster_with(&theirs, 1, &[10], &[1]);
        let ours = RosterBook::open(&scratch("ours")).unwrap();

        // A stray op for a roster we do not hold is dropped, not an error.
        let enroll = theirs
            .sign(&roster, &key(3), Action::Enroll { invite: None }, 4)
            .unwrap();
        assert!(ours.ingest(vec![enroll.clone()]).unwrap().is_empty());

        // The whole log, in any order, arrives as the same roster.
        let mut ops = theirs.export(&roster).unwrap();
        ops.reverse();
        assert_eq!(ours.ingest(ops).unwrap(), BTreeSet::from([roster]));
        assert_eq!(ours.state(&roster), theirs.state(&roster));

        // A forged op (someone else's signature on our member's behalf) changes nothing.
        let mut forged = enroll;
        forged.signer = id(9);
        assert!(ours.ingest(vec![forged]).unwrap().is_empty());
    }

    #[test]
    fn the_plan_names_every_carrier_to_every_other() {
        let book = RosterBook::open(&scratch("plan")).unwrap();
        // My roster, with two repeaters, carries me. A friend's roster, with one, carries me too.
        roster_with(&book, 1, &[10, 11], &[1]);
        roster_with(&book, 2, &[20], &[2, 1]);
        // A third carries only someone else: none of its repeaters are mine to ask.
        roster_with(&book, 3, &[30], &[3]);

        let plan: BTreeMap<_, _> = grant_plan(&book.states(), &id(1)).into_iter().collect();
        assert_eq!(
            plan.keys().copied().collect::<BTreeSet<_>>(),
            BTreeSet::from([id(10), id(11), id(20)])
        );
        let mut expected = vec![id(11), id(20)];
        expected.sort();
        assert_eq!(plan[&id(10)], expected);
        assert!(plan[&id(20)].contains(&id(10)) && plan[&id(20)].contains(&id(11)));
        assert!(grant_plan(&book.states(), &id(4)).is_empty());
    }

    #[test]
    fn a_withdrawal_takes_my_repeaters_out_of_the_plan() {
        let book = RosterBook::open(&scratch("withdraw")).unwrap();
        let roster = roster_with(&book, 2, &[20], &[1]);
        assert_eq!(grant_plan(&book.states(), &id(1)).len(), 1);
        book.sign(&roster, &key(1), Action::Withdraw, 9).unwrap();
        assert!(grant_plan(&book.states(), &id(1)).is_empty());
    }

    #[test]
    fn an_owner_can_remove_a_member_and_they_cannot_simply_enrol_again() {
        let book = RosterBook::open(&scratch("remove")).unwrap();
        // An open roster: anyone may enrol, which is what makes the removal's stickiness matter.
        let roster = roster_with(&book, 1, &[10], &[2]);
        assert!(book.state(&roster).unwrap().carried.contains(&id(2)));

        let targets =
            sign_owner_change(&key(1), &book, &roster, OwnerChange::RemoveMember(id(2)), 5)
                .unwrap();
        assert_eq!(targets, BTreeSet::from([id(10)]));
        assert!(!book.state(&roster).unwrap().carried.contains(&id(2)));

        let _ = book.sign(&roster, &key(2), Action::Enroll { invite: None }, 6);
        assert!(!book.state(&roster).unwrap().carried.contains(&id(2)));

        // An invite made after the removal is what lets them back.
        book.sign(&roster, &key(1), Action::Invite { member: id(2) }, 7)
            .unwrap();
        let _ = book.sign(&roster, &key(2), Action::Enroll { invite: None }, 8);
        assert!(book.state(&roster).unwrap().carried.contains(&id(2)));
    }

    #[test]
    fn only_the_owner_changes_a_roster_and_a_removed_machine_still_hears_it() {
        let book = RosterBook::open(&scratch("owner")).unwrap();
        let roster = roster_with(&book, 1, &[10, 11], &[1, 2]);
        assert!(matches!(
            sign_owner_change(&key(2), &book, &roster, OwnerChange::RemoveMember(id(1)), 5),
            Err(RepeaterError::NotOwner)
        ));

        let targets = sign_owner_change(
            &key(1),
            &book,
            &roster,
            OwnerChange::RemoveRepeater(id(11)),
            6,
        )
        .unwrap();
        assert_eq!(targets, BTreeSet::from([id(10), id(11)]));
        assert_eq!(
            book.state(&roster)
                .unwrap()
                .repeaters
                .keys()
                .copied()
                .collect::<Vec<_>>(),
            vec![id(10)]
        );

        sign_owner_change(
            &key(1),
            &book,
            &roster,
            OwnerChange::Policy(Policy::Invite),
            7,
        )
        .unwrap();
        let state = book.state(&roster).unwrap();
        assert_eq!(state.policy, Policy::Invite);
        assert!(
            state.carried.contains(&id(2)),
            "a policy change is never retroactive"
        );
    }

    #[test]
    fn a_card_carries_my_rosters_and_a_friend_learns_them_from_it() {
        // Sam owns one roster and is carried by June's; a third roster only mentions Sam's friend.
        let sams = RosterBook::open(&scratch("card-sam")).unwrap();
        let owned = roster_with(&sams, 2, &[20], &[2]);
        let junes = roster_with(&sams, 1, &[10], &[2]);
        let other = roster_with(&sams, 3, &[30], &[3]);
        let card = build_card(&key(2), &sams).unwrap();
        assert_eq!(build_card(&key(2), &sams).unwrap(), card, "deterministic");

        let mine = RosterBook::open(&scratch("card-me")).unwrap();
        let vouchers = ingest_cards(&mine, std::slice::from_ref(&card), &id(4));
        let mut expected = vec![owned, junes];
        expected.sort();
        assert_eq!(vouchers.keys().copied().collect::<Vec<_>>(), expected);
        assert!(vouchers.values().all(|v| v == &BTreeSet::from([id(2)])));
        assert!(mine.state(&other).is_none(), "only rosters Sam is in");
        assert_eq!(mine.state(&owned), sams.state(&owned));

        // Reading the same card again still vouches (nothing new to ingest, same answer).
        assert_eq!(
            ingest_cards(&mine, std::slice::from_ref(&card), &id(4)),
            vouchers
        );

        // My own card vouches for nothing; a tampered one is ignored.
        assert!(ingest_cards(&mine, std::slice::from_ref(&card), &id(2)).is_empty());
        let mut tampered = card;
        let last = tampered.len() - 1;
        tampered[last] ^= 1;
        assert!(open_card(&tampered).is_err());
    }

    #[test]
    fn a_card_cannot_vouch_for_a_roster_its_signer_is_not_in() {
        // Mallory republishes June's roster on her own card: the log is real, so it is learned,
        // but she is no voucher for it.
        let junes = RosterBook::open(&scratch("card-june")).unwrap();
        let roster = roster_with(&junes, 1, &[10], &[1]);
        let ops = junes.export(&roster).unwrap();
        let body = postcard::to_allocvec(&CardBody {
            v: CARD_V,
            rosters: vec![ops],
        })
        .unwrap();
        let sig = ed25519_dalek::Signer::sign(&key(6), &card_signing_input(&body));
        let card = postcard::to_allocvec(&SignedCard {
            signer: id(6),
            body,
            sig: sig.to_bytes().to_vec(),
        })
        .unwrap();
        let mine = RosterBook::open(&scratch("card-mallory")).unwrap();
        assert!(ingest_cards(&mine, &[card], &id(4)).is_empty());
        assert!(mine.state(&roster).is_some());
    }

    #[test]
    fn an_invite_is_what_an_enrolment_cites_in_an_invite_only_roster() {
        let book = RosterBook::open(&scratch("invite")).unwrap();
        let roster = book.create(&key(1), Policy::Invite, 1).unwrap();
        assert_eq!(invite_for(&book, &roster, &id(2)), None);
        let invite = book
            .sign(&roster, &key(1), Action::Invite { member: id(2) }, 2)
            .unwrap();
        assert_eq!(invite_for(&book, &roster, &id(2)), Some(invite.id()));
        book.sign(
            &roster,
            &key(2),
            Action::Enroll {
                invite: invite_for(&book, &roster, &id(2)),
            },
            3,
        )
        .unwrap();
        assert!(book.state(&roster).unwrap().carried.contains(&id(2)));
    }

    #[test]
    fn signing_on_an_unknown_roster_is_an_error() {
        let book = RosterBook::open(&scratch("unknown")).unwrap();
        assert!(matches!(
            book.sign(&[7; 32], &key(1), Action::Withdraw, 1),
            Err(RepeaterError::UnknownRoster)
        ));
    }
}
