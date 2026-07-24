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
const DEFAULT_SINCE_MINUTES: u64 = 60;
const HTTP_TIMEOUT_SECONDS: u64 = 10;
const ONCE_RETRY_SECONDS: u64 = 2;
const ONCE_MAX_ATTEMPTS: u64 = 15;

#[derive(Parser)]
#[command(
    name = "trail-stash-client",
    about = "Pair with a streetCryptid phone and observe its location trail through trail-stash only"
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

        /// Replace an existing paired phone while retaining this CLI's identity.
        #[arg(long)]
        force: bool,

        /// Invite lifetime in seconds.
        #[arg(long, default_value_t = DEFAULT_PAIR_TTL_SECONDS)]
        ttl_seconds: u64,

        /// Developer automation: submit this process's transcript-derived SAS target without stdin.
        #[arg(long, hide = true)]
        auto_sas: bool,
    },

    /// Reconcile the paired phone's namespace with only the configured stash endpoint.
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

        /// Initial history window. Subsequent runs resume by sequence number.
        #[arg(long, default_value_t = DEFAULT_SINCE_MINUTES)]
        since_minutes: u64,
    },

    /// Show local pairing state, configured endpoints, and stash health.
    Status,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct ClientState {
    version: u8,
    identity_secret: String,
    recv_secret: String,
    peer: Option<PeerState>,
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
            force,
            ttl_seconds,
            auto_sas,
        } => run_pair(&state_dir, &config, adb, force, ttl_seconds, auto_sas).await,
        ClientCommand::Watch {
            once,
            json,
            interval_seconds,
            since_minutes,
        } => {
            run_watch(
                &state_dir,
                &config,
                once,
                json,
                interval_seconds,
                since_minutes,
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
    force: bool,
    ttl_seconds: u64,
    auto_sas: bool,
) -> Result<()> {
    if ttl_seconds == 0 {
        bail!("pair invite TTL must be greater than zero");
    }

    let state_path = state_path(state_dir);
    let existing = load_state(&state_path)?;
    if existing
        .as_ref()
        .and_then(|state| state.peer.as_ref())
        .is_some()
        && !force
    {
        bail!("a phone is already paired; pass --force to replace it");
    }

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
    } else {
        println!("ADB command:");
        println!("adb shell am start -a android.intent.action.VIEW -d \"{link}\" {APP_PACKAGE}");
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
    state.peer = Some(peer.clone());
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
    since_minutes: u64,
) -> Result<()> {
    if !once && interval_seconds == 0 {
        bail!("watch interval must be greater than zero");
    }

    let state_path = state_path(state_dir);
    let mut state = load_state(&state_path)?.ok_or_else(|| anyhow!("no CLI state; pair first"))?;
    let peer = state
        .peer
        .clone()
        .ok_or_else(|| anyhow!("no paired phone; run the pair command first"))?;
    let peer_author =
        hex_decode(&peer.endpoint_id).context("stored phone endpoint id is invalid")?;
    let watch_root = state_dir.join("stash-replica");
    if watch_root.exists() {
        fs::remove_dir_all(&watch_root)
            .with_context(|| format!("clearing {}", watch_root.display()))?;
    }

    register_namespace(config, &peer.trail_ticket)
        .await
        .context("registering the phone namespace with trail-stash")?;

    let stash_endpoint = config.stash_endpoint_short()?;
    println!(
        "Watching phone {} through stash {} only. No gossip subscription or phone ticket is used.",
        short_hex(&peer.endpoint_id),
        stash_endpoint
    );

    let initial_since = if peer.last_seq == 0 && since_minutes > 0 {
        now_ms().saturating_sub(since_minutes.saturating_mul(60_000))
    } else {
        0
    };

    let mut sync_attempt = 0u64;
    loop {
        // iroh-docs extends explicit peers with useful peers remembered in its replica DB. A fresh
        // store per attempt ensures the configured stash remains the only possible dial target.
        sync_attempt += 1;
        let watch_replica = watch_root.join(format!("attempt-{}-{sync_attempt}", now_ms()));
        let (node, _) = create_node(Some(&state), watch_replica.clone())?;
        configure_node_telemetry(&node, config);
        node.start(
            config.relay_urls.clone(),
            config.relay_token.clone(),
            true,
            true,
            true,
        )
            .await
            .context("starting the stash-only node")?;

        let attempt = async {
            let fixes = node
                .sync_trail_via_only(
                    initial_since,
                    peer.trail_ticket.clone(),
                    config.stash_ticket.clone(),
                )
                .await
                .context("direct stash-only trail reconciliation")?;
            if fixes
                .iter()
                .any(|fix| fix.author.as_slice() != peer_author.as_slice())
            {
                bail!("stash returned a decryptable fix for an unexpected author");
            }
            Ok::<_, anyhow::Error>(fixes)
        }
        .await;
        let shutdown = node.shutdown().await.context("shutting down watcher node");
        if let Err(error) = fs::remove_dir_all(&watch_replica) {
            tracing::warn!(
                path = %watch_replica.display(),
                error = %error,
                "could not remove the isolated watch replica"
            );
        }
        shutdown?;
        let mut fixes = match attempt {
            Ok(fixes) => fixes,
            Err(error) => {
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
                if once && sync_attempt >= ONCE_MAX_ATTEMPTS {
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

        let last_seq = state
            .peer
            .as_ref()
            .map(|saved| saved.last_seq)
            .unwrap_or_default();
        let new_fixes = fixes
            .into_iter()
            .filter(|fix| fix.seq > last_seq)
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

        if let Some(latest) = new_fixes.last() {
            if let Some(saved) = state.peer.as_mut() {
                saved.last_seq = latest.seq;
                saved.last_fix_ts = Some(latest.fix.ts);
            }
            save_state(&state_path, &state)?;
        }

        if !json {
            println!(
                "[sync] strict_peer={} recovered={} new={} last_seq={}",
                stash_endpoint,
                recovered,
                new_fixes.len(),
                state
                    .peer
                    .as_ref()
                    .map(|saved| saved.last_seq)
                    .unwrap_or_default()
            );
        }

        if once {
            break;
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

    match state.and_then(|saved| saved.peer) {
        Some(peer) => {
            println!("paired=true");
            println!("phone_endpoint={}", short_hex(&peer.endpoint_id));
            println!(
                "phone_handle={}",
                peer.profile_handle.as_deref().unwrap_or("unknown")
            );
            println!("last_seq={}", peer.last_seq);
            println!(
                "last_fix_ts={}",
                peer.last_fix_ts
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "none".into())
            );
        }
        None => println!("paired=false"),
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
        peer: None,
    });
    Ok((node, next_state))
}

fn configure_node_telemetry(node: &LocationNode, config: &RuntimeConfig) {
    let Some(endpoint) = config.otel_endpoint.as_ref() else {
        return;
    };
    let instance = format!("stash-cli-{}", short_hex(&hex_encode(&node.endpoint_id())));
    let active = configure_telemetry(endpoint.clone(), instance);
    if active {
        println!("OTEL export enabled for the CLI core.");
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
            peer: Some(PeerState {
                endpoint_id: "33".repeat(32),
                trail_ticket: "doc-ticket".into(),
                profile_handle: Some("@phone".into()),
                paired_at_ms: 1,
                last_seq: 2,
                last_fix_ts: Some(3),
            }),
        };
        let encoded = serde_json::to_vec(&state).unwrap();
        let decoded: ClientState = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(decoded.peer.unwrap().last_seq, 2);
    }
}
