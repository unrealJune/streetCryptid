//! The §4.6 restart **policy** and the **control record** that carries its inputs between
//! devices — the part of session recovery that is pure, so every decision it makes can be tested
//! without a network, a clock, or a second phone.
//!
//! [`sessions`](crate::sessions) owns the cryptography (deriving, installing and opening restarted
//! sessions); `lib.rs` owns the I/O (reading a peer's control record out of the replica, writing
//! ours). This module owns only *what to do*, given what each side can see:
//!
//! | role     | sees                                           | may do                         |
//! |----------|------------------------------------------------|--------------------------------|
//! | leader   | its session, the follower's control record     | restart, answering a request   |
//! | follower | its session, its own outstanding request       | ask for a restart, withdraw it |
//!
//! The asymmetry is the point. Two sides that may each restart unilaterally can each restart past
//! the other forever; one side that decides, and one that asks, cannot.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::crypto::VerifiedEnvelope;
use crate::session_store::RestartRequest;
use crate::sessions::{
    Assessment, Broken, Health, PublishedPrekey, Role, SessionError, SessionManager,
    PREKEY_MAX_USE_AGE_MS, REQUEST_REPEAT_MS, RESTART_SETTLE_MS,
};

/// Wire version of [`ControlRecord`]. The `rsy` slot's previous occupant (the two-sided resync
/// record) was version 1, so a reader of either kind refuses the other cleanly.
pub const CONTROL_RECORD_V: u8 = 2;

const REQUEST_TAG_CONTEXT: &str = "sc-dr/v1/restart-request";

/// What a device publishes, HPKE-sealed to its friends, in its `rsy/<author>` slot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ControlRecord {
    pub v: u8,
    /// When this record was written (author's clock). Only used to pick the newest copy.
    pub ts: u64,
    /// The author's newest restart prekeys, newest first.
    pub prekeys: Vec<WirePrekey>,
    /// Restart requests to the author's leaders.
    pub requests: Vec<WireRequest>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct WirePrekey {
    pub id: u32,
    pub public: [u8; 32],
    pub created_ms: u64,
}

/// A follower's request that one of its leaders restart their session.
///
/// Addressed by a tag rather than an endpoint id. Every friend can read the record (it carries
/// the prekeys they would restart against), and naming the leader in clear would tell each of
/// them who else this device is friends with and having trouble reaching.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct WireRequest {
    pub to: [u8; 16],
    /// Follower's clock; strictly increasing per pair. The leader answers any request newer than
    /// the last one it answered, so neither side needs the other's clock.
    pub ts: u64,
}

/// The tag a follower addresses a request to its `leader` with.
pub fn request_tag(leader: &[u8; 32], follower: &[u8; 32]) -> [u8; 16] {
    let mut hasher = blake3::Hasher::new_derive_key(REQUEST_TAG_CONTEXT);
    hasher.update(leader);
    hasher.update(follower);
    let mut tag = [0u8; 16];
    tag.copy_from_slice(&hasher.finalize().as_bytes()[..16]);
    tag
}

impl ControlRecord {
    pub fn new(
        author: &[u8; 32],
        ts: u64,
        prekeys: &[PublishedPrekey],
        requests: &[RestartRequest],
    ) -> Self {
        Self {
            v: CONTROL_RECORD_V,
            ts,
            prekeys: prekeys
                .iter()
                .map(|p| WirePrekey {
                    id: p.id,
                    public: p.public,
                    created_ms: p.created_ms,
                })
                .collect(),
            requests: requests
                .iter()
                .map(|r| WireRequest {
                    to: request_tag(&r.peer, author),
                    ts: r.ts,
                })
                .collect(),
        }
    }

    pub fn encode(&self) -> Option<Vec<u8>> {
        postcard::to_allocvec(self).ok()
    }

    /// Decode a control record; anything else in the slot (including the retired v1 resync
    /// record) is `None`.
    pub fn decode(bytes: &[u8]) -> Option<Self> {
        let record: Self = postcard::from_bytes(bytes).ok()?;
        (record.v == CONTROL_RECORD_V).then_some(record)
    }

    /// The author's newest prekey.
    pub fn newest_prekey(&self) -> Option<PublishedPrekey> {
        self.prekeys
            .iter()
            .max_by_key(|p| (p.created_ms, p.id))
            .map(|p| PublishedPrekey {
                id: p.id,
                public: p.public,
                created_ms: p.created_ms,
            })
    }

    /// The author's request to `leader` (us), if it has one outstanding.
    pub fn request_for(&self, leader: &[u8; 32], author: &[u8; 32]) -> Option<u64> {
        let tag = request_tag(leader, author);
        self.requests
            .iter()
            .filter(|r| r.to == tag)
            .map(|r| r.ts)
            .max()
    }
}

/// What recovery should do about one peer this pass.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    /// Nothing is wrong, or nothing can be done yet.
    None,
    /// Leader: restart against `prekey`, answering the follower's request at `answering` if any.
    Restart {
        prekey: PublishedPrekey,
        answering: Option<u64>,
    },
    /// Leader: a restart is due but the follower has published no prekey fresh enough to use.
    AwaitPrekey,
    /// Follower: ask the leader to restart, at our clock `ts`.
    Request { ts: u64 },
    /// Follower: withdraw our outstanding request.
    Withdraw,
}

impl Action {
    pub fn as_str(self) -> &'static str {
        match self {
            Action::None => "none",
            Action::Restart { .. } => "restart",
            Action::AwaitPrekey => "await_prekey",
            Action::Request { .. } => "request",
            Action::Withdraw => "withdraw",
        }
    }
}

/// The leader's decision for one follower.
///
/// * A request newer than the last one answered is answered, always — the follower has seen
///   something the leader cannot, and asking is the only way it has to say so.
/// * The leader's own evidence — a damaged record, or `R` distinct envelopes from the follower it
///   cannot open — restarts too, but not on top of a restart of its own that is still waiting to
///   be answered, until [`RESTART_SETTLE_MS`] has passed.
/// * A lapse alone never restarts. §4.5 drops a peer who has stopped contributing ratchet keys so
///   that a device in someone else's hands cannot keep tracking by doing nothing; restarting on
///   the leader's initiative would undo that. A lapsed follower that is still alive will ask.
/// * Only against a prekey fresh enough that its owner is demonstrably still running
///   ([`PREKEY_MAX_USE_AGE_MS`]).
pub fn plan_leader(
    assessment: &Assessment,
    peer_control: Option<&ControlRecord>,
    leader: &[u8; 32],
    follower: &[u8; 32],
    now_ms: u64,
) -> Action {
    debug_assert_eq!(assessment.role, Role::Leader);
    if assessment.health == Health::NoSession {
        return Action::None;
    }
    let request = peer_control
        .and_then(|c| c.request_for(leader, follower))
        .filter(|ts| *ts > assessment.answered_request_ts);
    let own_evidence = matches!(
        assessment.health,
        Health::Broken(Broken::Damaged) | Health::Broken(Broken::Misses)
    ) && !(assessment.awaiting_answer
        && now_ms.saturating_sub(assessment.created_ms) < RESTART_SETTLE_MS);
    if request.is_none() && !own_evidence {
        return Action::None;
    }
    let prekey = peer_control
        .and_then(ControlRecord::newest_prekey)
        .filter(|p| now_ms.saturating_sub(p.created_ms) <= PREKEY_MAX_USE_AGE_MS);
    match prekey {
        Some(prekey) => Action::Restart {
            prekey,
            answering: request,
        },
        None => Action::AwaitPrekey,
    }
}

/// The follower's decision for one leader.
///
/// Asks when the session is broken and no request is outstanding; repeats an unanswered one
/// after [`REQUEST_REPEAT_MS`]; withdraws once the session works again. A request counts as
/// answered when the session in use has a different origin than the one it was made from.
pub fn plan_follower(
    assessment: &Assessment,
    outstanding: Option<&RestartRequest>,
    now_ms: u64,
) -> Action {
    debug_assert_eq!(assessment.role, Role::Follower);
    match (assessment.health, outstanding) {
        (Health::NoSession, Some(_)) => Action::Withdraw,
        (Health::NoSession, None) => Action::None,
        (Health::Healthy, Some(_)) => Action::Withdraw,
        (Health::Healthy, None) => Action::None,
        (Health::Broken(_), None) => Action::Request { ts: now_ms },
        (Health::Broken(_), Some(request)) => {
            if now_ms.saturating_sub(request.ts) >= REQUEST_REPEAT_MS {
                // Strictly after the last one, even if our clock went backwards: the leader
                // answers only requests newer than the last it answered.
                Action::Request {
                    ts: now_ms.max(request.ts.saturating_add(1)),
                }
            } else {
                Action::None
            }
        }
    }
}

/// What one recovery pass found and did.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct PassReport {
    pub desynced: u32,
    pub primed: u32,
    pub restarted: u32,
    pub requested: u32,
    pub withdrawn: u32,
    pub await_prekey: u32,
    pub errors: Vec<String>,
}

/// One recovery pass over `friends`, given what the replica holds. Everything but the I/O of the
/// native driver (`LocationNode::recover_sessions`), so a test harness runs exactly this.
///
/// * `leader_envelopes` — the latest envelopes in our replica, verified; those from friends who
///   lead us are checked for a restart to adopt (`SessionManager::prime`).
/// * `peer_controls` — the newest control record of each friend we lead.
pub fn run_pass(
    manager: &SessionManager,
    friends: &[[u8; 32]],
    leader_envelopes: &[VerifiedEnvelope],
    peer_controls: &HashMap<[u8; 32], ControlRecord>,
    now_ms: u64,
) -> PassReport {
    let mut report = PassReport::default();
    let self_id = manager.self_id();

    // 1. Follower: adopt any restart already waiting in the replica.
    for verified in leader_envelopes {
        if !friends.contains(&verified.author) || manager.role(&verified.author) != Role::Follower {
            continue;
        }
        match manager.prime(&verified.author, verified, now_ms) {
            Ok(true) => report.primed += 1,
            Ok(false) => {}
            Err(err) => report.errors.push(err.to_string()),
        }
    }

    // 2. Decide, per peer.
    let outstanding = manager.requests().unwrap_or_default();
    for peer in friends {
        let assessment = manager.assess(peer, now_ms);
        if let Health::Broken(reason) = assessment.health {
            report.desynced += 1;
            tracing::debug!(
                sc.peer = %crate::telemetry::short_hex(peer),
                role = assessment.role.as_str(),
                reason = reason.as_str(),
                "session counts as broken"
            );
        }
        match assessment.role {
            Role::Leader => {
                match plan_leader(&assessment, peer_controls.get(peer), &self_id, peer, now_ms) {
                    Action::Restart { prekey, answering } => {
                        match manager.restart_as_leader(peer, &prekey, answering, now_ms) {
                            Ok(_) => report.restarted += 1,
                            Err(err) => report.errors.push(err.to_string()),
                        }
                    }
                    Action::AwaitPrekey => report.await_prekey += 1,
                    _ => {}
                }
            }
            Role::Follower => {
                let ours = outstanding.iter().find(|r| r.peer == *peer);
                match plan_follower(&assessment, ours, now_ms) {
                    Action::Request { ts } => {
                        let request = RestartRequest {
                            peer: *peer,
                            ts,
                            origin_at_request: assessment.origin_ts,
                        };
                        match manager.set_request(request) {
                            Ok(()) => {
                                report.requested += 1;
                                tracing::info!(
                                    sc.peer = %crate::telemetry::short_hex(peer),
                                    sc.restart = "requested",
                                    reason = match assessment.health {
                                        Health::Broken(r) => r.as_str(),
                                        _ => "",
                                    },
                                    "asked the leader to restart our session"
                                );
                            }
                            Err(err) => report.errors.push(err.to_string()),
                        }
                    }
                    Action::Withdraw => match manager.clear_request(peer) {
                        Ok(true) => report.withdrawn += 1,
                        Ok(false) => {}
                        Err(err) => report.errors.push(err.to_string()),
                    },
                    _ => {}
                }
            }
        }
    }
    report
}

/// The control record we should publish now: our prekeys (rotated and expired first) and our
/// outstanding requests.
pub fn our_control_record(
    manager: &SessionManager,
    now_ms: u64,
) -> Result<ControlRecord, SessionError> {
    let prekeys = manager.prekeys_for_publication(now_ms)?;
    let requests = manager.requests()?;
    Ok(ControlRecord::new(
        &manager.self_id(),
        now_ms,
        &prekeys,
        &requests,
    ))
}
