//! The command line.

use std::path::PathBuf;

use clap::{Parser, Subcommand, ValueEnum};

use crate::paths::Mode;
use crate::{client, daemon, install, VERSION};

#[derive(Parser)]
#[command(
    name = "streetcryptid-repeater",
    version = VERSION,
    about = "Carry friends' encrypted streetCryptid locations from this machine.",
    long_about = "Carry friends' encrypted streetCryptid locations from this machine.\n\n\
        A repeater holds ciphertext it cannot read, in memory only, for the people its owner's \
        phone puts on its roster. Start one with `run`, claim it by scanning `claim` with the \
        owner's phone, and keep it running with `install`."
)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Clone, Copy, ValueEnum)]
enum Switch {
    On,
    Off,
}

impl From<Switch> for bool {
    fn from(value: Switch) -> bool {
        matches!(value, Switch::On)
    }
}

#[derive(Subcommand)]
enum Commands {
    /// Run the repeater in the foreground (what the daemon runs). Shows the claim QR when run at a
    /// terminal; stops on Ctrl-C or SIGTERM.
    Run {
        /// Whose repeater this is: the person running it, or the machine's system service.
        #[arg(long, value_enum, default_value = "user")]
        mode: Mode,
        /// Where the identity, roster, grants and settings live.
        #[arg(long)]
        state_dir: Option<PathBuf>,
        /// Where to serve the management socket.
        #[arg(long)]
        socket: Option<PathBuf>,
    },
    /// What the running repeater is doing.
    Status {
        /// Print the raw snapshot (the Windows app's line protocol) instead.
        #[arg(long)]
        json: bool,
        #[arg(long)]
        socket: Option<PathBuf>,
    },
    /// Show the claim QR for the owner's phone to scan, renewing it until the repeater is claimed.
    Claim {
        /// Print the current code once and return.
        #[arg(long)]
        once: bool,
        /// Print the link alone, without the QR (it is a one-time secret: do not log it).
        #[arg(long)]
        link: bool,
        #[arg(long)]
        socket: Option<PathBuf>,
    },
    /// Show or change this machine's choices: diagnostics and keeping the machine awake.
    Settings {
        /// Send diagnostics (never a location) to the streetCryptid developers.
        #[arg(long, value_enum)]
        telemetry: Option<Switch>,
        /// Hold off sleep while on mains power.
        #[arg(long, value_enum)]
        keep_awake: Option<Switch>,
        #[arg(long)]
        socket: Option<PathBuf>,
    },
    /// Show redacted connection settings, or save a JSON file (restart to apply).
    Network {
        /// Read settings from this file, or "-" for stdin. Keys never go in command arguments.
        #[arg(long)]
        file: Option<PathBuf>,
        #[arg(long)]
        socket: Option<PathBuf>,
    },
    /// Show this machine's name, or name it ("Living room PC"); phones show it once the owner's
    /// phone picks it up.
    Name {
        /// The new name, at most 40 characters.
        #[arg(conflicts_with = "clear")]
        name: Option<String>,
        /// Remove the name.
        #[arg(long)]
        clear: bool,
        #[arg(long)]
        socket: Option<PathBuf>,
    },
    /// Release the repeater from its owner: it stops carrying everyone and shows a new claim code.
    /// The identity is kept.
    Release {
        /// Release without asking: it cannot be undone from this machine.
        #[arg(long)]
        yes: bool,
        #[arg(long)]
        socket: Option<PathBuf>,
    },
    /// Print every message the repeater sends, one JSON object per line.
    Watch {
        #[arg(long)]
        socket: Option<PathBuf>,
    },
    /// Keep the repeater running as a systemd daemon (opt in): for you, or with --system for the
    /// whole machine, from boot.
    Install {
        /// The machine's repeater (needs root): its own account, started at boot. Moves your
        /// identity into it.
        #[arg(long)]
        system: bool,
        /// Keep a per-user daemon running after you sign out.
        #[arg(long)]
        linger: bool,
        /// With --system: move the identity from this state directory (default: the sudo user's).
        #[arg(long, conflicts_with = "no_move")]
        move_from: Option<PathBuf>,
        /// With --system: start with the service's own identity rather than moving yours.
        #[arg(long)]
        no_move: bool,
        /// With --system: who may manage it without sudo (default: the sudo user).
        #[arg(long)]
        admin: Option<String>,
        /// Send diagnostics (off unless you say so).
        #[arg(long, value_enum)]
        telemetry: Option<Switch>,
        /// Hold off sleep while on mains power.
        #[arg(long, value_enum)]
        keep_awake: Option<Switch>,
        /// Install and enable, but do not start it now.
        #[arg(long)]
        no_start: bool,
    },
    /// Stop and remove the daemon. The identity is kept: a later `run` or `install` is the same,
    /// claimed repeater.
    Uninstall {
        /// Remove the machine's repeater (needs root) and move its identity back to the sudo user.
        #[arg(long)]
        system: bool,
        /// With --system: move the identity to this directory instead.
        #[arg(long, conflicts_with = "keep_state")]
        move_to: Option<PathBuf>,
        /// With --system: leave the identity in /var/lib/streetcryptid-repeater.
        #[arg(long)]
        keep_state: bool,
    },
}

pub fn main() -> i32 {
    let cli = Cli::parse();
    let result = match cli.command {
        Commands::Run {
            mode,
            state_dir,
            socket,
        } => daemon::run(daemon::RunArgs {
            mode,
            state_dir,
            socket,
        }),
        Commands::Install {
            system,
            linger,
            move_from,
            no_move,
            admin,
            telemetry,
            keep_awake,
            no_start,
        } => install::install(install::InstallArgs {
            system,
            linger,
            move_from,
            no_move,
            admin,
            telemetry: telemetry.map(Into::into),
            keep_awake: keep_awake.map(Into::into),
            no_start,
        }),
        Commands::Uninstall {
            system,
            move_to,
            keep_state,
        } => install::uninstall(install::UninstallArgs {
            system,
            move_to,
            keep_state,
        }),
        command => client_command(command),
    };
    match result {
        Ok(()) => 0,
        Err(error) => {
            // Our own message, not the chain under it: a dependency's error may carry a ticket or
            // a peer address, and this goes to a terminal or the journal.
            eprintln!("streetcryptid-repeater: {error}");
            1
        }
    }
}

fn client_command(command: Commands) -> anyhow::Result<()> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    runtime.block_on(async {
        match command {
            Commands::Status { json, socket } => client::status(socket, json).await,
            Commands::Network { file, socket } => client::network(socket, file).await,
            Commands::Claim { once, link, socket } => client::claim(socket, once, link).await,
            Commands::Settings {
                telemetry,
                keep_awake,
                socket,
            } => {
                client::settings(
                    socket,
                    telemetry.map(Into::into),
                    keep_awake.map(Into::into),
                )
                .await
            }
            Commands::Name {
                name,
                clear,
                socket,
            } => client::name(socket, if clear { Some(String::new()) } else { name }).await,
            Commands::Release { yes, socket } => client::release(socket, yes).await,
            Commands::Watch { socket } => client::watch(socket).await,
            _ => unreachable!("handled in main"),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;

    #[test]
    fn the_command_line_is_well_formed() {
        Cli::command().debug_assert();
    }
}
