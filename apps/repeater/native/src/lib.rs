use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use fs2::FileExt;
use iroh::SecretKey;
use serde::{Deserialize, Serialize};
use streetcryptid_repeater::roster::Policy;
use trail_stash::config::StashConfig;
use trail_stash::node::{default_delivery, default_waker, StashNode, Storage};

pub fn claim_directory(dir: &Path) -> Result<File> {
    std::fs::create_dir_all(dir)?;
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(dir.join("host.lock"))?;
    lock.try_lock_exclusive()
        .context("This repeater is already running")?;
    Ok(lock)
}

pub fn identity(dir: &Path) -> Result<SecretKey> {
    let path = dir.join("secret.key");
    match std::fs::read(&path) {
        Ok(bytes) => {
            let seed: [u8; 32] = bytes.try_into().map_err(|_| {
                anyhow::anyhow!("The repeater identity is damaged; it was not replaced")
            })?;
            Ok(SecretKey::from_bytes(&seed))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            if dir.join("roster.bin").exists() || dir.join("namespaces.json").exists() {
                bail!(
                    "The repeater identity is missing; restore it rather than claiming a new one"
                );
            }
            let secret = SecretKey::generate();
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(path)?;
            file.write_all(&secret.to_bytes())?;
            file.sync_all()?;
            Ok(secret)
        }
        Err(e) => Err(e.into()),
    }
}

pub async fn start(dir: &Path, secret: SecretKey) -> Result<Arc<StashNode>> {
    let config = StashConfig::from_env(|_| None);
    // On disk, like every repeater (REPEATERS.md §5.1): a Windows restart for an update is
    // exactly when a phone is most likely to be asleep, so what was carried must survive it.
    tokio::time::timeout(
        Duration::from_secs(30),
        StashNode::spawn_with(
            Storage::Persistent(dir.into()),
            secret,
            config.retention,
            &[],
            None,
            default_delivery(),
            default_waker(),
        ),
    )
    .await
    .context("Starting the repeater timed out")?
}

/// Written into a per-user state directory once its identity has moved to the Windows service.
/// A per-user host refuses such a directory: starting there would mint a second identity for a
/// machine whose owner already claimed the first.
pub const SERVICE_MARKER: &str = "moved-to-service";

/// The line protocol between the host and whatever supervises it (the desktop app, or the
/// Windows service relaying for it). 2: settings replaced the local subscription command, and
/// snapshots carry the host's version, mode, storage and settings.
pub const PROTOCOL: u32 = 2;

/// Choices the person running the repeater makes about this machine. They live with the node's
/// state, not with the UI, because under the Windows service the UI is a client that comes and
/// goes and the host is what has to honour them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostSettings {
    /// Send diagnostics to the developers' collector. Meaningful only in a build that has one.
    /// Off until the person has seen the choice: the UI sends their answer when setup completes.
    pub telemetry: bool,
    /// Ask Windows not to sleep while this PC is on mains power.
    pub keep_awake: bool,
}

/// [`HostSettings`] behind the flags the telemetry filter and the power thread read.
pub struct Settings {
    path: PathBuf,
    current: Mutex<HostSettings>,
    telemetry: Arc<AtomicBool>,
    keep_awake: Arc<AtomicBool>,
}

impl Settings {
    /// A missing file is the default. A damaged one reads as "no" to both rather than refusing
    /// to start — the safe reading of a consent nobody can read — and stays in place until the
    /// next deliberate change replaces it.
    pub fn open(dir: &Path) -> Self {
        let path = dir.join("host-settings.json");
        let current = std::fs::read(&path)
            .ok()
            .map(|bytes| serde_json::from_slice(&bytes).unwrap_or_default())
            .unwrap_or_default();
        Self {
            path,
            telemetry: Arc::new(AtomicBool::new(current.telemetry)),
            keep_awake: Arc::new(AtomicBool::new(current.keep_awake)),
            current: Mutex::new(current),
        }
    }

    pub fn get(&self) -> HostSettings {
        *self.current.lock().expect("settings poisoned")
    }

    pub fn telemetry_flag(&self) -> Arc<AtomicBool> {
        self.telemetry.clone()
    }

    pub fn keep_awake_flag(&self) -> Arc<AtomicBool> {
        self.keep_awake.clone()
    }

    /// Persist first, then apply: a choice reported as saved must survive a restart.
    pub fn set(&self, next: HostSettings) -> Result<()> {
        let mut current = self.current.lock().expect("settings poisoned");
        let tmp = self.path.with_extension("json.tmp");
        {
            let mut file = File::create(&tmp)?;
            file.write_all(&serde_json::to_vec(&next)?)?;
            file.sync_all()?;
        }
        std::fs::rename(&tmp, &self.path)?;
        *current = next;
        self.telemetry.store(next.telemetry, Ordering::Relaxed);
        self.keep_awake.store(next.keep_awake, Ordering::Relaxed);
        Ok(())
    }
}

/// Bytes the node keeps on disk: the replica, the ciphertext and the small control files.
pub fn storage_bytes(dir: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    entries
        .flatten()
        .map(|entry| match entry.file_type() {
            Ok(kind) if kind.is_dir() => storage_bytes(&entry.path()),
            Ok(_) => entry.metadata().map(|m| m.len()).unwrap_or(0),
            Err(_) => 0,
        })
        .sum()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub protocol: u32,
    pub version: &'static str,
    pub mode: &'static str,
    pub endpoint_id: String,
    pub claimed: bool,
    pub claim_url: Option<String>,
    pub owner: Option<String>,
    pub policy: Option<&'static str>,
    pub members: Vec<String>,
    pub tracked: usize,
    pub missing: usize,
    pub received: u64,
    pub connections: u64,
    pub connections_opened: u64,
    pub bytes_received: u64,
    pub bytes_sent: u64,
    pub storage_bytes: u64,
    pub settings: HostSettings,
    pub telemetry_available: bool,
}

/// What the snapshot says about the host itself, as opposed to the node.
pub struct HostInfo {
    pub version: &'static str,
    pub mode: &'static str,
    pub storage_bytes: u64,
    pub settings: HostSettings,
    pub telemetry_available: bool,
}

pub fn snapshot(node: &StashNode, host: HostInfo) -> Snapshot {
    let repeater = node.repeater().expect("persistent repeater");
    let state = repeater.roster_state();
    let (missing, tracked) = node.content_stats();
    let metrics = node.endpoint().metrics();
    let socket = &metrics.socket;
    let claim_url = repeater.claim_secret().map(|secret| {
        format!(
            "https://streetcrypt.id/repeater#t={}&s={}",
            node.node_ticket(),
            hex(&secret)
        )
    });
    Snapshot {
        protocol: PROTOCOL,
        version: host.version,
        mode: host.mode,
        endpoint_id: hex(&repeater.id()),
        claimed: state.is_some(),
        claim_url,
        owner: state.as_ref().map(|s| hex(&s.owner)),
        policy: state.as_ref().map(|s| match s.policy {
            Policy::Open => "Open",
            Policy::Invite => "Invite only",
        }),
        members: state
            .map(|s| s.carried.iter().map(|id| hex(id)).collect())
            .unwrap_or_default(),
        tracked,
        missing,
        received: node.arrival_count(),
        connections: socket
            .num_conns_opened
            .get()
            .saturating_sub(socket.num_conns_closed.get()),
        connections_opened: socket.num_conns_opened.get(),
        bytes_received: socket.recv_data_ipv4.get()
            + socket.recv_data_ipv6.get()
            + socket.recv_data_relay.get(),
        bytes_sent: socket.send_ipv4.get() + socket.send_ipv6.get() + socket.send_relay.get(),
        storage_bytes: host.storage_bytes,
        settings: host.settings,
        telemetry_available: host.telemetry_available,
    }
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_survives_restart_and_corruption_is_never_replaced() {
        let dir = tempfile::tempdir().unwrap();
        let first = identity(dir.path()).unwrap().public();
        assert_eq!(identity(dir.path()).unwrap().public(), first);
        std::fs::write(dir.path().join("secret.key"), b"broken").unwrap();
        assert!(identity(dir.path()).is_err());
        assert_eq!(
            std::fs::read(dir.path().join("secret.key")).unwrap(),
            b"broken"
        );
    }

    #[test]
    fn lost_identity_does_not_reclaim_an_owned_machine() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("roster.bin"), b"existing").unwrap();
        assert!(identity(dir.path()).is_err());
        assert!(!dir.path().join("secret.key").exists());
    }

    #[test]
    fn settings_default_to_nothing_leaving_and_survive_restart() {
        let dir = tempfile::tempdir().unwrap();
        let settings = Settings::open(dir.path());
        assert_eq!(settings.get(), HostSettings::default());
        assert!(!settings.telemetry_flag().load(Ordering::Relaxed));
        let chosen = HostSettings {
            telemetry: true,
            keep_awake: true,
        };
        settings.set(chosen).unwrap();
        assert!(settings.telemetry_flag().load(Ordering::Relaxed));
        assert!(settings.keep_awake_flag().load(Ordering::Relaxed));
        assert_eq!(Settings::open(dir.path()).get(), chosen);
    }

    #[test]
    fn damaged_settings_read_as_no_and_are_not_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("host-settings.json"), b"{broken").unwrap();
        assert_eq!(Settings::open(dir.path()).get(), HostSettings::default());
        assert_eq!(
            std::fs::read(dir.path().join("host-settings.json")).unwrap(),
            b"{broken"
        );
    }

    #[test]
    fn storage_counts_nested_files() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("blobs").join("a")).unwrap();
        std::fs::write(dir.path().join("blobs").join("a").join("one"), [0u8; 10]).unwrap();
        std::fs::write(dir.path().join("secret.key"), [0u8; 32]).unwrap();
        assert_eq!(storage_bytes(dir.path()), 42);
    }

    #[test]
    fn only_one_host_can_hold_a_directory() {
        let dir = tempfile::tempdir().unwrap();
        let first = claim_directory(dir.path()).unwrap();
        assert!(claim_directory(dir.path()).is_err());
        drop(first);
        assert!(claim_directory(dir.path()).is_ok());
    }

    #[tokio::test]
    async fn snapshot_counts_servable_content() -> Result<()> {
        use iroh_blobs::store::mem::MemStore;
        use iroh_blobs::BlobsProtocol;
        use iroh_docs::api::protocol::{AddrInfoOptions, ShareMode};
        use iroh_docs::protocol::Docs;
        use iroh_gossip::net::Gossip;

        let dir = tempfile::tempdir()?;
        let node = start(dir.path(), SecretKey::from_bytes(&[31; 32])).await?;
        let endpoint = iroh::Endpoint::builder(iroh::endpoint::presets::N0)
            .secret_key(SecretKey::from_bytes(&[32; 32]))
            .bind()
            .await?;
        let gossip = Gossip::builder().spawn(endpoint.clone());
        let blobs = MemStore::new();
        let docs = Docs::memory()
            .spawn(endpoint.clone(), (*blobs).clone(), gossip.clone())
            .await?;
        let router = iroh::protocol::Router::builder(endpoint.clone())
            .accept(iroh_gossip::ALPN, gossip)
            .accept(iroh_docs::ALPN, docs.clone())
            .accept(iroh_blobs::ALPN, BlobsProtocol::new(&blobs, None))
            .spawn();
        let doc = docs.create().await?;
        doc.set_bytes(
            docs.author_default().await?,
            format!("{}/fix", hex(endpoint.id().as_bytes())).into_bytes(),
            b"opaque ciphertext".to_vec(),
        )
        .await?;
        let ticket = doc
            .share(ShareMode::Read, AddrInfoOptions::RelayAndAddresses)
            .await?
            .to_string();
        node.register(&ticket, None).await?;
        doc.start_sync(vec![node.endpoint_addr()]).await?;
        tokio::time::timeout(Duration::from_secs(30), async {
            while node.content_stats() != (0, 1) {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await?;

        let state = snapshot(
            &node,
            HostInfo {
                version: "test",
                mode: "user",
                storage_bytes: 0,
                settings: HostSettings::default(),
                telemetry_available: false,
            },
        );
        assert_eq!((state.tracked, state.missing), (1, 0));
        assert!(state.bytes_received > 0);
        assert!(state.bytes_sent > 0);
        assert!(state.connections_opened > 0);
        node.shutdown().await;
        router.shutdown().await?;
        endpoint.close().await;
        Ok(())
    }
}
