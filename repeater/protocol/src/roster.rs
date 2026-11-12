//! The **repeater roster**: whose trails a person's repeaters carry, who may change that, and which
//! machines are that person's repeaters. Design: streetCryptid `docs/social/REPEATERS.md` §3–§4.
//!
//! A roster belongs to one **owner** — the phone that claimed its first repeater — and is a
//! hash-linked log of operations, each signed by the endpoint key of the phone that made it.
//! Repeaters replicate the log between themselves and enforce it; phones read it and check it.
//! Nobody has to trust a repeater about it: every rule below is decided from signatures alone, by
//! anyone holding the ops.
//!
//! **What the roster governs is carrying, never reading.** Anyone may pull ciphertext from a
//! repeater, as from any other replica (§2.1). The roster decides only whose namespaces a repeater
//! holds and accepts pushes for.
//!
//! ## Attestation: how a repeater is linked to its owner
//! Four signatures and one handshake, each by a different party, so no single key can put a
//! machine in someone's roster or a roster on someone's machine:
//!
//! 1. **`Genesis`**, signed by the owner, names the owner. Its op id *is* the roster id.
//! 2. A **[`RepeaterCert`]**, signed by the *repeater's* key, binds `(roster id, owner, repeater)`.
//!    A repeater issues one only to a phone that presented its one-time claim secret, which only
//!    someone at its console has (`repeater.rs`). An owner therefore cannot list a machine that
//!    did not agree to be theirs.
//! 3. **`AddRepeater { cert }`**, signed by the owner, puts that cert in the log. A repeater
//!    therefore cannot add itself, or its siblings, to a roster.
//! 4. A friend's **`RepeaterCard`** (app side, signed by a friend already verified by SAS) names
//!    the roster id and head, which is how a phone learns of a roster without trusting whoever
//!    told it.
//!
//! The handshake: dialling a repeater over iroh authenticates the endpoint key that answered, so
//! "the machine I am talking to" and "the repeater in the cert" are the same key or the dial fails.
//!
//! ## Signed bytes, never a re-encode
//! An op is kept as the exact bytes its signer signed ([`SignedOp::body`]) and decoded only after
//! the signature checks out. `PairMsg` and `ProfileRecord` sign a re-encode of the decoded struct,
//! which is why appending a field to either is a breaking change; this log does not share that
//! trap — a reader that decodes an older or newer body still verifies the bytes it was given.
//!
//! ## Concurrency rules
//! Every op names its causal parents, so the log is a DAG and any two replicas that hold the same
//! ops derive the same state whatever order the ops arrived in (`order_does_not_matter`). Every
//! rule is phrased in terms of *ancestors* — what the signer had seen — never arrival order:
//!
//! * an op counts only if its signer held the needed role **in the op's own causal past**; an op
//!   that does not is refused at insert, because its past can never change;
//! * a **removal beats anything concurrent with it**: an invite concurrent with its inviter's
//!   revocation does not stand, and an enrollment concurrent with (or followed by) a removal or a
//!   withdrawal ends; a revocation made *after* an invite stops later invites, not that one;
//! * a `Remove` is sticky against re-enrollment, until an invitation made *after* it;
//! * a `SetPolicy` applies to ops that have seen it, never retroactively; two concurrent ones
//!   resolve to `Invite`, the stricter;
//! * an **uninvited** enrollment concurrent with a `SetPolicy { Invite }` does not stand. Without
//!   this, closing a roster closed nothing: anyone holding the genesis (which friends' cards
//!   publish) could sign an `Enroll` on the open genesis alone, and its past would say "open".
//!   An enrollment the owner had SEEN when closing is in that op's past, so it is not concurrent
//!   and keeps standing — closing is still never retroactive.
//!
//! Pure: no iroh, no tokio. ed25519 is ed25519-dalek 2, the same as the app's core, so the phone
//! signs ops with the code that verifies them here.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use serde::{Deserialize, Serialize};

/// A 32-byte iroh endpoint id (an ed25519 public key).
pub type EndpointId = [u8; 32];
/// The id of one op: a BLAKE3 hash over its signer, signed bytes and signature.
pub type OpId = [u8; 32];
/// A roster's id: the op id of its genesis.
pub type RosterId = OpId;

/// Domain separation for op signatures.
const OP_CTX: &[u8] = b"streetcryptid/repeater/roster-op/v1";
/// Domain separation for repeater certificates.
const CERT_CTX: &[u8] = b"streetcryptid/repeater/cert/v1";
/// Domain separation for op ids.
const OP_ID_CTX: &str = "streetcryptid repeater roster op id v1";

/// The most accepted ops one roster holds. A roster is a handful of people and a few machines;
/// this bounds what a hostile member of an open roster can make every repeater store.
///
/// The last [`OWNER_RESERVE`] of them are the owner's alone, so a roster that strangers have
/// filled can still be closed and cleaned by the one person entitled to: a flood of valid
/// `Enroll`s from throwaway keys in an `open` roster stops further enrollments, never the owner's
/// `SetPolicy` or `Remove`. Ops held aside for a missing parent are bounded separately
/// ([`MAX_PENDING`]) and never count here, because they cost their sender nothing to mint.
pub const MAX_OPS: usize = 4096;
/// The share of [`MAX_OPS`] only the owner's ops may use.
pub const OWNER_RESERVE: usize = 512;
/// The most accepted ops any one signer other than the owner may have in a roster. A member
/// enrolls, withdraws and enrolls again a handful of times in a lifetime; an inviter invites
/// people. Without it one key could spend the whole non-owner share by itself.
pub const MAX_OPS_PER_SIGNER: usize = 128;
/// The most ops held aside for a missing parent, per class (the owner's, and everyone else's).
/// Pending ops are in memory only and are dropped on a restart; a full queue refuses a new one,
/// which its sender offers again later. The owner's class cannot be filled by anyone else,
/// because only the owner's key signs an op the owner's queue will hold.
pub const MAX_PENDING: usize = 256;
/// The largest signed op body accepted.
pub const MAX_OP_BYTES: usize = 1024;
/// The most parents one op may name.
pub const MAX_PARENTS: usize = 16;

/// Who may ask a roster's repeaters to carry their trail.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Policy {
    /// Carrying needs an `Invite` from the owner or an inviter, then the person's `Enroll`.
    Invite,
    /// Anyone who learns of the roster may `Enroll` directly.
    Open,
}

/// A role beyond plain membership. The owner holds every role implicitly.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Role {
    /// May invite people to an `Invite` roster.
    Inviter,
}

/// What a repeater attests about itself when it is claimed. Signed by the repeater.
///
/// Its bytes are the four fields postcard-encoded in order, then, **only when the repeater has a
/// name**, `Option<String>` (`Some(name)`). An unnamed cert is therefore byte-identical to one
/// from before names existed, and older readers, which decode with `postcard::from_bytes` and
/// ignore what follows, read a named cert as the same four fields. The signature covers the raw
/// bytes, so verification never depends on how a reader decodes them. Append any later field the
/// same way: after this one, and only when present.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CertBody {
    pub roster: RosterId,
    pub owner: EndpointId,
    pub repeater: EndpointId,
    pub issued_ms: u64,
    /// What the person at the machine called it ("Living room PC"), shown in the app wherever
    /// the machine is. Set by the machine and signed by it, so neither its owner nor anyone
    /// relaying the roster can put words in its mouth. At most [`MAX_REPEATER_NAME`] characters,
    /// with no control characters ([`repeater_name`]).
    pub name: Option<String>,
}

/// The longest repeater name, in characters.
pub const MAX_REPEATER_NAME: usize = 40;

/// A name as a repeater may carry it: trimmed, inner whitespace collapsed to single spaces,
/// control characters refused, at most [`MAX_REPEATER_NAME`] characters. `None` for an empty
/// or unusable name, which means "no name".
pub fn repeater_name(text: &str) -> Option<String> {
    if text.chars().any(|c| c.is_control() && !c.is_whitespace()) {
        return None;
    }
    let name = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let count = name.chars().count();
    (count > 0 && count <= MAX_REPEATER_NAME).then_some(name)
}

/// The fields every cert has had since v0.3.0, exactly as they are encoded.
#[derive(Serialize, Deserialize)]
struct CertFields {
    roster: RosterId,
    owner: EndpointId,
    repeater: EndpointId,
    issued_ms: u64,
}

impl CertBody {
    fn encode(&self) -> Vec<u8> {
        let mut bytes = postcard::to_allocvec(&CertFields {
            roster: self.roster,
            owner: self.owner,
            repeater: self.repeater,
            issued_ms: self.issued_ms,
        })
        .expect("a cert body always serializes");
        if let Some(name) = &self.name {
            bytes.extend(
                postcard::to_allocvec(&Some(name.as_str())).expect("a name always serializes"),
            );
        }
        bytes
    }

    fn decode(bytes: &[u8]) -> Result<Self, RosterError> {
        let malformed = RosterError::Malformed("cert body");
        let (fields, rest): (CertFields, _) =
            postcard::take_from_bytes(bytes).map_err(|_| malformed.clone())?;
        // Nothing after the fields: a cert from before names, or an unnamed one. Something after
        // them that is not a valid name is refused rather than shown: the machine signed it, but
        // the app should never display what `repeater_name` would not have let it set.
        let name = if rest.is_empty() {
            None
        } else {
            let (name, _): (Option<String>, _) =
                postcard::take_from_bytes(rest).map_err(|_| malformed.clone())?;
            match name {
                Some(name) if repeater_name(&name).as_deref() == Some(name.as_str()) => Some(name),
                Some(_) => return Err(malformed),
                None => None,
            }
        };
        Ok(Self {
            roster: fields.roster,
            owner: fields.owner,
            repeater: fields.repeater,
            issued_ms: fields.issued_ms,
            name,
        })
    }
}

/// A repeater's signed statement that it belongs to `roster`, claimed by `owner`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RepeaterCert {
    /// [`CertBody`]'s bytes, exactly as signed.
    pub body: Vec<u8>,
    pub sig: Vec<u8>,
}

impl RepeaterCert {
    /// Issue a certificate with the repeater's own key.
    pub fn issue(repeater_key: &SigningKey, body: &CertBody) -> Self {
        let body = body.encode();
        let sig = repeater_key.sign(&signing_input(CERT_CTX, &body));
        Self {
            body,
            sig: sig.to_bytes().to_vec(),
        }
    }

    /// Check the signature against the repeater named inside, and return what it attests.
    pub fn verify(&self) -> Result<CertBody, RosterError> {
        let body = CertBody::decode(&self.body)?;
        verify_sig(&body.repeater, CERT_CTX, &self.body, &self.sig)?;
        Ok(body)
    }
}

/// One roster operation. Append new variants only at the end (postcard tags by position).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum Action {
    /// Founds a roster. Only valid as the first op, signed by `owner`.
    Genesis {
        owner: EndpointId,
        policy: Policy,
        /// Makes two rosters by the same owner distinct.
        nonce: [u8; 16],
    },
    /// Owner only.
    SetPolicy { policy: Policy },
    /// Owner only; the cert must be the named repeater's, for this roster and owner.
    AddRepeater { cert: RepeaterCert },
    /// Owner only.
    RemoveRepeater { repeater: EndpointId },
    /// Owner or an inviter: offer `member` carrying in an `Invite` roster.
    Invite { member: EndpointId },
    /// Signed by the member: "carry my trail". Names the invite it answers, if any.
    Enroll { invite: Option<OpId> },
    /// Owner only.
    Grant { member: EndpointId, role: Role },
    /// Owner only.
    Revoke { member: EndpointId, role: Role },
    /// Owner only: stop carrying `member`, and drop any role they hold.
    Remove { member: EndpointId },
    /// Signed by the member: stop carrying my trail.
    Withdraw,
}

/// The signed part of an op.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpBody {
    /// `None` only for `Genesis`.
    pub roster: Option<RosterId>,
    /// The heads the signer had seen. Empty only for `Genesis`.
    pub parents: Vec<OpId>,
    /// Signer's wall clock. Informational — no rule reads it.
    pub ts_ms: u64,
    pub action: Action,
}

/// An op as it travels and as it is stored: the exact signed bytes plus the signature.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SignedOp {
    pub signer: EndpointId,
    pub body: Vec<u8>,
    pub sig: Vec<u8>,
}

impl SignedOp {
    /// Sign `body` with an endpoint's key.
    pub fn sign(key: &SigningKey, body: &OpBody) -> Self {
        let bytes = postcard::to_allocvec(body).expect("an op body always serializes");
        let sig = key.sign(&signing_input(OP_CTX, &bytes));
        Self {
            signer: key.verifying_key().to_bytes(),
            body: bytes,
            sig: sig.to_bytes().to_vec(),
        }
    }

    /// This op's id.
    pub fn id(&self) -> OpId {
        let mut hasher = blake3::Hasher::new_derive_key(OP_ID_CTX);
        hasher.update(&self.signer);
        hasher.update(&(self.body.len() as u64).to_le_bytes());
        hasher.update(&self.body);
        hasher.update(&self.sig);
        *hasher.finalize().as_bytes()
    }

    /// Check the signature over the stored bytes, then decode them.
    pub fn verify(&self) -> Result<OpBody, RosterError> {
        if self.body.len() > MAX_OP_BYTES {
            return Err(RosterError::TooLarge);
        }
        verify_sig(&self.signer, OP_CTX, &self.body, &self.sig)?;
        postcard::from_bytes(&self.body).map_err(|_| RosterError::Malformed("op body"))
    }
}

fn signing_input(ctx: &[u8], body: &[u8]) -> Vec<u8> {
    let mut msg = Vec::with_capacity(ctx.len() + body.len());
    msg.extend_from_slice(ctx);
    msg.extend_from_slice(body);
    msg
}

fn verify_sig(signer: &EndpointId, ctx: &[u8], body: &[u8], sig: &[u8]) -> Result<(), RosterError> {
    let key = VerifyingKey::from_bytes(signer).map_err(|_| RosterError::BadSignature)?;
    let sig = Signature::from_slice(sig).map_err(|_| RosterError::BadSignature)?;
    key.verify_strict(&signing_input(ctx, body), &sig)
        .map_err(|_| RosterError::BadSignature)
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RosterError {
    #[error("signature does not verify")]
    BadSignature,
    #[error("malformed {0}")]
    Malformed(&'static str),
    #[error("op is larger than the 1024-byte limit")]
    TooLarge,
    #[error("roster is full")]
    Full,
    #[error("not a genesis op: {0}")]
    BadGenesis(&'static str),
    #[error("op belongs to another roster")]
    WrongRoster,
    #[error("bad parents: {0}")]
    BadParents(&'static str),
    #[error("not allowed: {0}")]
    Unauthorized(&'static str),
}

/// What [`Roster::insert`] did with an op.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Inserted {
    /// Accepted (and any pending ops it unblocked were tried too).
    Accepted,
    /// Already held.
    Known,
    /// Held aside until its parents arrive.
    Pending,
}

/// A set of op indices (insertion positions). An op's ancestors are all at lower indices.
#[derive(Debug, Clone, Default)]
struct Bits(Vec<u64>);

impl Bits {
    fn set(&mut self, i: usize) {
        let word = i / 64;
        if self.0.len() <= word {
            self.0.resize(word + 1, 0);
        }
        self.0[word] |= 1 << (i % 64);
    }

    fn has(&self, i: usize) -> bool {
        self.0
            .get(i / 64)
            .map(|word| word & (1 << (i % 64)) != 0)
            .unwrap_or(false)
    }

    fn union(&mut self, other: &Bits) {
        if self.0.len() < other.0.len() {
            self.0.resize(other.0.len(), 0);
        }
        for (a, b) in self.0.iter_mut().zip(&other.0) {
            *a |= b;
        }
    }
}

#[derive(Debug, Clone)]
struct Node {
    op: SignedOp,
    body: OpBody,
    /// Every op this one causally follows.
    ancestors: Bits,
    /// Whether any accepted op names this one as a parent.
    has_children: bool,
}

/// Which ops a question is asked over: the whole log, or one op's causal past.
#[derive(Clone, Copy)]
enum Scope<'a> {
    All,
    Past(&'a Bits),
}

impl Scope<'_> {
    fn contains(&self, i: usize) -> bool {
        match self {
            Scope::All => true,
            Scope::Past(bits) => bits.has(i),
        }
    }
}

/// The derived state of a roster.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RosterState {
    pub id: RosterId,
    pub owner: EndpointId,
    pub policy: Policy,
    /// Whose trails the repeaters carry.
    pub carried: BTreeSet<EndpointId>,
    /// Who may invite (the owner included).
    pub inviters: BTreeSet<EndpointId>,
    /// The roster's repeaters and what each attested.
    pub repeaters: BTreeMap<EndpointId, CertBody>,
}

/// A roster: verified ops in an order where every parent precedes its children.
#[derive(Debug, Clone)]
pub struct Roster {
    id: RosterId,
    owner: EndpointId,
    genesis_policy: Policy,
    nodes: Vec<Node>,
    index: HashMap<OpId, usize>,
    pending: HashMap<OpId, (SignedOp, OpBody)>,
    /// Accepted ops per signer, for [`MAX_OPS_PER_SIGNER`].
    per_signer: HashMap<EndpointId, usize>,
}

impl Roster {
    /// Found a roster: a signed `Genesis` with no parents, signed by the owner it names.
    pub fn from_genesis(op: SignedOp) -> Result<Self, RosterError> {
        let body = op.verify()?;
        let (owner, policy) = match body.action {
            Action::Genesis { owner, policy, .. } => (owner, policy),
            _ => return Err(RosterError::BadGenesis("first op is not Genesis")),
        };
        if body.roster.is_some() || !body.parents.is_empty() {
            return Err(RosterError::BadGenesis("genesis names a roster or parents"));
        }
        if op.signer != owner {
            return Err(RosterError::BadGenesis(
                "genesis is not signed by its owner",
            ));
        }
        let id = op.id();
        let mut index = HashMap::new();
        index.insert(id, 0);
        Ok(Self {
            id,
            owner,
            genesis_policy: policy,
            nodes: vec![Node {
                op,
                body,
                ancestors: Bits::default(),
                has_children: false,
            }],
            index,
            pending: HashMap::new(),
            per_signer: HashMap::new(),
        })
    }

    /// Rebuild a roster from an export: genesis first, then anything, in any order.
    pub fn from_ops(ops: Vec<SignedOp>) -> Result<Self, RosterError> {
        let mut ops = ops.into_iter();
        let genesis = ops.next().ok_or(RosterError::BadGenesis("no ops"))?;
        let mut roster = Self::from_genesis(genesis)?;
        for op in ops {
            // An export can carry ops a replica refused; they are not fatal to the rest.
            let _ = roster.insert(op);
        }
        Ok(roster)
    }

    pub fn id(&self) -> RosterId {
        self.id
    }

    pub fn owner(&self) -> EndpointId {
        self.owner
    }

    pub fn len(&self) -> usize {
        self.nodes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }

    pub fn pending_len(&self) -> usize {
        self.pending.len()
    }

    pub fn contains(&self, id: &OpId) -> bool {
        self.index.contains_key(id)
    }

    /// The ops nothing else follows yet — what a new op should name as its parents.
    pub fn heads(&self) -> Vec<OpId> {
        let mut heads: Vec<OpId> = self
            .nodes
            .iter()
            .filter(|node| !node.has_children)
            .map(|node| node.op.id())
            .collect();
        heads.sort();
        heads
    }

    /// Every accepted op, genesis first, parents before children.
    pub fn export(&self) -> Vec<SignedOp> {
        self.nodes.iter().map(|node| node.op.clone()).collect()
    }

    /// Verify `op` and add it: accepted if its parents are here and it is valid in its own past,
    /// held aside if a parent is missing, refused otherwise.
    pub fn insert(&mut self, op: SignedOp) -> Result<Inserted, RosterError> {
        let id = op.id();
        if self.index.contains_key(&id) || self.pending.contains_key(&id) {
            return Ok(Inserted::Known);
        }
        // The signature first: nothing unsigned may count toward any limit, or anyone could
        // spend them with garbage.
        let body = op.verify()?;
        if body.roster != Some(self.id) {
            return Err(RosterError::WrongRoster);
        }
        if matches!(body.action, Action::Genesis { .. }) {
            return Err(RosterError::BadGenesis("a second genesis"));
        }
        if body.parents.is_empty() || body.parents.len() > MAX_PARENTS {
            return Err(RosterError::BadParents("must name 1..=16 parents"));
        }
        let mut seen = std::collections::HashSet::new();
        if !body.parents.iter().all(|p| seen.insert(*p)) {
            return Err(RosterError::BadParents("duplicate parent"));
        }
        if body.parents.iter().any(|p| !self.index.contains_key(p)) {
            let owners = op.signer == self.owner;
            let held = self
                .pending
                .values()
                .filter(|(held, _)| (held.signer == self.owner) == owners)
                .count();
            if held >= MAX_PENDING {
                return Err(RosterError::Full);
            }
            self.pending.insert(id, (op, body));
            return Ok(Inserted::Pending);
        }
        self.accept(op, body)?;
        self.drain_pending();
        Ok(Inserted::Accepted)
    }

    /// Whether one more op by `signer` fits: [`MAX_OPS`] for the owner, the non-reserved share
    /// and [`MAX_OPS_PER_SIGNER`] for everyone else.
    fn has_room_for(&self, signer: &EndpointId) -> bool {
        if *signer == self.owner {
            return self.nodes.len() < MAX_OPS;
        }
        self.nodes.len() < MAX_OPS - OWNER_RESERVE
            && self.per_signer.get(signer).copied().unwrap_or(0) < MAX_OPS_PER_SIGNER
    }

    fn accept(&mut self, op: SignedOp, body: OpBody) -> Result<(), RosterError> {
        if !self.has_room_for(&op.signer) {
            return Err(RosterError::Full);
        }
        let mut ancestors = Bits::default();
        for parent in &body.parents {
            let i = self.index[parent];
            ancestors.set(i);
            ancestors.union(&self.nodes[i].ancestors);
        }
        self.check(&op.signer, &body, &ancestors)?;
        for parent in &body.parents {
            let i = self.index[parent];
            self.nodes[i].has_children = true;
        }
        let id = op.id();
        self.index.insert(id, self.nodes.len());
        *self.per_signer.entry(op.signer).or_insert(0) += 1;
        self.nodes.push(Node {
            op,
            body,
            ancestors,
            has_children: false,
        });
        Ok(())
    }

    /// Retry held ops until a pass accepts nothing. Ops that turn out invalid are dropped.
    fn drain_pending(&mut self) {
        loop {
            let ready: Vec<OpId> = self
                .pending
                .iter()
                .filter(|(_, (_, body))| body.parents.iter().all(|p| self.index.contains_key(p)))
                .map(|(id, _)| *id)
                .collect();
            if ready.is_empty() {
                return;
            }
            // Deterministic order within a pass; acceptance itself does not depend on it.
            let mut ready = ready;
            ready.sort();
            for id in ready {
                if let Some((op, body)) = self.pending.remove(&id) {
                    let _ = self.accept(op, body);
                }
            }
        }
    }

    /// Is `body`, signed by `signer`, allowed given exactly the ops in `past`?
    fn check(&self, signer: &EndpointId, body: &OpBody, past: &Bits) -> Result<(), RosterError> {
        let scope = Scope::Past(past);
        let owner_only = |what| {
            if *signer == self.owner {
                Ok(())
            } else {
                Err(RosterError::Unauthorized(what))
            }
        };
        match &body.action {
            Action::Genesis { .. } => Err(RosterError::BadGenesis("a second genesis")),
            Action::SetPolicy { .. } => owner_only("only the owner sets the policy"),
            Action::RemoveRepeater { .. } => owner_only("only the owner removes repeaters"),
            Action::AddRepeater { cert } => {
                owner_only("only the owner adds repeaters")?;
                let attested = cert.verify()?;
                if attested.roster != self.id || attested.owner != self.owner {
                    return Err(RosterError::Unauthorized(
                        "the repeater attested a different roster or owner",
                    ));
                }
                Ok(())
            }
            Action::Grant { member, .. } | Action::Revoke { member, .. } => {
                owner_only("only the owner grants roles")?;
                if *member == self.owner {
                    return Err(RosterError::Unauthorized("the owner's roles are fixed"));
                }
                Ok(())
            }
            Action::Remove { member } => {
                owner_only("only the owner removes members")?;
                if *member == self.owner {
                    return Err(RosterError::Unauthorized("the owner cannot be removed"));
                }
                Ok(())
            }
            Action::Invite { .. } => {
                if self.is_inviter(signer, scope) {
                    Ok(())
                } else {
                    Err(RosterError::Unauthorized(
                        "only the owner or an inviter invites",
                    ))
                }
            }
            Action::Enroll { invite } => self.enroll_allowed(signer, *invite, scope),
            Action::Withdraw => {
                if self.enrolls_of(signer, scope).next().is_some() {
                    Ok(())
                } else {
                    Err(RosterError::Unauthorized(
                        "withdrawing without having enrolled",
                    ))
                }
            }
        }
    }

    fn enroll_allowed(
        &self,
        signer: &EndpointId,
        invite: Option<OpId>,
        scope: Scope<'_>,
    ) -> Result<(), RosterError> {
        if *signer == self.owner {
            return Ok(());
        }
        if self.is_banned(signer, scope) {
            return Err(RosterError::Unauthorized(
                "removed, and not invited again since",
            ));
        }
        if let Some(invite) = invite {
            let valid = self.index.get(&invite).is_some_and(|&i| {
                scope.contains(i)
                    && matches!(&self.nodes[i].body.action,
                        Action::Invite { member } if member == signer)
                    && self.invite_survives(i, scope)
            });
            if !valid {
                return Err(RosterError::Unauthorized(
                    "the invite is not one this member had seen",
                ));
            }
            return Ok(());
        }
        if self.policy_in(scope) == Policy::Open {
            Ok(())
        } else {
            Err(RosterError::Unauthorized("this roster is invite-only"))
        }
    }

    // ---- questions over a scope -------------------------------------------------------------

    fn indices<'a>(&'a self, scope: Scope<'a>) -> impl Iterator<Item = usize> + 'a {
        (0..self.nodes.len()).filter(move |i| scope.contains(*i))
    }

    /// Whether op `r` is NOT in op `x`'s past — i.e. `r` is concurrent with `x` or after it.
    fn unseen_by(&self, r: usize, x: usize) -> bool {
        r != x && !self.nodes[x].ancestors.has(r)
    }

    fn policy_in(&self, scope: Scope<'_>) -> Policy {
        let sets: Vec<usize> = self
            .indices(scope)
            .filter(|&i| matches!(self.nodes[i].body.action, Action::SetPolicy { .. }))
            .collect();
        // The latest ones: not in the past of another.
        let latest = sets.iter().filter(|&&a| {
            !sets
                .iter()
                .any(|&b| b != a && self.nodes[b].ancestors.has(a))
        });
        let mut policy = None;
        for &i in latest {
            if let Action::SetPolicy { policy: p } = self.nodes[i].body.action {
                policy = Some(match (policy, p) {
                    (Some(Policy::Invite), _) | (_, Policy::Invite) => Policy::Invite,
                    _ => Policy::Open,
                });
            }
        }
        policy.unwrap_or(self.genesis_policy)
    }

    /// Ops in `scope` that take `role` (or everything) away from `member`.
    fn removals_of<'a>(
        &'a self,
        member: &'a EndpointId,
        role: Option<Role>,
        scope: Scope<'a>,
    ) -> impl Iterator<Item = usize> + 'a {
        self.indices(scope)
            .filter(move |&i| match (&self.nodes[i].body.action, role) {
                (Action::Remove { member: m }, _) => m == member,
                (Action::Revoke { member: m, role: r }, Some(want)) => m == member && *r == want,
                _ => false,
            })
    }

    fn is_inviter(&self, who: &EndpointId, scope: Scope<'_>) -> bool {
        if *who == self.owner {
            return true;
        }
        self.indices(scope).any(|g| {
            matches!(&self.nodes[g].body.action,
                Action::Grant { member, role: Role::Inviter } if member == who)
                && !self
                    .removals_of(who, Some(Role::Inviter), scope)
                    .any(|r| self.unseen_by(r, g))
        })
    }

    /// Whether ops `a` and `b` are concurrent: neither had seen the other.
    fn concurrent(&self, a: usize, b: usize) -> bool {
        a != b && !self.nodes[a].ancestors.has(b) && !self.nodes[b].ancestors.has(a)
    }

    /// An invite stands unless its inviter lost the role **concurrently** with it. A revocation
    /// made after the invite (one that had seen it) stops future invites, not this one — it was
    /// valid when made, and the owner who wants it gone removes the member.
    fn invite_survives(&self, invite: usize, scope: Scope<'_>) -> bool {
        let inviter = self.nodes[invite].op.signer;
        inviter == self.owner
            || !self
                .removals_of(&inviter, Some(Role::Inviter), scope)
                .any(|r| self.concurrent(r, invite))
    }

    /// Removed, with no invitation for them made after the removal.
    fn is_banned(&self, member: &EndpointId, scope: Scope<'_>) -> bool {
        self.indices(scope).any(|r| {
            matches!(&self.nodes[r].body.action, Action::Remove { member: m } if m == member)
                && !self.indices(scope).any(|o| {
                    matches!(&self.nodes[o].body.action, Action::Invite { member: m } if m == member)
                        && self.nodes[o].ancestors.has(r)
                })
        })
    }

    fn enrolls_of<'a>(
        &'a self,
        member: &'a EndpointId,
        scope: Scope<'a>,
    ) -> impl Iterator<Item = usize> + 'a {
        self.indices(scope).filter(move |&i| {
            self.nodes[i].op.signer == *member
                && matches!(self.nodes[i].body.action, Action::Enroll { .. })
        })
    }

    fn is_carried_in(&self, member: &EndpointId, scope: Scope<'_>) -> bool {
        self.enrolls_of(member, scope).any(|e| {
            // The invite it answered must still stand (its inviter not revoked unseen).
            let invite_ok = match self.nodes[e].body.action {
                Action::Enroll {
                    invite: Some(invite),
                } => {
                    self
                    .index
                    .get(&invite)
                    .is_some_and(|&i| self.invite_survives(i, scope))
                    // An invite was not needed if the roster was open when they enrolled.
                    || self.policy_in(Scope::Past(&self.nodes[e].ancestors)) == Policy::Open
                }
                _ => true,
            };
            // Did it need the roster to be open? An answered invite that still stands did not.
            let uninvited = match self.nodes[e].body.action {
                Action::Enroll {
                    invite: Some(invite),
                } => !self
                    .index
                    .get(&invite)
                    .is_some_and(|&i| self.invite_survives(i, scope)),
                _ => true,
            };
            let ended = self.indices(scope).any(|w| {
                let node = &self.nodes[w];
                match &node.body.action {
                    Action::Remove { member: m } => m == member && self.unseen_by(w, e),
                    Action::Withdraw => node.op.signer == *member && self.unseen_by(w, e),
                    // Closing beats an uninvited enrollment it had not seen, like a removal does.
                    Action::SetPolicy {
                        policy: Policy::Invite,
                    } => uninvited && self.concurrent(w, e),
                    _ => false,
                }
            });
            invite_ok && !ended
        })
    }

    // ---- public state -----------------------------------------------------------------------

    /// Whether `member`'s trail is carried, given every op held.
    pub fn is_carried(&self, member: &EndpointId) -> bool {
        self.is_carried_in(member, Scope::All)
    }

    /// The full derived state.
    pub fn state(&self) -> RosterState {
        let scope = Scope::All;
        let mut enrolled: BTreeSet<EndpointId> = BTreeSet::new();
        let mut granted: BTreeSet<EndpointId> = BTreeSet::new();
        for node in &self.nodes {
            match &node.body.action {
                Action::Enroll { .. } => {
                    enrolled.insert(node.op.signer);
                }
                Action::Grant { member, .. } => {
                    granted.insert(*member);
                }
                _ => {}
            }
        }
        let carried = enrolled
            .into_iter()
            .filter(|m| self.is_carried_in(m, scope))
            .collect();
        let mut inviters: BTreeSet<EndpointId> = granted
            .into_iter()
            .filter(|m| self.is_inviter(m, scope))
            .collect();
        inviters.insert(self.owner);

        let mut repeaters = BTreeMap::new();
        for (a, node) in self.nodes.iter().enumerate() {
            let Action::AddRepeater { cert } = &node.body.action else {
                continue;
            };
            let Ok(attested) = cert.verify() else {
                continue;
            };
            let removed = self.indices(scope).any(|r| {
                matches!(&self.nodes[r].body.action,
                    Action::RemoveRepeater { repeater } if *repeater == attested.repeater)
                    && self.unseen_by(r, a)
            });
            if !removed {
                repeaters.insert(attested.repeater, attested);
            }
        }

        RosterState {
            id: self.id,
            owner: self.owner,
            policy: self.policy_in(scope),
            carried,
            inviters,
            repeaters,
        }
    }

    /// The newest invite naming `member` that an `Enroll` could cite now: one whose inviter was
    /// not revoked concurrently with it, made after every `Remove` of `member` (a removal is
    /// sticky until an invitation made after it, §3.3). What a phone cites, and what an owner's
    /// screen lists as "invited".
    pub fn standing_invite(&self, member: &EndpointId) -> Option<OpId> {
        let scope = Scope::All;
        self.indices(scope)
            .filter(|&i| {
                matches!(&self.nodes[i].body.action, Action::Invite { member: m } if m == member)
                    && self.invite_survives(i, scope)
                    && self
                        .removals_of(member, None, scope)
                        .all(|r| self.nodes[i].ancestors.has(r))
            })
            .last()
            .map(|i| self.nodes[i].op.id())
    }

    /// Whether `who` signed any accepted op here: the owner, and everyone who ever enrolled,
    /// withdrew or invited. A repeater lets them `Fetch`, so a member the owner removed can read
    /// that it was (the same log is on every member's card anyway, §3.3).
    pub fn has_signed(&self, who: &EndpointId) -> bool {
        *who == self.owner || self.per_signer.contains_key(who)
    }

    /// Whether `repeater` was listed by the owner and is no longer: an `AddRepeater` for it is in
    /// the log and the derived state does not list it. A machine that was claimed but whose
    /// `AddRepeater` has not arrived yet is *not* removed — that is the ordinary window between
    /// `Claim` and the owner publishing the cert — so this, not "absent from the state", is what
    /// a repeater stops serving on.
    pub fn is_removed_repeater(&self, repeater: &EndpointId) -> bool {
        let ever_added = self.nodes.iter().any(|node| {
            matches!(&node.body.action, Action::AddRepeater { cert }
                if cert.verify().is_ok_and(|body| body.repeater == *repeater))
        });
        ever_added && !self.state().repeaters.contains_key(repeater)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(seed: u8) -> SigningKey {
        SigningKey::from_bytes(&[seed; 32])
    }

    fn id_of(key: &SigningKey) -> EndpointId {
        key.verifying_key().to_bytes()
    }

    fn cert_fields() -> CertFields {
        CertFields {
            roster: [7; 32],
            owner: id_of(&key(1)),
            repeater: id_of(&key(9)),
            issued_ms: 5,
        }
    }

    fn cert_body(name: Option<&str>) -> CertBody {
        CertBody {
            roster: [7; 32],
            owner: id_of(&key(1)),
            repeater: id_of(&key(9)),
            issued_ms: 5,
            name: name.map(str::to_string),
        }
    }

    #[test]
    fn a_named_cert_carries_its_name_and_an_unnamed_one_is_the_old_bytes() {
        let named = RepeaterCert::issue(&key(9), &cert_body(Some("Living room PC")));
        assert_eq!(
            named.verify().unwrap().name.as_deref(),
            Some("Living room PC")
        );

        // Unnamed: exactly the four fields every older reader expects, nothing after them.
        let unnamed = RepeaterCert::issue(&key(9), &cert_body(None));
        assert_eq!(unnamed.body, postcard::to_allocvec(&cert_fields()).unwrap());
        assert_eq!(unnamed.verify().unwrap().name, None);
    }

    #[test]
    fn a_named_cert_reads_as_the_old_fields_to_an_older_reader() {
        let named = RepeaterCert::issue(&key(9), &cert_body(Some("Attic Pi")));
        // What a reader from before names does: decode the four fields, ignore the rest.
        let old: CertFields = postcard::from_bytes(&named.body).unwrap();
        assert_eq!(old.repeater, id_of(&key(9)));
        assert_eq!(old.issued_ms, 5);
    }

    #[test]
    fn a_cert_whose_name_the_app_would_refuse_does_not_verify() {
        let mut body = postcard::to_allocvec(&cert_fields()).unwrap();
        body.extend(postcard::to_allocvec(&Some("bell\u{7}")).unwrap());
        let sig = key(9).sign(&signing_input(CERT_CTX, &body));
        let cert = RepeaterCert {
            body,
            sig: sig.to_bytes().to_vec(),
        };
        assert!(cert.verify().is_err());
    }

    #[test]
    fn names_are_trimmed_bounded_and_free_of_control_characters() {
        assert_eq!(
            repeater_name("  Living   room\tPC "),
            Some("Living room PC".into())
        );
        assert_eq!(repeater_name("   "), None);
        assert_eq!(repeater_name("a\u{0}b"), None);
        assert!(repeater_name(&"x".repeat(MAX_REPEATER_NAME)).is_some());
        assert_eq!(repeater_name(&"x".repeat(MAX_REPEATER_NAME + 1)), None);
    }

    const OWNER: u8 = 1;
    const ALICE: u8 = 2;
    const BOB: u8 = 3;
    const CAROL: u8 = 4;
    const REPEATER: u8 = 9;

    /// A roster under test plus a convenience for signing ops onto its heads.
    struct Fixture {
        roster: Roster,
    }

    impl Fixture {
        fn new(policy: Policy) -> Self {
            let genesis = SignedOp::sign(
                &key(OWNER),
                &OpBody {
                    roster: None,
                    parents: vec![],
                    ts_ms: 1,
                    action: Action::Genesis {
                        owner: id_of(&key(OWNER)),
                        policy,
                        nonce: [7; 16],
                    },
                },
            );
            Self {
                roster: Roster::from_genesis(genesis).unwrap(),
            }
        }

        /// Sign an op on explicit parents without inserting it.
        fn op_on(&self, signer: u8, parents: Vec<OpId>, action: Action) -> SignedOp {
            SignedOp::sign(
                &key(signer),
                &OpBody {
                    roster: Some(self.roster.id()),
                    parents,
                    ts_ms: 2,
                    action,
                },
            )
        }

        /// Sign on the current heads and insert; returns the op id or the refusal.
        fn act(&mut self, signer: u8, action: Action) -> Result<OpId, RosterError> {
            let op = self.op_on(signer, self.roster.heads(), action);
            let id = op.id();
            self.roster.insert(op).map(|_| id)
        }

        fn carried(&self, who: u8) -> bool {
            self.roster.is_carried(&id_of(&key(who)))
        }

        fn cert(&self, repeater: u8, roster: RosterId, owner: EndpointId) -> RepeaterCert {
            RepeaterCert::issue(
                &key(repeater),
                &CertBody {
                    roster,
                    owner,
                    repeater: id_of(&key(repeater)),
                    issued_ms: 3,
                    name: None,
                },
            )
        }
    }

    fn member(seed: u8) -> EndpointId {
        id_of(&key(seed))
    }

    // ---- genesis and signatures ------------------------------------------------------------

    #[test]
    fn genesis_must_be_signed_by_the_owner_it_names() {
        let forged = SignedOp::sign(
            &key(ALICE),
            &OpBody {
                roster: None,
                parents: vec![],
                ts_ms: 1,
                action: Action::Genesis {
                    owner: member(OWNER),
                    policy: Policy::Open,
                    nonce: [0; 16],
                },
            },
        );
        assert!(matches!(
            Roster::from_genesis(forged),
            Err(RosterError::BadGenesis(_))
        ));
    }

    #[test]
    fn a_tampered_body_or_a_swapped_signer_fails_verification() {
        let mut f = Fixture::new(Policy::Open);
        let mut op = f.op_on(ALICE, f.roster.heads(), Action::Enroll { invite: None });
        op.body[0] ^= 1;
        assert_eq!(f.roster.insert(op), Err(RosterError::BadSignature));

        let mut op = f.op_on(ALICE, f.roster.heads(), Action::Enroll { invite: None });
        op.signer = member(BOB);
        assert_eq!(f.roster.insert(op), Err(RosterError::BadSignature));
        assert!(!f.carried(ALICE) && !f.carried(BOB));
    }

    #[test]
    fn an_op_from_another_roster_is_refused() {
        let mut f = Fixture::new(Policy::Open);
        let other = Fixture::new(Policy::Invite); // different genesis ⇒ different id
        assert_ne!(f.roster.id(), other.roster.id());
        let op = other.op_on(ALICE, other.roster.heads(), Action::Enroll { invite: None });
        assert_eq!(f.roster.insert(op), Err(RosterError::WrongRoster));
    }

    #[test]
    fn an_op_with_no_parents_or_a_second_genesis_is_refused() {
        let mut f = Fixture::new(Policy::Open);
        let orphan = f.op_on(ALICE, vec![], Action::Enroll { invite: None });
        assert!(matches!(
            f.roster.insert(orphan),
            Err(RosterError::BadParents(_))
        ));
        let again = f.op_on(
            OWNER,
            f.roster.heads(),
            Action::Genesis {
                owner: member(OWNER),
                policy: Policy::Open,
                nonce: [1; 16],
            },
        );
        assert!(matches!(
            f.roster.insert(again),
            Err(RosterError::BadGenesis(_))
        ));
    }

    // ---- carrying ----------------------------------------------------------------------------

    #[test]
    fn an_open_roster_carries_anyone_who_enrolls() {
        let mut f = Fixture::new(Policy::Open);
        f.act(ALICE, Action::Enroll { invite: None }).unwrap();
        assert!(f.carried(ALICE));
        assert!(!f.carried(BOB));
    }

    #[test]
    fn the_owner_may_always_enroll() {
        let mut f = Fixture::new(Policy::Invite);
        f.act(OWNER, Action::Enroll { invite: None }).unwrap();
        assert!(f.carried(OWNER));
    }

    #[test]
    fn an_invite_roster_needs_an_invite_for_that_member() {
        let mut f = Fixture::new(Policy::Invite);
        assert!(f.act(ALICE, Action::Enroll { invite: None }).is_err());

        let invite = f
            .act(
                OWNER,
                Action::Invite {
                    member: member(BOB),
                },
            )
            .unwrap();
        // Bob's invite does not admit Alice.
        assert!(f
            .act(
                ALICE,
                Action::Enroll {
                    invite: Some(invite)
                }
            )
            .is_err());
        f.act(
            BOB,
            Action::Enroll {
                invite: Some(invite),
            },
        )
        .unwrap();
        assert!(f.carried(BOB));
        assert!(!f.carried(ALICE));
    }

    #[test]
    fn an_invitation_alone_carries_nobody() {
        let mut f = Fixture::new(Policy::Invite);
        f.act(
            OWNER,
            Action::Invite {
                member: member(BOB),
            },
        )
        .unwrap();
        assert!(!f.carried(BOB), "only the member's own Enroll consents");
    }

    #[test]
    fn withdrawing_stops_carrying_and_enrolling_again_resumes_it() {
        let mut f = Fixture::new(Policy::Open);
        f.act(ALICE, Action::Enroll { invite: None }).unwrap();
        f.act(ALICE, Action::Withdraw).unwrap();
        assert!(!f.carried(ALICE));
        f.act(ALICE, Action::Enroll { invite: None }).unwrap();
        assert!(f.carried(ALICE));
    }

    #[test]
    fn withdrawing_without_enrolling_is_refused() {
        let mut f = Fixture::new(Policy::Open);
        assert!(f.act(ALICE, Action::Withdraw).is_err());
    }

    #[test]
    fn a_removal_is_sticky_until_a_later_invite() {
        let mut f = Fixture::new(Policy::Open);
        f.act(ALICE, Action::Enroll { invite: None }).unwrap();
        f.act(
            OWNER,
            Action::Remove {
                member: member(ALICE),
            },
        )
        .unwrap();
        assert!(!f.carried(ALICE));
        // Open roster, but removed: enrolling again is refused.
        assert!(f.act(ALICE, Action::Enroll { invite: None }).is_err());
        // The owner changes their mind.
        let invite = f
            .act(
                OWNER,
                Action::Invite {
                    member: member(ALICE),
                },
            )
            .unwrap();
        f.act(
            ALICE,
            Action::Enroll {
                invite: Some(invite),
            },
        )
        .unwrap();
        assert!(f.carried(ALICE));
    }

    #[test]
    fn a_removal_beats_a_concurrent_enrollment() {
        let mut f = Fixture::new(Policy::Open);
        let base = f.roster.heads();
        let enroll = f.op_on(ALICE, base.clone(), Action::Enroll { invite: None });
        let remove = f.op_on(
            OWNER,
            base,
            Action::Remove {
                member: member(ALICE),
            },
        );
        f.roster.insert(enroll).unwrap();
        f.roster.insert(remove).unwrap();
        assert!(!f.carried(ALICE));
    }

    #[test]
    fn nobody_but_the_owner_removes_grants_or_sets_policy() {
        let mut f = Fixture::new(Policy::Open);
        f.act(ALICE, Action::Enroll { invite: None }).unwrap();
        for action in [
            Action::Remove {
                member: member(ALICE),
            },
            Action::Grant {
                member: member(BOB),
                role: Role::Inviter,
            },
            Action::SetPolicy {
                policy: Policy::Invite,
            },
            Action::RemoveRepeater {
                repeater: member(REPEATER),
            },
        ] {
            assert!(matches!(
                f.act(BOB, action),
                Err(RosterError::Unauthorized(_))
            ));
        }
        assert!(f.carried(ALICE));
    }

    #[test]
    fn the_owner_cannot_be_removed_or_demoted() {
        let mut f = Fixture::new(Policy::Open);
        assert!(f
            .act(
                OWNER,
                Action::Remove {
                    member: member(OWNER)
                }
            )
            .is_err());
        assert!(f
            .act(
                OWNER,
                Action::Revoke {
                    member: member(OWNER),
                    role: Role::Inviter
                }
            )
            .is_err());
    }

    // ---- inviters ----------------------------------------------------------------------------

    #[test]
    fn an_inviter_can_invite_until_revoked() {
        let mut f = Fixture::new(Policy::Invite);
        assert!(f
            .act(
                ALICE,
                Action::Invite {
                    member: member(BOB)
                }
            )
            .is_err());
        f.act(
            OWNER,
            Action::Grant {
                member: member(ALICE),
                role: Role::Inviter,
            },
        )
        .unwrap();
        let invite = f
            .act(
                ALICE,
                Action::Invite {
                    member: member(BOB),
                },
            )
            .unwrap();
        f.act(
            BOB,
            Action::Enroll {
                invite: Some(invite),
            },
        )
        .unwrap();
        assert!(f.carried(BOB));

        f.act(
            OWNER,
            Action::Revoke {
                member: member(ALICE),
                role: Role::Inviter,
            },
        )
        .unwrap();
        assert!(f
            .act(
                ALICE,
                Action::Invite {
                    member: member(CAROL)
                }
            )
            .is_err());
        // Revoking Alice does not undo an enrollment her invite had already produced.
        assert!(f.carried(BOB));
        assert!(!f.roster.state().inviters.contains(&member(ALICE)));
    }

    #[test]
    fn an_invite_concurrent_with_its_inviters_revocation_does_not_stand() {
        let mut f = Fixture::new(Policy::Invite);
        f.act(
            OWNER,
            Action::Grant {
                member: member(ALICE),
                role: Role::Inviter,
            },
        )
        .unwrap();
        let base = f.roster.heads();
        let invite = f.op_on(
            ALICE,
            base.clone(),
            Action::Invite {
                member: member(BOB),
            },
        );
        let invite_id = invite.id();
        let revoke = f.op_on(
            OWNER,
            base,
            Action::Revoke {
                member: member(ALICE),
                role: Role::Inviter,
            },
        );
        f.roster.insert(invite).unwrap();
        // Bob enrolls having seen the invite but not the revocation.
        let enroll = f.op_on(
            BOB,
            vec![invite_id],
            Action::Enroll {
                invite: Some(invite_id),
            },
        );
        f.roster.insert(enroll).unwrap();
        assert!(f.carried(BOB), "valid until the revocation is known");
        f.roster.insert(revoke).unwrap();
        assert!(
            !f.carried(BOB),
            "a removal beats anything concurrent with it"
        );
    }

    #[test]
    fn a_regrant_after_a_revoke_restores_the_role() {
        let mut f = Fixture::new(Policy::Invite);
        let grant = Action::Grant {
            member: member(ALICE),
            role: Role::Inviter,
        };
        f.act(OWNER, grant.clone()).unwrap();
        f.act(
            OWNER,
            Action::Revoke {
                member: member(ALICE),
                role: Role::Inviter,
            },
        )
        .unwrap();
        f.act(OWNER, grant).unwrap();
        assert!(f
            .act(
                ALICE,
                Action::Invite {
                    member: member(BOB)
                }
            )
            .is_ok());
    }

    // ---- policy ------------------------------------------------------------------------------

    #[test]
    fn closing_a_roster_does_not_drop_people_who_enrolled_while_it_was_open() {
        let mut f = Fixture::new(Policy::Open);
        f.act(ALICE, Action::Enroll { invite: None }).unwrap();
        f.act(
            OWNER,
            Action::SetPolicy {
                policy: Policy::Invite,
            },
        )
        .unwrap();
        assert!(f.carried(ALICE));
        assert!(f.act(BOB, Action::Enroll { invite: None }).is_err());
    }

    #[test]
    fn an_enrollment_concurrent_with_closing_does_not_stand() {
        // Concurrent and backdated look the same: neither was seen by the close. So a genuine
        // race costs the enrollee an invite, which is the price of closing meaning anything.
        let mut f = Fixture::new(Policy::Open);
        let base = f.roster.heads();
        let close = f.op_on(
            OWNER,
            base.clone(),
            Action::SetPolicy {
                policy: Policy::Invite,
            },
        );
        let enroll = f.op_on(ALICE, base, Action::Enroll { invite: None });
        f.roster.insert(close).unwrap();
        f.roster.insert(enroll).unwrap();
        assert!(
            !f.carried(ALICE),
            "closing beats an uninvited enrollment it had not seen"
        );
    }

    #[test]
    fn closing_a_roster_keeps_out_an_enrollment_backdated_onto_the_open_genesis() {
        let mut f = Fixture::new(Policy::Open);
        let genesis = f.roster.heads();
        f.act(ALICE, Action::Enroll { invite: None }).unwrap();
        f.act(
            OWNER,
            Action::SetPolicy {
                policy: Policy::Invite,
            },
        )
        .unwrap();
        // Alice enrolled while it was open and the owner saw it: closing is not retroactive.
        assert!(f.carried(ALICE));

        // Bob signs an Enroll citing only the genesis, whose past says "open". It is accepted
        // as an op (its past cannot change) but does not stand against the close.
        let backdated = f.op_on(BOB, genesis, Action::Enroll { invite: None });
        f.roster.insert(backdated).unwrap();
        assert!(!f.carried(BOB));

        // An invite after the close is how Bob gets in.
        let invite = f
            .act(
                OWNER,
                Action::Invite {
                    member: member(BOB),
                },
            )
            .unwrap();
        f.act(
            BOB,
            Action::Enroll {
                invite: Some(invite),
            },
        )
        .unwrap();
        assert!(f.carried(BOB));
    }

    #[test]
    fn concurrent_policies_resolve_to_invite() {
        let mut f = Fixture::new(Policy::Open);
        let base = f.roster.heads();
        for policy in [Policy::Open, Policy::Invite] {
            let op = f.op_on(OWNER, base.clone(), Action::SetPolicy { policy });
            f.roster.insert(op).unwrap();
        }
        assert_eq!(f.roster.state().policy, Policy::Invite);
    }

    // ---- repeaters ---------------------------------------------------------------------------

    #[test]
    fn a_repeater_is_listed_only_with_its_own_cert_for_this_roster_and_owner() {
        let mut f = Fixture::new(Policy::Open);
        let roster = f.roster.id();
        let owner = member(OWNER);

        // Signed by the right repeater, for this roster and owner.
        let good = f.cert(REPEATER, roster, owner);
        f.act(OWNER, Action::AddRepeater { cert: good }).unwrap();
        assert!(f.roster.state().repeaters.contains_key(&member(REPEATER)));

        // A cert for another roster, or naming another owner, is refused.
        let wrong_roster = f.cert(10, [0; 32], owner);
        assert!(f
            .act(OWNER, Action::AddRepeater { cert: wrong_roster })
            .is_err());
        let wrong_owner = f.cert(11, roster, member(ALICE));
        assert!(f
            .act(OWNER, Action::AddRepeater { cert: wrong_owner })
            .is_err());

        // A cert claiming to be repeater 12 but signed by 13: the signature is checked against
        // the repeater it names.
        let mut forged = f.cert(13, roster, owner);
        let mut body: CertBody = postcard::from_bytes(&forged.body).unwrap();
        body.repeater = member(12);
        forged.body = postcard::to_allocvec(&body).unwrap();
        assert!(f.act(OWNER, Action::AddRepeater { cert: forged }).is_err());

        // Only the owner may list a repeater, even with a good cert.
        let by_alice = f.cert(14, roster, owner);
        assert!(f
            .act(ALICE, Action::AddRepeater { cert: by_alice })
            .is_err());

        assert_eq!(
            f.roster
                .state()
                .repeaters
                .keys()
                .copied()
                .collect::<Vec<_>>(),
            vec![member(REPEATER)]
        );
    }

    #[test]
    fn removing_a_repeater_beats_a_concurrent_re_add() {
        let mut f = Fixture::new(Policy::Open);
        let cert = f.cert(REPEATER, f.roster.id(), member(OWNER));
        f.act(OWNER, Action::AddRepeater { cert: cert.clone() })
            .unwrap();
        let base = f.roster.heads();
        let readd = f.op_on(OWNER, base.clone(), Action::AddRepeater { cert });
        let remove = f.op_on(
            OWNER,
            base,
            Action::RemoveRepeater {
                repeater: member(REPEATER),
            },
        );
        f.roster.insert(readd).unwrap();
        f.roster.insert(remove).unwrap();
        assert!(f.roster.state().repeaters.is_empty());
    }

    #[test]
    fn a_repeater_is_removed_only_once_it_was_listed() {
        let mut f = Fixture::new(Policy::Open);
        // Claimed, cert not yet published: absent from the state, and not removed.
        assert!(!f.roster.is_removed_repeater(&member(REPEATER)));
        let cert = f.cert(REPEATER, f.roster.id(), member(OWNER));
        f.act(OWNER, Action::AddRepeater { cert }).unwrap();
        assert!(!f.roster.is_removed_repeater(&member(REPEATER)));
        f.act(
            OWNER,
            Action::RemoveRepeater {
                repeater: member(REPEATER),
            },
        )
        .unwrap();
        assert!(f.roster.is_removed_repeater(&member(REPEATER)));
        // A sibling that was never listed is not "removed" either.
        assert!(!f.roster.is_removed_repeater(&member(10)));
    }

    #[test]
    fn a_standing_invite_is_one_made_after_any_removal() {
        let mut f = Fixture::new(Policy::Invite);
        assert_eq!(f.roster.standing_invite(&member(ALICE)), None);
        let first = f
            .act(
                OWNER,
                Action::Invite {
                    member: member(ALICE),
                },
            )
            .unwrap();
        assert_eq!(f.roster.standing_invite(&member(ALICE)), Some(first));
        f.act(
            ALICE,
            Action::Enroll {
                invite: Some(first),
            },
        )
        .unwrap();
        f.act(
            OWNER,
            Action::Remove {
                member: member(ALICE),
            },
        )
        .unwrap();
        // The removal voids the invite before it.
        assert_eq!(f.roster.standing_invite(&member(ALICE)), None);
        let second = f
            .act(
                OWNER,
                Action::Invite {
                    member: member(ALICE),
                },
            )
            .unwrap();
        assert_eq!(f.roster.standing_invite(&member(ALICE)), Some(second));
        f.act(
            ALICE,
            Action::Enroll {
                invite: Some(second),
            },
        )
        .unwrap();
        assert!(f.carried(ALICE));
    }

    // ---- limits ------------------------------------------------------------------------------

    /// A throwaway key, distinct for each `n`.
    fn stranger(n: u32) -> SigningKey {
        let mut seed = [0xEE; 32];
        seed[..4].copy_from_slice(&n.to_le_bytes());
        SigningKey::from_bytes(&seed)
    }

    #[test]
    fn unsigned_junk_never_counts_toward_a_limit() {
        let mut f = Fixture::new(Policy::Open);
        for n in 0..(MAX_PENDING as u32 + 10) {
            let mut op = f.op_on(ALICE, vec![[n as u8; 32]], Action::Withdraw);
            op.sig[0] ^= 1;
            assert_eq!(f.roster.insert(op), Err(RosterError::BadSignature));
        }
        assert_eq!(f.roster.pending_len(), 0);
        f.act(ALICE, Action::Enroll { invite: None }).unwrap();
    }

    #[test]
    fn a_flood_of_orphans_cannot_block_the_owner_or_an_accepted_op() {
        let mut f = Fixture::new(Policy::Open);
        // Valid signatures on parents nobody has: they cost the sender nothing.
        let mut n = 0u32;
        loop {
            let key = stranger(n);
            let body = OpBody {
                roster: Some(f.roster.id()),
                parents: vec![blake3::hash(&n.to_le_bytes()).into()],
                ts_ms: 2,
                action: Action::Enroll { invite: None },
            };
            n += 1;
            match f.roster.insert(SignedOp::sign(&key, &body)) {
                Ok(Inserted::Pending) => {}
                Err(RosterError::Full) => break,
                other => panic!("unexpected {other:?}"),
            }
        }
        assert_eq!(f.roster.pending_len(), MAX_PENDING);
        // An op with its parents present is not held, so the queue being full does not touch it.
        f.act(ALICE, Action::Enroll { invite: None }).unwrap();
        // The owner's own held-aside ops have their own queue.
        let early = f.op_on(
            OWNER,
            f.roster.heads(),
            Action::SetPolicy {
                policy: Policy::Invite,
            },
        );
        let late = f.op_on(
            OWNER,
            vec![early.id()],
            Action::Remove {
                member: member(ALICE),
            },
        );
        assert_eq!(f.roster.insert(late), Ok(Inserted::Pending));
        assert_eq!(f.roster.insert(early), Ok(Inserted::Accepted));
        assert!(!f.carried(ALICE));
    }

    #[test]
    fn one_signer_cannot_spend_the_roster_alone() {
        let mut f = Fixture::new(Policy::Open);
        let mut accepted = 0;
        loop {
            let action = if accepted % 2 == 0 {
                Action::Enroll { invite: None }
            } else {
                Action::Withdraw
            };
            match f.act(ALICE, action) {
                Ok(_) => accepted += 1,
                Err(RosterError::Full) => break,
                Err(e) => panic!("unexpected {e:?}"),
            }
        }
        assert_eq!(accepted, MAX_OPS_PER_SIGNER);
        // Someone else still gets in.
        f.act(BOB, Action::Enroll { invite: None }).unwrap();
    }

    #[test]
    fn a_roster_full_of_strangers_still_takes_the_owners_ops() {
        let mut f = Fixture::new(Policy::Open);
        let mut n = 0u32;
        loop {
            let body = OpBody {
                roster: Some(f.roster.id()),
                parents: vec![f.roster.id()],
                ts_ms: 2,
                action: Action::Enroll { invite: None },
            };
            match f.roster.insert(SignedOp::sign(&stranger(n), &body)) {
                Ok(Inserted::Accepted) => n += 1,
                Err(RosterError::Full) => break,
                other => panic!("unexpected {other:?}"),
            }
        }
        assert_eq!(f.roster.len(), MAX_OPS - OWNER_RESERVE);
        // Thousands of heads now; name the genesis alone so MAX_PARENTS is not what refuses.
        let genesis = f.roster.id();
        let late = f.op_on(ALICE, vec![genesis], Action::Enroll { invite: None });
        assert_eq!(f.roster.insert(late), Err(RosterError::Full));
        // The owner closes the roster and removes someone: both fit in the reserve.
        let close = f.op_on(
            OWNER,
            vec![genesis],
            Action::SetPolicy {
                policy: Policy::Invite,
            },
        );
        let close_id = close.id();
        assert_eq!(f.roster.insert(close), Ok(Inserted::Accepted));
        let first = id_of(&stranger(0));
        let remove = f.op_on(OWNER, vec![close_id], Action::Remove { member: first });
        assert_eq!(f.roster.insert(remove), Ok(Inserted::Accepted));
        assert!(!f.roster.is_carried(&first));
        // A close that had not seen the flood ends every uninvited enrollment in it (§3.3).
        assert!(!f.roster.is_carried(&id_of(&stranger(1))));
    }

    // ---- replication -------------------------------------------------------------------------

    #[test]
    fn an_op_whose_parent_is_missing_waits_then_applies() {
        let mut f = Fixture::new(Policy::Invite);
        let invite = f.op_on(
            OWNER,
            f.roster.heads(),
            Action::Invite {
                member: member(BOB),
            },
        );
        let enroll = f.op_on(
            BOB,
            vec![invite.id()],
            Action::Enroll {
                invite: Some(invite.id()),
            },
        );
        assert_eq!(f.roster.insert(enroll), Ok(Inserted::Pending));
        assert!(!f.carried(BOB));
        assert_eq!(f.roster.insert(invite), Ok(Inserted::Accepted));
        assert_eq!(f.roster.pending_len(), 0);
        assert!(f.carried(BOB));
    }

    #[test]
    fn an_export_rebuilds_the_same_state() {
        let mut f = Fixture::new(Policy::Invite);
        f.act(
            OWNER,
            Action::Grant {
                member: member(ALICE),
                role: Role::Inviter,
            },
        )
        .unwrap();
        let invite = f
            .act(
                ALICE,
                Action::Invite {
                    member: member(BOB),
                },
            )
            .unwrap();
        f.act(
            BOB,
            Action::Enroll {
                invite: Some(invite),
            },
        )
        .unwrap();
        let rebuilt = Roster::from_ops(f.roster.export()).unwrap();
        assert_eq!(rebuilt.state(), f.roster.state());
        assert_eq!(rebuilt.heads(), f.roster.heads());
    }

    #[test]
    fn duplicates_are_known_not_errors() {
        let mut f = Fixture::new(Policy::Open);
        let op = f.op_on(ALICE, f.roster.heads(), Action::Enroll { invite: None });
        assert_eq!(f.roster.insert(op.clone()), Ok(Inserted::Accepted));
        assert_eq!(f.roster.insert(op), Ok(Inserted::Known));
    }

    /// The property everything else rests on: replicas that hold the same ops agree, whatever
    /// order the ops reached them in. Builds a log with concurrent branches (a revocation racing
    /// an invite, a removal racing an enrollment, an enrollment backdated past a close), then
    /// feeds it to fresh rosters in many orders.
    #[test]
    fn order_does_not_matter() {
        let mut f = Fixture::new(Policy::Open);
        let root = f.roster.heads();
        let grant = f.op_on(
            OWNER,
            root.clone(),
            Action::Grant {
                member: member(ALICE),
                role: Role::Inviter,
            },
        );
        let alice_in = f.op_on(ALICE, root.clone(), Action::Enroll { invite: None });
        let carol_in = f.op_on(CAROL, root.clone(), Action::Enroll { invite: None });
        // The owner had seen Alice's enrollment when closing, so it keeps standing.
        let close = f.op_on(
            OWNER,
            vec![grant.id(), alice_in.id()],
            Action::SetPolicy {
                policy: Policy::Invite,
            },
        );
        let invite = f.op_on(
            ALICE,
            vec![close.id()],
            Action::Invite {
                member: member(BOB),
            },
        );
        let revoke = f.op_on(
            OWNER,
            vec![close.id()],
            Action::Revoke {
                member: member(ALICE),
                role: Role::Inviter,
            },
        );
        let bob_in = f.op_on(
            BOB,
            vec![invite.id()],
            Action::Enroll {
                invite: Some(invite.id()),
            },
        );
        let remove_carol = f.op_on(
            OWNER,
            root,
            Action::Remove {
                member: member(CAROL),
            },
        );
        let dave_in = f.op_on(5, vec![close.id()], Action::Enroll { invite: None });

        let ops = vec![
            grant,
            alice_in,
            carol_in,
            close,
            invite,
            revoke,
            bob_in,
            remove_carol,
            dave_in,
        ];
        let genesis = f.roster.export().remove(0);

        let mut reference: Option<RosterState> = None;
        // A tiny deterministic shuffle (no rand in the pure core).
        let mut seed = 0x2545_f491_4f6c_dd1du64;
        for _ in 0..200 {
            let mut order = ops.clone();
            for i in (1..order.len()).rev() {
                seed ^= seed << 13;
                seed ^= seed >> 7;
                seed ^= seed << 17;
                order.swap(i, (seed % (i as u64 + 1)) as usize);
            }
            let mut roster = Roster::from_genesis(genesis.clone()).unwrap();
            for op in order {
                let _ = roster.insert(op);
            }
            assert_eq!(roster.pending_len(), 0);
            let state = roster.state();
            match &reference {
                None => reference = Some(state),
                Some(expected) => assert_eq!(&state, expected),
            }
        }

        let state = reference.unwrap();
        assert!(
            state.carried.contains(&member(ALICE)),
            "enrolled while open"
        );
        assert!(
            !state.carried.contains(&member(BOB)),
            "his invite raced its inviter's revocation"
        );
        assert!(
            !state.carried.contains(&member(CAROL)),
            "her enrollment raced her removal"
        );
        assert!(
            !state.carried.contains(&member(5)),
            "enrolled without an invite after the roster closed"
        );
        assert_eq!(state.policy, Policy::Invite);
        assert_eq!(state.inviters, BTreeSet::from([member(OWNER)]));
    }
}
