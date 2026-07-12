//! In-memory registry of "who wants to be woken about which namespace".
//!
//! This is the entire persistent state of the stash — and it is deliberately **not** persistent.
//! It lives in RAM for the process lifetime only; a restart clears it and devices re-register on
//! their next opted-in sync. Holding `(namespace → push subscriptions)` is the one bit of
//! identity-adjacent metadata the stash keeps (see ARCHITECTURE §10, "relay operator"); locations
//! are never here.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

/// An iroh-docs namespace id (the public key of a user's trail doc).
pub type NamespaceId = [u8; 32];

/// Which push transport a token belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Platform {
    /// Apple Push Notification service (iOS).
    Apns,
    /// Firebase Cloud Messaging (Android).
    Fcm,
}

impl Platform {
    pub fn as_str(&self) -> &'static str {
        match self {
            Platform::Apns => "apns",
            Platform::Fcm => "fcm",
        }
    }
}

/// A device's silent-push destination. The `token` is sensitive: never log it in full.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct PushSubscription {
    pub platform: Platform,
    pub token: String,
}

impl PushSubscription {
    /// A log-safe rendering: platform + a short suffix of the token, never the whole thing.
    pub fn redacted(&self) -> String {
        let n = self.token.len();
        let tail = if n >= 4 { &self.token[n - 4..] } else { "" };
        format!("{}:…{}", self.platform.as_str(), tail)
    }
}

/// Process-lifetime, in-memory registry. `Send + Sync` via an internal mutex so it can be shared
/// across the async control-API + replica tasks.
#[derive(Default)]
pub struct NamespaceRegistry {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    /// Namespaces we've been asked to replicate at least once (so import runs once each).
    known: HashSet<NamespaceId>,
    /// Wake targets per namespace.
    subs: HashMap<NamespaceId, HashSet<PushSubscription>>,
}

impl NamespaceRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record interest in `ns`, optionally adding a push subscription. Returns `true` iff this is
    /// the first time we've seen `ns` (so the caller triggers the one-time ticket import).
    pub fn register(&self, ns: NamespaceId, sub: Option<PushSubscription>) -> bool {
        let mut g = self.inner.lock().expect("registry mutex poisoned");
        let is_new = g.known.insert(ns);
        if let Some(sub) = sub {
            g.subs.entry(ns).or_default().insert(sub);
        }
        is_new
    }

    /// Drop one device's push subscription from `ns`. Returns `true` iff it was present. The
    /// namespace stays "known" (still replicated) — unsubscribing only stops the wake, matching
    /// `DELETE /v1/namespaces/{id}/subscription`.
    pub fn unsubscribe(&self, ns: &NamespaceId, sub: &PushSubscription) -> bool {
        let mut g = self.inner.lock().expect("registry mutex poisoned");
        if let Some(set) = g.subs.get_mut(ns) {
            let removed = set.remove(sub);
            if set.is_empty() {
                g.subs.remove(ns);
            }
            removed
        } else {
            false
        }
    }

    /// The wake targets for a namespace that just changed. Waking the entry's own author is a
    /// harmless no-op (it already has the data), so the registry does not special-case it.
    pub fn wake_targets(&self, ns: &NamespaceId) -> Vec<PushSubscription> {
        let g = self.inner.lock().expect("registry mutex poisoned");
        g.subs
            .get(ns)
            .map(|s| s.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// Every namespace we've been granted (own + friends across all devices).
    pub fn known_namespaces(&self) -> Vec<NamespaceId> {
        let g = self.inner.lock().expect("registry mutex poisoned");
        g.known.iter().copied().collect()
    }

    pub fn is_known(&self, ns: &NamespaceId) -> bool {
        self.inner
            .lock()
            .expect("registry mutex poisoned")
            .known
            .contains(ns)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sub(tok: &str) -> PushSubscription {
        PushSubscription {
            platform: Platform::Apns,
            token: tok.to_string(),
        }
    }

    #[test]
    fn first_register_is_new_then_idempotent() {
        let reg = NamespaceRegistry::new();
        let ns = [1u8; 32];
        assert!(reg.register(ns, Some(sub("aaaa1111"))));
        assert!(!reg.register(ns, Some(sub("bbbb2222"))));
        assert!(reg.is_known(&ns));
    }

    #[test]
    fn wake_targets_dedupe_identical_subscriptions() {
        let reg = NamespaceRegistry::new();
        let ns = [2u8; 32];
        reg.register(ns, Some(sub("token-xyz")));
        reg.register(ns, Some(sub("token-xyz"))); // same device re-registers
        reg.register(ns, Some(sub("other-dev")));
        assert_eq!(reg.wake_targets(&ns).len(), 2);
    }

    #[test]
    fn unsubscribe_removes_target_but_keeps_namespace_known() {
        let reg = NamespaceRegistry::new();
        let ns = [3u8; 32];
        let s = sub("wake-me");
        reg.register(ns, Some(s.clone()));
        assert!(reg.unsubscribe(&ns, &s));
        assert!(!reg.unsubscribe(&ns, &s)); // already gone
        assert!(reg.wake_targets(&ns).is_empty());
        assert!(reg.is_known(&ns)); // still replicated
    }

    #[test]
    fn register_without_subscription_still_marks_known() {
        let reg = NamespaceRegistry::new();
        let ns = [4u8; 32];
        assert!(reg.register(ns, None));
        assert!(reg.is_known(&ns));
        assert!(reg.wake_targets(&ns).is_empty());
    }

    #[test]
    fn redacted_never_reveals_full_token() {
        let s = sub("supersecrettoken1234");
        let r = s.redacted();
        assert_eq!(r, "apns:…1234");
        assert!(!r.contains("supersecret"));
    }

    #[test]
    fn known_namespaces_lists_all_grants() {
        let reg = NamespaceRegistry::new();
        reg.register([5u8; 32], None);
        reg.register([6u8; 32], Some(sub("t")));
        let mut all = reg.known_namespaces();
        all.sort();
        assert_eq!(all, vec![[5u8; 32], [6u8; 32]]);
    }
}
