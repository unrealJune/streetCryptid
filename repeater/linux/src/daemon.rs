//! `streetcryptid-repeater run`: the node, and the management plane on a Unix socket.
//!
//! The Windows repeater splits this across a host and a supervising service that relays its
//! lines to the app over a named pipe. Here systemd is the supervisor (restart, backoff,
//! start before sign-in), so one process is both: it runs the node the Windows host runs and
//! speaks the service's side of that pipe to every CLI that connects —
//!
//! 1. a `service` line (`starting` / `running` / `stopped`), then the latest snapshot;
//! 2. a snapshot every two seconds and an `arrival` per newly servable fix, to everyone;
//! 3. exactly one command, `settings`, answered with a `result` to the client that sent it and a
//!    fresh snapshot to everyone. Anything else and the client is dropped.
//!
//! A client that stops reading is disconnected rather than allowed to hold memory; it reconnects
//! and is handed the latest snapshot.

use std::io::IsTerminal;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use serde_json::Value;
use streetcryptid_repeater_host::{
    claim_directory, identity, init_telemetry, message, run_pulse, snapshot, start, Command,
    HostInfo, PulseInfo, Settings, Snapshot, MAX_COMMAND_LINE, SERVICE_MARKER,
};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{broadcast, mpsc, oneshot};
use trail_stash::config::{DEFAULT_PEER_SYNC_INTERVAL_MIN, DEFAULT_PRUNE_INTERVAL_MIN};

use crate::paths::{self, Mode};
use crate::{power, qr, TELEMETRY_ENDPOINT, VERSION};

/// How many management clients may be connected at once. A person runs one or two.
const MAX_CLIENTS: usize = 16;
/// Lines a slow client may fall behind before it is dropped.
const CLIENT_BACKLOG: usize = 256;
/// A client that does not take a line within this is gone.
const WRITE_TIMEOUT: Duration = Duration::from_secs(10);

pub struct RunArgs {
    pub mode: Mode,
    pub state_dir: Option<PathBuf>,
    pub socket: Option<PathBuf>,
}

pub fn run(args: RunArgs) -> Result<()> {
    let state_dir = match args.state_dir {
        Some(dir) => dir,
        None => paths::default_state_dir(args.mode)?,
    };
    if args.mode == Mode::User && state_dir.join(SERVICE_MARKER).exists() {
        bail!(
            "This repeater's identity moved to the system service. Manage it with this CLI \
             (`streetcryptid-repeater status`), or move it back with `sudo streetcryptid-repeater \
             uninstall --system`."
        );
    }
    crate::migrate::create_private_dir(&state_dir)?;
    let _lock = claim_directory(&state_dir).context("This repeater is already running")?;
    let secret = identity(&state_dir).context("The repeater identity could not be read")?;
    let settings = Arc::new(Settings::open(&state_dir));
    // Before the runtime exists: the exporter reads its endpoint from the environment, and no
    // other thread may be running while it is written.
    init_telemetry(TELEMETRY_ENDPOINT, &secret, settings.telemetry_flag());
    let socket = args
        .socket
        .unwrap_or_else(|| paths::default_socket(args.mode, &state_dir));
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    let result = runtime.block_on(serve(
        args.mode,
        state_dir,
        socket.clone(),
        secret,
        settings,
    ));
    runtime.shutdown_timeout(Duration::from_secs(5));
    let _ = std::fs::remove_file(&socket);
    result
}

async fn serve(
    mode: Mode,
    dir: PathBuf,
    socket: PathBuf,
    secret: iroh::SecretKey,
    settings: Arc<Settings>,
) -> Result<()> {
    let started_at = Instant::now();
    let hub = Arc::new(Hub::new(message::service(VERSION, "starting", 0)));
    let listener = bind(&socket, mode)?;
    let (commands, mut requested) = mpsc::channel::<Request>(16);
    let accept = tokio::spawn(accept_loop(listener, hub.clone(), commands, mode));
    let interactive = std::io::stdout().is_terminal();
    say(&format!(
        "streetCryptid repeater {VERSION} starting ({}; control socket {})",
        mode.name(),
        socket.display()
    ));

    let mut stop = std::pin::pin!(shutdown_signal());
    let node = tokio::select! {
        result = start(&dir, secret) => result.context("The repeater node could not start")?,
        _ = &mut stop => {
            accept.abort();
            return Ok(());
        }
    };
    let power = power::KeepAwake::spawn(settings.keep_awake_flag());
    drop(tracing::info_span!(
        "repeater.host.start",
        host.platform = "linux",
        host.mode = mode.name(),
        host.version = VERSION,
        host.start_ms = started_at.elapsed().as_millis() as u64,
    ));
    let prune = tokio::spawn(node.clone().run_prune_loop(DEFAULT_PRUNE_INTERVAL_MIN));
    let siblings = tokio::spawn(trail_stash::repeater::run_sibling_loop(
        node.clone(),
        vec![],
        Duration::from_secs(DEFAULT_PEER_SYNC_INTERVAL_MIN * 60),
    ));
    let pulse = tokio::spawn(run_pulse(
        node.clone(),
        PulseInfo {
            platform: "linux",
            mode: mode.name(),
            version: VERSION,
        },
        power.clone(),
        started_at,
    ));
    let run_id = streetcryptid_repeater_host::run_id();
    let info = || HostInfo {
        version: VERSION,
        mode: mode.name(),
        settings: settings.get(),
        telemetry_available: TELEMETRY_ENDPOINT.is_some_and(|e| !e.trim().is_empty()),
        keep_awake_held: streetcryptid_repeater_host::PowerState::holding(&*power),
    };
    let mut console = Console::new(interactive);
    let publish = |state: Snapshot, console: &mut Console| {
        console.observe(&state);
        hub.publish_snapshot(message::snapshot(&run_id, &state));
    };
    publish(snapshot(&node, info()), &mut console);
    hub.set_service(message::service(VERSION, "running", 0));
    notify("READY=1");

    let mut arrivals = node.subscribe_arrivals();
    let mut interval = tokio::time::interval(Duration::from_secs(2));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            _ = &mut stop => break,
            Some(Request { command, reply }) = requested.recv() => {
                let ok = match command.settings() {
                    Ok(next) => settings.set(next).is_ok(),
                    Err(_) => false,
                };
                let _ = reply.send(message::result(&run_id, &command.request_id, ok));
                publish(snapshot(&node, info()), &mut console);
            }
            _ = interval.tick() => publish(snapshot(&node, info()), &mut console),
            arrival = arrivals.recv() => match arrival {
                Ok(sequence) => hub.broadcast(message::arrival(&run_id, sequence)),
                Err(broadcast::error::RecvError::Lagged(_)) => {}
                Err(broadcast::error::RecvError::Closed) => break,
            },
        }
    }
    notify("STOPPING=1");
    say("streetCryptid repeater stopping");
    hub.set_service(message::service(VERSION, "stopped", 0));
    drop(tracing::info_span!(
        "repeater.host.stop",
        host.platform = "linux",
        host.mode = mode.name(),
        uptime_s = started_at.elapsed().as_secs(),
    ));
    accept.abort();
    pulse.abort();
    prune.abort();
    siblings.abort();
    let _ = tokio::time::timeout(Duration::from_secs(5), node.shutdown()).await;
    Ok(())
}

/// Progress for whoever is watching: the terminal, or the journal under systemd. Never a key,
/// a ticket or the claim link — those reach only an interactive terminal ([`Console`]).
fn say(line: &str) {
    println!("{line}");
}

/// What the daemon tells a person at its terminal. The claim QR is printed only when stdout is
/// an interactive terminal: under systemd stdout is the journal, and the claim link is a one-time
/// secret meant for exactly one reader, at one screen (`streetcryptid-repeater claim` shows it).
struct Console {
    interactive: bool,
    claimed: Option<bool>,
    claim_url: Option<String>,
}

impl Console {
    fn new(interactive: bool) -> Self {
        Self {
            interactive,
            claimed: None,
            claim_url: None,
        }
    }

    fn observe(&mut self, state: &Snapshot) {
        if self.claimed != Some(state.claimed) {
            self.claimed = Some(state.claimed);
            if state.claimed {
                say(&format!(
                    "Claimed. Carrying {} {}.",
                    state.members.len(),
                    if state.members.len() == 1 {
                        "person"
                    } else {
                        "people"
                    }
                ));
            } else if !self.interactive {
                say("Unclaimed. Run `streetcryptid-repeater claim` at a terminal to show the claim code.");
            }
        }
        if self.interactive && state.claim_url != self.claim_url {
            self.claim_url = state.claim_url.clone();
            if let Some(url) = &state.claim_url {
                println!(
                    "\n{}",
                    qr::claim_text(url, trail_stash::repeater::CLAIM_WINDOW_MS / 60_000)
                );
            }
        }
    }
}

/// Listen on `path`, owner-only for a person's daemon and owner+group for the service. The parent
/// directory is private too (0700, or the service's 0750 runtime directory), so there is no moment
/// when the socket is reachable by anyone else.
fn bind(path: &Path, mode: Mode) -> Result<UnixListener> {
    use std::os::unix::fs::PermissionsExt;
    if let Some(parent) = path.parent() {
        if !parent.exists() {
            crate::migrate::create_private_dir(parent)?;
        }
    }
    if path.exists() {
        if std::os::unix::net::UnixStream::connect(path).is_ok() {
            bail!(
                "Another repeater is already listening on {}",
                path.display()
            );
        }
        // Left by a daemon that did not exit cleanly.
        std::fs::remove_file(path)
            .with_context(|| format!("removing a stale socket at {}", path.display()))?;
    }
    let listener =
        UnixListener::bind(path).with_context(|| format!("listening on {}", path.display()))?;
    let permissions = match mode {
        Mode::User => 0o600,
        Mode::Service => 0o660,
    };
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(permissions))?;
    Ok(listener)
}

struct Request {
    command: Command,
    reply: oneshot::Sender<Value>,
}

async fn accept_loop(
    listener: UnixListener,
    hub: Arc<Hub>,
    commands: mpsc::Sender<Request>,
    mode: Mode,
) {
    let slots = Arc::new(tokio::sync::Semaphore::new(MAX_CLIENTS));
    let me = unsafe { libc::geteuid() };
    loop {
        let Ok((stream, _)) = listener.accept().await else {
            tokio::time::sleep(Duration::from_millis(100)).await;
            continue;
        };
        // The socket's permissions are the gate; this is the second lock on the same door. A
        // person's daemon answers only that person (and root); the service answers whoever its
        // 0660 socket let in.
        let allowed = match (mode, stream.peer_cred()) {
            (_, Err(_)) => false,
            (Mode::Service, Ok(_)) => true,
            (Mode::User, Ok(peer)) => peer.uid() == me || peer.uid() == 0,
        };
        if !allowed {
            continue;
        }
        let Ok(slot) = slots.clone().try_acquire_owned() else {
            continue;
        };
        let hub = hub.clone();
        let commands = commands.clone();
        tokio::spawn(async move {
            serve_client(stream, hub, commands).await;
            drop(slot);
        });
    }
}

async fn serve_client(stream: UnixStream, hub: Arc<Hub>, commands: mpsc::Sender<Request>) {
    let (read, mut write) = stream.into_split();
    let (initial, mut lines) = hub.join();
    let (replies, mut replied) = mpsc::channel::<Value>(4);
    // Reads commands until the client closes, sends anything invalid, or overflows a line.
    let reader = tokio::spawn(async move {
        let mut input = BufReader::new(read);
        loop {
            let mut line = Vec::new();
            let read = (&mut input)
                .take(MAX_COMMAND_LINE as u64 + 1)
                .read_until(b'\n', &mut line)
                .await;
            if !matches!(read, Ok(1..=MAX_COMMAND_LINE)) || line.last() != Some(&b'\n') {
                break;
            }
            let Ok(command) = serde_json::from_slice::<Command>(&line) else {
                break;
            };
            if command.settings().is_err() {
                break;
            }
            let (reply, answer) = oneshot::channel();
            if commands.send(Request { command, reply }).await.is_err() {
                break;
            }
            let Ok(answer) = answer.await else { break };
            if replies.send(answer).await.is_err() {
                break;
            }
        }
    });
    let mut alive = true;
    for line in initial {
        if !send(&mut write, line).await {
            alive = false;
            break;
        }
    }
    while alive {
        alive = tokio::select! {
            line = lines.recv() => match line {
                Ok(line) => send(&mut write, line).await,
                // Fell behind: drop it rather than queue for it.
                Err(_) => false,
            },
            reply = replied.recv() => match reply {
                Some(reply) => send(&mut write, Hub::line(&reply)).await,
                None => false,
            },
        };
    }
    reader.abort();
}

async fn send(write: &mut tokio::net::unix::OwnedWriteHalf, line: Arc<str>) -> bool {
    matches!(
        tokio::time::timeout(WRITE_TIMEOUT, write.write_all(line.as_bytes())).await,
        Ok(Ok(()))
    )
}

/// The latest `service` and snapshot lines, for whoever connects next, and a broadcast of every
/// line to whoever is connected.
struct Hub {
    latest: Mutex<(Arc<str>, Option<Arc<str>>)>,
    lines: broadcast::Sender<Arc<str>>,
}

impl Hub {
    fn new(service: Value) -> Self {
        Self {
            latest: Mutex::new((Self::line(&service), None)),
            lines: broadcast::channel(CLIENT_BACKLOG).0,
        }
    }

    fn line(value: &Value) -> Arc<str> {
        format!("{value}\n").into()
    }

    /// Subscribe and take the lines a newcomer starts from, atomically with any publish, so it
    /// neither misses nor repeats one.
    fn join(&self) -> (Vec<Arc<str>>, broadcast::Receiver<Arc<str>>) {
        let latest = self.latest.lock().expect("hub poisoned");
        let receiver = self.lines.subscribe();
        let mut initial = vec![latest.0.clone()];
        initial.extend(latest.1.clone());
        (initial, receiver)
    }

    fn set_service(&self, service: Value) {
        let line = Self::line(&service);
        let mut latest = self.latest.lock().expect("hub poisoned");
        latest.0 = line.clone();
        let _ = self.lines.send(line);
    }

    fn publish_snapshot(&self, snapshot: Value) {
        let line = Self::line(&snapshot);
        let mut latest = self.latest.lock().expect("hub poisoned");
        latest.1 = Some(line.clone());
        let _ = self.lines.send(line);
    }

    fn broadcast(&self, value: Value) {
        let _latest = self.latest.lock().expect("hub poisoned");
        let _ = self.lines.send(Self::line(&value));
    }
}

async fn shutdown_signal() {
    use tokio::signal::unix::{signal, SignalKind};
    let (Ok(mut term), Ok(mut int)) = (
        signal(SignalKind::terminate()),
        signal(SignalKind::interrupt()),
    ) else {
        return std::future::pending().await;
    };
    tokio::select! {
        _ = term.recv() => {}
        _ = int.recv() => {}
    }
}

/// `sd_notify`, for `Type=notify`: systemd counts the unit started only once the node is up, so
/// `systemctl start` (and `install`) return to a repeater that is answering.
fn notify(state: &str) {
    use std::os::linux::net::SocketAddrExt;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::net::{SocketAddr, UnixDatagram};
    let Some(path) = std::env::var_os("NOTIFY_SOCKET") else {
        return;
    };
    let Ok(socket) = UnixDatagram::unbound() else {
        return;
    };
    let bytes = path.as_bytes();
    let _ = match bytes.strip_prefix(b"@") {
        Some(name) => SocketAddr::from_abstract_name(name)
            .and_then(|addr| socket.send_to_addr(state.as_bytes(), &addr)),
        None => socket.send_to(state.as_bytes(), Path::new(&path)),
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_newcomer_starts_from_the_latest_lines() {
        let hub = Hub::new(serde_json::json!({"kind": "service"}));
        let (initial, _) = hub.join();
        assert_eq!(initial.len(), 1);
        hub.publish_snapshot(serde_json::json!({"kind": "snapshot", "n": 1}));
        hub.publish_snapshot(serde_json::json!({"kind": "snapshot", "n": 2}));
        let (initial, mut lines) = hub.join();
        assert_eq!(initial.len(), 2);
        assert!(initial[1].contains("\"n\":2"));
        assert!(initial.iter().all(|l| l.ends_with('\n')));
        hub.broadcast(serde_json::json!({"kind": "arrival"}));
        assert!(lines.try_recv().unwrap().contains("arrival"));
    }

    #[tokio::test]
    async fn a_second_daemon_does_not_steal_a_live_socket() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("control.sock");
        let _first = bind(&path, Mode::User).unwrap();
        assert!(bind(&path, Mode::User).is_err());
    }

    #[tokio::test]
    async fn a_stale_socket_is_replaced_and_the_new_one_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("control.sock");
        drop(bind(&path, Mode::User).unwrap());
        assert!(path.exists());
        let _listener = bind(&path, Mode::User).unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[tokio::test]
    async fn clients_get_the_latest_lines_and_are_dropped_for_anything_but_settings() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("control.sock");
        let listener = bind(&path, Mode::User).unwrap();
        let hub = Arc::new(Hub::new(message::service("test", "running", 0)));
        hub.publish_snapshot(serde_json::json!({"kind": "snapshot"}));
        let (commands, mut requested) = mpsc::channel::<Request>(4);
        tokio::spawn(accept_loop(listener, hub.clone(), commands, Mode::User));
        tokio::spawn(async move {
            while let Some(request) = requested.recv().await {
                let id = request.command.request_id.clone();
                let _ = request.reply.send(message::result("run", &id, true));
            }
        });

        let stream = UnixStream::connect(&path).await.unwrap();
        let (read, mut write) = stream.into_split();
        let mut lines = BufReader::new(read).lines();
        let first = lines.next_line().await.unwrap().unwrap();
        assert!(first.contains("\"kind\":\"service\""));
        let second = lines.next_line().await.unwrap().unwrap();
        assert!(second.contains("\"kind\":\"snapshot\""));
        write
            .write_all(
                b"{\"protocol\":2,\"kind\":\"settings\",\"requestId\":\"r1\",\"telemetry\":false,\"keepAwake\":true}\n",
            )
            .await
            .unwrap();
        let reply = lines.next_line().await.unwrap().unwrap();
        assert!(reply.contains("\"requestId\":\"r1\"") && reply.contains("\"ok\":true"));

        write.write_all(b"{\"kind\":\"claim\"}\n").await.unwrap();
        let closed = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                match lines.next_line().await {
                    Ok(Some(_)) => continue,
                    _ => break,
                }
            }
        })
        .await;
        assert!(
            closed.is_ok(),
            "an invalid command must close the connection"
        );
    }
}
