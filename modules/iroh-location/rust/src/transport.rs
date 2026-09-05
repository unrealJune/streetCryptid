//! The transport settings a background bootstrap needs before it can call `start`.
//!
//! The last piece of state the native drain path was missing. `start` needs relay URLs, a relay
//! token and the three transport toggles; today those reach it from JS, where the URLs and token
//! are build-time `EXPO_PUBLIC_*` constants inlined into the bundle and the toggles are user
//! preferences. A wake with no JS context has neither, so — exactly as with
//! [`crate::recipients`] — JS writes them down once and the background path reads them.
//!
//! # On storing the relay token
//!
//! It is not a secret this store weakens. `EXPO_PUBLIC_*` values are inlined into the app bundle,
//! so anyone holding the binary already has it; that is recorded in `infra/otel/README.md` for the
//! collector endpoint and applies verbatim here. Writing it to the app's private data dir adds no
//! exposure that unpacking the IPA or APK does not already give.
//!
//! # Fail-closed
//!
//! Unset or unreadable is an error at `start`, never a default. Booting a background node with an
//! empty relay list would produce one that runs, reports healthy, and can only ever reach peers on
//! the same LAN — which is indistinguishable from the connectivity failures this whole effort
//! exists to diagnose.

use std::path::{Path, PathBuf};
use std::sync::RwLock;

use serde::{Deserialize, Serialize};

use crate::durable::write_atomic;

const TRANSPORT_DIR: &str = "transport";
const CONFIG_FILE: &str = "config";

/// Everything `LocationNode::start` needs, in one record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, uniffi::Record)]
pub struct TransportConfig {
    pub relay_urls: Vec<String>,
    pub relay_auth_token: String,
    pub relay_enabled: bool,
    pub ip_enabled: bool,
    pub ble_enabled: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum TransportError {
    #[error("transport config io: {0}")]
    Io(String),
    /// Nothing stored yet, or what is stored cannot be read. Both mean the background path must
    /// not start — see the module docs.
    #[error("no usable transport config; the app has not stored one yet")]
    Unset,
}

impl From<std::io::Error> for TransportError {
    fn from(e: std::io::Error) -> Self {
        TransportError::Io(e.to_string())
    }
}

/// The transport settings, cached in memory and mirrored to disk.
#[derive(Debug)]
pub struct TransportStore {
    dir: PathBuf,
    path: PathBuf,
    /// Read once per bootstrap and written only when the user changes a toggle, so the asymmetry
    /// of `RwLock` is the right one.
    current: RwLock<Option<TransportConfig>>,
}

impl TransportStore {
    pub fn open(state_dir: &Path) -> Result<Self, TransportError> {
        let dir = state_dir.join(TRANSPORT_DIR);
        std::fs::create_dir_all(&dir)?;
        let path = dir.join(CONFIG_FILE);
        let current = match std::fs::read(&path) {
            Ok(raw) => postcard::from_bytes::<TransportConfig>(&raw).ok(),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(e.into()),
        };
        Ok(Self {
            dir,
            path,
            current: RwLock::new(current),
        })
    }

    /// The stored settings, or [`TransportError::Unset`].
    pub fn get(&self) -> Result<TransportConfig, TransportError> {
        self.current
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
            .ok_or(TransportError::Unset)
    }

    /// Replace the settings, durable before returning.
    pub fn set(&self, config: TransportConfig) -> Result<(), TransportError> {
        let bytes = postcard::to_allocvec(&config)
            .map_err(|e| TransportError::Io(format!("encode: {e}")))?;
        write_atomic(&self.dir, &self.path, &bytes)?;
        *self.current.write().unwrap_or_else(|e| e.into_inner()) = Some(config);
        Ok(())
    }
}
