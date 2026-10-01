//! `peer.contact` — one span for every time this phone actually exchanged data with a specific peer.
//!
//! Every other span on the delivery path answers "did the envelope move?". None answered "did the
//! two PHONES talk?", and on a background wake that is the question: a friend's dot can update
//! because the stash relayed it hours later, because a third friend reconciled it on, or because the
//! two phones were connected at the same moment and handed it over themselves. Those look identical
//! on the map and in `fix.received.app`, and they mean very different things about whether two
//! sleeping phones' wakes ever line up.
//!
//! So each of the four places a peer is named at the moment data crosses — gossip send, gossip
//! receive, trail push, trail pull — emits one of these, with:
//!
//! - `contact.dir` — `send` | `recv`
//! - `contact.lane` — `gossip` (the live path) | `docs` (trail reconciliation)
//! - `contact.role` — `friend` | `stash` | `other`, from [`PeerRoles`]
//! - `contact.path` — `ble` | `lan` | `direct` | `relay` | `live` (see `delivery_label`)
//! - `contact.from_author` — receive only: the peer handed over ITS OWN envelope, i.e. the
//!   author's phone was on the other end, not a mirror of it
//! - `sc.peer` — short endpoint id, so a pair of devices is one filter
//!
//! These are deliberately spanmetrics dimensions (`infra/otel/collector-config.yaml`): the
//! question is usually asked days later ("did A and B ever sync while both were in pockets last
//! week?"), which is past the trace retention but inside the metrics one. `sc.peer` is bounded by
//! the friend count, unlike `sc.seq` / `sc.entry_hash`.
//!
//! The span's own duration is meaningless (opened and closed after the fact), the same convention
//! as `trail.push.peer`.

use std::collections::HashSet;

/// Which direction the data went.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dir {
    Send,
    Recv,
}

impl Dir {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Send => "send",
            Self::Recv => "recv",
        }
    }
}

/// Which pipe carried it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lane {
    /// The live path: an envelope broadcast to, or received from, a gossip neighbour.
    Gossip,
    /// Trail reconciliation: a push that a peer finished, or entries a peer delivered on a pull.
    Docs,
}

impl Lane {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Gossip => "gossip",
            Self::Docs => "docs",
        }
    }
}

/// Who a peer is to this device, as far as the native core can tell.
///
/// Built from the two durable stores JS keeps current — the recipient set (sharing + watching,
/// which together are the pool) and the delivery config — so it works the same on a JS-free wake.
/// A friend is checked FIRST: the stash is identified by position in the delivery list (it goes
/// first when opted into, see `DeliveryConfig::peer_tickets`), and a friend must never be filed as
/// the stash because that position was briefly someone else's.
#[derive(Debug, Clone, Default)]
pub struct PeerRoles {
    friends: HashSet<[u8; 32]>,
    stash: Option<[u8; 32]>,
}

impl PeerRoles {
    pub fn new(friends: impl IntoIterator<Item = [u8; 32]>, stash: Option<[u8; 32]>) -> Self {
        let friends: HashSet<[u8; 32]> = friends.into_iter().collect();
        let stash = stash.filter(|id| !friends.contains(id));
        Self { friends, stash }
    }

    /// `friend` | `stash` | `other`. `other` is honest rather than a guess: a pool member we hold no
    /// recipient record for, or a peer from before the config was written.
    pub fn role(&self, peer: &[u8; 32]) -> &'static str {
        if self.friends.contains(peer) {
            "friend"
        } else if self.stash.as_ref() == Some(peer) {
            "stash"
        } else {
            "other"
        }
    }
}

/// One exchange with one peer. See the module docs for what each field means.
pub struct Contact<'a> {
    pub dir: Dir,
    pub lane: Lane,
    pub peer: &'a [u8; 32],
    pub role: &'static str,
    pub path: &'a str,
    /// `Some` on receive only.
    pub from_author: Option<bool>,
    /// Envelopes (gossip: always 1) or entries (docs) that crossed in this contact.
    pub entries: u64,
}

/// Emit the `peer.contact` span.
pub fn record(contact: Contact<'_>) {
    let span = tracing::info_span!(
        "peer.contact",
        sc.peer = %crate::telemetry::short_hex(contact.peer),
        contact.dir = contact.dir.as_str(),
        contact.lane = contact.lane.as_str(),
        contact.role = contact.role,
        contact.path = contact.path,
        contact.from_author = tracing::field::Empty,
        entries = contact.entries,
    );
    if let Some(from_author) = contact.from_author {
        span.record("contact.from_author", from_author);
    }
    span.in_scope(|| {});
}

/// One peer's share of a docs pull: how many entries it delivered, and whether any of them was its
/// own (the author's phone itself, rather than a copy it was holding for someone else).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PullTally {
    pub entries: u64,
    pub from_author: bool,
}

/// Fold a pull's `(from, author)` deliveries into one tally per serving peer, in a stable order.
///
/// Per PEER rather than per entry because the question is "did we reach them", and a peer that
/// reconciled five namespaces in one pass is still one contact.
pub fn tally_pull(deliveries: &[([u8; 32], [u8; 32])]) -> Vec<([u8; 32], PullTally)> {
    let mut out: Vec<([u8; 32], PullTally)> = Vec::new();
    for (from, author) in deliveries {
        let idx = match out.iter().position(|(peer, _)| peer == from) {
            Some(idx) => idx,
            None => {
                out.push((*from, PullTally::default()));
                out.len() - 1
            }
        };
        let tally = &mut out[idx].1;
        tally.entries += 1;
        tally.from_author |= from == author;
    }
    out.sort_unstable_by_key(|(peer, _)| *peer);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: [u8; 32] = [0xaa; 32];
    const B: [u8; 32] = [0xbb; 32];
    const STASH: [u8; 32] = [0x55; 32];

    #[test]
    fn roles_name_friends_the_stash_and_everyone_else() {
        let roles = PeerRoles::new([A], Some(STASH));
        assert_eq!(roles.role(&A), "friend");
        assert_eq!(roles.role(&STASH), "stash");
        assert_eq!(roles.role(&B), "other");
    }

    #[test]
    fn a_friend_is_never_filed_as_the_stash() {
        // The stash is identified by list position; if a friend ever sits there (stash opted in
        // but its ticket missing), the recipient record has to win.
        let roles = PeerRoles::new([A], Some(A));
        assert_eq!(roles.role(&A), "friend");
    }

    #[test]
    fn empty_roles_say_other_rather_than_guess() {
        assert_eq!(PeerRoles::default().role(&A), "other");
    }

    #[test]
    fn a_pull_is_one_contact_per_peer() {
        // Stash relays two friends' slots; A hands over its own slot and B's.
        let out = tally_pull(&[(STASH, A), (A, A), (STASH, B), (A, B)]);
        let stash = PullTally {
            entries: 2,
            from_author: false,
        };
        let friend = PullTally {
            entries: 2,
            from_author: true,
        };
        // Sorted by peer id: 0x55.. before 0xaa...
        assert_eq!(out, vec![(STASH, stash), (A, friend)]);
    }

    #[test]
    fn names_are_stable() {
        // Dashboards and spanmetrics series match on these strings.
        assert_eq!(Dir::Send.as_str(), "send");
        assert_eq!(Dir::Recv.as_str(), "recv");
        assert_eq!(Lane::Gossip.as_str(), "gossip");
        assert_eq!(Lane::Docs.as_str(), "docs");
    }
}
