//! The CLI's side of the management plane: `status`, `claim`, `settings` and `watch`, all over
//! the daemon's Unix socket (`daemon.rs`), in the line protocol the Windows app speaks.

use std::io::IsTerminal;
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use serde_json::Value;
use streetcryptid_repeater_host::PROTOCOL;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::net::unix::{OwnedReadHalf, OwnedWriteHalf};
use tokio::net::UnixStream;

use crate::paths;
use crate::qr;

/// How long to wait for a first snapshot: a daemon that has just started is still binding its
/// endpoint (the node gives itself 30 s).
const FIRST_SNAPSHOT: Duration = Duration::from_secs(45);
const REPLY: Duration = Duration::from_secs(15);
/// A line from the daemon longer than this is not one it wrote.
const MAX_LINE: usize = 1 << 20;

pub struct Connection {
    pub socket: PathBuf,
    lines: Lines<BufReader<OwnedReadHalf>>,
    write: OwnedWriteHalf,
}

impl Connection {
    /// Connect to the given socket, or to the first running repeater: the person's own, then the
    /// machine's.
    pub async fn open(explicit: Option<PathBuf>) -> Result<Self> {
        let candidates = match explicit {
            Some(path) => vec![path],
            None => paths::socket_candidates(),
        };
        let mut denied = None;
        for path in &candidates {
            match std::fs::metadata(path) {
                Ok(_) => {}
                // The service's runtime directory is 0750: an outsider cannot even see the socket.
                Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
                    denied = Some(path.clone());
                    continue;
                }
                Err(_) => continue,
            }
            match UnixStream::connect(path).await {
                Ok(stream) => {
                    verify_peer(&stream, path)?;
                    let (read, write) = stream.into_split();
                    return Ok(Self {
                        socket: path.clone(),
                        lines: BufReader::new(read).lines(),
                        write,
                    });
                }
                Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
                    denied = Some(path.clone());
                }
                Err(_) => {}
            }
        }
        if let Some(path) = denied {
            bail!(
                "You may not manage the repeater at {}. Use sudo, or ask an administrator to add you \
                 to the `{}` group (then sign in again).",
                path.display(),
                paths::SYSTEM_USER
            );
        }
        bail!(
            "No repeater is running. Start one in this terminal with `streetcryptid-repeater run`, \
             or keep one running with `streetcryptid-repeater install`."
        )
    }

    pub async fn next(&mut self) -> Result<Option<Value>> {
        let Some(line) = self.lines.next_line().await? else {
            return Ok(None);
        };
        if line.len() > MAX_LINE {
            bail!("The repeater sent a line this CLI does not understand");
        }
        let value: Value =
            serde_json::from_str(&line).context("The repeater sent malformed JSON")?;
        if value["protocol"].as_u64() != Some(PROTOCOL as u64) {
            bail!(
                "The repeater speaks protocol {}, this CLI {PROTOCOL}. Update whichever is older.",
                value["protocol"]
            );
        }
        Ok(Some(value))
    }

    /// The first snapshot, telling the person once if the daemon is still starting.
    pub async fn snapshot(&mut self) -> Result<Value> {
        let mut told = false;
        tokio::time::timeout(FIRST_SNAPSHOT, async {
            loop {
                let message = self
                    .next()
                    .await?
                    .ok_or_else(|| anyhow!("The repeater closed the connection"))?;
                match message["kind"].as_str() {
                    Some("snapshot") => return Ok(message["snapshot"].clone()),
                    Some("service") => match message["service"]["host"].as_str() {
                        Some("stopped") => bail!("The repeater is stopping"),
                        Some("starting" | "restarting") if !told => {
                            eprintln!("Waiting for the repeater to start…");
                            told = true;
                        }
                        _ => {}
                    },
                    _ => {}
                }
            }
        })
        .await
        .map_err(|_| anyhow!("The repeater did not report within {FIRST_SNAPSHOT:?}"))?
    }

    async fn send(&mut self, value: &Value) -> Result<()> {
        let line = format!("{value}\n");
        self.write.write_all(line.as_bytes()).await?;
        Ok(())
    }
}

/// The daemon is trusted only if it runs as this account, as root, or as the service account: the
/// claim link it hands over is what a phone will trust, so it must come from the real repeater.
fn verify_peer(stream: &UnixStream, path: &std::path::Path) -> Result<()> {
    let peer = stream
        .peer_cred()
        .context("Could not tell who is serving the repeater socket")?;
    // SAFETY: geteuid cannot fail.
    let me = unsafe { libc::geteuid() };
    let service = crate::install::lookup_user(paths::SYSTEM_USER).map(|u| u.uid);
    if peer.uid() == me || peer.uid() == 0 || Some(peer.uid()) == service {
        return Ok(());
    }
    bail!(
        "{} is served by an account this CLI does not trust (uid {}); refusing to use it",
        path.display(),
        peer.uid()
    )
}

pub async fn status(socket: Option<PathBuf>, json: bool) -> Result<()> {
    let mut connection = Connection::open(socket).await?;
    let state = connection.snapshot().await?;
    if json {
        println!("{}", serde_json::to_string_pretty(&state)?);
        return Ok(());
    }
    print!("{}", describe(&state, &connection.socket));
    Ok(())
}

/// The status, as the Windows app's status panel says it.
pub fn describe(state: &Value, socket: &std::path::Path) -> String {
    let count = |key: &str| state[key].as_u64().unwrap_or(0);
    let mut out = format!(
        "streetCryptid repeater {} ({})\n",
        state["version"].as_str().unwrap_or("?"),
        match state["mode"].as_str() {
            Some("service") => "system service",
            _ => "user",
        }
    );
    let row = |out: &mut String, label: &str, value: String| {
        out.push_str(&format!("  {label:<12} {value}\n"));
    };
    row(&mut out, "Endpoint", short(state["endpointId"].as_str()));
    if state["claimed"].as_bool() == Some(true) {
        row(
            &mut out,
            "Owner",
            format!(
                "{} · {}",
                short(state["owner"].as_str()),
                state["policy"].as_str().unwrap_or("?")
            ),
        );
        let members = state["members"].as_array().map_or(0, |m| m.len());
        row(
            &mut out,
            "Carrying",
            plural(members as u64, "person", "people"),
        );
    } else {
        row(
            &mut out,
            "Owner",
            "unclaimed — run `streetcryptid-repeater claim` and scan the code".into(),
        );
    }
    let missing = count("missing");
    let mut ready = plural(count("tracked"), "encrypted item", "encrypted items") + " ready";
    if missing > 0 {
        ready.push_str(&format!(" ({missing} waiting for data)"));
    }
    row(&mut out, "Forwarding", ready);
    row(
        &mut out,
        "Received",
        plural(count("received"), "location update", "location updates") + " since start",
    );
    row(
        &mut out,
        "Network",
        format!(
            "{} open · {} in · {} out",
            plural(count("connections"), "connection", "connections"),
            bytes(count("bytesReceived")),
            bytes(count("bytesSent")),
        ),
    );
    let settings = &state["settings"];
    let available = state["telemetryAvailable"].as_bool() == Some(true);
    row(
        &mut out,
        "Diagnostics",
        match (available, settings["telemetry"].as_bool() == Some(true)) {
            (false, _) => "not in this build".into(),
            (true, true) => "sending".into(),
            (true, false) => "off".into(),
        },
    );
    row(
        &mut out,
        "Keep awake",
        match (
            settings["keepAwake"].as_bool() == Some(true),
            state["keepAwakeHeld"].as_bool() == Some(true),
        ) {
            (false, _) => "off".into(),
            (true, true) => "on (holding off sleep)".into(),
            (true, false) => "on, not holding: on battery, or the system refused".into(),
        },
    );
    row(&mut out, "Socket", socket.display().to_string());
    out
}

fn short(id: Option<&str>) -> String {
    match id {
        Some(id) if id.len() > 10 => format!("{}…", &id[..10]),
        Some(id) => id.to_string(),
        None => "—".into(),
    }
}

fn plural(n: u64, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

fn on_off(on: bool) -> &'static str {
    if on {
        "on"
    } else {
        "off"
    }
}

fn bytes(n: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut value = n as f64;
    let mut unit = 0;
    while value >= 1000.0 && unit < UNITS.len() - 1 {
        value /= 1000.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{n} B")
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

/// Show the claim QR until the repeater is claimed, a fresh one whenever the old link expires.
pub async fn claim(socket: Option<PathBuf>, once: bool, link_only: bool) -> Result<()> {
    let mut connection = Connection::open(socket).await?;
    let mut state = connection.snapshot().await?;
    let interactive = std::io::stdout().is_terminal();
    let window = trail_stash::repeater::CLAIM_WINDOW_MS / 60_000;
    let mut shown: Option<String> = None;
    loop {
        if state["claimed"].as_bool() == Some(true) {
            let members = state["members"].as_array().map_or(0, |m| m.len()) as u64;
            println!(
                "Claimed by {}. Carrying {}. Manage who it carries on the owner's phone \
                 (Settings > Repeaters).",
                short(state["owner"].as_str()),
                plural(members, "person", "people")
            );
            return Ok(());
        }
        if let Some(url) = state["claimUrl"].as_str() {
            if shown.as_deref() != Some(url) {
                if link_only {
                    println!("{url}");
                } else {
                    if interactive && shown.is_some() {
                        // A new code replaces the expired one rather than scrolling under it.
                        print!("\x1b[2J\x1b[H");
                    }
                    println!("{}", qr::claim_text(url, window));
                    if !once {
                        eprintln!("Waiting for the claim (Ctrl-C to stop)…");
                    }
                }
                shown = Some(url.to_string());
                if once {
                    return Ok(());
                }
            }
        }
        state = loop {
            let message = connection
                .next()
                .await?
                .ok_or_else(|| anyhow!("The repeater stopped"))?;
            if message["kind"] == "snapshot" {
                break message["snapshot"].clone();
            }
        };
    }
}

/// Print the current settings, or change them: the one command the management plane takes.
pub async fn settings(
    socket: Option<PathBuf>,
    telemetry: Option<bool>,
    keep_awake: Option<bool>,
) -> Result<()> {
    let mut connection = Connection::open(socket).await?;
    let state = connection.snapshot().await?;
    let current = &state["settings"];
    let available = state["telemetryAvailable"].as_bool() == Some(true);
    if telemetry.is_none() && keep_awake.is_none() {
        println!(
            "diagnostics  {}{}",
            on_off(current["telemetry"].as_bool() == Some(true)),
            if available {
                ""
            } else {
                " (this build has none to send)"
            }
        );
        println!(
            "keep-awake   {}",
            on_off(current["keepAwake"].as_bool() == Some(true))
        );
        return Ok(());
    }
    let next_telemetry = telemetry.unwrap_or(current["telemetry"].as_bool() == Some(true));
    let next_keep_awake = keep_awake.unwrap_or(current["keepAwake"].as_bool() == Some(true));
    let request_id = streetcryptid_repeater_host::run_id()[..16].to_string();
    connection
        .send(&serde_json::json!({
            "protocol": PROTOCOL,
            "kind": "settings",
            "requestId": request_id,
            "telemetry": next_telemetry,
            "keepAwake": next_keep_awake,
        }))
        .await?;
    let ok = tokio::time::timeout(REPLY, async {
        loop {
            let message = connection
                .next()
                .await?
                .ok_or_else(|| anyhow!("The repeater closed the connection"))?;
            if message["kind"] == "result" && message["requestId"] == request_id.as_str() {
                return Ok::<_, anyhow::Error>(message["ok"].as_bool() == Some(true));
            }
        }
    })
    .await
    .map_err(|_| anyhow!("The repeater did not answer"))??;
    if !ok {
        bail!("The repeater could not save its settings; check its state directory");
    }
    println!(
        "Saved: diagnostics {}, keep-awake {}.",
        on_off(next_telemetry),
        on_off(next_keep_awake)
    );
    if next_telemetry && !available {
        println!("This build was made without a diagnostics endpoint, so nothing will be sent.");
    }
    Ok(())
}

/// Every line the daemon writes, as it writes it: the Windows app's view, for scripts.
pub async fn watch(socket: Option<PathBuf>) -> Result<()> {
    let mut connection = Connection::open(socket).await?;
    while let Some(message) = connection.next().await? {
        println!("{message}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn describes_a_claimed_repeater_without_secrets() {
        let state = serde_json::json!({
            "protocol": 2, "version": "1.2.3", "mode": "service",
            "endpointId": "0123456789abcdef0123", "claimed": true,
            "claimUrl": null, "owner": "fedcba9876543210", "policy": "Invite only",
            "members": ["aa", "bb"], "tracked": 4, "missing": 1, "received": 9,
            "connections": 2, "connectionsOpened": 5, "bytesReceived": 1_500_000,
            "bytesSent": 999, "settings": {"telemetry": false, "keepAwake": true},
            "telemetryAvailable": true, "keepAwakeHeld": true
        });
        let text = describe(&state, std::path::Path::new("/run/x.sock"));
        assert!(text.contains("system service"));
        assert!(text.contains("Carrying     2 people"));
        assert!(text.contains("4 encrypted items ready (1 waiting for data)"));
        assert!(text.contains("1.5 MB in"));
        assert!(text.contains("999 B out"));
        assert!(text.contains("Keep awake   on (holding off sleep)"));
        assert!(!text.contains("0123456789abcdef0123"));
    }

    #[test]
    fn sizes_read_like_the_windows_app() {
        assert_eq!(bytes(0), "0 B");
        assert_eq!(bytes(1_234), "1.2 KB");
        assert_eq!(bytes(5_000_000_000), "5.0 GB");
    }
}
