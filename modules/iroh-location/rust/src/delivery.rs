//! Where a published envelope has to be *sent* for it to leave this phone.
//!
//! The third and last of the "JS writes it down once, the background path reads it" stores, after
//! [`crate::recipients`] (who to seal for) and [`crate::transport`] (how to reach the network).
//! This one answers the question those two do not: **who to hand the sealed bytes to.**
//!
//! # Why this had to exist
//!
//! `docs_write` writes the LOCAL replica, and iroh-docs broadcasts a local insert only for
//! namespaces the live engine has marked as syncing — which a publish-only context never does. So
//! a fix is not off the phone until [`crate::LocationNode::push_trail`] has dialed somebody, and
//! `push_trail` needs peer *tickets*, which are not derivable from anything the native side
//! already holds: [`crate::recipients`] stores endpoint ids, and an id without an addr is not
//! dialable on a cold start.
//!
//! Without this store the native drain path could seal an envelope, gossip it to an empty swarm,
//! write it to a replica nobody reconciles with, and report success — which is precisely what two
//! phones did all day on 2026-08-31 while the stash received nothing from either.
//!
//! # Staleness
//!
//! Same shape as [`crate::recipients`], and safe in the same direction. A ticket for a friend who
//! has left the pool costs one dial to someone who will not accept the namespace; a friend added
//! since the last push is missed until it lands, and the mounted app is by definition running at
//! the moment a friend is added. Neither loses a fix: the entries stay in the local replica and go
//! out on the next push.
//!
//! # Empty is a valid, meaningful value
//!
//! Unlike [`crate::transport`], "nothing to push to" is a real configuration — a user with the
//! stash opted out and no friends yet — not a bootstrap that has not happened. So this store
//! returns an empty config rather than failing, and the drain treats an empty peer list as "no
//! push to make" rather than as an error to retry. The distinction matters because the alternative
//! is a warning on every wake for a user who has done nothing wrong.
//!
//! # On storing the stash PSK
//!
//! The same reasoning as the relay token in [`crate::transport`]: it is an `EXPO_PUBLIC_*` value
//! inlined into the app bundle, so anyone holding the binary already has it, and writing it to the
//! app's private data dir adds no exposure that unpacking the IPA or APK does not.

use std::path::{Path, PathBuf};
use std::sync::RwLock;

use serde::{Deserialize, Serialize};

use crate::durable::write_atomic;

const DELIVERY_DIR: &str = "delivery";
const CONFIG_FILE: &str = "config";

/// Everything the drain needs to get a published envelope off the device.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, uniffi::Record)]
pub struct DeliveryConfig {
    /// Every endpoint worth dialing after a drain: the trail stash first when it is opted into,
    /// then every pool member. Mirrors `durablePeerTickets()` in `location-sharing.ts` — the two
    /// must agree, because whichever path publishes has to reach the same set.
    pub peer_tickets: Vec<String>,
    /// Base URL of the trail stash's content API, when the user has opted into durable delivery.
    /// `None` means push to peers only and upload no blobs.
    pub stash_base_url: Option<String>,
    /// Pre-shared key for that API, when the deployment requires one. Meaningless without
    /// `stash_base_url` and always written with it.
    pub stash_psk: Option<String>,
}

impl DeliveryConfig {
    /// Whether there is anywhere at all to send. An empty peer list makes a push a no-op that still
    /// costs a native round trip and a span, so the drain checks this first.
    pub fn is_empty(&self) -> bool {
        self.peer_tickets.is_empty()
    }

    /// The stash content endpoint and its key, when durable delivery is opted into.
    ///
    /// The URL alone decides: `psk` is `None` for a deployment that does not require one, which is
    /// a supported configuration rather than a half-written record. `stash_psk` without
    /// `stash_base_url` is meaningless and ignored.
    pub fn stash(&self) -> Option<(&str, Option<String>)> {
        self.stash_base_url
            .as_deref()
            .map(|url| (url, self.stash_psk.clone()))
    }
}

/// When the native drain last managed each step, in ms since epoch.
///
/// Three separate answers because the gaps between them are the whole diagnosis: accepted but not
/// published is a gate or battery decision, published but not pushed is a phone talking to its own
/// replica, and neither is visible from a single "last seen" number.
#[derive(Debug, Clone, Default, PartialEq, Eq, uniffi::Record)]
pub struct PublishWatermarks {
    /// A fix passed the confidence gate and became this device's position.
    pub last_accepted_at: Option<u64>,
    /// A drain put at least one envelope on the wire.
    pub last_published_at: Option<u64>,
    /// A push completed, so those envelopes actually left the device.
    pub last_pushed_at: Option<u64>,
}

#[derive(Debug, thiserror::Error)]
pub enum DeliveryError {
    #[error("delivery config io: {0}")]
    Io(String),
}

impl From<std::io::Error> for DeliveryError {
    fn from(e: std::io::Error) -> Self {
        DeliveryError::Io(e.to_string())
    }
}

/// The delivery settings, cached in memory and mirrored to disk.
#[derive(Debug)]
pub struct DeliveryStore {
    dir: PathBuf,
    path: PathBuf,
    /// Read on every drain and written only when the pool or the stash opt-in changes, so the
    /// asymmetry of `RwLock` is the right one.
    current: RwLock<DeliveryConfig>,
}

impl DeliveryStore {
    pub fn open(state_dir: &Path) -> Result<Self, DeliveryError> {
        let dir = state_dir.join(DELIVERY_DIR);
        std::fs::create_dir_all(&dir)?;
        let path = dir.join(CONFIG_FILE);
        // A config we cannot decode is treated as absent rather than as an error. Unlike the seq
        // counter, nothing here is corrupted by starting over: JS rewrites it on the next launch,
        // and until then the entries wait in the local replica.
        let current = match std::fs::read(&path) {
            Ok(raw) => postcard::from_bytes::<DeliveryConfig>(&raw).unwrap_or_default(),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => DeliveryConfig::default(),
            Err(e) => return Err(e.into()),
        };
        Ok(Self {
            dir,
            path,
            current: RwLock::new(current),
        })
    }

    /// Where to send right now. Empty when nothing has been stored yet.
    pub fn get(&self) -> DeliveryConfig {
        self.current
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// Replace the settings, durable before returning.
    pub fn set(&self, config: DeliveryConfig) -> Result<(), DeliveryError> {
        let bytes = postcard::to_allocvec(&config)
            .map_err(|e| DeliveryError::Io(format!("encode: {e}")))?;
        write_atomic(&self.dir, &self.path, &bytes)?;
        *self.current.write().unwrap_or_else(|e| e.into_inner()) = config;
        Ok(())
    }
}
