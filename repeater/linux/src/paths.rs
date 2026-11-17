//! Where a repeater keeps its state and where it listens.
//!
//! Two installations, the Windows repeater's two modes:
//!
//! | mode      | state                                   | control socket                                          |
//! | --------- | --------------------------------------- | ------------------------------------------------------- |
//! | `user`    | `$XDG_STATE_HOME/streetcryptid/repeater` | `$XDG_RUNTIME_DIR/streetcryptid-repeater/control.sock`  |
//! | `service` | `/var/lib/streetcryptid-repeater`        | `/run/streetcryptid-repeater/control.sock`              |
//!
//! The state directory holds only what makes this the same repeater (the identity, the signed
//! roster, the grants, the settings); what it carries is in memory. The socket is the management
//! plane, and the claim link travels over it, so it is never world-accessible: the user socket is
//! in a 0700 directory, the service's is 0660 to the service's group.

use std::path::{Path, PathBuf};

use anyhow::{bail, Result};

pub const SERVICE_NAME: &str = "streetcryptid-repeater";
/// The account the system service runs as, and the group whose members may manage it.
pub const SYSTEM_USER: &str = "streetcryptid-repeater";
pub const SYSTEM_STATE_DIR: &str = "/var/lib/streetcryptid-repeater";
pub const SYSTEM_RUNTIME_DIR: &str = "/run/streetcryptid-repeater";
pub const SOCKET_NAME: &str = "control.sock";
/// Overrides every other way of finding the socket, for the CLI.
pub const SOCKET_ENV: &str = "STREETCRYPTID_REPEATER_SOCKET";

#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
pub enum Mode {
    /// Run by and for the person signed in (a terminal, or a `systemctl --user` unit).
    User,
    /// Run by the system unit as its own account, before and after anyone signs in.
    Service,
}

impl Mode {
    pub fn name(self) -> &'static str {
        match self {
            Mode::User => "user",
            Mode::Service => "service",
        }
    }
}

fn env_dir(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
}

/// `$XDG_STATE_HOME/streetcryptid/repeater`, else `~/.local/state/streetcryptid/repeater`.
pub fn user_state_dir() -> Result<PathBuf> {
    if let Some(state) = env_dir("XDG_STATE_HOME") {
        return Ok(state.join("streetcryptid").join("repeater"));
    }
    match env_dir("HOME") {
        Some(home) => Ok(home.join(".local/state/streetcryptid/repeater")),
        None => bail!("Neither XDG_STATE_HOME nor HOME is set; pass --state-dir"),
    }
}

/// `$XDG_RUNTIME_DIR/streetcryptid-repeater`, when the session has one.
pub fn user_runtime_dir() -> Option<PathBuf> {
    env_dir("XDG_RUNTIME_DIR").map(|dir| dir.join(SERVICE_NAME))
}

pub fn default_state_dir(mode: Mode) -> Result<PathBuf> {
    match mode {
        Mode::User => user_state_dir(),
        Mode::Service => Ok(PathBuf::from(SYSTEM_STATE_DIR)),
    }
}

/// Where a daemon listens unless told otherwise. A user session without a runtime directory
/// (a bare `su`, some containers) keeps the socket beside the state, which is private too.
pub fn default_socket(mode: Mode, state_dir: &Path) -> PathBuf {
    match mode {
        Mode::Service => Path::new(SYSTEM_RUNTIME_DIR).join(SOCKET_NAME),
        Mode::User => user_runtime_dir()
            .unwrap_or_else(|| state_dir.to_path_buf())
            .join(SOCKET_NAME),
    }
}

/// Every place a running repeater might be listening, in the order the CLI tries them: the
/// person's own repeater first, then the machine's.
pub fn socket_candidates() -> Vec<PathBuf> {
    if let Some(explicit) = env_dir(SOCKET_ENV) {
        return vec![explicit];
    }
    let mut candidates = Vec::new();
    if let Some(runtime) = user_runtime_dir() {
        candidates.push(runtime.join(SOCKET_NAME));
    }
    if let Ok(state) = user_state_dir() {
        candidates.push(state.join(SOCKET_NAME));
    }
    candidates.push(Path::new(SYSTEM_RUNTIME_DIR).join(SOCKET_NAME));
    candidates
}
