use std::{
    env, fs,
    io::{self, Write},
    path::{Path, PathBuf},
    process::Command,
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use anyhow::{anyhow, bail, Context, Result};
use clap::{Parser, Subcommand};
use iroh_location::{
    configure_telemetry, encode_pair_invite, flush_telemetry, LocationNode, PairResult, PairState,
    SasRoleKind,
};
use iroh_tickets::endpoint::EndpointTicket;
use serde::{Deserialize, Serialize};

const STATE_VERSION: u8 = 1;
const APP_PACKAGE: &str = "com.unrealjune.streetcryptid";
const DEFAULT_PAIR_TTL_SECONDS: u64 = 900;
const DEFAULT_WATCH_INTERVAL_SECONDS: u64 = 10;
const HTTP_TIMEOUT_SECONDS: u64 = 10;
const NODE_OPERATION_TIMEOUT_SECONDS: u64 = 15;
const SYNC_ATTEMPT_TIMEOUT_SECONDS: u64 = 15;
const ONCE_RETRY_SECONDS: u64 = 2;
const ONCE_MAX_ATTEMPTS: u64 = 15;

#[derive(Parser)]
#[command(
    name = "trail-stash-client",
    about = "Pair with streetCryptid phones and observe their location trails through trail-stash only"
)]
struct Cli {
    /// Persistent keys, pair metadata, and isolated iroh replicas.
    #[arg(long, global = true)]
    state_dir: Option<PathBuf>,

    #[command(subcommand)]
    command: ClientCommand,
}

#[derive(Subcommand)]
enum ClientCommand {
    /// Create an invite, complete the normal visual SAS pairing, and register the phone's trail.
    Pair {
        /// Open the invite on the single ADB-connected Android device.
        #[arg(long)]
        adb: bool,

        /// Open the invite on an iOS Simulator with this UDID.
        #[arg(long)]
        simulator: Option<String>,

        /// Re-pair a phone this CLI already knows, resetting its watch cursor. Pairing an
        /// ADDITIONAL phone does not need this — the CLI holds many peers at once.
        #[arg(long)]
        force: bool,

        /// Invite lifetime in seconds.
        #[arg(long, default_value_t = DEFAULT_PAIR_TTL_SECONDS)]
        ttl_seconds: u64,

        /// Developer automation: submit this process's transcript-derived SAS target without stdin.
        #[arg(long, hide = true)]
        auto_sas: bool,
    },

    /// Reconcile every paired phone's namespace with only the configured stash endpoint.
    Watch {
        /// Sync once and exit instead of polling.
        #[arg(long)]
        once: bool,

        /// Emit one JSON object per received fix.
        #[arg(long)]
        json: bool,

        /// Poll interval for continuous watch mode.
        #[arg(long, default_value_t = DEFAULT_WATCH_INTERVAL_SECONDS)]
        interval_seconds: u64,

        /// With --once, keep polling for a new fix until this timeout expires.
        #[arg(long, default_value_t = 0)]
        timeout_seconds: u64,
    },

    /// Show local pairing state, configured endpoints, and stash health.
    Status,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct ClientState {
    version: u8,
    identity_secret: String,
    recv_secret: String,
    /// Every phone this CLI is paired with. One identity, many friends — the same shape a real
    /// device has, which is what makes it useful for validating a device that must serve several
    /// peers at once (per-friend ratchet sessions and a multi-recipient wrap set, see
    /// `docs/social/FORWARD-SECRECY.md` §4.1/§4.5).
    ///
    /// No migration from the older single-`peer` field: this is a developer debug client, and a
    /// stale state directory simply reads as unpaired and re-pairs. `#[serde(default)]` is what
    /// makes that self-healing rather than a parse error.
    #[serde(default)]
    peers: Vec<PeerState>,
}

impl ClientState {
    /// Index of the peer with this endpoint id, if paired.
    fn peer_index(&self, endpoint_id: &str) -> Option<usize> {
        self.peers
            .iter()
            .position(|peer| peer.endpoint_id == endpoint_id)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct PeerState {
    endpoint_id: String,
    trail_ticket: String,
    profile_handle: Option<String>,
    paired_at_ms: u64,
    last_seq: u64,
    last_fix_ts: Option<u64>,
}

#[derive(Clone, Debug)]
struct RuntimeConfig {
    relay_urls: Vec<String>,
    relay_token: String,
    stash_url: String,
    stash_ticket: String,
    stash_psk: Option<String>,
    otel_endpoint: Option<String>,
}

impl RuntimeConfig {
    fn load() -> Result<Self> {
        let relay_urls = required_env("EXPO_PUBLIC_IROH_RELAY_URLS")?
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .collect::<Vec<_>>();
        if relay_urls.is_empty() {
            bail!("EXPO_PUBLIC_IROH_RELAY_URLS contains no relay URLs");
        }

        let stash_ticket = required_env("EXPO_PUBLIC_TRAIL_STASH_TICKET")?;
        stash_ticket
            .parse::<EndpointTicket>()
            .context("EXPO_PUBLIC_TRAIL_STASH_TICKET is not a valid endpoint ticket")?;

        Ok(Self {
            relay_urls,
            relay_token: required_env("EXPO_PUBLIC_IROH_RELAY_TOKEN")?,
            stash_url: required_env("EXPO_PUBLIC_TRAIL_STASH_URL")?
                .trim_end_matches('/')
                .to_owned(),
            stash_ticket,
            stash_psk: optional_env("EXPO_PUBLIC_TRAIL_STASH_PSK"),
            otel_endpoint: optional_env("EXPO_PUBLIC_OTEL_ENDPOINT"),
        })
    }

    fn stash_endpoint_short(&self) -> Result<String> {
        let ticket = self
            .stash_ticket
            .parse::<EndpointTicket>()
            .context("invalid stash endpoint ticket")?;
        Ok(hex_encode(ticket.endpoint_addr().id.as_bytes())
            .chars()
            .take(10)
            .collect())
    }
}

#[derive(Serialize)]
struct FixOutput {
    source: &'static str,
    stash_endpoint: String,
    author: String,
    seq: u64,
    lat: f64,
    lon: f64,
    accuracy_m: f64,
    heading_deg: f64,
    fix_ts: u64,
    observed_at: u64,
    lag_ms: u64,
}

struct PairingFigure {
    index: u32,
    name: String,
    art: String,
}

#[tokio::main(flavor = "multi_thread")]
async fn main() {
    load_dotenv();
    let cli = Cli::parse();
    let result = run(cli).await;
    flush_telemetry().await;
    if let Err(error) = result {
        eprintln!("error: {error:#}");
        std::process::exit(1);
    }
}

async fn run(cli: Cli) -> Result<()> {
    let state_dir = cli.state_dir.map(Ok).unwrap_or_else(default_state_dir)?;
    let config = RuntimeConfig::load()?;

    match cli.command {
        ClientCommand::Pair {
            adb,
            simulator,
            force,
            ttl_seconds,
            auto_sas,
        } => {
            run_pair(
                &state_dir,
                &config,
                adb,
                simulator.as_deref(),
                force,
                ttl_seconds,
                auto_sas,
            )
            .await
        }
        ClientCommand::Watch {
            once,
            json,
            interval_seconds,
            timeout_seconds,
        } => {
            run_watch(
                &state_dir,
                &config,
                once,
                json,
                interval_seconds,
                timeout_seconds,
            )
            .await
        }
        ClientCommand::Status => run_status(&state_dir, &config).await,
    }
}

async fn run_pair(
    state_dir: &Path,
    config: &RuntimeConfig,
    open_adb: bool,
    simulator: Option<&str>,
    force: bool,
    ttl_seconds: u64,
    auto_sas: bool,
) -> Result<()> {
    if ttl_seconds == 0 {
        bail!("pair invite TTL must be greater than zero");
    }
    if open_adb && simulator.is_some() {
        bail!("choose only one invite target: --adb or --simulator");
    }

    let state_path = state_path(state_dir);
    let existing = load_state(&state_path)?;
    // Pairing an ADDITIONAL phone is now the normal case, so an existing peer is not on its own a
    // reason to refuse. `--force` is only needed to re-pair a phone this CLI already knows, which
    // is checked after the handshake, once we actually know which endpoint answered.
    let _ = &existing;

    let pair_replica = state_dir.join("pairing-replica");
    let (node, mut state) = create_node(existing.as_ref(), pair_replica)?;
    save_state(&state_path, &state)?;
    configure_node_telemetry(&node, config);
    node.start(
        config.relay_urls.clone(),
        config.relay_token.clone(),
        true,
        true,
        true,
    )
    .await
    .context("starting the pairing node")?;
    node.publish_profile(
        "@stash-debug".into(),
        "Trail Stash Debug".into(),
        "  .-.  \n (o o) \n --|-- \n  / \\  ".into(),
        "#2F9E6A".into(),
    )
    .await
    .context("publishing the CLI debug profile")?;

    let invite = node
        .create_invite(ttl_seconds)
        .await
        .context("creating a pairing invite")?;
    let token = encode_pair_invite(invite).context("encoding the pairing invite")?;
    let link = pair_link(&token);

    println!("Pairing invite:");
    println!("{link}");
    println!();
    println!("Keep the Friends screen open and complete the visual comparison on both devices.");

    if open_adb {
        open_pair_link_with_adb(&link)?;
        println!("Opened the invite on the ADB-connected phone.");
    } else if let Some(udid) = simulator {
        open_pair_link_with_simctl(udid, &link)?;
        println!("Opened the invite on iOS Simulator {udid}.");
    } else {
        println!("ADB command:");
        println!("adb shell am start -a android.intent.action.VIEW -d \"{link}\" {APP_PACKAGE}");
        println!("iOS Simulator command:");
        println!("xcrun simctl openurl <udid> \"{link}\"");
    }

    let session_id = wait_for_pair_session(&node, Duration::from_secs(ttl_seconds)).await?;
    complete_visual_pairing(&node, &session_id, auto_sas).await?;
    let result = wait_for_pair_result(&node, &session_id).await?;

    if result.peer_trail_ticket.is_empty() {
        bail!("pair completed without a phone trail read-ticket");
    }

    let peer = PeerState {
        endpoint_id: hex_encode(&result.peer_endpoint_id),
        trail_ticket: result.peer_trail_ticket.clone(),
        profile_handle: result
            .peer_profile
            .as_ref()
            .map(|profile| profile.handle.clone()),
        paired_at_ms: now_ms(),
        last_seq: 0,
        last_fix_ts: None,
    };
    match state.peer_index(&peer.endpoint_id) {
        // Re-pairing a phone we already know discards its `last_seq`, so require --force: without
        // it a stray second pair would silently rewind the watch cursor and replay old fixes.
        Some(_) if !force => bail!(
            "phone {} is already paired; pass --force to re-pair it (pairing a DIFFERENT phone needs no flag)",
            short_hex(&peer.endpoint_id)
        ),
        Some(index) => state.peers[index] = peer.clone(),
        None => state.peers.push(peer.clone()),
    }
    save_state(&state_path, &state)?;

    let stash_replica = state_dir.join("stash-replica");
    if stash_replica.exists() {
        fs::remove_dir_all(&stash_replica)
            .with_context(|| format!("clearing {}", stash_replica.display()))?;
    }

    register_namespace(config, &peer.trail_ticket)
        .await
        .context("pair saved, but registering the phone namespace with trail-stash failed")?;
    node.shutdown()
        .await
        .context("shutting down pairing node")?;

    println!();
    println!(
        "Paired with {}{} and registered its trail with stash {}.",
        peer.profile_handle.as_deref().unwrap_or("phone"),
        if peer.profile_handle.is_some() {
            format!(" ({})", short_hex(&peer.endpoint_id))
        } else {
            format!(" {}", short_hex(&peer.endpoint_id))
        },
        config.stash_endpoint_short()?
    );
    println!("Run `just trail-stash-client watch` to receive stash-only fixes.");
    Ok(())
}

async fn run_watch(
    state_dir: &Path,
    config: &RuntimeConfig,
    once: bool,
    json: bool,
    interval_seconds: u64,
    timeout_seconds: u64,
) -> Result<()> {
    if !once && interval_seconds == 0 {
        bail!("watch interval must be greater than zero");
    }
    if !once && timeout_seconds > 0 {
        bail!("watch timeout requires --once");
    }
    let deadline =
        (timeout_seconds > 0).then(|| Instant::now() + Duration::from_secs(timeout_seconds));

    let state_path = state_path(state_dir);
    let mut state = load_state(&state_path)?.ok_or_else(|| anyhow!("no CLI state; pair first"))?;
    if state.peers.is_empty() {
        bail!("no paired phone; run the pair command first");
    }
    let peers = state.peers.clone();
    // Decode every author up front so a corrupt state file fails before we start a node.
    let peer_authors = peers
        .iter()
        .map(|peer| {
            hex_decode(&peer.endpoint_id).with_context(|| {
                format!(
                    "stored phone endpoint id is invalid: {}",
                    short_hex(&peer.endpoint_id)
                )
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let watch_root = state_dir.join("stash-replica");
    if watch_root.exists() {
        fs::remove_dir_all(&watch_root)
            .with_context(|| format!("clearing {}", watch_root.display()))?;
    }

    // One namespace per paired phone — each device writes its own trail, so they must all be
    // registered with the stash before we can reconcile any of them.
    for peer in &peers {
        register_namespace(config, &peer.trail_ticket)
            .await
            .with_context(|| {
                format!(
                    "registering namespace for phone {}",
                    short_hex(&peer.endpoint_id)
                )
            })?;
    }

    let stash_endpoint = config.stash_endpoint_short()?;
    let watch_message = format!(
        "Watching {} phone(s) [{}] through stash {} only. No gossip subscription or phone ticket is used.",
        peers.len(),
        peers
            .iter()
            .map(|peer| short_hex(&peer.endpoint_id))
            .collect::<Vec<_>>()
            .join(", "),
        stash_endpoint
    );
    if json {
        eprintln!("{watch_message}");
    } else {
        println!("{watch_message}");
    }

    let mut sync_attempt = 0u64;
    loop {
        // iroh-docs extends explicit peers with useful peers remembered in its replica DB. A fresh
        // store per attempt ensures the configured stash remains the only possible dial target.
        sync_attempt += 1;
        let watch_replica = watch_root.join(format!("attempt-{}-{sync_attempt}", now_ms()));
        let pairing_replica = watch_root
            .parent()
            .ok_or_else(|| anyhow!("observer state directory has no parent"))?
            .join("pairing-replica");
        let node = create_watch_node(&state, pairing_replica)?;
        configure_node_telemetry(&node, config);
        eprintln!("[watch] starting isolated iroh node (attempt {sync_attempt})");
        tokio::time::timeout(
            Duration::from_secs(NODE_OPERATION_TIMEOUT_SECONDS),
            node.start(
                config.relay_urls.clone(),
                config.relay_token.clone(),
                true,
                true,
                true,
            ),
        )
        .await
        .context("starting the stash-only node timed out")?
        .context("starting the stash-only node")?;
        eprintln!("[watch] isolated iroh node ready (attempt {sync_attempt})");

        let attempt = async {
            // Reconcile each paired phone's namespace in turn and merge the results. Every fix is
            // still checked against the author of the namespace it came from, so one phone's trail
            // can never be attributed to another.
            let mut fixes = Vec::new();
            for (peer, peer_author) in peers.iter().zip(peer_authors.iter()) {
                let peer_fixes = tokio::time::timeout(
                    Duration::from_secs(SYNC_ATTEMPT_TIMEOUT_SECONDS),
                    node.sync_latest_via_only(
                        peer.trail_ticket.clone(),
                        config.stash_ticket.clone(),
                        config.stash_url.clone(),
                        config.stash_psk.clone(),
                    ),
                )
                .await
                .with_context(|| {
                    format!(
                        "direct stash-only trail reconciliation timed out for phone {}",
                        short_hex(&peer.endpoint_id)
                    )
                })?
                .with_context(|| {
                    format!(
                        "direct stash-only trail reconciliation for phone {}",
                        short_hex(&peer.endpoint_id)
                    )
                })?;
                if peer_fixes
                    .iter()
                    .any(|fix| fix.author.as_slice() != peer_author.as_slice())
                {
                    bail!(
                        "stash returned a decryptable fix for an unexpected author in phone {}'s namespace",
                        short_hex(&peer.endpoint_id)
                    );
                }
                fixes.extend(peer_fixes);
            }
            Ok::<_, anyhow::Error>(fixes)
        }
        .await;
        let mut fixes = match attempt {
            Ok(fixes) => fixes,
            Err(error) => {
                let _ = tokio::time::timeout(
                    Duration::from_secs(NODE_OPERATION_TIMEOUT_SECONDS),
                    node.shutdown(),
                )
                .await;
                let _ = fs::remove_dir_all(&watch_replica);
                eprintln!(
                    "[sync-error] attempt={} stash={} error={error:#}",
                    sync_attempt, stash_endpoint
                );
                tracing::warn!(
                    attempt = sync_attempt,
                    stash.peer = %stash_endpoint,
                    error = %error,
                    "stash.cli.sync_failed"
                );
                if once
                    && (sync_attempt >= ONCE_MAX_ATTEMPTS
                        || deadline.is_some_and(|deadline| Instant::now() >= deadline))
                {
                    return Err(error).context("stash-only sync retry budget exhausted");
                }
                tokio::time::sleep(Duration::from_secs(if once {
                    ONCE_RETRY_SECONDS
                } else {
                    interval_seconds
                }))
                .await;
                continue;
            }
        };
        fixes.sort_by_key(|fix| fix.seq);
        let recovered = fixes.len() as u64;

        // `seq` is monotonic PER AUTHOR, not globally, so the cursor has to be per peer. A single
        // shared `last_seq` would let a chatty phone's sequence number suppress a quieter phone's
        // genuinely new fixes (and vice versa) — the fixes would arrive, be filtered out, and the
        // watch would look idle while the pipeline was healthy.
        let new_fixes = fixes
            .into_iter()
            .filter(|fix| {
                let author = hex_encode(&fix.author);
                state
                    .peer_index(&author)
                    .is_some_and(|index| fix.seq > state.peers[index].last_seq)
            })
            .collect::<Vec<_>>();

        for incoming in &new_fixes {
            let observed_at = now_ms();
            let output = FixOutput {
                source: "trail-stash",
                stash_endpoint: stash_endpoint.clone(),
                author: hex_encode(&incoming.author),
                seq: incoming.seq,
                lat: incoming.fix.lat,
                lon: incoming.fix.lon,
                accuracy_m: incoming.fix.accuracy_m,
                heading_deg: incoming.fix.heading_deg,
                fix_ts: incoming.fix.ts,
                observed_at,
                lag_ms: observed_at.saturating_sub(incoming.fix.ts),
            };
            print_fix(&output, json)?;
            tracing::info!(
                sc.author = %short_hex(&output.author),
                sc.seq = output.seq,
                source = output.source,
                stash.peer = %output.stash_endpoint,
                fix.ts = output.fix_ts,
                fix.lag_ms = output.lag_ms,
                "stash.cli.fix"
            );
        }

        if !new_fixes.is_empty() {
            // Advance each phone's own cursor to the highest seq seen for it this round. `fixes`
            // was sorted by seq across all authors, so take a max per author rather than assuming
            // the last element belongs to any particular phone.
            for fix in &new_fixes {
                let author = hex_encode(&fix.author);
                if let Some(index) = state.peer_index(&author) {
                    let saved = &mut state.peers[index];
                    if fix.seq > saved.last_seq {
                        saved.last_seq = fix.seq;
                        saved.last_fix_ts = Some(fix.fix.ts);
                    }
                }
            }
            save_state(&state_path, &state)?;
        }

        if !json {
            println!(
                "[sync] strict_peer={} recovered={} new={} cursors=[{}]",
                stash_endpoint,
                recovered,
                new_fixes.len(),
                state
                    .peers
                    .iter()
                    .map(|saved| format!(
                        "{}:{}",
                        short_hex(&saved.endpoint_id),
                        saved.last_seq
                    ))
                    .collect::<Vec<_>>()
                    .join(" ")
            );
        }

        if once && !new_fixes.is_empty() {
            io::stdout().flush().context("flushing fix output")?;
            return Ok(());
        }

        tokio::time::timeout(
            Duration::from_secs(NODE_OPERATION_TIMEOUT_SECONDS),
            node.shutdown(),
        )
        .await
        .context("shutting down watcher node timed out")?
        .context("shutting down watcher node")?;
        if let Err(error) = fs::remove_dir_all(&watch_replica) {
            tracing::warn!(
                path = %watch_replica.display(),
                error = %error,
                "could not remove the isolated watch replica"
            );
        }

        if once && (!new_fixes.is_empty() || deadline.is_none()) {
            break;
        }
        if once {
            if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
                bail!("no new stash fix received within {timeout_seconds} seconds");
            }
            tokio::time::sleep(Duration::from_secs(ONCE_RETRY_SECONDS)).await;
            continue;
        }

        tokio::select! {
            result = tokio::signal::ctrl_c() => {
                result.context("waiting for Ctrl+C")?;
                println!("Stopping stash-only watch.");
                break;
            }
            _ = tokio::time::sleep(Duration::from_secs(interval_seconds)) => {}
        }
    }

    Ok(())
}

async fn run_status(state_dir: &Path, config: &RuntimeConfig) -> Result<()> {
    let state_path = state_path(state_dir);
    let state = load_state(&state_path)?;

    println!("state_dir={}", state_dir.display());
    println!("relay_count={}", config.relay_urls.len());
    println!("stash_url={}", config.stash_url);
    println!("stash_endpoint={}", config.stash_endpoint_short()?);
    println!("otel_configured={}", config.otel_endpoint.is_some());
    // Our OWN endpoint id, so a caller can ask the other side of a pairing whether it still
    // lists us. `paired=` only reflects what THIS state dir believes; a phone whose friend
    // records were cleared (scripts/e2e reset the pool between runs) leaves the CLI claiming a
    // pairing that no longer exists, and the failure then shows up much later as a peer that
    // never decrypts anything. Cheap to derive — the endpoint id is just the ed25519 public key
    // of the stored identity secret, so no node has to be constructed to print it.
    if let Some(saved) = state.as_ref() {
        println!("self_endpoint={}", self_endpoint_short(saved)?);
    }

    let peers = state.map(|saved| saved.peers).unwrap_or_default();
    // `paired=` stays a plain true/false so existing scripts that grep for `^paired=true` keep
    // working (see scripts/e2e/ensure-stash-observer.sh); the per-phone lines are indexed because
    // there can now be several.
    println!("paired={}", !peers.is_empty());
    println!("peer_count={}", peers.len());
    for (index, peer) in peers.iter().enumerate() {
        println!("phone{index}_endpoint={}", short_hex(&peer.endpoint_id));
        println!(
            "phone{index}_handle={}",
            peer.profile_handle.as_deref().unwrap_or("unknown")
        );
        println!("phone{index}_last_seq={}", peer.last_seq);
        println!(
            "phone{index}_last_fix_ts={}",
            peer.last_fix_ts
                .map(|value| value.to_string())
                .unwrap_or_else(|| "none".into())
        );
    }

    let response = http_client()?
        .get(format!("{}/healthz", config.stash_url))
        .send()
        .await
        .context("requesting trail-stash health")?;
    println!("stash_health={}", response.status());
    if !response.status().is_success() {
        bail!("trail-stash health check failed with {}", response.status());
    }
    Ok(())
}

fn create_node(
    state: Option<&ClientState>,
    data_dir: PathBuf,
) -> Result<(Arc<LocationNode>, ClientState)> {
    fs::create_dir_all(&data_dir)
        .with_context(|| format!("creating replica directory {}", data_dir.display()))?;
    let identity = state
        .map(|saved| hex_decode(&saved.identity_secret))
        .transpose()
        .context("stored identity secret is invalid")?;
    let recv = state
        .map(|saved| hex_decode(&saved.recv_secret))
        .transpose()
        .context("stored receiving secret is invalid")?;
    let node = LocationNode::new_with_data_dir(identity, recv, data_dir)
        .context("constructing the iroh location node")?;
    let next_state = state.cloned().unwrap_or_else(|| ClientState {
        version: STATE_VERSION,
        identity_secret: hex_encode(&node.identity_secret()),
        recv_secret: hex_encode(&node.recv_secret()),
        peers: Vec::new(),
    });
    Ok((node, next_state))
}

/// Short form of this client's own endpoint id, derived from the stored identity secret.
fn self_endpoint_short(state: &ClientState) -> Result<String> {
    let secret = hex_decode(&state.identity_secret).context("stored identity secret is invalid")?;
    let bytes: [u8; 32] = secret
        .as_slice()
        .try_into()
        .map_err(|_| anyhow!("stored identity secret is not 32 bytes"))?;
    let signing = ed25519_dalek::SigningKey::from_bytes(&bytes);
    Ok(short_hex(&hex_encode(signing.verifying_key().as_bytes())))
}

fn create_watch_node(state: &ClientState, data_dir: PathBuf) -> Result<Arc<LocationNode>> {
    fs::create_dir_all(&data_dir)
        .with_context(|| format!("creating replica directory {}", data_dir.display()))?;
    let identity =
        hex_decode(&state.identity_secret).context("stored identity secret is invalid")?;
    let recv = hex_decode(&state.recv_secret).context("stored receiving secret is invalid")?;
    LocationNode::new_with_data_dir(Some(identity), Some(recv), data_dir)
        .context("constructing the ephemeral stash watcher")
}

fn configure_node_telemetry(node: &LocationNode, config: &RuntimeConfig) {
    let Some(endpoint) = config.otel_endpoint.as_ref() else {
        return;
    };
    let instance = format!("stash-cli-{}", short_hex(&hex_encode(&node.endpoint_id())));
    let active = configure_telemetry(endpoint.clone(), instance);
    if active {
        eprintln!("OTEL export enabled for the CLI core.");
    }
}

async fn wait_for_pair_session(node: &Arc<LocationNode>, timeout: Duration) -> Result<Vec<u8>> {
    let deadline = Instant::now() + timeout;
    loop {
        for event in node.poll_pair_events().await {
            if matches!(
                event.kind,
                iroh_location::PairEventKind::PendingRequest
                    | iroh_location::PairEventKind::Verifying
            ) {
                return Ok(event.session_id);
            }
        }
        if Instant::now() >= deadline {
            bail!("pairing invite expired before the phone connected");
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

async fn complete_visual_pairing(
    node: &Arc<LocationNode>,
    session_id: &[u8],
    auto_sas: bool,
) -> Result<()> {
    let deadline = Instant::now() + Duration::from_secs(70);
    let challenge = loop {
        if let Some(challenge) = node
            .pair_sas_challenge(session_id.to_vec())
            .await
            .context("reading the visual pairing challenge")?
        {
            break challenge;
        }
        if let Some(state) = node
            .pair_state(session_id.to_vec())
            .await
            .context("reading pairing state")?
        {
            if matches!(state.state, PairState::Rejected | PairState::Failed) {
                bail!("the phone rejected or failed the pairing attempt");
            }
        }
        if Instant::now() >= deadline {
            bail!("pairing did not reach the visual verification gate");
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    };

    match challenge.role {
        SasRoleKind::Displayer => {
            let figure = pairing_figure(challenge.target_index)?;
            println!();
            println!("Show the phone user this figure:");
            print_figure(&figure);
            let matched =
                auto_sas || prompt_yes_no("Did the phone user choose this exact figure? [y/N] ")?;
            node.confirm_pair_display(session_id.to_vec(), matched)
                .await
                .context("submitting the displayed-figure confirmation")?;
            if !matched {
                bail!("pairing cancelled because the figures did not match");
            }
        }
        SasRoleKind::Picker => {
            if challenge.option_indices.len() != 4 {
                bail!("pairing challenge contained an invalid option count");
            }
            println!();
            println!("Choose the figure currently shown on the phone:");
            for (position, index) in challenge.option_indices.iter().enumerate() {
                println!();
                println!("Option {}:", position + 1);
                print_figure(&pairing_figure(*index)?);
            }
            let figure_index = if auto_sas {
                challenge.target_index
            } else {
                let selected = prompt_choice(4)?;
                challenge.option_indices[selected - 1]
            };
            node.submit_pair_choice(session_id.to_vec(), figure_index)
                .await
                .context("submitting the selected pairing figure")?;
        }
    }
    Ok(())
}

async fn wait_for_pair_result(node: &Arc<LocationNode>, session_id: &[u8]) -> Result<PairResult> {
    let deadline = Instant::now() + Duration::from_secs(70);
    loop {
        if let Some(result) = node
            .pair_result(session_id.to_vec())
            .await
            .context("reading the completed pair result")?
        {
            return Ok(result);
        }
        if let Some(state) = node
            .pair_state(session_id.to_vec())
            .await
            .context("reading pairing state")?
        {
            if matches!(state.state, PairState::Rejected | PairState::Failed) {
                bail!("pairing was rejected or failed before both sides accepted");
            }
        }
        if Instant::now() >= deadline {
            bail!("timed out waiting for the phone to confirm the visual pairing");
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

async fn register_namespace(config: &RuntimeConfig, read_ticket: &str) -> Result<()> {
    #[derive(Serialize)]
    struct Registration<'a> {
        read_ticket: &'a str,
    }

    let request = http_client()?
        .post(format!("{}/v1/namespaces", config.stash_url))
        .json(&Registration { read_ticket });
    let request = if let Some(psk) = config.stash_psk.as_ref() {
        request.bearer_auth(psk)
    } else {
        request
    };
    let response = request
        .send()
        .await
        .context("sending the namespace registration")?;
    if response.status() != reqwest::StatusCode::CREATED {
        bail!(
            "trail-stash namespace registration failed with {}",
            response.status()
        );
    }
    Ok(())
}

fn http_client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(HTTP_TIMEOUT_SECONDS))
        .build()
        .context("building the trail-stash HTTP client")
}

fn open_pair_link_with_adb(link: &str) -> Result<()> {
    let status = Command::new("adb")
        .args([
            "shell",
            "am",
            "start",
            "-a",
            "android.intent.action.VIEW",
            "-d",
            link,
            APP_PACKAGE,
        ])
        .status()
        .context(
            "running adb; verify adb is installed and exactly one Android device is connected",
        )?;
    if !status.success() {
        bail!("adb failed to open the pairing link ({status})");
    }
    Ok(())
}

fn open_pair_link_with_simctl(udid: &str, link: &str) -> Result<()> {
    let status = Command::new("xcrun")
        .args(["simctl", "openurl", udid, link])
        .status()
        .context("running xcrun simctl; verify Xcode is installed and the simulator is booted")?;
    if !status.success() {
        bail!("simctl failed to open the pairing link ({status})");
    }
    Ok(())
}

fn print_fix(output: &FixOutput, json: bool) -> Result<()> {
    if json {
        println!(
            "{}",
            serde_json::to_string(output).context("encoding JSON fix output")?
        );
    } else {
        println!(
            "[fix] seq={} lat={:.6} lon={:.6} accuracy_m={:.1} heading_deg={:.1} fix_ts={} lag_ms={} source={} stash={}",
            output.seq,
            output.lat,
            output.lon,
            output.accuracy_m,
            output.heading_deg,
            output.fix_ts,
            output.lag_ms,
            output.source,
            output.stash_endpoint
        );
    }
    Ok(())
}

fn print_figure(figure: &PairingFigure) {
    println!("#{} {}", figure.index, figure.name);
    println!("{}", figure.art);
}

fn pairing_figure(index: u32) -> Result<PairingFigure> {
    const HEADS: [(&str, [&str; 2]); 16] = [
        ("round eyes", ["  .-.  ", " (o o) "]),
        ("wide eyes", ["  .-.  ", " (O O) "]),
        ("sleepy eyes", ["  .-.  ", " (- -) "]),
        ("bright eyes", ["  .-.  ", " (^ ^) "]),
        ("peaked head", ["  /_\\  ", " [o o] "]),
        ("peaked cross eyes", ["  /_\\  ", " [x x] "]),
        ("square head", [" .---. ", " |o o| "]),
        ("square sleepy head", [" .---. ", " |- -| "]),
        ("curly head", ["  { }  ", " {o o} "]),
        ("curly wide eyes", ["  { }  ", " {O O} "]),
        ("antenna head", ["  .^.  ", " (o o) "]),
        ("antenna cross eyes", ["  .^.  ", " (x x) "]),
        ("horned head", ["  \\_/  ", " <o o> "]),
        ("horned wide eyes", ["  \\_/  ", " <O O> "]),
        ("flat head", ["  ===  ", " [o o] "]),
        ("flat bright eyes", ["  ___  ", " [^ ^] "]),
    ];
    const BODIES: [(&str, [&str; 2]); 16] = [
        ("raised arms", [" \\ | / ", "  / \\  "]),
        ("wide arms", [" --|-- ", "  / \\  "]),
        ("low arms", ["  \\|/  ", "  / \\  "]),
        ("right wave", ["  /|-- ", "  / \\  "]),
        ("left wave", [" --|\\  ", "  / \\  "]),
        ("hands on hips", ["  <|>  ", "  / \\  "]),
        ("diamond body", ["  /#\\  ", "  / \\  "]),
        ("box body", ["  [|]  ", "  / \\  "]),
        ("wide feet", ["  /|\\  ", " _/ \\_ "]),
        ("together feet", ["  /|\\  ", "  | |  "]),
        ("left step", ["  /|\\  ", " _/ |  "]),
        ("right step", ["  /|\\  ", "  | \\_ "]),
        ("round body", ["  (|)  ", "  / \\  "]),
        ("tall body", ["   |   ", "  /|\\  "]),
        ("short body", ["  -|-  ", "  / \\  "]),
        ("crossed legs", ["  /|\\  ", "  \\ /  "]),
    ];

    if index >= 256 {
        bail!("pairing figure index must be between 0 and 255");
    }
    let head = HEADS[(index >> 4) as usize];
    let body = BODIES[(index & 0x0f) as usize];
    Ok(PairingFigure {
        index,
        name: format!("{}, {}", head.0, body.0),
        art: [head.1[0], head.1[1], body.1[0], body.1[1]].join("\n"),
    })
}

fn prompt_yes_no(prompt: &str) -> Result<bool> {
    print!("{prompt}");
    io::stdout().flush().context("flushing terminal prompt")?;
    let mut input = String::new();
    io::stdin()
        .read_line(&mut input)
        .context("reading terminal input")?;
    Ok(matches!(
        input.trim().to_ascii_lowercase().as_str(),
        "y" | "yes"
    ))
}

fn prompt_choice(option_count: usize) -> Result<usize> {
    loop {
        print!("Option [1-{option_count}]: ");
        io::stdout().flush().context("flushing terminal prompt")?;
        let mut input = String::new();
        io::stdin()
            .read_line(&mut input)
            .context("reading terminal input")?;
        if let Ok(value) = input.trim().parse::<usize>() {
            if (1..=option_count).contains(&value) {
                return Ok(value);
            }
        }
        println!("Enter a number between 1 and {option_count}.");
    }
}

fn pair_link(token: &str) -> String {
    format!(
        "streetcryptid:///social?token={}",
        token.replacen(':', "%3A", 1)
    )
}

fn state_path(state_dir: &Path) -> PathBuf {
    state_dir.join("client-state.json")
}

fn load_state(path: &Path) -> Result<Option<ClientState>> {
    if !path.exists() {
        return Ok(None);
    }
    let bytes = fs::read(path).with_context(|| format!("reading {}", path.display()))?;
    let state: ClientState =
        serde_json::from_slice(&bytes).with_context(|| format!("parsing {}", path.display()))?;
    if state.version != STATE_VERSION {
        bail!(
            "unsupported state version {} in {}",
            state.version,
            path.display()
        );
    }
    Ok(Some(state))
}

fn save_state(path: &Path, state: &ClientState) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("creating state directory {}", parent.display()))?;
    }
    let bytes = serde_json::to_vec_pretty(state).context("encoding CLI state")?;
    fs::write(path, bytes).with_context(|| format!("writing {}", path.display()))?;
    set_private_permissions(path)?;
    Ok(())
}

#[cfg(unix)]
fn set_private_permissions(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .with_context(|| format!("securing {}", path.display()))
}

#[cfg(not(unix))]
fn set_private_permissions(_path: &Path) -> Result<()> {
    Ok(())
}

fn default_state_dir() -> Result<PathBuf> {
    if let Some(path) = optional_env("STREETCRYPTID_STASH_CLI_DIR") {
        return Ok(PathBuf::from(path));
    }
    if let Some(path) = optional_env("LOCALAPPDATA") {
        return Ok(PathBuf::from(path)
            .join("streetcryptid")
            .join("trail-stash-client"));
    }
    if let Some(path) = optional_env("XDG_DATA_HOME") {
        return Ok(PathBuf::from(path)
            .join("streetcryptid")
            .join("trail-stash-client"));
    }
    if let Some(path) = optional_env("HOME") {
        return Ok(PathBuf::from(path)
            .join(".local")
            .join("share")
            .join("streetcryptid")
            .join("trail-stash-client"));
    }
    bail!("cannot determine a state directory; pass --state-dir")
}

fn load_dotenv() {
    let mut roots = Vec::new();
    if let Ok(current) = env::current_dir() {
        roots.push(current);
    }
    roots.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")));

    for root in roots {
        for ancestor in root.ancestors() {
            let candidate = ancestor.join(".env.local");
            if candidate.is_file() {
                let _ = dotenvy::from_path(candidate);
                return;
            }
        }
    }
}

fn required_env(name: &str) -> Result<String> {
    optional_env(name).ok_or_else(|| anyhow!("{name} is not configured"))
}

fn optional_env(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

fn short_hex(value: &str) -> String {
    value.chars().take(10).collect()
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn hex_decode(value: &str) -> Result<Vec<u8>> {
    if value.len() % 2 != 0 {
        bail!("hex value has odd length");
    }
    (0..value.len())
        .step_by(2)
        .map(|index| {
            u8::from_str_radix(&value[index..index + 2], 16)
                .with_context(|| format!("invalid hex at byte {}", index / 2))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pair_link_matches_the_app_codec() {
        assert_eq!(
            pair_link("scpair1:abcd"),
            "streetcryptid:///social?token=scpair1%3Aabcd"
        );
    }

    #[test]
    fn figure_catalog_matches_the_typescript_edges() {
        let first = pairing_figure(0).unwrap();
        assert_eq!(first.name, "round eyes, raised arms");
        assert_eq!(first.art, "  .-.  \n (o o) \n \\ | / \n  / \\  ");

        let last = pairing_figure(255).unwrap();
        assert_eq!(last.name, "flat bright eyes, crossed legs");
        assert_eq!(last.art, "  ___  \n [^ ^] \n  /|\\  \n  \\ /  ");
    }

    #[test]
    fn state_round_trips_without_location_payloads() {
        let state = ClientState {
            version: STATE_VERSION,
            identity_secret: "11".repeat(32),
            recv_secret: "22".repeat(32),
            peers: vec![
                PeerState {
                    endpoint_id: "33".repeat(32),
                    trail_ticket: "doc-ticket".into(),
                    profile_handle: Some("@phone".into()),
                    paired_at_ms: 1,
                    last_seq: 2,
                    last_fix_ts: Some(3),
                },
                PeerState {
                    endpoint_id: "44".repeat(32),
                    trail_ticket: "doc-ticket-2".into(),
                    profile_handle: Some("@phone2".into()),
                    paired_at_ms: 4,
                    last_seq: 5,
                    last_fix_ts: Some(6),
                },
            ],
        };
        let encoded = serde_json::to_vec(&state).unwrap();
        let decoded: ClientState = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(decoded.peers.len(), 2);
        assert_eq!(decoded.peers[0].last_seq, 2);
        assert_eq!(decoded.peers[1].last_seq, 5);
        // Cursors are addressed by endpoint id, which is what keeps one phone's seq from
        // advancing another's.
        assert_eq!(decoded.peer_index(&"44".repeat(32)), Some(1));
        assert_eq!(decoded.peer_index(&"99".repeat(32)), None);
    }

    #[test]
    fn state_without_peers_field_reads_as_unpaired() {
        // A state directory written before multi-peer support has `peer`, not `peers`. There is
        // deliberately no migration (this is a debug client): serde ignores the unknown field and
        // `#[serde(default)]` yields an empty list, so the CLI reports unpaired and re-pairs
        // rather than failing to parse.
        let legacy = r#"{"version":1,"identity_secret":"aa","recv_secret":"bb","peer":null}"#;
        let decoded: ClientState = serde_json::from_str(legacy).unwrap();
        assert!(decoded.peers.is_empty());
    }
}
