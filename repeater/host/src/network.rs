//! Machine-local connection settings. Keys are write-only over the management protocol:
//! snapshots expose presence, never credentials. Changes take effect on the next host start.

use std::collections::BTreeSet;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{bail, Context, Result};
use iroh::{RelayConfig, RelayMap, RelayUrl};
use serde::{Deserialize, Serialize};

#[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NetworkConfig {
    #[serde(default)]
    pub relays: Vec<Relay>,
    #[serde(default)]
    pub telemetry_endpoint: String,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Relay {
    pub url: String,
    /// Omitted/null preserves the saved key for this URL; "" removes it.
    #[serde(default)]
    pub auth_token: Option<String>,
}

impl std::fmt::Debug for NetworkConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("NetworkConfig { [redacted] }")
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkStatus {
    pub relays: Vec<RelayStatus>,
    pub telemetry_endpoint: String,
    pub restart_required: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayStatus {
    pub url: String,
    pub has_auth_token: bool,
}

impl NetworkConfig {
    pub fn validate(&self) -> Result<()> {
        if self.relays.len() > 8 {
            bail!("At most eight relays may be configured");
        }
        let mut urls = BTreeSet::new();
        for relay in &self.relays {
            let url = checked_url(&relay.url)?;
            if url.path() != "/" || !urls.insert(url.to_string()) {
                bail!("Relay URLs must be unique origins");
            }
            if let Some(key) = &relay.auth_token {
                if key.len() > 512 || !key.bytes().all(|b| (0x21..=0x7e).contains(&b)) {
                    bail!(
                        "Relay keys must be at most 512 printable ASCII characters without spaces"
                    );
                }
            }
        }
        if !self.telemetry_endpoint.is_empty() {
            checked_url(&self.telemetry_endpoint)?;
        }
        Ok(())
    }

    pub fn relay_map(&self) -> Result<Option<RelayMap>> {
        self.validate()?;
        if self.relays.is_empty() {
            return Ok(None);
        }
        let mut configs = Vec::new();
        for relay in &self.relays {
            let url: RelayUrl = relay
                .url
                .parse()
                .map_err(|_| anyhow::anyhow!("Invalid relay URL"))?;
            let mut config = RelayConfig::from(url);
            if let Some(key) = relay.auth_token.as_ref().filter(|key| !key.is_empty()) {
                config = config.with_auth_token(key.clone());
            }
            configs.push(config);
        }
        Ok(Some(configs.into_iter().collect()))
    }

    pub fn telemetry_endpoint<'a>(&'a self, built_in: Option<&'a str>) -> Option<&'a str> {
        if self.telemetry_endpoint.is_empty() {
            built_in.filter(|e| !e.trim().is_empty())
        } else {
            Some(&self.telemetry_endpoint)
        }
    }
}

fn checked_url(value: &str) -> Result<url::Url> {
    if value.len() > 2048 || value.trim() != value {
        bail!("Invalid endpoint URL");
    }
    let url = url::Url::parse(value).map_err(|_| anyhow::anyhow!("Invalid endpoint URL"))?;
    let loopback = url.host_str().is_some_and(|host| {
        host == "localhost"
            || host
                .trim_matches(['[', ']'])
                .parse::<std::net::IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
    });
    if !(url.scheme() == "https" || (url.scheme() == "http" && loopback))
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        bail!("Use HTTPS (HTTP only on loopback), without credentials, query or fragment");
    }
    Ok(url)
}

pub struct NetworkSettings {
    path: PathBuf,
    active: NetworkConfig,
    saved: Mutex<NetworkConfig>,
}

impl NetworkSettings {
    pub fn open(dir: &Path) -> Result<Self> {
        let path = dir.join("network-settings.json");
        let mut config: NetworkConfig = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| {
                anyhow::anyhow!("Invalid network settings; restore network-settings.json")
            })?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => NetworkConfig::default(),
            Err(_) => bail!("Could not read network settings"),
        };
        config.validate()?;
        normalize(&mut config);
        Ok(Self {
            path,
            active: config.clone(),
            saved: Mutex::new(config),
        })
    }

    pub fn active(&self) -> &NetworkConfig {
        &self.active
    }

    pub fn status(&self) -> NetworkStatus {
        let saved = self.saved.lock().expect("network settings poisoned");
        NetworkStatus {
            relays: saved
                .relays
                .iter()
                .map(|relay| RelayStatus {
                    url: relay.url.clone(),
                    has_auth_token: relay.auth_token.as_ref().is_some_and(|s| !s.is_empty()),
                })
                .collect(),
            telemetry_endpoint: saved.telemetry_endpoint.clone(),
            restart_required: *saved != self.active,
        }
    }

    pub fn set(&self, mut next: NetworkConfig) -> Result<()> {
        next.validate()?;
        normalize(&mut next);
        let mut saved = self.saved.lock().expect("network settings poisoned");
        for relay in &mut next.relays {
            if relay.auth_token.is_none() {
                relay.auth_token = saved
                    .relays
                    .iter()
                    .find(|old| old.url == relay.url)
                    .and_then(|old| old.auth_token.clone());
            }
        }
        // A fresh file avoids following a planted temporary-file symlink. Restrict it before
        // writing any key; Windows inherits the state directory's user/service ACL.
        let tmp = self.path.with_extension(format!("{}.tmp", crate::run_id()));
        let result = (|| -> Result<()> {
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&tmp)?;
            file.write_all(&serde_json::to_vec(&next)?)?;
            file.sync_all()?;
            std::fs::rename(&tmp, &self.path)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
        result.context("Could not save network settings")?;
        *saved = next;
        Ok(())
    }
}

fn normalize(config: &mut NetworkConfig) {
    for relay in &mut config.relays {
        relay.url = checked_url(&relay.url).expect("validated URL").to_string();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(key: Option<&str>) -> NetworkConfig {
        NetworkConfig {
            relays: vec![Relay {
                url: "https://relay.example".into(),
                auth_token: key.map(str::to_owned),
            }],
            telemetry_endpoint: "https://collector.example/otlp".into(),
        }
    }

    #[test]
    fn keys_are_write_only_preserved_cleared_and_applied_after_restart() {
        let dir = tempfile::tempdir().unwrap();
        let settings = NetworkSettings::open(dir.path()).unwrap();
        settings.set(config(Some("test-secret"))).unwrap();
        let status = serde_json::to_string(&settings.status()).unwrap();
        assert!(!status.contains("test-secret"));
        assert!(settings.status().restart_required);
        assert!(settings.active().relay_map().unwrap().is_none());
        settings.set(config(None)).unwrap();
        let reopened = NetworkSettings::open(dir.path()).unwrap();
        assert!(!reopened.status().restart_required);
        let map = reopened.active().relay_map().unwrap().unwrap();
        assert_eq!(
            map.relays::<Vec<_>>()[0].auth_token.as_deref(),
            Some("test-secret")
        );
        assert_eq!(
            reopened
                .active()
                .telemetry_endpoint(Some("https://default.example")),
            Some("https://collector.example/otlp")
        );
        reopened.set(config(Some(""))).unwrap();
        assert!(!reopened.status().relays[0].has_auth_token);
        reopened.set(NetworkConfig::default()).unwrap();
        assert!(reopened.status().relays.is_empty());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(dir.path().join("network-settings.json"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn invalid_urls_and_keys_cannot_replace_saved_settings() {
        let dir = tempfile::tempdir().unwrap();
        let settings = NetworkSettings::open(dir.path()).unwrap();
        settings.set(config(Some("saved"))).unwrap();
        for url in [
            "http://remote.example",
            "https://user:secret@example.com",
            "https://relay.example?token=secret",
            "file:///tmp/x",
            "https://relay.example/#key",
        ] {
            let mut next = config(None);
            next.relays[0].url = url.into();
            assert!(settings.set(next).is_err());
        }
        let mut duplicate = config(None);
        duplicate.relays.push(Relay {
            url: "https://relay.example/".into(),
            auth_token: None,
        });
        assert!(settings.set(duplicate).is_err());
        assert!(settings.set(config(Some("bad\r\nkey"))).is_err());
        assert!(settings.status().relays[0].has_auth_token);
        assert!(!format!("{:?}", config(Some("saved"))).contains("saved"));
    }

    #[test]
    fn relay_keys_are_scoped_to_their_own_url() {
        let dir = tempfile::tempdir().unwrap();
        let settings = NetworkSettings::open(dir.path()).unwrap();
        let mut next = config(Some("first-key"));
        next.relays.push(Relay {
            url: "https://second.example".into(),
            auth_token: Some("second-key".into()),
        });
        settings.set(next).unwrap();
        let reopened = NetworkSettings::open(dir.path()).unwrap();
        let map = reopened.active().relay_map().unwrap().unwrap();
        assert_eq!(
            map.get(&"https://relay.example".parse().unwrap())
                .unwrap()
                .auth_token
                .as_deref(),
            Some("first-key")
        );
        assert_eq!(
            map.get(&"https://second.example".parse().unwrap())
                .unwrap()
                .auth_token
                .as_deref(),
            Some("second-key")
        );
        let mut renamed = config(None);
        renamed.relays[0].url = "https://new.example".into();
        settings.set(renamed).unwrap();
        assert!(!settings.status().relays[0].has_auth_token);
    }

    #[test]
    fn damaged_settings_never_silently_switch_to_public_relays() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("network-settings.json"), b"broken").unwrap();
        assert!(NetworkSettings::open(dir.path()).is_err());
    }
}
