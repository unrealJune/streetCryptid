use std::collections::HashMap;
use uuid::Uuid;

/// Platform-specific device identifier.
/// On Apple platforms this is a UUID string; on Linux/Android it is a hex MAC address.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct DeviceId(pub(crate) String);

impl DeviceId {
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for DeviceId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<String> for DeviceId {
    fn from(s: String) -> Self {
        Self(s)
    }
}

impl From<&str> for DeviceId {
    fn from(s: &str) -> Self {
        Self(s.to_owned())
    }
}

/// A discovered BLE device snapshot.
///
/// Produced by the library, never constructed by callers, so it carries no
/// `Default`. Match with a trailing `..` to stay forward-compatible.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct BleDevice {
    pub id: DeviceId,
    pub name: Option<String>,
    pub rssi: Option<i16>,
    pub services: Vec<Uuid>,
    /// Manufacturer-specific advertisement data, keyed by the 16-bit Bluetooth
    /// SIG company identifier.
    ///
    /// A BLE advertisement carries at most one manufacturer-data field, so this
    /// map holds either zero or one entry; it is a map because the company
    /// identifier is the useful part to match on. Empty when the peer
    /// advertised none.
    pub manufacturer_data: HashMap<u16, Vec<u8>>,
    /// Service advertisement data, keyed by service UUID. Empty when the peer
    /// advertised none.
    pub service_data: HashMap<Uuid, Vec<u8>>,
}
