//! `trail-stash` — streetCryptid's always-on, ciphertext-blind trail replica.
//!
//! ## Why this exists
//! The durable path (iroh-docs) already does store-and-forward, but offline recovery assumes
//! *some other pool member* is online when a phone reconnects (see `docs/social/ARCHITECTURE.md`
//! §1.3, §5–6). In a two-person pool that set is empty. The stash is a headless, always-on member
//! of every opted-in pool: it replicates each user's encrypted trail 24/7 so either phone can
//! reconcile against it instead of needing the other phone, and it nudges backgrounded phones to
//! sync via a silent push (the [`waker`] seam).
//!
//! ## What the stash is NOT
//! It is never a recipient, so it is **never wrapped for** (§4): it holds only opaque ciphertext,
//! has no keys, and performs no crypto. In MLS (RFC 9420) terms it is an untrusted **Delivery
//! Service** — see [`mls`].
//!
//! ## Security posture
//! * **Stateless & fully in-memory.** No disk, no DB. The docs replica, blobs store, and the
//!   [`subscriptions`] registry all live in RAM; a restart clears everything and devices
//!   re-register. Nothing user-derived is ever at rest here.
//! * **Opt-in.** Nothing is replicated until a device presents a read-ticket
//!   ([`api::RegisterRequest`]); no grant → no data.
//! * **Blind logging.** Push tokens are never logged in full (see
//!   [`subscriptions::PushSubscription::redacted`]).
//!
//! ## Build status
//! The modules below ([`config`], [`retention`], [`subscriptions`], [`mls`], [`waker`], [`api`])
//! are pure and fully unit-tested with no live node. The live in-memory replica + HTTP control
//! API ([`node`], behind the `live` feature) targets iroh-docs `0.101` / iroh-blobs `0.103`;
//! its exact wiring is best-effort until the iroh cross-compile gate is exercised, the same
//! status as `modules/iroh-location/rust/src/docs.rs`.

pub mod api;
pub mod auth;
pub mod config;
pub mod mls;
pub mod push;
pub mod retention;
pub mod subscriptions;
pub mod waker;

#[cfg(feature = "live")]
pub mod node;
