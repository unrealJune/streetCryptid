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

use std::fmt;
use std::sync::Arc;

use parking_lot::Mutex;

type Held = Arc<dyn Fn() -> bool + Send + Sync>;

struct Policy {
    alpns: Vec<Vec<u8>>,
    held: Held,
}

/// Which protocols keep BLE to themselves, and when. Shared by a transport and every hook it
/// hands out; empty (nothing deferred) until [`crate::BleTransport::reserve_links_for`] is called.
#[derive(Default)]
pub(crate) struct LinkPriority {
    policy: Mutex<Option<Policy>>,
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
}
