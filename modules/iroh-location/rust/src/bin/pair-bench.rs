//! Times a real pairing handshake end to end, on the host, between two real `LocationNode`s.
//!
//! WHY THIS EXISTS
//! ---------------
//! Pairing latency had no measurement anywhere. `pairing.poll` (JS) samples the state machine from
//! outside every ~4s, which cannot separate "waiting for a relay" from "waiting for the human at
//! the SAS gate", and every one of the 43 unit tests in `pairing.rs` builds a `PairCore` with NO
//! runtime attached — so `runtime_endpoint()` errors, `our_endpoint_ticket()` returns `""` through
//! its error branch, and the `Endpoint::online()` wait is never executed under test at all. The
//! cost was invisible to the test suite and to telemetry for the same reason.
//!
//! This drives the crate's own public API — the same calls the app makes — so a number here means
//! the same thing it would on a phone, minus the UI, BLE stack and permission prompts. Those are
//! excluded on purpose: they are what makes a device run ambiguous.
//!
//! WHAT TO LOOK AT
//! ---------------
//! `--no-relay` is the point of the tool. `Endpoint::online()` resolves only once a relay handshake
//! has completed and pends forever when no relay is reachable, so with relays gone every message
//! built pays the full `ENDPOINT_ONLINE_TIMEOUT`. Compare the two runs: if `--no-relay` is many
//! times slower than the configured run, the per-message wait is confirmed as the amplifier that
//! turns a relay outage into a near-timeout instead of a small delay.
//!
//! Usage:
//!   cargo run --features cli --bin pair-bench                # relays from .env.local
//!   cargo run --features cli --bin pair-bench -- --no-relay  # simulate the outage
//!   cargo run --features cli --bin pair-bench -- --iterations 3

use std::{
    env,
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

use anyhow::{bail, Context, Result};
use clap::Parser;
use iroh_location::{LocationNode, PairState, SasRoleKind};

#[derive(Parser, Debug)]
#[command(about = "Time a real pairing handshake between two nodes on this host")]
struct Cli {
    /// Comma-separated relay URLs. Defaults to EXPO_PUBLIC_IROH_RELAY_URLS.
    #[arg(long)]
    relays: Option<String>,

    /// Start both nodes with NO relays, reproducing the outage. `online()` can then never
    /// resolve, so every message built pays the full endpoint-online timeout.
    #[arg(long, default_value_t = false)]
    no_relay: bool,

    /// How many handshakes to run. Each uses a fresh pair of nodes and fresh data dirs.
    #[arg(long, default_value_t = 1)]
    iterations: u32,
}

/// One phase of the handshake, in the order a user experiences it.
struct Phase {
    name: &'static str,
    millis: u128,
}

#[tokio::main(flavor = "multi_thread")]
async fn main() {
    load_dotenv();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                // The spans this tool exists to read. Everything else stays at warn so the
                // iroh/quinn firehose does not bury them.
                .unwrap_or_else(|_| "warn,iroh_location::pairing=info".into()),
        )
        .with_target(false)
        .init();

    if let Err(error) = run(Cli::parse()).await {
        eprintln!("error: {error:#}");
        std::process::exit(1);
    }
}

async fn run(cli: Cli) -> Result<()> {
    let relays: Vec<String> = if cli.no_relay {
        Vec::new()
    } else {
        cli.relays
            .or_else(|| env::var("EXPO_PUBLIC_IROH_RELAY_URLS").ok())
            .context("no relays: pass --relays or set EXPO_PUBLIC_IROH_RELAY_URLS (or --no-relay)")?
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .collect()
    };
    let relay_token = env::var("EXPO_PUBLIC_IROH_RELAY_TOKEN").unwrap_or_default();

    println!(
        "relays: {}",
        if relays.is_empty() {
            "(none — simulating the outage)".to_owned()
        } else {
            relays.join(", ")
        }
    );

    let mut totals = Vec::new();
    for iteration in 1..=cli.iterations {
        println!("\n──────── iteration {iteration} ────────");
        let elapsed = one_handshake(&relays, &relay_token).await?;
        totals.push(elapsed);
    }

    if totals.len() > 1 {
        let sum: u128 = totals.iter().sum();
        println!(
            "\ntotal over {} runs: min {}ms  max {}ms  mean {}ms",
            totals.len(),
            totals.iter().min().unwrap(),
            totals.iter().max().unwrap(),
            sum / totals.len() as u128
        );
    }
    Ok(())
}

async fn one_handshake(relays: &[String], relay_token: &str) -> Result<u128> {
    let root = env::temp_dir().join(format!("pair-bench-{}", now_nanos()));
    let alice = spawn_node(&root, "alice", relays, relay_token).await?;
    let bob = spawn_node(&root, "bob", relays, relay_token).await?;

    let mut phases = Vec::new();
    let overall = Instant::now();

    // 1. Alice mints an invite. This is the first `our_endpoint_ticket()` call of the flow.
    let t = Instant::now();
    let invite = alice
        .create_invite(300)
        .await
        .context("alice: create_invite")?;
    phases.push(Phase {
        name: "create_invite (alice)",
        millis: t.elapsed().as_millis(),
    });

    // 2. Bob redeems it. This runs Hello + Reveal, each building a message on BOTH sides —
    //    and the responder builds its reply inside Bob's dial, so the waits serialize.
    let t = Instant::now();
    let session_id = bob
        .initiate_pair(invite)
        .await
        .context("bob: initiate_pair")?;
    phases.push(Phase {
        name: "initiate_pair (bob)  ← Hello+Reveal",
        millis: t.elapsed().as_millis(),
    });

    // 3. Both sides reach the SAS gate. No human here, so this is machine time only.
    let t = Instant::now();
    let alice_session = wait_for_session(&alice, Duration::from_secs(75)).await?;
    phases.push(Phase {
        name: "alice sees the session",
        millis: t.elapsed().as_millis(),
    });

    let t = Instant::now();
    tokio::try_join!(
        clear_sas(&bob, &session_id, "bob"),
        clear_sas(&alice, &alice_session, "alice"),
    )?;
    phases.push(Phase {
        name: "SAS gate (both, no human)",
        millis: t.elapsed().as_millis(),
    });

    // 4. Accept exchange — one more message built per side.
    let t = Instant::now();
    tokio::try_join!(
        wait_complete(&bob, &session_id, "bob"),
        wait_complete(&alice, &alice_session, "alice"),
    )?;
    phases.push(Phase {
        name: "accept → complete",
        millis: t.elapsed().as_millis(),
    });

    let total = overall.elapsed().as_millis();

    println!("\n{:<38} {:>9}", "phase", "ms");
    println!("{}", "─".repeat(48));
    for phase in &phases {
        println!("{:<38} {:>9}", phase.name, phase.millis);
    }
    println!("{}", "─".repeat(48));
    println!("{:<38} {:>9}", "TOTAL (no human in the loop)", total);

    // Shut down in reverse: the session store's writer claim is process-global and released only
    // when the last handle drops, so a leaked node makes the next iteration fail with AlreadyOpen.
    let _ = bob.shutdown().await;
    let _ = alice.shutdown().await;
    Ok(total)
}

async fn spawn_node(
    root: &PathBuf,
    who: &str,
    relays: &[String],
    relay_token: &str,
) -> Result<Arc<LocationNode>> {
    let data = root.join(who).join("data");
    let state = root.join(who).join("state");
    std::fs::create_dir_all(&data)?;
    std::fs::create_dir_all(&state)?;

    let node = LocationNode::new_at_dirs(
        None,
        None,
        data.to_string_lossy().into_owned(),
        state.to_string_lossy().into_owned(),
    )
    .with_context(|| format!("{who}: constructing the node"))?;

    let t = Instant::now();
    node.start(
        relays.to_vec(),
        relay_token.to_owned(),
        !relays.is_empty(),
        true,  // ip
        false, // ble — host has no BLE central, and it is not what we are timing
    )
    .await
    .with_context(|| format!("{who}: node.start"))?;
    println!("{who}: node.start {}ms", t.elapsed().as_millis());
    Ok(node)
}

/// The inbound side learns its session id only when the handshake reaches it.
async fn wait_for_session(node: &Arc<LocationNode>, budget: Duration) -> Result<Vec<u8>> {
    let deadline = Instant::now() + budget;
    loop {
        if let Some(record) = node.list_pair_sessions().await.into_iter().next() {
            return Ok(record.session_id);
        }
        if Instant::now() >= deadline {
            bail!("the inbound side never saw a pairing session");
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// Clear the visual gate the way a correct human would, with no think time.
async fn clear_sas(node: &Arc<LocationNode>, session_id: &[u8], who: &str) -> Result<()> {
    let deadline = Instant::now() + Duration::from_secs(75);
    let challenge = loop {
        if let Some(challenge) = node.pair_sas_challenge(session_id.to_vec()).await? {
            break challenge;
        }
        if let Some(state) = node.pair_state(session_id.to_vec()).await? {
            if matches!(state.state, PairState::Rejected | PairState::Failed) {
                bail!("{who}: pairing was rejected or failed before the SAS gate");
            }
        }
        if Instant::now() >= deadline {
            bail!("{who}: never reached the visual verification gate");
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    };

    match challenge.role {
        // target_index is the correct answer; picking it is what a human who matched would do.
        SasRoleKind::Picker => {
            node.submit_pair_choice(session_id.to_vec(), challenge.target_index)
                .await?;
        }
        SasRoleKind::Displayer => {
            node.confirm_pair_display(session_id.to_vec(), true).await?;
        }
    }
    Ok(())
}

async fn wait_complete(node: &Arc<LocationNode>, session_id: &[u8], who: &str) -> Result<()> {
    let deadline = Instant::now() + Duration::from_secs(75);
    loop {
        if node.pair_result(session_id.to_vec()).await?.is_some() {
            return Ok(());
        }
        if let Some(state) = node.pair_state(session_id.to_vec()).await? {
            if matches!(state.state, PairState::Rejected | PairState::Failed) {
                bail!("{who}: pairing ended as {:?}", state.state);
            }
        }
        if Instant::now() >= deadline {
            bail!("{who}: pairing never completed");
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn now_nanos() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default()
}

/// Same `.env.local` discovery the trail-stash client uses, so both tools read one config.
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
