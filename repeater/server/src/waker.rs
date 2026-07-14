//! Push-to-sync seam — **interface + no-op stub for now**.
//!
//! A replica only makes trails *available*; a backgrounded phone still has to wake and pull
//! (ARCHITECTURE §9). When the replica accepts a new remote entry for a namespace, it asks the
//! [`Waker`] to send a silent, data-only push to that namespace's subscribers so their headless
//! runtime wakes and runs `syncTrail`.
//!
//! Real APNs/FCM implementations come later (they need provider credentials kept out of the repo).
//! Until then [`NoopWaker`] lets the replica run end-to-end without push, and tests use a recorder.

use crate::subscriptions::{NamespaceId, PushSubscription};

/// Sends a wake-up to a set of push destinations. Implementations must not block the caller for
/// long (the replica calls this from its event loop) and must never log full tokens.
pub trait Waker: Send + Sync {
    /// Wake every `target` because `namespace` gained new entries.
    fn wake(&self, namespace: &NamespaceId, targets: &[PushSubscription]);
}

/// Does nothing. Use before push credentials are wired, or when running a single-node dev stash.
#[derive(Debug, Default, Clone, Copy)]
pub struct NoopWaker;

impl Waker for NoopWaker {
    fn wake(&self, _namespace: &NamespaceId, _targets: &[PushSubscription]) {}
}

#[cfg(feature = "live")]
pub use live::{EnvCredentials, HttpPushWaker, PushConfig, PushCredentials};

#[cfg(feature = "live")]
mod live {
    use std::sync::Arc;

    use reqwest::Client;

    use super::Waker;
    use crate::push::{apns_request, fcm_request, PushRequest};
    use crate::subscriptions::{NamespaceId, Platform, PushSubscription};

    /// Supplies the short-lived `Authorization` bearer per platform at send time. A production impl
    /// mints an APNs ES256 JWT / an FCM OAuth2 access token (and refreshes them). **TODO:** that
    /// credential minting is the remaining piece — [`EnvCredentials`] reads a static bearer from the
    /// environment as a placeholder so the send path is exercisable end-to-end today.
    pub trait PushCredentials: Send + Sync {
        fn apns_bearer(&self) -> Option<String>;
        fn fcm_bearer(&self) -> Option<String>;
    }

    /// Placeholder credential source: reads static bearers from `APNS_BEARER` / `FCM_BEARER`.
    pub struct EnvCredentials;
    impl PushCredentials for EnvCredentials {
        fn apns_bearer(&self) -> Option<String> {
            std::env::var("APNS_BEARER").ok().filter(|s| !s.is_empty())
        }
        fn fcm_bearer(&self) -> Option<String> {
            std::env::var("FCM_BEARER").ok().filter(|s| !s.is_empty())
        }
    }

    /// Static per-platform routing config for the sender.
    #[derive(Debug, Clone)]
    pub struct PushConfig {
        /// `api.push.apple.com` (prod) or `api.sandbox.push.apple.com` (dev).
        pub apns_host: String,
        /// App bundle id, sent as `apns-topic`.
        pub bundle_id: String,
        /// Firebase project id.
        pub fcm_project_id: String,
    }

    /// Real waker: builds a silent push per target (see [`crate::push`]) and POSTs it fire-and-
    /// forget. A failed wake is non-fatal — the phone still catches up on its next foreground sync.
    pub struct HttpPushWaker {
        client: Client,
        config: PushConfig,
        creds: Arc<dyn PushCredentials>,
    }

    impl HttpPushWaker {
        pub fn new(config: PushConfig, creds: Arc<dyn PushCredentials>) -> Self {
            Self {
                client: Client::new(),
                config,
                creds,
            }
        }

        fn build(&self, ns: &NamespaceId, sub: &PushSubscription) -> Option<(PushRequest, String)> {
            match sub.platform {
                Platform::Apns => Some((
                    apns_request(
                        &self.config.apns_host,
                        &self.config.bundle_id,
                        &sub.token,
                        ns,
                    ),
                    self.creds.apns_bearer()?,
                )),
                Platform::Fcm => Some((
                    fcm_request(&self.config.fcm_project_id, &sub.token, ns),
                    self.creds.fcm_bearer()?,
                )),
            }
        }
    }

    impl Waker for HttpPushWaker {
        fn wake(&self, namespace: &NamespaceId, targets: &[PushSubscription]) {
            for sub in targets {
                #[allow(unused_mut)] // only mutated by the otel traceparent embedding below
                let Some((mut req, bearer)) = self.build(namespace, sub) else {
                    tracing::warn!("stash: no push credential for {}", sub.redacted());
                    continue;
                };
                // One span per push send. wake() runs inside the caller's `stash.entry.received`
                // span, so this parents there — and its OWN context rides the payload as a
                // `traceparent`, letting the woken phone link its wake back to this exact push.
                let span = tracing::info_span!(
                    "stash.wake.push",
                    sc.namespace = %crate::telemetry::short_hex(namespace),
                    platform = ?sub.platform,
                    http.response.status_code = tracing::field::Empty,
                );
                #[cfg(feature = "otel")]
                if let Some(tp) = crate::telemetry::traceparent_of(&span) {
                    match sub.platform {
                        // APNs: custom top-level key next to `type`/`ns` (never inside `aps`).
                        Platform::Apns => {
                            req.body["traceparent"] = tp.into();
                        }
                        // FCM: the data map is the only payload the app's handler receives.
                        Platform::Fcm => {
                            req.body["message"]["data"]["traceparent"] = tp.into();
                        }
                    }
                }
                let client = self.client.clone();
                let redacted = sub.redacted();
                let send = async move {
                    let mut rb = client.post(&req.url).bearer_auth(bearer).json(&req.body);
                    for (k, v) in &req.headers {
                        rb = rb.header(k.as_str(), v.as_str());
                    }
                    match rb.send().await {
                        Ok(resp) => {
                            tracing::Span::current()
                                .record("http.response.status_code", resp.status().as_u16());
                            if !resp.status().is_success() {
                                tracing::warn!("stash: push {redacted} -> {}", resp.status());
                            }
                        }
                        Err(e) => tracing::warn!("stash: push {redacted} failed: {e}"),
                    }
                };
                use tracing::Instrument;
                tokio::spawn(send.instrument(span));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::subscriptions::Platform;
    use std::sync::Mutex;

    /// Records wake calls so a test can assert who would have been pushed.
    #[derive(Default)]
    struct RecordingWaker {
        calls: Mutex<Vec<(NamespaceId, usize)>>,
    }
    impl Waker for RecordingWaker {
        fn wake(&self, namespace: &NamespaceId, targets: &[PushSubscription]) {
            self.calls.lock().unwrap().push((*namespace, targets.len()));
        }
    }

    #[test]
    fn noop_waker_is_a_safe_default() {
        let w = NoopWaker;
        w.wake(&[0u8; 32], &[]); // must not panic
    }

    #[test]
    fn recording_waker_captures_targets() {
        let w = RecordingWaker::default();
        let ns = [5u8; 32];
        let targets = vec![PushSubscription {
            platform: Platform::Fcm,
            token: "abc".to_string(),
        }];
        w.wake(&ns, &targets);
        let calls = w.calls.lock().unwrap();
        assert_eq!(calls.as_slice(), &[(ns, 1)]);
    }
}
