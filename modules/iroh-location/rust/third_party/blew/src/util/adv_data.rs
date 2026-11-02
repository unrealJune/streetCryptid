//! Parsing for the advertisement-data encoding used across the Android JNI
//! boundary.
//!
//! `BleCentralManager.kt` flattens manufacturer and service data to
//! `"<key>:<hex>,<key>:<hex>"`, mirroring the comma-joined form already used
//! for service UUIDs, because marshalling a map of byte arrays through JNI is
//! considerably more machinery than a string.
//!
//! This lives outside `platform::android` so it can be tested on every host,
//! not just on a device.

use std::collections::HashMap;
use std::hash::Hash;

/// Decode `"<key>:<hex>,<key>:<hex>"` into a map.
///
/// Entries with an unparseable key, an odd-length payload, or a non-hex digit
/// are skipped: one malformed field should cost its own entry, not the whole
/// advertisement.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub(crate) fn parse_keyed_hex<K: Hash + Eq>(
    raw: &str,
    parse_key: impl Fn(&str) -> Option<K>,
) -> HashMap<K, Vec<u8>> {
    raw.split(',')
        .filter(|entry| !entry.is_empty())
        .filter_map(|entry| {
            let (key, hex) = entry.split_once(':')?;
            let key = parse_key(key)?;
            if hex.len() % 2 != 0 {
                return None;
            }
            // The even-length check above guarantees no remainder.
            let bytes = hex
                .as_bytes()
                .as_chunks::<2>()
                .0
                .iter()
                .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).ok()?, 16).ok())
                .collect::<Option<Vec<u8>>>()?;
            Some((key, bytes))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn u16_key(k: &str) -> Option<u16> {
        k.parse().ok()
    }

    #[test]
    fn empty_input_yields_empty_map() {
        assert!(parse_keyed_hex("", u16_key).is_empty());
    }

    #[test]
    fn parses_single_entry() {
        let got = parse_keyed_hex("76:0215aabb", u16_key);
        assert_eq!(got, HashMap::from([(76, vec![0x02, 0x15, 0xaa, 0xbb])]));
    }

    #[test]
    fn parses_multiple_entries() {
        let got = parse_keyed_hex("76:00,224:ff01", u16_key);
        assert_eq!(
            got,
            HashMap::from([(76, vec![0x00]), (224, vec![0xff, 0x01])])
        );
    }

    #[test]
    fn empty_payload_is_kept() {
        assert_eq!(
            parse_keyed_hex("76:", u16_key),
            HashMap::from([(76, vec![])])
        );
    }

    #[test]
    fn malformed_entries_are_skipped_individually() {
        // In order: unparseable key, odd-length hex, non-hex digit, no colon.
        let got = parse_keyed_hex("nope:00,76:abc,77:zz,78,79:0a", u16_key);
        assert_eq!(got, HashMap::from([(79, vec![0x0a])]));
    }

    #[test]
    fn parses_uuid_keys() {
        let uuid = Uuid::parse_str("0000180f-0000-1000-8000-00805f9b34fb").unwrap();
        let got = parse_keyed_hex(&format!("{uuid}:64"), |k| k.parse::<Uuid>().ok());
        assert_eq!(got, HashMap::from([(uuid, vec![0x64])]));
    }

    #[test]
    fn uppercase_hex_is_accepted() {
        assert_eq!(
            parse_keyed_hex("76:AABB", u16_key),
            HashMap::from([(76, vec![0xaa, 0xbb])])
        );
    }
}
