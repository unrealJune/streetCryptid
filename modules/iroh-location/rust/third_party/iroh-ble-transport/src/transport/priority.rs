//! Keeping BLE links free for a few protocols while they matter.
//!
//! Added by the streetCryptid project (2026-10). A BLE link carries a few kilobytes a second, and
//! every iroh connection to a peer shares the one pipe to it. On 2026-10-30 a Pixel 10 dialled a
//! pairing Hello to an iPhone the instant a pipe came up, and so did the two phones' friend sync:
//! thirteen `/iroh-sync/1` connections and a gossip one were established over that pipe in nine
//! seconds, the link retransmitted continuously, and the Hello never connected. It gave up after
//! 37.7 s. Nothing about the pairing was wrong except where it stood in the queue.
//!
//! [`LinkPriority`] lets the application say "while this holds, BLE is for these protocols only".
//! The transport's hook then refuses anything else on BLE — before dialling a peer that is in
//! BLE range, and after the handshake for a connection that arrived over BLE anyway (a peer whose
//! own build does not hold back). Connections over IP or a relay are never touched.
//!
//! Refusing NEW connections was not enough. On 2026-10-31 two phones that shared namespaces had
//! been syncing over their BLE link for minutes (about 700 KB each way) when a Bump window opened;
//! every `/iroh-sync/1` connection already established kept streaming, and three Hellos and a
//! Reject in a row timed out behind them. So while the policy holds, connections already on BLE
//! for any other protocol are closed too ([`LinkPriority::close_deferred`], driven by the sweep
//! [`crate::BleTransport::reserve_links_for`] starts). They redial afterwards, over BLE once the
//! hold ends, or over IP whenever they have it.

use std::fmt;
use std::sync::Arc;

use parking_lot::Mutex;

type Held = Arc<dyn Fn() -> bool + Send + Sync>;

struct Policy {
    alpns: Vec<Vec<u8>>,
    held: Held,
}

/// A connection the hook let onto BLE, as the sweep needs to see it.
pub(crate) trait TrackedConnection: Send + Sync {
    fn alpn(&self) -> &[u8];
    /// Still open.
    fn alive(&self) -> bool;
    /// Close it if it still rides BLE; whether it was closed.
    fn close_if_on_ble(&self) -> bool;
}

/// Which protocols keep BLE to themselves, and when. Shared by a transport and every hook it
/// hands out; empty (nothing deferred) until [`crate::BleTransport::reserve_links_for`] is called.
#[derive(Default)]
pub(crate) struct LinkPriority {
    policy: Mutex<Option<Policy>>,
    /// Connections that came up over BLE, so a hold can close the ones it defers.
    tracked: Mutex<Vec<Box<dyn TrackedConnection>>>,
}

impl fmt::Debug for LinkPriority {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let policy = self.policy.lock();
        f.debug_struct("LinkPriority")
            .field("alpns", &policy.as_ref().map(|p| p.alpns.len()))
            .finish()
    }
}

impl LinkPriority {
    pub(crate) fn set(&self, alpns: Vec<Vec<u8>>, held: Held) {
        *self.policy.lock() = Some(Policy { alpns, held });
    }

    /// Whether a connection for `alpn` must stay off BLE right now.
    pub(crate) fn defers(&self, alpn: &[u8]) -> bool {
        let policy = self.policy.lock();
        let Some(policy) = policy.as_ref() else {
            return false;
        };
        !policy.alpns.iter().any(|kept| kept.as_slice() == alpn) && (policy.held)()
    }

    /// Remember a connection that came up over BLE (dropping any that have closed since).
    pub(crate) fn track(&self, connection: Box<dyn TrackedConnection>) {
        let mut tracked = self.tracked.lock();
        tracked.retain(|c| c.alive());
        tracked.push(connection);
    }

    /// Close every tracked connection the policy defers right now that still rides BLE, and
    /// forget the ones that have closed. Returns how many were closed.
    pub(crate) fn close_deferred(&self) -> usize {
        let mut tracked = self.tracked.lock();
        let mut closed = 0;
        tracked.retain(|c| {
            if !c.alive() {
                return false;
            }
            if self.defers(c.alpn()) && c.close_if_on_ble() {
                closed += 1;
                return false;
            }
            true
        });
        closed
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    #[test]
    fn nothing_is_deferred_until_a_policy_is_set() {
        assert!(!LinkPriority::default().defers(b"/iroh-sync/1"));
    }

    #[test]
    fn only_other_protocols_are_deferred_and_only_while_held() {
        let held = Arc::new(AtomicBool::new(true));
        let priority = LinkPriority::default();
        let flag = Arc::clone(&held);
        priority.set(
            vec![b"pair".to_vec()],
            Arc::new(move || flag.load(Ordering::SeqCst)),
        );

        assert!(!priority.defers(b"pair"));
        assert!(priority.defers(b"/iroh-sync/1"));

        held.store(false, Ordering::SeqCst);
        assert!(!priority.defers(b"/iroh-sync/1"));
    }

    struct Fake {
        alpn: Vec<u8>,
        on_ble: bool,
        open: Arc<AtomicBool>,
    }

    impl TrackedConnection for Fake {
        fn alpn(&self) -> &[u8] {
            &self.alpn
        }
        fn alive(&self) -> bool {
            self.open.load(Ordering::SeqCst)
        }
        fn close_if_on_ble(&self) -> bool {
            if self.on_ble {
                self.open.store(false, Ordering::SeqCst);
            }
            self.on_ble
        }
    }

    fn fake(priority: &LinkPriority, alpn: &[u8], on_ble: bool) -> Arc<AtomicBool> {
        let open = Arc::new(AtomicBool::new(true));
        priority.track(Box::new(Fake {
            alpn: alpn.to_vec(),
            on_ble,
            open: Arc::clone(&open),
        }));
        open
    }

    #[test]
    fn a_hold_closes_established_connections_of_other_protocols_on_ble_only() {
        let held = Arc::new(AtomicBool::new(false));
        let priority = LinkPriority::default();
        let flag = Arc::clone(&held);
        priority.set(
            vec![b"pair".to_vec()],
            Arc::new(move || flag.load(Ordering::SeqCst)),
        );
        let sync = fake(&priority, b"/iroh-sync/1", true);
        let pair = fake(&priority, b"pair", true);
        let sync_over_ip = fake(&priority, b"/iroh-sync/1", false);

        // Not held: nothing is touched.
        assert_eq!(priority.close_deferred(), 0);
        assert!(sync.load(Ordering::SeqCst));

        held.store(true, Ordering::SeqCst);
        assert_eq!(priority.close_deferred(), 1);
        assert!(!sync.load(Ordering::SeqCst));
        assert!(pair.load(Ordering::SeqCst));
        assert!(sync_over_ip.load(Ordering::SeqCst));
        // Closed ones are forgotten, so a second sweep closes nothing new.
        assert_eq!(priority.close_deferred(), 0);
    }
}
