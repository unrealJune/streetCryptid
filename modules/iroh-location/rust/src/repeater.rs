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
//! * **enroll or withdraw** — the one opt-in there is, which is having one's own trail carried;
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
/// Which of our rosters each repeater has acknowledged, beside the book (REPEATERS.md §4.4).
/// A separate file, not a field of [`BookState`]: postcard cannot read an appended field from an
/// older file, and this one may be lost without harm — losing it only means offering every
/// roster once more.
pub const DELIVERED_FILE: &str = "repeaters-delivered.bin";
const DELIVERED_V: u32 = 1;
/// This phone's repeater preferences (today only auto-invite, §3.2). Lost or torn means the
/// defaults, which invite nobody.
pub const PREFS_FILE: &str = "repeaters-prefs.bin";
const PREFS_V: u32 = 1;

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
struct Prefs {
    v: u32,
    /// Invite each new friend, at pairing, to every invite-only roster this phone may invite to.
    auto_invite: bool,
}

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
    delivered_path: PathBuf,
    /// For each (roster, repeater), our heads when that repeater last answered a `Publish` of
    /// it. A roster whose heads have moved since is owed to that repeater ([`deliver`]).
    delivered: Mutex<BTreeMap<(RosterId, EndpointId), Vec<OpId>>>,
    prefs_path: PathBuf,
    prefs: Mutex<Prefs>,
}

#[derive(Default, Serialize, Deserialize)]
struct DeliveredState {
    v: u32,
    entries: Vec<(RosterId, EndpointId, Vec<OpId>)>,
}

impl RosterBook {
    pub fn open(dir: &Path) -> anyhow::Result<Self> {
        std::fs::create_dir_all(dir)?;
        let delivered_path = dir.join(DELIVERED_FILE);
        // Unreadable means "offer everything again", which is always safe.
        let delivered: BTreeMap<(RosterId, EndpointId), Vec<OpId>> = std::fs::read(&delivered_path)
            .ok()
            .and_then(|raw| postcard::from_bytes::<DeliveredState>(&raw).ok())
            .filter(|state| state.v == DELIVERED_V)
            .map(|state| {
                state
                    .entries
                    .into_iter()
                    .map(|(roster, repeater, heads)| ((roster, repeater), heads))
                    .collect()
            })
            .unwrap_or_default();
        let prefs_path = dir.join(PREFS_FILE);
        let prefs = std::fs::read(&prefs_path)
            .ok()
            .and_then(|raw| postcard::from_bytes::<Prefs>(&raw).ok())
            .filter(|prefs| prefs.v == PREFS_V)
            .unwrap_or_default();
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
            delivered_path,
            delivered: Mutex::new(delivered),
            prefs: Mutex::new(prefs),
            prefs_path,
        })
    }

    /// Whether new friends are invited, at pairing, to the rosters this phone may invite to.
    pub fn auto_invite(&self) -> bool {
        self.prefs
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .auto_invite
    }

    pub fn set_auto_invite(&self, on: bool) -> anyhow::Result<()> {
        let mut prefs = self.prefs.lock().unwrap_or_else(|p| p.into_inner());
        let next = Prefs {
            v: PREFS_V,
            auto_invite: on,
        };
        std::fs::write(&self.prefs_path, postcard::to_allocvec(&next)?)?;
        *prefs = next;
        Ok(())
    }

    /// The rosters this phone has signed an op in: the one it owns, and every one it enrolled
    /// in or withdrew from. These are the rosters it has something to say to — a `Withdraw` is
    /// owed as much as an `Enroll` — and the only ones it dials (§11, G7). A roster merely seen
    /// on a friend's card is not one of them.
    pub fn involved(&self, me: &EndpointId) -> Vec<RosterId> {
        self.lock()
            .values()
            .filter(|roster| roster.export().iter().any(|op| op.signer == *me))
            .map(Roster::id)
            .collect()
    }

    /// Every repeater `roster` has ever listed, removed ones included: a machine the owner took
    /// out must still hear that it was, or it carries on (§11, G2).
    fn ever_listed(roster: &Roster) -> BTreeSet<EndpointId> {
        roster
            .export()
            .iter()
            .filter_map(|op| match op.verify().ok()?.action {
                Action::AddRepeater { cert } => cert.verify().ok().map(|body| body.repeater),
                _ => None,
            })
            .collect()
    }

    /// What is owed: each (roster, repeater) among the rosters `me` is involved in where that
    /// repeater has not acknowledged our current heads.
    pub fn undelivered(&self, me: &EndpointId) -> Vec<(RosterId, EndpointId)> {
        let rosters = self.lock();
        let delivered = self.delivered.lock().unwrap_or_else(|p| p.into_inner());
        let mut owed = Vec::new();
        for roster in rosters.values() {
            if !roster.export().iter().any(|op| op.signer == *me) {
                continue;
            }
            let heads = roster.heads();
            for repeater in Self::ever_listed(roster) {
                if delivered.get(&(roster.id(), repeater)) != Some(&heads) {
                    owed.push((roster.id(), repeater));
                }
            }
        }
        owed
    }

    /// Record that `repeater` took our copy of `roster` as it stood at `heads`.
    pub fn mark_delivered(
        &self,
        roster: &RosterId,
        repeater: &EndpointId,
        heads: Vec<OpId>,
    ) -> anyhow::Result<()> {
        use std::io::Write;
        let mut delivered = self.delivered.lock().unwrap_or_else(|p| p.into_inner());
        if delivered.get(&(*roster, *repeater)) == Some(&heads) {
            return Ok(());
        }
        delivered.insert((*roster, *repeater), heads);
        let state = DeliveredState {
            v: DELIVERED_V,
            entries: delivered
                .iter()
                .map(|((roster, repeater), heads)| (*roster, *repeater, heads.clone()))
                .collect(),
        };
        let bytes = postcard::to_allocvec(&state)?;
        let tmp = self.delivered_path.with_extension("tmp");
        {
            let mut file = std::fs::File::create(&tmp)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
        }
        std::fs::rename(&tmp, &self.delivered_path)?;
        Ok(())
    }

    /// Our heads for `roster` and its ops, read together so a delivery is recorded against
    /// exactly what was sent.
    fn snapshot(&self, roster: &RosterId) -> Option<(Vec<OpId>, Vec<SignedOp>)> {
        self.lock()
            .get(roster)
            .map(|held| (held.heads(), held.export()))
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

/// Take in friends' cards, each paired with the friend whose profile namespace it was read from
/// ([`crate::profile::ProfileDocs::read_key_from_friends`]): every roster log into the book (judged
/// op by op, as anything else there), and for each roster, who vouched for it. Our own card is
/// skipped; a card that does not verify is ignored, never an error, since it came from a
/// namespace we only read.
///
/// A card vouches only when its signer IS the friend it was read from (§11, G9). A friend who
/// republishes a card someone else signed still teaches us the rosters on it, since a log
/// verifies itself, but makes nobody a voucher: otherwise a friend could have a stranger listed
/// as one, and the day vouches decide auto-enrollment, that stranger would count.
pub fn ingest_cards(
    book: &RosterBook,
    cards: &[(EndpointId, Vec<u8>)],
    me: &EndpointId,
) -> BTreeMap<RosterId, BTreeSet<EndpointId>> {
    let mut vouchers: BTreeMap<RosterId, BTreeSet<EndpointId>> = BTreeMap::new();
    for (owner, bytes) in cards {
        let Ok((signer, rosters)) = open_card(bytes) else {
            continue;
        };
        if signer == *me {
            continue;
        }
        let vouches = signer == *owner;
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
            if book.ingest(ops).is_err() || !vouches {
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

/// The newest invite naming `member` in `roster` that still stands
/// ([`Roster::standing_invite`]): what an `Enroll` cites in an invite-only roster.
pub fn invite_for(book: &RosterBook, roster: &RosterId, member: &EndpointId) -> Option<OpId> {
    book.lock().get(roster)?.standing_invite(member)
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

/// Our carriers as push targets: every repeater in a roster that carries us, minus anyone the
/// push already dials explicitly. `TrailDocs::push` hands them to the live engine without waiting
/// on them, so a carrier asleep never extends a push.
pub(crate) fn push_carriers(
    states: &[RosterState],
    me: &EndpointId,
    explicit: &[EndpointAddr],
) -> Vec<EndpointAddr> {
    let dialled: BTreeSet<_> = explicit.iter().map(|addr| *addr.id.as_bytes()).collect();
    carriers(states, me)
        .into_iter()
        .filter(|carrier| carrier != me && !dialled.contains(carrier))
        .filter_map(|carrier| iroh::EndpointId::from_bytes(&carrier).ok())
        .map(EndpointAddr::new)
        .collect()
}

/// Match a remembered trail ticket to a known friend only when its address is unambiguous.
pub(crate) fn friend_namespaces(
    tickets: &[String],
    friends: &BTreeSet<EndpointId>,
) -> Vec<(EndpointId, [u8; 32])> {
    tickets
        .iter()
        .filter_map(|raw| {
            let ticket: iroh_docs::DocTicket = raw.parse().ok()?;
            let owners: BTreeSet<_> = ticket
                .nodes
                .iter()
                .map(|addr| *addr.id.as_bytes())
                .filter(|id| friends.contains(id))
                .collect();
            if owners.len() != 1 {
                return None;
            }
            Some((*owners.first()?, ticket.capability.id().to_bytes()))
        })
        .collect()
}

/// At most three carriers per friend and six distinct carriers per receive pass.
pub fn pull_plan(
    states: &[RosterState],
    friends: &[(EndpointId, [u8; 32])],
    offset: usize,
) -> BTreeMap<[u8; 32], Vec<EndpointId>> {
    const PER_FRIEND: usize = 3;
    const PER_PASS: usize = 6;

    if friends.is_empty() {
        return BTreeMap::new();
    }
    let candidates: Vec<_> = friends
        .iter()
        .map(|(friend, namespace)| (*namespace, carriers(states, friend)))
        .collect();
    let mut selected = BTreeSet::new();
    let mut plan: BTreeMap<[u8; 32], Vec<EndpointId>> = BTreeMap::new();
    for rank in 0..PER_FRIEND {
        for i in 0..candidates.len() {
            let (namespace, repeaters) =
                &candidates[(i + offset % candidates.len()) % candidates.len()];
            if rank >= repeaters.len() {
                continue;
            }
            let repeater = *repeaters
                .iter()
                .nth((rank + offset % repeaters.len()) % repeaters.len())
                .expect("rank is in the set");
            if selected.contains(&repeater) || selected.len() < PER_PASS {
                selected.insert(repeater);
                plan.entry(*namespace).or_default().push(repeater);
            }
        }
    }
    plan
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
        // A refusal is an answer too: the machine is up and reachable (`device.health`).
        crate::contact::note_repeater_contact();
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
/// here if there is none), and list it there. `carry_me` enrolls this phone too — the same opt-in
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

/// Enroll in (`carry = true`) or withdraw from a roster this phone holds, and tell its repeaters.
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
    /// Who may enroll from now on. Never retroactive: nobody already carried is dropped.
    Policy(Policy),
    /// Stop carrying a member. Sticky: they cannot enroll again, even in an open roster, until
    /// someone invites them after this.
    RemoveMember(EndpointId),
    /// Take a machine out of the roster.
    RemoveRepeater(EndpointId),
    /// Let someone invite people to an invite-only roster (§3.2).
    GrantInviter(EndpointId),
    /// Stop someone inviting. Invites they already made stand (§3.3).
    RevokeInviter(EndpointId),
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
        OwnerChange::GrantInviter(member) => Action::Grant {
            member,
            role: streetcryptid_repeater::roster::Role::Inviter,
        },
        OwnerChange::RevokeInviter(member) => Action::Revoke {
            member,
            role: streetcryptid_repeater::roster::Role::Inviter,
        },
    };
    book.sign(roster, key, action, now_ms)?;
    Ok(before.repeaters.into_keys().collect())
}

/// Invite `member` to an invite-only roster this phone may invite to (it owns it or holds
/// `inviter`), and tell its repeaters. An invite carries nobody: `member` still decides, with an
/// `Enroll` that cites it (§4.5). Returns whether a new invite was signed; a member already
/// carried, or with an invite still standing, is not invited twice.
pub async fn invite(
    endpoint: &Endpoint,
    key: &SigningKey,
    book: &RosterBook,
    roster: &RosterId,
    member: &EndpointId,
    now_ms: u64,
) -> Result<bool, RepeaterError> {
    if !sign_invite(key, book, roster, member, now_ms)? {
        return Ok(false);
    }
    publish_everywhere(endpoint, book, roster).await;
    Ok(true)
}

/// The signing half of [`invite`].
pub fn sign_invite(
    key: &SigningKey,
    book: &RosterBook,
    roster: &RosterId,
    member: &EndpointId,
    now_ms: u64,
) -> Result<bool, RepeaterError> {
    let state = book.state(roster).ok_or(RepeaterError::UnknownRoster)?;
    if state.carried.contains(member) || pending_invites(book, roster).contains(member) {
        return Ok(false);
    }
    // The roster judges whether we may (owner or a standing inviter, in the op's own past).
    book.sign(roster, key, Action::Invite { member: *member }, now_ms)?;
    Ok(true)
}

/// Who holds an invite to `roster` and is not carried yet. Whether each invite still stands is
/// the roster's call at enrollment; this is what the owner's screen lists as "invited".
pub fn pending_invites(book: &RosterBook, roster: &RosterId) -> BTreeSet<EndpointId> {
    let Some(state) = book.state(roster) else {
        return BTreeSet::new();
    };
    let invited: BTreeSet<EndpointId> = book
        .export(roster)
        .unwrap_or_default()
        .iter()
        .filter_map(|op| match op.verify().ok()?.action {
            Action::Invite { member } => Some(member),
            _ => None,
        })
        .filter(|member| !state.carried.contains(member))
        .collect();
    invited
        .into_iter()
        .filter(|member| invite_for(book, roster, member).is_some())
        .collect()
}

/// The invite-only rosters `me` may invite `member` to and has not yet: what auto-invite, and
/// the pairing screen's "also invite them", act on (§4.4).
pub fn invite_targets(book: &RosterBook, me: &EndpointId, member: &EndpointId) -> Vec<RosterId> {
    book.states()
        .into_iter()
        .filter(|state| {
            state.policy == Policy::Invite
                && state.inviters.contains(me)
                && *member != state.owner
                && !state.carried.contains(member)
        })
        .map(|state| state.id)
        .filter(|roster| !pending_invites(book, roster).contains(member))
        .collect()
}

/// [`sign_owner_change`], then hand the roster to every repeater it names. A removal takes effect
/// on each repeater the moment the op reaches it (the daemon releases a removed member's grants
/// then); one asleep hears it from a sibling, or from us on a later grant pass ([`deliver`]).
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

/// Hand our whole copy of `roster` to each of its repeaters. A repeater that is asleep catches
/// up from its siblings, or from us on a later grant pass: a delivery is recorded only when the
/// repeater answers, and [`deliver`] offers whatever is still owed.
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
    let Some((heads, ops)) = book.snapshot(roster) else {
        return 0;
    };
    let request = Request::Publish { ops };
    // In parallel: each call is bounded by `CALL_TIMEOUT`, and a sleeping laptop must not hold
    // up the others (one dial at a time cost up to 20 s each).
    let answers = n0_future::join_all(targets.iter().map(|repeater| {
        let request = &request;
        async move {
            let addr = endpoint_addr(repeater).ok()?;
            Some((*repeater, call(endpoint, addr, request).await))
        }
    }))
    .await;
    let mut reached = 0;
    for (repeater, answer) in answers.into_iter().flatten() {
        match answer {
            // `Published` means the repeater judged every op we sent; one it refused would be
            // refused again, so it is delivered either way.
            Ok(Response::Published { .. }) => {
                reached += 1;
                if let Err(e) = book.mark_delivered(roster, &repeater, heads.clone()) {
                    tracing::warn!(error = %e, "repeater: could not record a delivery");
                }
            }
            Ok(other) => tracing::warn!(response = ?other, "repeater: publish refused"),
            Err(e) => tracing::debug!(error = %e, "repeater: publish failed"),
        }
    }
    reached
}

/// Offer every roster op this phone still owes a repeater (REPEATERS.md §4.4): for each roster
/// it has signed an op in, each repeater that roster has ever listed and that has not answered a
/// `Publish` of our current copy. Runs at the start of every grant pass, before the refresh, so
/// an `Enroll`, `Withdraw` or `Remove` made while a repeater slept reaches it the next time both
/// are up — not only when this phone happens to change the same roster again. Returns how many
/// repeaters took one.
pub async fn deliver(endpoint: &Endpoint, me: &EndpointId, book: &RosterBook) -> usize {
    let mut by_roster: BTreeMap<RosterId, BTreeSet<EndpointId>> = BTreeMap::new();
    for (roster, repeater) in book.undelivered(me) {
        by_roster.entry(roster).or_default().insert(repeater);
    }
    let mut reached = 0;
    for (roster, targets) in by_roster {
        reached += publish_to(endpoint, book, &roster, &targets).await;
    }
    reached
}

/// Bring the rosters we take part in up to date from their repeaters: the one we own and the ones
/// that carry us, the only ones a repeater lets us `Fetch`. A roster we merely saw on a card, or
/// withdrew from, is not dialled at all (§11, G7): it would be refused, and the dial alone tells
/// that roster's machines our endpoint id and address before we opted into anything.
pub async fn refresh(endpoint: &Endpoint, me: &EndpointId, book: &RosterBook) -> usize {
    let mut fetched = 0;
    let states = book
        .states()
        .into_iter()
        .filter(|state| state.owner == *me || state.carried.contains(me));
    for state in states {
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

/// How long a push to carriers alone waits for one of them to confirm it holds what was pushed
/// ([`receipt`]). Short: a carrier is never what a push depends on (§5), and on iOS this is wake
/// time. A carrier that misses it still reconciles whenever it next wakes.
pub const RECEIPT_BUDGET: Duration = Duration::from_secs(8);
/// How long to wait between asking the carriers again, while the entries are still crossing.
const RECEIPT_RETRY: Duration = Duration::from_millis(1500);

/// Ask our carriers, in parallel and until `budget` runs out, whether they hold every one of
/// `hashes` in full (`Have`, §5). Returns the first carrier that does. This is the only way a
/// phone with no stash and no awake friend learns that a push landed anywhere (§11, G5); the push
/// itself hands carriers to the live engine without waiting for them.
pub async fn receipt(
    endpoint: &Endpoint,
    carriers: &BTreeSet<EndpointId>,
    hashes: &[[u8; 32]],
    budget: Duration,
) -> Option<EndpointId> {
    if carriers.is_empty() || hashes.is_empty() {
        return None;
    }
    let hashes: Vec<[u8; 32]> = hashes.iter().copied().take(wire::MAX_HAVE_HASHES).collect();
    let request = Request::Have { hashes };
    let deadline = tokio::time::Instant::now() + budget;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return None;
        }
        let answers = n0_future::join_all(carriers.iter().map(|carrier| {
            let request = &request;
            async move {
                let addr = endpoint_addr(carrier).ok()?;
                match tokio::time::timeout(remaining, call(endpoint, addr, request)).await {
                    Ok(Ok(Response::Have { present })) if present.iter().all(|held| *held) => {
                        Some(*carrier)
                    }
                    _ => None,
                }
            }
        }))
        .await;
        if let Some(carrier) = answers.into_iter().flatten().next() {
            return Some(carrier);
        }
        let pause =
            RECEIPT_RETRY.min(deadline.saturating_duration_since(tokio::time::Instant::now()));
        if pause.is_zero() {
            return None;
        }
        tokio::time::sleep(pause).await;
    }
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
    fn an_op_is_owed_to_every_listed_repeater_until_it_answers() {
        let dir = scratch("owed");
        let book = RosterBook::open(&dir).unwrap();
        // Mine (owner 1, repeaters 10 and 11), and a friend's I only saw (owner 5, repeater 12).
        let mine = roster_with(&book, 1, &[10, 11], &[1]);
        let seen = roster_with(&book, 5, &[12], &[5]);
        assert_eq!(book.involved(&id(1)), vec![mine]);
        let owed: BTreeSet<_> = book.undelivered(&id(1)).into_iter().collect();
        assert_eq!(owed, BTreeSet::from([(mine, id(10)), (mine, id(11))]));
        assert!(!owed.iter().any(|(roster, _)| *roster == seen));

        // Repeater 10 answered; 11 was asleep. Only 11 is still owed, across a reopen.
        let (heads, _) = book.snapshot(&mine).unwrap();
        book.mark_delivered(&mine, &id(10), heads).unwrap();
        drop(book);
        let book = RosterBook::open(&dir).unwrap();
        assert_eq!(book.undelivered(&id(1)), vec![(mine, id(11))]);

        // A new op makes it owed to both again — and to a machine just removed, which must hear
        // that it was.
        book.sign(
            &mine,
            &key(1),
            Action::RemoveRepeater { repeater: id(11) },
            5,
        )
        .unwrap();
        let owed: BTreeSet<_> = book.undelivered(&id(1)).into_iter().collect();
        assert_eq!(owed, BTreeSet::from([(mine, id(10)), (mine, id(11))]));

        // A lost or torn delivery record only means offering everything again.
        std::fs::write(dir.join(DELIVERED_FILE), b"torn").unwrap();
        drop(book);
        let book = RosterBook::open(&dir).unwrap();
        assert_eq!(book.undelivered(&id(1)).len(), 2);
    }

    #[test]
    fn a_member_who_withdrew_still_owes_the_withdrawal() {
        let book = RosterBook::open(&scratch("owed-withdraw")).unwrap();
        let roster = roster_with(&book, 5, &[12], &[2]);
        for repeater in [12] {
            let (heads, _) = book.snapshot(&roster).unwrap();
            book.mark_delivered(&roster, &id(repeater), heads).unwrap();
        }
        assert!(book.undelivered(&id(2)).is_empty());
        book.sign(&roster, &key(2), Action::Withdraw, 6).unwrap();
        assert!(!book.state(&roster).unwrap().carried.contains(&id(2)));
        assert_eq!(book.involved(&id(2)), vec![roster]);
        assert_eq!(book.undelivered(&id(2)), vec![(roster, id(12))]);
        // Someone who never signed anything in it owes nothing and dials nothing.
        assert!(book.involved(&id(3)).is_empty());
        assert!(book.undelivered(&id(3)).is_empty());
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
    fn push_adds_only_my_carriers_without_duplicating_explicit_peers() {
        let book = RosterBook::open(&scratch("push-plan")).unwrap();
        roster_with(&book, 1, &[10, 11], &[2]);
        roster_with(&book, 3, &[20], &[4]);
        let explicit = iroh::EndpointId::from_bytes(&id(10)).unwrap();
        let peers = vec![EndpointAddr::new(explicit)];

        let carriers = push_carriers(&book.states(), &id(2), &peers);
        assert_eq!(
            carriers.len(),
            1,
            "10 is dialled already; 20 does not carry us"
        );
        assert_eq!(*carriers[0].id.as_bytes(), id(11));
        assert!(push_carriers(&book.states(), &id(9), &[]).is_empty());
    }

    #[tokio::test]
    async fn native_push_reaches_a_roster_carrier_without_explicit_peers() -> anyhow::Result<()> {
        use iroh::{protocol::Router, RelayMode, SecretKey};
        use iroh_blobs::{store::mem::MemStore, BlobsProtocol};
        use iroh_docs::{protocol::Docs, store::Query};
        use iroh_gossip::net::Gossip;

        let dir = scratch("native-carrier-push");
        let phone = crate::LocationNode::new_at_dirs(
            Some(vec![21; 32]),
            None,
            dir.join("data").to_string_lossy().into_owned(),
            dir.join("state").to_string_lossy().into_owned(),
        )?;
        phone
            .start(vec![], String::new(), false, true, false)
            .await?;

        let endpoint = Endpoint::builder(iroh::endpoint::presets::N0)
            .secret_key(SecretKey::from_bytes(&[22; 32]))
            .relay_mode(RelayMode::Disabled)
            .bind()
            .await?;
        let gossip = Gossip::builder().spawn(endpoint.clone());
        let blobs = MemStore::new();
        let docs = Docs::memory()
            .spawn(endpoint.clone(), (*blobs).clone(), gossip.clone())
            .await?;
        let router = Router::builder(endpoint.clone())
            .accept(iroh_gossip::ALPN, gossip)
            .accept(iroh_docs::ALPN, docs.clone())
            .accept(iroh_blobs::ALPN, BlobsProtocol::new(&blobs, None))
            .spawn();

        let live = phone.live().await?;
        live.endpoint
            .address_lookup()?
            .add(iroh::address_lookup::memory::MemoryLookup::from_endpoint_info([endpoint.addr()]));
        let book = phone.roster_book().await?;
        roster_with(&book, 21, &[22], &[21]);
        let namespace = live.trail.own_namespace();
        let ticket: iroh_docs::DocTicket = live.trail.read_ticket(namespace).await?.parse()?;
        let carrier_doc = docs.import_namespace(ticket.capability).await?;
        carrier_doc.start_sync(Vec::new()).await?;
        live.trail
            .write(namespace, &phone.author, b"sealed fix".to_vec())
            .await?;

        // With no stash and no friend there is nothing to wait for: the carrier is scheduled and
        // the push returns at once.
        tokio::time::timeout(Duration::from_secs(3), phone.push_trail(Vec::new())).await??;

        let key = crate::docs::encode_key(&phone.author);
        tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                if let Some(entry) = carrier_doc
                    .get_one(Query::single_latest_per_key().key_exact(&key).build())
                    .await?
                {
                    if blobs
                        .blobs()
                        .get_bytes(entry.content_hash())
                        .await
                        .is_ok_and(|bytes| bytes.as_ref() == b"sealed fix")
                    {
                        return Ok::<(), anyhow::Error>(());
                    }
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await??;

        phone.shutdown().await?;
        router.shutdown().await?;
        endpoint.close().await;
        std::fs::remove_dir_all(dir)?;
        Ok(())
    }

    #[tokio::test]
    async fn native_pull_persists_a_new_friend_card_after_reopening() -> anyhow::Result<()> {
        use crate::ns_book::{NamespaceBook, PROFILE_BOOK_FILE, TRAIL_BOOK_FILE};

        let dir = scratch("native-card-reopen");
        let writer = crate::LocationNode::new_at_dirs(
            Some(vec![31; 32]),
            None,
            dir.join("writer-data").to_string_lossy().into_owned(),
            dir.join("writer-state").to_string_lossy().into_owned(),
        )?;
        writer
            .start(vec![], String::new(), false, true, false)
            .await?;
        let live = writer.live().await?;
        let writer_book = writer.roster_book().await?;
        let roster = roster_with(&writer_book, 31, &[33], &[31]);
        live.profile
            .publish_key(CARD_KEY, build_card(&key(31), &writer_book)?)
            .await?;
        let profile_ticket = live.profile.ticket().await?;
        let trail_ticket = live.trail.read_ticket(live.trail.own_namespace()).await?;
        let reader = crate::LocationNode::new_at_dirs(
            Some(vec![32; 32]),
            None,
            dir.join("reader-data").to_string_lossy().into_owned(),
            dir.join("reader-state").to_string_lossy().into_owned(),
        )?;
        let reader_state = reader.state_dir.clone();
        for (file, ticket) in [
            (PROFILE_BOOK_FILE, &profile_ticket),
            (TRAIL_BOOK_FILE, &trail_ticket),
        ] {
            let book = NamespaceBook::open(&reader_state, file)?;
            book.add_friend(crate::ns_book::ticket_namespace(ticket)?, ticket)?;
        }

        reader
            .start(vec![], String::new(), false, true, false)
            .await?;
        reader
            .recipient_store()
            .await?
            .set(&[crate::encode_hex(live.endpoint.id().as_bytes())])?;
        let reader_live = reader.live().await?;
        reader_live.endpoint.address_lookup()?.add(
            iroh::address_lookup::memory::MemoryLookup::from_endpoint_info([live.endpoint.addr()]),
        );
        let writer_id = *live.endpoint.id().as_bytes();
        let matched = friend_namespaces(
            &reader_live.trail.friend_tickets(),
            &BTreeSet::from([writer_id]),
        );
        assert_eq!(
            matched.len(),
            1,
            "the remembered trail must select its friend"
        );
        assert!(reader.roster_book().await?.state(&roster).is_none());
        tokio::time::timeout(
            Duration::from_secs(12),
            reader.pull_latest(Vec::new(), Some(10_000), None),
        )
        .await??;
        assert!(reader.roster_book().await?.state(&roster).is_some());

        drop(reader_live);
        reader.shutdown().await?;
        drop(live);
        writer.shutdown().await?;
        assert!(RosterBook::open(&reader_state)?.state(&roster).is_some());
        std::fs::remove_dir_all(dir)?;
        Ok(())
    }

    #[test]
    fn trail_tickets_are_matched_only_to_an_unambiguous_known_friend() {
        let capability =
            iroh_docs::Capability::Write(iroh_docs::NamespaceSecret::from_bytes(&[71; 32]));
        let namespace = capability.id().to_bytes();
        let addr = |seed| EndpointAddr::new(iroh::EndpointId::from_bytes(&id(seed)).unwrap());
        let ticket = iroh_docs::DocTicket {
            capability: capability.clone(),
            nodes: vec![addr(2)],
        };
        let ambiguous = iroh_docs::DocTicket {
            capability,
            nodes: vec![addr(2), addr(3)],
        };
        assert_eq!(
            friend_namespaces(
                &[ticket.to_string(), ambiguous.to_string(), "invalid".into()],
                &BTreeSet::from([id(2), id(3)]),
            ),
            vec![(id(2), namespace)]
        );
        assert!(friend_namespaces(&[ticket.to_string()], &BTreeSet::from([id(4)])).is_empty());
    }

    #[test]
    fn pull_targets_only_friends_carriers_and_respects_both_caps() {
        let book = RosterBook::open(&scratch("pull-plan")).unwrap();
        roster_with(&book, 1, &[10, 11, 12, 13], &[2]);
        roster_with(&book, 3, &[12, 20, 21, 22], &[4]);
        roster_with(&book, 5, &[30], &[6]);

        let plan = pull_plan(
            &book.states(),
            &[(id(2), [2; 32]), (id(4), [4; 32]), (id(6), [6; 32])],
            0,
        );
        assert!(!plan[&[2; 32]].is_empty());
        assert!(!plan[&[4; 32]].is_empty());
        assert_eq!(plan[&[6; 32]], vec![id(30)]);
        assert!(!plan[&[2; 32]].contains(&id(20)));
        assert!(!plan[&[4; 32]].contains(&id(10)));
        let all: BTreeSet<_> = plan.values().flatten().copied().collect();
        assert!(all.len() <= 6);
        assert!(!plan.values().any(|targets| targets.len() > 3));
    }

    #[test]
    fn pull_rotates_which_friends_fit_the_per_pass_cap() {
        let book = RosterBook::open(&scratch("pull-fairness")).unwrap();
        let friends: Vec<_> = (0..7)
            .map(|i| {
                roster_with(&book, 40 + i, &[60 + i], &[50 + i]);
                (id(50 + i), [i; 32])
            })
            .collect();
        let first = pull_plan(&book.states(), &friends, 0);
        let next = pull_plan(&book.states(), &friends, 1);
        assert_eq!(first.len(), 6);
        assert!(!first.contains_key(&[6; 32]));
        assert!(next.contains_key(&[6; 32]));
    }

    #[test]
    fn pull_rotates_carriers_when_a_friend_has_more_than_three() {
        let book = RosterBook::open(&scratch("pull-carrier-fairness")).unwrap();
        roster_with(&book, 1, &[10, 11, 12, 13, 14], &[2]);
        let friends = [(id(2), [2; 32])];
        let first = pull_plan(&book.states(), &friends, 0);
        let next = pull_plan(&book.states(), &friends, 1);
        let all: BTreeSet<_> = (0..5)
            .flat_map(|offset| pull_plan(&book.states(), &friends, offset)[&[2; 32]].clone())
            .collect();
        assert_eq!(first[&[2; 32]].len(), 3);
        assert_ne!(first, next);
        assert_eq!(
            all,
            BTreeSet::from([id(10), id(11), id(12), id(13), id(14)])
        );
    }

    #[test]
    fn an_owner_can_remove_a_member_and_they_cannot_simply_enroll_again() {
        let book = RosterBook::open(&scratch("remove")).unwrap();
        // An open roster: anyone may enroll, which is what makes the removal's stickiness matter.
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
        let from_sam = [(id(2), card.clone())];
        let vouchers = ingest_cards(&mine, &from_sam, &id(4));
        let mut expected = vec![owned, junes];
        expected.sort();
        assert_eq!(vouchers.keys().copied().collect::<Vec<_>>(), expected);
        assert!(vouchers.values().all(|v| v == &BTreeSet::from([id(2)])));
        assert!(mine.state(&other).is_none(), "only rosters Sam is in");
        assert_eq!(mine.state(&owned), sams.state(&owned));

        // Reading the same card again still vouches (nothing new to ingest, same answer).
        assert_eq!(ingest_cards(&mine, &from_sam, &id(4)), vouchers);

        // My own card vouches for nothing; a tampered one is ignored.
        assert!(ingest_cards(&mine, &from_sam, &id(2)).is_empty());
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
        assert!(ingest_cards(&mine, &[(id(6), card)], &id(4)).is_empty());
        assert!(mine.state(&roster).is_some());
    }

    #[test]
    fn a_card_vouches_only_from_the_friend_whose_profile_it_was_read_from() {
        // June's genuine card, republished in Mallory's profile namespace: the roster is learned,
        // but June is not a voucher on Mallory's say-so (§11, G9).
        let junes = RosterBook::open(&scratch("card-relayed-june")).unwrap();
        let roster = roster_with(&junes, 1, &[10], &[1]);
        let card = build_card(&key(1), &junes).unwrap();
        let mine = RosterBook::open(&scratch("card-relayed-me")).unwrap();
        assert!(ingest_cards(&mine, &[(id(6), card.clone())], &id(4)).is_empty());
        assert!(mine.state(&roster).is_some());
        // Read from June's own namespace, it vouches.
        let vouchers = ingest_cards(&mine, &[(id(1), card)], &id(4));
        assert_eq!(vouchers.get(&roster), Some(&BTreeSet::from([id(1)])));
    }

    #[test]
    fn an_invite_is_what_an_enrollment_cites_in_an_invite_only_roster() {
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
    fn an_inviter_invites_new_friends_once_and_only_to_invite_rosters() {
        let dir = scratch("invite-plan");
        let book = RosterBook::open(&dir).unwrap();
        let closed = book.create(&key(1), Policy::Invite, 1).unwrap();
        let open = book.create(&key(1), Policy::Open, 1).unwrap();
        // Someone else's invite-only roster, where I am not an inviter.
        let theirs = book.create(&key(5), Policy::Invite, 1).unwrap();
        assert_eq!(invite_targets(&book, &id(1), &id(2)), vec![closed]);
        assert!(!invite_targets(&book, &id(1), &id(2)).contains(&open));
        assert!(!invite_targets(&book, &id(1), &id(2)).contains(&theirs));

        assert!(sign_invite(&key(1), &book, &closed, &id(2), 2).unwrap());
        assert_eq!(pending_invites(&book, &closed), BTreeSet::from([id(2)]));
        assert!(invite_targets(&book, &id(1), &id(2)).is_empty());
        assert!(
            !sign_invite(&key(1), &book, &closed, &id(2), 3).unwrap(),
            "not twice"
        );

        // An inviter the owner granted may invite too; once revoked, not any more.
        sign_owner_change(&key(1), &book, &closed, OwnerChange::GrantInviter(id(3)), 4).unwrap();
        assert_eq!(invite_targets(&book, &id(3), &id(4)), vec![closed]);
        assert!(sign_invite(&key(3), &book, &closed, &id(4), 5).unwrap());
        sign_owner_change(
            &key(1),
            &book,
            &closed,
            OwnerChange::RevokeInviter(id(3)),
            6,
        )
        .unwrap();
        assert!(invite_targets(&book, &id(3), &id(6)).is_empty());
        assert!(sign_invite(&key(3), &book, &closed, &id(6), 7).is_err());

        // Auto-invite is off until set, and survives a reopen.
        assert!(!book.auto_invite());
        book.set_auto_invite(true).unwrap();
        drop(book);
        assert!(RosterBook::open(&dir).unwrap().auto_invite());
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
