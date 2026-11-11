//! `streetcryptid-repeater` — the contract between a streetCryptid phone and a repeater.
//! Design: streetCryptid `docs/social/REPEATERS.md`.
//!
//! ## What belongs here
//! Exactly what both sides must agree on byte for byte, and nothing else:
//!
//! * [`roster`] — the signed op log saying whose trails a person's repeaters carry, who may change
//!   that, and which machines are theirs; every rule for judging it; the [`roster::RepeaterCert`]
//!   that links a repeater to its owner.
//! * [`wire`] — the `streetcryptid/repeater/1` requests, responses and framing, the grant proof
//!   that a namespace is the caller's own, and the claim link a repeater prints.
//!
//! ## What does not
//! Transport (each side has its own iroh, and they are different versions), storage, timers, and
//! anything only one side reads: the console claim window and the namespace book are the
//! repeater's; the `RepeaterCard` a friend publishes and the enrolment prompt are the app's.
//! Nothing here does I/O, so every rule is a unit test.
//!
//! Every identity is a raw 32-byte ed25519 public key, which is what an iroh endpoint id and an
//! iroh-docs namespace id both are; converting to and from iroh types is the caller's business.

pub mod roster;
pub mod wire;
