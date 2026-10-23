use iroh::{RelayMap, RelayMode, RelayUrl};

pub(crate) fn custom_relay_mode(
    relay_urls: &[String],
    auth_token: &str,
) -> Result<RelayMode, String> {
    if relay_urls.is_empty() {
        return Err("at least one relay URL is required".into());
    }

    let auth_token = auth_token.trim();
    if auth_token.is_empty() {
        return Err("relay auth token is required".into());
    }

    let mut relays = Vec::with_capacity(relay_urls.len());
    for relay_url in relay_urls {
        let relay_url = relay_url.trim();
        if relay_url.is_empty() {
            return Err("relay URL cannot be empty".into());
        }
        let parsed = relay_url
            .parse::<RelayUrl>()
            .map_err(|error| format!("bad relay URL {relay_url:?}: {error}"))?;
        relays.push(parsed);
    }

    Ok(RelayMode::Custom(
        RelayMap::from_iter(relays).with_auth_token(auth_token.to_owned()),
    ))
}

/// The relays this process's node is configured with, set at `start`. `None` until then (and in
/// the wasm build), which makes [`scrub_addr`] a no-op.
static KNOWN_RELAYS: std::sync::RwLock<Option<Vec<RelayUrl>>> = std::sync::RwLock::new(None);
/// Relay URLs [`scrub_addr`] has already reported dropping, so each is logged once per process.
static REPORTED: std::sync::Mutex<Vec<RelayUrl>> = std::sync::Mutex::new(Vec::new());

/// Record the relays this node uses. Called by `start` with the same URLs it builds the relay map
/// from; `None` when relaying is disabled, which leaves peer addresses untouched.
// Unused by the wasm build, which shares this file and leaves addresses alone: a browser can only
// reach a peer through a relay, so it keeps every one a ticket names.
#[allow(dead_code)]
pub(crate) fn set_known_relays(relay_urls: Option<&[String]>) {
    let known = relay_urls.map(|urls| {
        urls.iter()
            .filter_map(|url| url.trim().parse::<RelayUrl>().ok())
            .collect::<Vec<_>>()
    });
    *KNOWN_RELAYS
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = known;
}

/// Drop every relay URL from a peer's address that this node does not itself use.
///
/// A ticket records the relay its owner was homed on WHEN it was minted, and the app keeps tickets
/// for the life of a friendship: every friend paired before 2026-10-11 still names an
/// `iroh-*.junephilip.com` relay, retired that day, whose name now lands on a wildcard record that
/// answers TLS with an internal error. Each dial from such a ticket opened a doomed relay
/// connection beside the real one (on 2026-10-22 every phone in the fleet held one). Every build
/// shares one relay list, so a friend's live home relay is always in ours; anything else is stale,
/// and the endpoint's address lookup (N0 DNS/pkarr) supplies the friend's current home relay.
///
/// IP and custom (BLE) addresses are kept: they cost nothing to try and are the same-wifi fast path.
pub(crate) fn scrub_addr(addr: iroh::EndpointAddr) -> iroh::EndpointAddr {
    let known = KNOWN_RELAYS
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let Some(known) = known.as_ref() else {
        return addr;
    };
    let (kept, dropped) = partition_relays(addr, known);
    drop(known);
    for url in dropped {
        let mut reported = REPORTED
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !reported.contains(&url) {
            tracing::info!(
                relay = %url,
                "relay: dropping a relay this node does not use from a peer address"
            );
            reported.push(url);
        }
    }
    kept
}

/// The pure half of [`scrub_addr`]: the address with only `known` relays, and the relays dropped.
fn partition_relays(
    addr: iroh::EndpointAddr,
    known: &[RelayUrl],
) -> (iroh::EndpointAddr, Vec<RelayUrl>) {
    let mut dropped = Vec::new();
    let addrs = addr.addrs.into_iter().filter(|transport| match transport {
        iroh::TransportAddr::Relay(url) if !known.contains(url) => {
            dropped.push(url.clone());
            false
        }
        _ => true,
    });
    let kept = iroh::EndpointAddr::from_parts(addr.id, addrs.collect::<Vec<_>>());
    (kept, dropped)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn peer(addrs: Vec<iroh::TransportAddr>) -> iroh::EndpointAddr {
        let id = iroh::SecretKey::from_bytes(&[7u8; 32]).public();
        iroh::EndpointAddr::from_parts(id, addrs)
    }

    fn url(s: &str) -> RelayUrl {
        s.parse().unwrap()
    }

    #[test]
    fn drops_relays_this_node_does_not_use_and_keeps_everything_else() {
        let ip: std::net::SocketAddr = "192.168.1.47:52644".parse().unwrap();
        let addr = peer(vec![
            iroh::TransportAddr::Relay(url("https://iroh-wus.junephilip.com")),
            iroh::TransportAddr::Relay(url("https://iroh-wus.streetcrypt.id")),
            iroh::TransportAddr::Ip(ip),
        ]);
        let known = [
            url("https://iroh-wus.streetcrypt.id"),
            url("https://iroh-euw.streetcrypt.id"),
        ];
        let (kept, dropped) = partition_relays(addr.clone(), &known);
        assert_eq!(kept.id, addr.id);
        assert_eq!(
            kept.relay_urls().cloned().collect::<Vec<_>>(),
            vec![url("https://iroh-wus.streetcrypt.id")]
        );
        assert_eq!(kept.ip_addrs().copied().collect::<Vec<_>>(), vec![ip]);
        assert_eq!(dropped, vec![url("https://iroh-wus.junephilip.com")]);
    }

    #[test]
    fn an_address_left_with_no_relay_keeps_its_id_for_the_address_lookup() {
        let addr = peer(vec![iroh::TransportAddr::Relay(url(
            "https://iroh-sea.junephilip.com",
        ))]);
        let (kept, dropped) =
            partition_relays(addr.clone(), &[url("https://iroh-sea.streetcrypt.id")]);
        assert_eq!(kept.id, addr.id);
        assert!(kept.addrs.is_empty());
        assert_eq!(dropped.len(), 1);
    }

    #[test]
    fn a_known_relay_is_matched_with_or_without_a_trailing_slash() {
        // `RelayUrl` normalises, so the configured `https://host` matches a ticket's `https://host/`.
        let addr = peer(vec![iroh::TransportAddr::Relay(url(
            "https://iroh-wus.streetcrypt.id/",
        ))]);
        let (kept, dropped) = partition_relays(addr, &[url("https://iroh-wus.streetcrypt.id")]);
        assert_eq!(kept.relay_urls().count(), 1);
        assert!(dropped.is_empty());
    }

    #[test]
    fn builds_authenticated_relay_map() {
        let urls = vec![
            "https://relay-us.example.com".into(),
            "https://relay-eu.example.com".into(),
            "https://relay-ap.example.com".into(),
        ];

        let RelayMode::Custom(map) = custom_relay_mode(&urls, "relay-token").unwrap() else {
            panic!("expected custom relay mode");
        };
        let relays: Vec<_> = map.relays();

        assert_eq!(relays.len(), 3);
        assert!(relays
            .iter()
            .all(|relay| relay.auth_token.as_deref() == Some("relay-token")));
    }

    #[test]
    fn rejects_missing_relay_configuration() {
        assert!(custom_relay_mode(&[], "relay-token").is_err());
        assert!(custom_relay_mode(&["https://relay.example.com".into()], " ").is_err());
        assert!(custom_relay_mode(&["not a URL".into()], "relay-token").is_err());
    }
}
