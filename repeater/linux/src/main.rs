//! `streetcryptid-repeater` — the streetCryptid repeater for Linux.
//!
//! One binary is the daemon (`run`) and every way of managing it (`status`, `claim`, `settings`,
//! `watch`, `install`, `uninstall`). The daemon embeds the same node the Windows host does
//! (`repeater/host`, on the server crate's `Storage::MemoryRepeater`) and serves the Windows
//! management plane's line protocol on a Unix socket instead of a named pipe: a `service` line, the
//! latest snapshot, then snapshots and arrivals; the one command it takes is `settings`. README.md
//! has the whole picture.

#[cfg(target_os = "linux")]
mod cli;
#[cfg(target_os = "linux")]
mod client;
#[cfg(target_os = "linux")]
mod daemon;
#[cfg(target_os = "linux")]
mod install;
#[cfg(target_os = "linux")]
mod migrate;
#[cfg(target_os = "linux")]
mod paths;
#[cfg(target_os = "linux")]
mod power;
#[cfg(target_os = "linux")]
mod qr;

/// The release version, stamped by the release workflow; a local build reports the crate's.
pub const VERSION: &str = match option_env!("REPEATER_VERSION") {
    Some(version) => version,
    None => env!("CARGO_PKG_VERSION"),
};

/// Where diagnostics go, fixed when the binary is built. Without it the exporter is never built
/// and no setting can turn it on; with it, nothing is sent until the person running the repeater
/// says yes (`settings --telemetry on`).
pub const TELEMETRY_ENDPOINT: Option<&str> = option_env!("SC_REPEATER_OTEL_ENDPOINT");

#[cfg(target_os = "linux")]
fn main() {
    std::process::exit(cli::main());
}

#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("streetcryptid-repeater is the Linux repeater; on Windows use the Windows repeater.");
    std::process::exit(2);
}
