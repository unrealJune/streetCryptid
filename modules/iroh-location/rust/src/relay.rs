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

#[cfg(test)]
mod tests {
    use super::*;

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
