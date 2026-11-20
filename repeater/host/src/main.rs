use std::io::{BufRead, Read, Write};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{bail, Result};
use streetcryptid_repeater_host::{
    claim_directory, identity, init_telemetry, message, read_name, run_pulse, snapshot, start,
    write_name, Action, Command, HostInfo, PulseInfo, Settings, MAX_COMMAND_LINE, SERVICE_MARKER,
};
use trail_stash::config::{DEFAULT_PEER_SYNC_INTERVAL_MIN, DEFAULT_PRUNE_INTERVAL_MIN};

const OUTPUT_CAPACITY: usize = 64;

/// The release version, stamped by `build.ps1`; a local build reports the crate's.
const VERSION: &str = match option_env!("REPEATER_VERSION") {
    Some(version) => version,
    None => env!("CARGO_PKG_VERSION"),
};

/// Where diagnostics go, fixed when the binary is built. Without it the exporter is never built
/// and no setting can turn it on; with it, nothing is sent until the person running the repeater
/// says yes.
const TELEMETRY_ENDPOINT: Option<&str> = option_env!("SC_REPEATER_OTEL_ENDPOINT");

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    /// Started by the desktop app for the person signed in; lives as long as the app does.
    User,
    /// Started by the Windows service, before and after anyone signs in.
    Service,
}

impl Mode {
    fn name(self) -> &'static str {
        match self {
            Mode::User => "user",
            Mode::Service => "service",
        }
    }
}

#[derive(Debug)]
struct Args {
    state_dir: PathBuf,
    mode: Mode,
}

fn parse_args(mut args: impl Iterator<Item = std::ffi::OsString>) -> Result<Args> {
    let mut state_dir = None;
    let mut mode = Mode::User;
    while let Some(arg) = args.next() {
        match arg.to_str() {
            Some("--state-dir") if state_dir.is_none() => {
                state_dir = Some(PathBuf::from(
                    args.next()
                        .ok_or_else(|| anyhow::anyhow!("Missing directory"))?,
                ));
            }
            Some("--mode") => {
                mode = match args.next().as_deref().and_then(|m| m.to_str()) {
                    Some("user") => Mode::User,
                    Some("service") => Mode::Service,
                    _ => bail!("Unknown mode"),
                };
            }
            _ => bail!("Unexpected arguments"),
        }
    }
    Ok(Args {
        state_dir: state_dir.ok_or_else(|| anyhow::anyhow!("Expected --state-dir"))?,
        mode,
    })
}

fn spawn_output<W: Write + Send + 'static>(
    mut out: W,
) -> (
    std::sync::mpsc::SyncSender<serde_json::Value>,
    std::thread::JoinHandle<()>,
) {
    let (writer, messages) = std::sync::mpsc::sync_channel(OUTPUT_CAPACITY);
    let worker = std::thread::spawn(move || {
        for message in messages {
            if serde_json::to_writer(&mut out, &message).is_err()
                || writeln!(out).is_err()
                || out.flush().is_err()
            {
                break;
            }
        }
    });
    (writer, worker)
}

fn main() {
    let code = match run() {
        Ok(()) => 0,
        Err(_) => {
            // Never send a key, ticket, path, or dependency error to logs.
            eprintln!("Repeater could not start or lost its desktop connection. Check its state directory and network, then retry.");
            1
        }
    };
    trail_stash::telemetry::shutdown();
    std::process::exit(code);
}

fn run() -> Result<()> {
    let args = parse_args(std::env::args_os().skip(1))?;
    if args.mode == Mode::User && args.state_dir.join(SERVICE_MARKER).exists() {
        bail!("This repeater's identity belongs to the Windows service");
    }
    let _lock = claim_directory(&args.state_dir)?;
    let secret = identity(&args.state_dir)?;
    let settings = Arc::new(Settings::open(&args.state_dir));
    // Before the runtime exists: the exporter reads its endpoint from the environment, and no
    // other thread may be running while it is written.
    init_telemetry(TELEMETRY_ENDPOINT, &secret, settings.telemetry_flag());
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    let result = runtime.block_on(serve(args, secret, settings));
    runtime.shutdown_timeout(Duration::from_secs(5));
    result
}

async fn serve(args: Args, secret: iroh::SecretKey, settings: Arc<Settings>) -> Result<()> {
    let dir = args.state_dir.clone();
    let mode = args.mode;
    // EOF on the inherited pipe stops the node even if the UI (or the service) crashes.
    let (stop, mut stopped) = tokio::sync::mpsc::channel(1);
    let (commands, mut requested) = tokio::sync::mpsc::channel::<Command>(16);
    std::thread::spawn(move || {
        let mut input = std::io::stdin().lock();
        loop {
            let mut line = Vec::new();
            if !matches!(
                (&mut input)
                    .take(MAX_COMMAND_LINE as u64 + 1)
                    .read_until(b'\n', &mut line),
                Ok(1..=MAX_COMMAND_LINE)
            ) || line.last() != Some(&b'\n')
            {
                break;
            }
            let Ok(command) = serde_json::from_slice::<Command>(&line) else {
                break;
            };
            if command.action().is_err() || commands.try_send(command).is_err() {
                break;
            }
        }
        let _ = stop.blocking_send(());
    });

    let started_at = Instant::now();
    let node = tokio::select! {
        result = start(&dir, secret) => result?,
        _ = stopped.recv() => return Ok(()),
    };
    if let Some(repeater) = node.repeater() {
        repeater.set_name(read_name(&dir).as_deref());
    }
    let power = power::KeepAwake::spawn(settings.keep_awake_flag());
    // Spans, not events: Loki keeps an event's message and drops its fields.
    drop(tracing::info_span!(
        "repeater.host.start",
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
            platform: std::env::consts::OS,
            mode: mode.name(),
            version: VERSION,
        },
        power.clone(),
        started_at,
    ));
    let run_id = streetcryptid_repeater_host::run_id();
    let mut arrivals = node.subscribe_arrivals();
    let (writer, _worker) = spawn_output(std::io::stdout());
    let mut interval = tokio::time::interval(Duration::from_secs(2));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let info = || HostInfo {
        version: VERSION,
        mode: mode.name(),
        settings: settings.get(),
        telemetry_available: TELEMETRY_ENDPOINT.is_some_and(|e| !e.trim().is_empty()),
        keep_awake_held: streetcryptid_repeater_host::PowerState::holding(&*power),
    };
    loop {
        let message = tokio::select! {
            _ = stopped.recv() => break,
            Some(command) = requested.recv() => {
                let ok = match command.action() {
                    Ok(Action::Settings(next)) => settings.set(next).is_ok(),
                    Ok(Action::Name(name)) => match (write_name(&dir, Some(&name)), node.repeater()) {
                        (Ok(kept), Some(repeater)) => {
                            repeater.set_name(kept.as_deref());
                            true
                        }
                        _ => false,
                    },
                    Ok(Action::Release) => match node.repeater() {
                        Some(repeater) => repeater.release().await.is_ok(),
                        None => false,
                    },
                    Err(_) => false,
                };
                // Command replies must not be silently dropped like decorative arrival events.
                let reply = message::result(&run_id, &command.request_id, ok);
                if writer.try_send(reply).is_err() { break; }
                message::snapshot(&run_id, &snapshot(&node, info()))
            }
            _ = interval.tick() => {
                message::snapshot(&run_id, &snapshot(&node, info()))
            }
            arrival = arrivals.recv() => {
                match arrival {
                    Ok(sequence) => message::arrival(&run_id, sequence),
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => break,
                }
            }
        };
        match writer.try_send(message) {
            Ok(()) | Err(std::sync::mpsc::TrySendError::Full(_)) => {}
            Err(std::sync::mpsc::TrySendError::Disconnected(_)) => break,
        }
    }
    drop(tracing::info_span!(
        "repeater.host.stop",
        host.mode = mode.name(),
        uptime_s = started_at.elapsed().as_secs(),
    ));
    pulse.abort();
    prune.abort();
    siblings.abort();
    let _ = tokio::time::timeout(Duration::from_secs(5), node.shutdown()).await;
    Ok(())
}

/// Keeping the machine awake while it is on mains power. A repeater that sleeps carries nothing,
/// and Windows puts an idle desktop to sleep after minutes; on battery the person's battery wins.
mod power {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    pub struct KeepAwake {
        on_ac: AtomicBool,
        holding: AtomicBool,
    }

    impl streetcryptid_repeater_host::PowerState for KeepAwake {
        fn on_ac(&self) -> bool {
            self.on_ac.load(Ordering::Relaxed)
        }

        fn holding(&self) -> bool {
            self.holding.load(Ordering::Relaxed)
        }
    }

    impl KeepAwake {
        /// `SetThreadExecutionState` binds the request to the calling thread, so one thread owns
        /// it for the life of the process and re-evaluates every half minute.
        pub fn spawn(wanted: Arc<AtomicBool>) -> Arc<Self> {
            let state = Arc::new(Self {
                on_ac: AtomicBool::new(sys::on_ac()),
                holding: AtomicBool::new(false),
            });
            let shared = state.clone();
            std::thread::spawn(move || loop {
                let on_ac = sys::on_ac();
                let hold = wanted.load(Ordering::Relaxed) && on_ac;
                shared.on_ac.store(on_ac, Ordering::Relaxed);
                if hold != shared.holding.load(Ordering::Relaxed) {
                    shared
                        .holding
                        .store(sys::hold_awake(hold), Ordering::Relaxed);
                }
                std::thread::sleep(Duration::from_secs(30));
            });
            state
        }
    }

    #[cfg(windows)]
    mod sys {
        #[repr(C)]
        #[derive(Default)]
        struct SystemPowerStatus {
            ac_line_status: u8,
            battery_flag: u8,
            battery_life_percent: u8,
            system_status_flag: u8,
            battery_life_time: u32,
            battery_full_life_time: u32,
        }

        #[link(name = "kernel32")]
        extern "system" {
            fn GetSystemPowerStatus(status: *mut SystemPowerStatus) -> i32;
            fn SetThreadExecutionState(flags: u32) -> u32;
        }

        const ES_CONTINUOUS: u32 = 0x8000_0000;
        const ES_SYSTEM_REQUIRED: u32 = 0x0000_0001;

        /// A desktop without a battery reports "online"; only an explicit "offline" is battery.
        pub fn on_ac() -> bool {
            let mut status = SystemPowerStatus::default();
            // SAFETY: a valid, writable SYSTEM_POWER_STATUS for the duration of the call.
            let ok = unsafe { GetSystemPowerStatus(&mut status) } != 0;
            !ok || status.ac_line_status != 0
        }

        pub fn hold_awake(hold: bool) -> bool {
            let flags = if hold {
                ES_CONTINUOUS | ES_SYSTEM_REQUIRED
            } else {
                ES_CONTINUOUS
            };
            // SAFETY: plain flags; the request belongs to the calling thread.
            let success = unsafe { SetThreadExecutionState(flags) } != 0;
            hold && success
        }
    }

    #[cfg(target_os = "macos")]
    #[path = "macos.rs"]
    mod sys;

    #[cfg(not(any(windows, target_os = "macos")))]
    mod sys {
        pub fn on_ac() -> bool {
            true
        }
        pub fn hold_awake(_: bool) -> bool {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::{channel, Receiver, Sender, TrySendError};

    fn args(list: &[&str]) -> Result<Args> {
        parse_args(list.iter().map(std::ffi::OsString::from))
    }

    #[test]
    fn arguments_name_a_directory_and_an_optional_mode() {
        let parsed = args(&["--state-dir", "C:\\state"]).unwrap();
        assert_eq!(parsed.state_dir, PathBuf::from("C:\\state"));
        assert_eq!(parsed.mode, Mode::User);
        let parsed = args(&["--state-dir", "C:\\state", "--mode", "service"]).unwrap();
        assert_eq!(parsed.mode, Mode::Service);
        assert!(args(&[]).is_err());
        assert!(args(&["--state-dir"]).is_err());
        assert!(args(&["--state-dir", "a", "--state-dir", "b"]).is_err());
        assert!(args(&["--state-dir", "a", "--mode", "admin"]).is_err());
        assert!(args(&["--state-dir", "a", "extra"]).is_err());
    }

    struct PausedOutput {
        entered: Option<Sender<()>>,
        resume: Receiver<()>,
    }

    impl Write for PausedOutput {
        fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
            if let Some(entered) = self.entered.take() {
                entered.send(()).unwrap();
                self.resume.recv().unwrap();
            }
            Ok(data.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn stalled_ui_cannot_block_or_grow_the_output_queue() {
        let (entered, waiting) = channel();
        let (resume, paused) = channel();
        let (writer, worker) = spawn_output(PausedOutput {
            entered: Some(entered),
            resume: paused,
        });
        writer.try_send(serde_json::json!({"protocol": 2})).unwrap();
        waiting.recv_timeout(Duration::from_secs(2)).unwrap();
        for _ in 0..OUTPUT_CAPACITY {
            writer.try_send(serde_json::json!({"sequence": 1})).unwrap();
        }
        assert!(matches!(
            writer.try_send(serde_json::Value::Null),
            Err(TrySendError::Full(_))
        ));
        drop(writer);
        resume.send(()).unwrap();
        worker.join().unwrap();
    }

    #[test]
    fn closed_pipe_disconnects_the_writer() {
        struct Closed;
        impl Write for Closed {
            fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
                Err(std::io::ErrorKind::BrokenPipe.into())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let (writer, worker) = spawn_output(Closed);
        writer.try_send(serde_json::Value::Null).unwrap();
        worker.join().unwrap();
        assert!(matches!(
            writer.try_send(serde_json::Value::Null),
            Err(TrySendError::Disconnected(_))
        ));
    }
}
