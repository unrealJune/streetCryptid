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
    // Memory only, like every repeater (REPEATERS.md §5.1): the identity, roster and grants stay
    // in `dir`, and no location ciphertext ever touches the disk. A restart comes back as the
    // same repeater, carrying the same people, holding nothing until their phones sync again.
    tokio::time::timeout(
        Duration::from_secs(30),
        StashNode::spawn_with(
            Storage::MemoryRepeater(dir.into()),
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
        let current: HostSettings = std::fs::read(&path)
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

const NAME_FILE: &str = "repeater-name.txt";

/// The name the person at this machine gave it (REPEATERS.md §4.1), read at start. A missing or
/// unusable file is "no name": a name is a label, never a reason to refuse to start.
pub fn read_name(dir: &Path) -> Option<String> {
    std::fs::read_to_string(dir.join(NAME_FILE))
        .ok()
        .and_then(|text| streetcryptid_repeater::roster::repeater_name(&text))
}

/// Save a name (or clear it with `None` / an empty one), returning what was kept. Refuses one
/// [`repeater_name`](streetcryptid_repeater::roster::repeater_name) would not carry, so the app
/// can say so instead of saving something the phone will never show.
pub fn write_name(dir: &Path, name: Option<&str>) -> Result<Option<String>> {
    let path = dir.join(NAME_FILE);
    let wanted = name.map(str::trim).filter(|n| !n.is_empty());
    let Some(wanted) = wanted else {
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
        return Ok(None);
    };
    let Some(name) = streetcryptid_repeater::roster::repeater_name(wanted) else {
        bail!("Not a usable name");
    };
    let tmp = path.with_extension("txt.tmp");
    {
        let mut file = File::create(&tmp)?;
        file.write_all(name.as_bytes())?;
        file.sync_all()?;
    }
    std::fs::rename(&tmp, &path)?;
    Ok(Some(name))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub protocol: u32,
    pub version: &'static str,
    pub mode: &'static str,
    pub endpoint_id: String,
    /// What this machine is called here, signed into the next cert it issues.
    pub name: Option<String>,
    /// The name in the cert its roster holds: what phones show now. Differs from `name` until
    /// the owner's phone picks up a rename.
    pub listed_name: Option<String>,
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
    pub settings: HostSettings,
    pub telemetry_available: bool,
    /// Whether the machine is actually being kept awake right now, as opposed to the setting
    /// asking for it: not on battery, and not where the OS refused (logind without polkit
    /// permission). Snapshot readers that predate it ignore it.
    pub keep_awake_held: bool,
}

/// What the snapshot says about the host itself, as opposed to the node.
pub struct HostInfo {
    pub version: &'static str,
    pub mode: &'static str,
    pub settings: HostSettings,
    pub telemetry_available: bool,
    pub keep_awake_held: bool,
}

pub fn snapshot(node: &StashNode, host: HostInfo) -> Snapshot {
    let repeater = node.repeater().expect("persistent repeater");
    let state = repeater.roster_state();
    let (missing, tracked) = node.content_stats();
    let metrics = node.endpoint().metrics();
    let socket = &metrics.socket;
    // The same link the server's console QR prints, from the crate the phone parses it with.
    let claim_url = repeater
        .claim_secret()
        .map(|secret| streetcryptid_repeater::wire::claim_url(&node.node_ticket(), &secret));
    Snapshot {
        protocol: PROTOCOL,
        version: host.version,
        mode: host.mode,
        endpoint_id: hex(&repeater.id()),
        name: repeater.name(),
        listed_name: repeater.listed_name(),
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
        settings: host.settings,
        telemetry_available: host.telemetry_available,
        keep_awake_held: host.keep_awake_held,
    }
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// A command a supervisor may send. Anything not an [`Action`] — another kind, another protocol,
/// an unknown field, a field the kind does not take — is refused, and the Windows host and the
/// Linux daemon both drop the connection that sent it.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Command {
    pub protocol: u32,
    pub kind: String,
    pub request_id: String,
    pub telemetry: Option<bool>,
    pub keep_awake: Option<bool>,
    /// For `name`: the new name, or `""` to clear it.
    pub name: Option<String>,
}

/// What the app may ask of the host: its settings, its name, or releasing the repeater from its
/// roster (REPEATERS.md §4.1). Each is something only the person at this machine decides.
#[derive(Debug, PartialEq)]
pub enum Action {
    Settings(HostSettings),
    Name(String),
    Release,
}

impl Command {
    pub fn action(&self) -> Result<Action> {
        if self.protocol != PROTOCOL || self.request_id.is_empty() || self.request_id.len() > 64 {
            bail!("Invalid command");
        }
        match (
            self.kind.as_str(),
            self.telemetry,
            self.keep_awake,
            self.name.as_deref(),
        ) {
            ("settings", Some(telemetry), Some(keep_awake), None) => {
                Ok(Action::Settings(HostSettings {
                    telemetry,
                    keep_awake,
                }))
            }
            // Bounded here as well as by `repeater_name`: the line itself is at most 4 KiB.
            ("name", None, None, Some(name)) if name.chars().count() <= 200 => {
                Ok(Action::Name(name.to_string()))
            }
            ("release", None, None, None) => Ok(Action::Release),
            _ => bail!("Invalid command"),
        }
    }
}

/// The longest command line a host reads, newline included. A settings command is ~120 bytes.
pub const MAX_COMMAND_LINE: usize = 4096;

/// The lines a host writes, one JSON object each. `runId` changes with every host process, so a
/// client can tell a restart from a pause.
pub mod message {
    use super::{Snapshot, PROTOCOL};
    use serde_json::{json, Value};

    pub fn snapshot(run_id: &str, snapshot: &Snapshot) -> Value {
        json!({"protocol": PROTOCOL, "kind": "snapshot", "runId": run_id, "snapshot": snapshot})
    }

    pub fn arrival(run_id: &str, sequence: u64) -> Value {
        json!({"protocol": PROTOCOL, "kind": "arrival", "runId": run_id, "sequence": sequence})
    }

    pub fn result(run_id: &str, request_id: &str, ok: bool) -> Value {
        json!({"protocol": PROTOCOL, "kind": "result", "runId": run_id,
            "requestId": request_id, "ok": ok})
    }

    /// What supervises the host, as the Windows service tells each app that connects. `host` is
    /// `starting`, `running`, `restarting` or `stopped`.
    pub fn service(version: &str, host: &str, restarts: u32) -> Value {
        json!({"protocol": PROTOCOL, "kind": "service",
            "service": {"version": version, "host": host, "restarts": restarts}})
    }
}

/// A fresh id for this host process (`runId`).
pub fn run_id() -> String {
    hex(SecretKey::generate().public().as_bytes())
}

/// iroh logs per packet path at debug and keeps endpoint-lifetime spans open for days; on a
/// machine that runs for weeks only its warnings are worth shipping.
pub const TELEMETRY_FILTER: &str = "info,iroh=warn,iroh_relay=warn,iroh_docs=warn,\
iroh_blobs=warn,iroh_gossip=warn,noq=warn,noq_proto=warn,noq_udp=warn";
pub const TELEMETRY_SERVICE: &str = "streetcryptid-repeater";

/// Install the OTLP exporter when this build was given an endpoint, behind the person's consent.
/// Without an endpoint nothing is installed and no setting can turn it on. Call it before any
/// other thread exists: it writes the exporter's environment.
pub fn init_telemetry(endpoint: Option<&str>, secret: &SecretKey, consent: Arc<AtomicBool>) {
    use tracing_subscriber::filter::{filter_fn, EnvFilter};
    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt;
    use tracing_subscriber::Layer;

    type Base = tracing_subscriber::layer::Layered<EnvFilter, tracing_subscriber::Registry>;

    let Some(endpoint) = endpoint.filter(|e| !e.trim().is_empty()) else {
        return;
    };
    std::env::set_var("OTEL_EXPORTER_OTLP_ENDPOINT", endpoint);
    std::env::set_var("OTEL_SERVICE_NAME", TELEMETRY_SERVICE);
    let Some(layers) = trail_stash::telemetry::otel_layers::<Base>(
        &trail_stash::telemetry::instance_id(&secret.public()),
    ) else {
        return;
    };
    // Each exporter is behind the person's choice, read on every span and event, so turning
    // diagnostics off takes effect at once and nothing recorded while off is ever sent.
    let layers: Vec<_> = layers
        .into_iter()
        .map(|layer| {
            let consent = consent.clone();
            layer.with_filter(filter_fn(move |_| consent.load(Ordering::Relaxed)))
        })
        .collect();
    tracing_subscriber::registry()
        .with(EnvFilter::new(TELEMETRY_FILTER))
        .with(layers)
        .init();
}

/// What the pulse reports about keeping the machine awake; each platform holds it its own way.
pub trait PowerState: Send + Sync {
    fn on_ac(&self) -> bool;
    fn holding(&self) -> bool;
}

/// Who is running the host, for the pulse.
#[derive(Debug, Clone, Copy)]
pub struct PulseInfo {
    /// `windows` or `linux`.
    pub platform: &'static str,
    /// `user` or `service`.
    pub mode: &'static str,
    pub version: &'static str,
}

/// How often the host reports on itself. A host that stops reporting is the signal: a desktop
/// repeater that is asleep, powered off or wedged emits nothing, and a gap between pulses is the
/// only way that absence can be measured (the phones' `device.health` exists for the same reason).
pub const PULSE_INTERVAL: Duration = Duration::from_secs(5 * 60);

/// One `repeater.host.pulse` span every [`PULSE_INTERVAL`]: what the node holds, what it has
/// moved, and whether it is keeping the machine awake. Spans, not events: Loki keeps an event's
/// message and drops its fields.
pub async fn run_pulse(
    node: Arc<StashNode>,
    info: PulseInfo,
    power: Arc<dyn PowerState>,
    started_at: std::time::Instant,
) {
    let mut interval = tokio::time::interval(PULSE_INTERVAL);
    interval.tick().await;
    loop {
        interval.tick().await;
        let (missing, tracked) = node.content_stats();
        let members = node
            .repeater()
            .and_then(|r| r.roster_state())
            .map(|s| s.carried.len())
            .unwrap_or(0);
        let metrics = node.endpoint().metrics();
        let socket = &metrics.socket;
        let span = tracing::info_span!(
            "repeater.host.pulse",
            host.platform = info.platform,
            host.mode = info.mode,
            host.version = info.version,
            uptime_s = started_at.elapsed().as_secs(),
            roster.claimed = node.repeater().is_some_and(|r| r.is_claimed()),
            roster.members = members as u64,
            content.tracked = tracked as u64,
            content.missing = missing as u64,
            fix.received = node.arrival_count(),
            net.connections = socket
                .num_conns_opened
                .get()
                .saturating_sub(socket.num_conns_closed.get()),
            net.bytes_in = socket.recv_data_ipv4.get()
                + socket.recv_data_ipv6.get()
                + socket.recv_data_relay.get(),
            net.bytes_out =
                socket.send_ipv4.get() + socket.send_ipv6.get() + socket.send_relay.get(),
            power.on_ac = power.on_ac(),
            power.keep_awake = power.holding(),
        );
        drop(span);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_commands_validate_the_protocol_and_shape() {
        let command: Command = serde_json::from_str(
            r#"{"protocol":2,"kind":"settings","requestId":"one","telemetry":true,"keepAwake":false}"#,
        )
        .unwrap();
        assert_eq!(
            command.action().unwrap(),
            Action::Settings(HostSettings {
                telemetry: true,
                keep_awake: false
            })
        );
        let old: Command = serde_json::from_str(
            r#"{"protocol":1,"kind":"settings","requestId":"one","telemetry":true,"keepAwake":false}"#,
        )
        .unwrap();
        assert!(old.action().is_err());
        assert!(serde_json::from_str::<Command>(
            r#"{"protocol":2,"kind":"subscription","requestId":"one","member":"ab","receiving":false}"#,
        )
        .is_err());
        // Settings without their values, or a release carrying some, are refused.
        let partial: Command =
            serde_json::from_str(r#"{"protocol":2,"kind":"settings","requestId":"one"}"#).unwrap();
        assert!(partial.action().is_err());
        let release: Command =
            serde_json::from_str(r#"{"protocol":2,"kind":"release","requestId":"two"}"#).unwrap();
        assert_eq!(release.action().unwrap(), Action::Release);
        let odd: Command = serde_json::from_str(
            r#"{"protocol":2,"kind":"release","requestId":"two","telemetry":true}"#,
        )
        .unwrap();
        assert!(odd.action().is_err());
    }

    #[test]
    fn name_commands_carry_a_name_and_nothing_else() {
        let name: Command = serde_json::from_str(
            r#"{"protocol":2,"kind":"name","requestId":"n","name":"Living room PC"}"#,
        )
        .unwrap();
        assert_eq!(
            name.action().unwrap(),
            Action::Name("Living room PC".into())
        );
        let clear: Command =
            serde_json::from_str(r#"{"protocol":2,"kind":"name","requestId":"n","name":""}"#)
                .unwrap();
        assert_eq!(clear.action().unwrap(), Action::Name(String::new()));
        let bare: Command =
            serde_json::from_str(r#"{"protocol":2,"kind":"name","requestId":"n"}"#).unwrap();
        assert!(bare.action().is_err());
        let mixed: Command = serde_json::from_str(
            r#"{"protocol":2,"kind":"settings","requestId":"n","telemetry":true,"keepAwake":false,"name":"x"}"#,
        )
        .unwrap();
        assert!(mixed.action().is_err());
    }

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
    fn a_name_is_kept_tidied_cleared_and_never_a_reason_to_fail() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read_name(dir.path()), None);
        assert_eq!(
            write_name(dir.path(), Some("  Living   room PC ")).unwrap(),
            Some("Living room PC".into())
        );
        assert_eq!(read_name(dir.path()), Some("Living room PC".into()));
        assert!(write_name(dir.path(), Some(&"x".repeat(41))).is_err());
        assert_eq!(read_name(dir.path()), Some("Living room PC".into()));
        assert_eq!(write_name(dir.path(), Some("")).unwrap(), None);
        assert_eq!(read_name(dir.path()), None);
        std::fs::write(dir.path().join(NAME_FILE), b"bell\x07").unwrap();
        assert_eq!(read_name(dir.path()), None);
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
                settings: HostSettings::default(),
                telemetry_available: false,
                keep_awake_held: false,
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
