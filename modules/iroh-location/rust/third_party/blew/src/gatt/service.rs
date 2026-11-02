use super::props::{AttributePermissions, CharacteristicProperties};
use uuid::Uuid;

#[derive(Debug, Clone, Default)]
pub struct GattDescriptor {
    pub uuid: Uuid,
    pub value: Vec<u8>,
}

/// A GATT characteristic.
///
/// # Platform caveats
///
/// **Apple:** If [`value`](Self::value) is non-empty **and** [`properties`](Self::properties)
/// includes [`CharacteristicProperties::WRITE`], CoreBluetooth treats the characteristic as
/// static and raises `NSInvalidArgumentException` → `SIGABRT` when a central writes to it.
/// For any writable characteristic set `value: vec![]` and handle reads via
/// [`PeripheralRequest::Read`](crate::peripheral::PeripheralRequest::Read).
#[derive(Debug, Clone, Default)]
pub struct GattCharacteristic {
    pub uuid: Uuid,
    pub properties: CharacteristicProperties,
    pub permissions: AttributePermissions,
    /// Static value for server-side characteristics; empty for client-discovered ones.
    pub value: Vec<u8>,
    pub descriptors: Vec<GattDescriptor>,
}

#[derive(Debug, Clone)]
pub struct GattService {
    pub uuid: Uuid,
    pub primary: bool,
    pub characteristics: Vec<GattCharacteristic>,
}

impl Default for GattService {
    /// Note `primary: true`, which is *not* what `#[derive(Default)]` would
    /// produce. Secondary services exist only to be included by another
    /// service and are vanishingly rare; defaulting to `false` would make the
    /// `..Default::default()` spread silently wrong for almost every caller.
    fn default() -> Self {
        Self {
            uuid: Uuid::nil(),
            primary: true,
            characteristics: Vec::new(),
        }
    }
}
