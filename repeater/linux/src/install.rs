//! `install` and `uninstall`: the opt-in daemon, as a systemd unit.
//!
//! Nothing runs in the background until someone asks for it. `install` (as a person) writes a
//! `systemctl --user` unit that runs while they are signed in, or after they sign out with
//! `--linger`; `sudo … install --system` makes it the machine's, the Windows service's
//! equivalent:
//!
//! - the binary is copied to `/usr/local/lib/streetcryptid-repeater/` and run from there, never
//!   from wherever it was downloaded, which its owner could replace under the service account;
//! - it runs as its own system account, `streetcryptid-repeater`, with no capabilities and a
//!   sandbox (`ProtectSystem=strict`, `ProtectHome`, `NoNewPrivileges`, …), started at boot;
//! - the state lives in `/var/lib/streetcryptid-repeater` (0700), the control socket in
//!   `/run/streetcryptid-repeater` (0750, socket 0660): root and members of the account's group
//!   manage it, and `install` adds the person who ran sudo to that group;
//! - the identity **moves** from the person's own state directory, and that directory is marked so
//!   a per-user daemon can never mint a second identity there (`migrate.rs`). `uninstall --system`
//!   moves it back.
//!
//! Re-running `install` updates the installed binary and restarts the daemon: the Windows app's
//! **Update service**.

use std::ffi::{CStr, CString};
use std::io::IsTerminal;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{bail, Context, Result};
use streetcryptid_repeater_host::{HostSettings, Settings, SERVICE_MARKER};

use crate::migrate::{self, Moved};
use crate::paths::{self, SERVICE_NAME, SYSTEM_STATE_DIR, SYSTEM_USER};

const SYSTEM_LIB_DIR: &str = "/usr/local/lib/streetcryptid-repeater";
const SYSTEM_UNIT: &str = "/etc/systemd/system/streetcryptid-repeater.service";
const POLKIT_RULES_DIR: &str = "/etc/polkit-1/rules.d";
const POLKIT_RULE: &str = "/etc/polkit-1/rules.d/50-streetcryptid-repeater.rules";

/// logind lets an unprivileged account hold off sleep only from an active session; the service's
/// account has none, so without this `settings --keep-awake on` is a setting the system refuses
/// (and `status` says so). It grants that one account the sleep inhibitor and nothing else.
pub fn polkit_rule() -> String {
    [
        "// Installed by `streetcryptid-repeater install --system` so the repeater's own account may",
        "// hold off sleep while on mains power (`settings --keep-awake on`). Removed by",
        "// `uninstall --system`.",
        "polkit.addRule(function (action, subject) {",
        "  if (action.id == \"org.freedesktop.login1.inhibit-block-sleep\" &&",
        &format!("      subject.user == \"{SYSTEM_USER}\") {{"),
        "    return polkit.Result.YES;",
        "  }",
        "});",
        "",
    ]
    .join("\n")
}

const BINARY: &str = "streetcryptid-repeater";

pub struct InstallArgs {
    pub system: bool,
    pub linger: bool,
    pub move_from: Option<PathBuf>,
    pub no_move: bool,
    pub admin: Option<String>,
    pub telemetry: Option<bool>,
    pub keep_awake: Option<bool>,
    pub no_start: bool,
}

pub struct UninstallArgs {
    pub system: bool,
    pub move_to: Option<PathBuf>,
    pub keep_state: bool,
}

pub struct User {
    pub name: String,
    pub uid: u32,
    pub gid: u32,
    pub home: PathBuf,
}

/// The passwd entry for `name`.
pub fn lookup_user(name: &str) -> Option<User> {
    let name_c = CString::new(name).ok()?;
    // SAFETY: getpwnam returns a pointer to static storage or null; we copy out of it at once and
    // the CLI is single-threaded here.
    unsafe {
        let entry = libc::getpwnam(name_c.as_ptr());
        if entry.is_null() {
            return None;
        }
        let entry = &*entry;
        Some(User {
            name: name.to_string(),
            uid: entry.pw_uid,
            gid: entry.pw_gid,
            home: PathBuf::from(CStr::from_ptr(entry.pw_dir).to_string_lossy().into_owned()),
        })
    }
}

fn is_root() -> bool {
    // SAFETY: geteuid cannot fail.
    unsafe { libc::geteuid() == 0 }
}

/// The person behind `sudo`, if there is one and it is not root itself.
fn sudo_user() -> Option<User> {
    std::env::var("SUDO_USER")
        .ok()
        .filter(|name| name != "root")
        .and_then(|name| lookup_user(&name))
}

/// A person's default state directory, read from their passwd entry rather than our environment
/// (which under sudo is root's).
fn default_user_state(user: &User) -> PathBuf {
    user.home.join(".local/state/streetcryptid/repeater")
}

fn run(program: &str, args: &[&str]) -> Result<()> {
    let status = Command::new(program)
        .args(args)
        .status()
        .with_context(|| format!("running {program}"))?;
    if !status.success() {
        bail!("`{program} {}` failed ({status})", args.join(" "));
    }
    Ok(())
}

fn systemctl(user: bool, args: &[&str]) -> Result<()> {
    let mut all = Vec::with_capacity(args.len() + 1);
    if user {
        all.push("--user");
    }
    all.extend_from_slice(args);
    run("systemctl", &all)
}

/// Copy this binary to `dir` (atomically, 0755) unless it is already running from there.
fn install_binary(dir: &Path) -> Result<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    let target = dir.join(BINARY);
    let current = std::env::current_exe()
        .context("finding this binary")?
        .canonicalize()?;
    if target.canonicalize().ok().as_deref() == Some(current.as_path()) {
        return Ok(target);
    }
    std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o755))?;
    let staging = dir.join(format!(".{BINARY}.tmp"));
    let _ = std::fs::remove_file(&staging);
    std::fs::copy(&current, &staging)
        .with_context(|| format!("copying {} to {}", current.display(), dir.display()))?;
    std::fs::set_permissions(&staging, std::fs::Permissions::from_mode(0o755))?;
    std::fs::File::open(&staging)?.sync_all()?;
    std::fs::rename(&staging, &target)?;
    Ok(target)
}

fn write_file(path: &Path, contents: &str, mode: u32) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let staging = path.with_extension("tmp");
    std::fs::write(&staging, contents).with_context(|| format!("writing {}", path.display()))?;
    std::fs::set_permissions(&staging, std::fs::Permissions::from_mode(mode))?;
    std::fs::rename(&staging, path)?;
    Ok(())
}

/// Record the person's choices before the daemon reads them; unspecified ones keep their value,
/// and a fresh state directory starts from "nothing leaves this machine".
fn apply_settings(dir: &Path, telemetry: Option<bool>, keep_awake: Option<bool>) -> Result<()> {
    if telemetry.is_none() && keep_awake.is_none() {
        return Ok(());
    }
    migrate::create_private_dir(dir)?;
    let settings = Settings::open(dir);
    let current = settings.get();
    settings
        .set(HostSettings {
            telemetry: telemetry.unwrap_or(current.telemetry),
            keep_awake: keep_awake.unwrap_or(current.keep_awake),
        })
        .context("saving the repeater's settings")
}

/// True when the repeater in `dir` is running: it holds `host.lock`.
fn is_running(dir: &Path) -> bool {
    use std::os::fd::AsRawFd;
    let Ok(file) = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(dir.join("host.lock"))
    else {
        return false;
    };
    // SAFETY: a valid fd for the duration of the call; the lock (if taken) is released when
    // `file` closes at the end of this function.
    unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) != 0 }
}

pub fn unit_text(exe: &Path, mode: paths::Mode, state_dir: &Path) -> String {
    let common = format!(
        "[Unit]\n\
         Description=streetCryptid repeater\n\
         Documentation=https://github.com/unrealJune/streetCryptid/tree/main/repeater/linux\n\
         Wants=network-online.target\n\
         After=network-online.target\n\
         \n\
         [Service]\n\
         Type=notify\n\
         NotifyAccess=main\n\
         ExecStart={exe} run --mode {mode} --state-dir {state}\n\
         Restart=on-failure\n\
         RestartSec=2s\n\
         RestartSteps=5\n\
         RestartMaxDelaySec=5min\n\
         TimeoutStartSec=90s\n\
         TimeoutStopSec=20s\n",
        exe = exe.display(),
        mode = mode.name(),
        state = state_dir.display(),
    );
    match mode {
        paths::Mode::User => format!("{common}\n[Install]\nWantedBy=default.target\n"),
        paths::Mode::Service => format!(
            "{common}\
             User={SYSTEM_USER}\n\
             Group={SYSTEM_USER}\n\
             StateDirectory={SERVICE_NAME}\n\
             StateDirectoryMode=0700\n\
             RuntimeDirectory={SERVICE_NAME}\n\
             RuntimeDirectoryMode=0750\n\
             UMask=0077\n\
             NoNewPrivileges=yes\n\
             CapabilityBoundingSet=\n\
             AmbientCapabilities=\n\
             ProtectSystem=strict\n\
             ProtectHome=yes\n\
             PrivateTmp=yes\n\
             PrivateDevices=yes\n\
             ProtectKernelTunables=yes\n\
             ProtectKernelModules=yes\n\
             ProtectKernelLogs=yes\n\
             ProtectControlGroups=yes\n\
             ProtectClock=yes\n\
             ProtectHostname=yes\n\
             RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK\n\
             RestrictNamespaces=yes\n\
             RestrictRealtime=yes\n\
             RestrictSUIDSGID=yes\n\
             LockPersonality=yes\n\
             MemoryDenyWriteExecute=yes\n\
             SystemCallArchitectures=native\n\
             \n\
             [Install]\n\
             WantedBy=multi-user.target\n"
        ),
    }
}

fn require_systemd() -> Result<()> {
    if !Path::new("/run/systemd/system").exists() {
        bail!(
            "systemd is not running here, so there is nothing to install into. Run \
             `streetcryptid-repeater run` under your own supervisor instead (it stops cleanly on \
             SIGTERM and keeps everything it needs in --state-dir)."
        );
    }
    Ok(())
}

pub fn install(args: InstallArgs) -> Result<()> {
    require_systemd()?;
    if args.system {
        install_system(args)
    } else if is_root() {
        bail!("As root, install the machine's repeater with `install --system`.")
    } else {
        install_user(args)
    }
}

fn user_unit_path() -> Result<PathBuf> {
    let config = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
        .context("HOME is not set")?;
    Ok(config
        .join("systemd/user")
        .join(format!("{SERVICE_NAME}.service")))
}

fn user_lib_dir() -> Result<PathBuf> {
    let home = std::env::var_os("HOME").context("HOME is not set")?;
    Ok(PathBuf::from(home).join(".local/lib").join(SERVICE_NAME))
}

fn install_user(args: InstallArgs) -> Result<()> {
    if args.move_from.is_some() || args.admin.is_some() {
        bail!("--move-from and --admin are for `install --system`");
    }
    if Command::new("systemctl")
        .args(["--user", "show-environment"])
        .output()
        .map(|o| !o.status.success())
        .unwrap_or(true)
    {
        bail!(
            "There is no systemd user session to install into (common over plain `su` or in \
             containers). Sign in normally, or use `sudo streetcryptid-repeater install --system`."
        );
    }
    let state = paths::user_state_dir()?;
    if state.join(SERVICE_MARKER).exists() {
        bail!(
            "This account's repeater identity moved to the system service. Manage it with \
             `streetcryptid-repeater status`, or move it back with `sudo streetcryptid-repeater \
             uninstall --system`."
        );
    }
    let exe = install_binary(&user_lib_dir()?)?;
    migrate::create_private_dir(&state)?;
    apply_settings(&state, args.telemetry, args.keep_awake)?;
    write_file(
        &user_unit_path()?,
        &unit_text(&exe, paths::Mode::User, &state),
        0o644,
    )?;
    systemctl(true, &["daemon-reload"])?;
    systemctl(true, &["enable", SERVICE_NAME])?;
    if args.linger {
        let me = std::env::var("USER").unwrap_or_default();
        run("loginctl", &["enable-linger", &me])
            .context("keeping the repeater running after you sign out")?;
    }
    println!(
        "Installed the repeater for this account ({}).",
        exe.display()
    );
    if args.no_start {
        println!("Start it with `systemctl --user start {SERVICE_NAME}`.");
        return Ok(());
    }
    systemctl(true, &["restart", SERVICE_NAME])?;
    if !args.linger {
        println!(
            "It runs while you are signed in. To keep it running after you sign out: \
             `loginctl enable-linger` (or re-run install with --linger)."
        );
    }
    after_start(None)
}

fn install_system(args: InstallArgs) -> Result<()> {
    if !is_root() {
        bail!("Installing the machine's repeater needs root: `sudo streetcryptid-repeater install --system`.");
    }
    if args.linger {
        bail!(
            "--linger is for a per-user install; the system service runs without anyone signed in"
        );
    }
    let account = ensure_account()?;
    let exe = install_binary(Path::new(SYSTEM_LIB_DIR))?;
    let state = PathBuf::from(SYSTEM_STATE_DIR);
    // A running service holds the destination; stop it before anything moves under it.
    let _ = Command::new("systemctl")
        .args(["stop", SERVICE_NAME])
        .stderr(std::process::Stdio::null())
        .status();

    let invoker = sudo_user();
    let source = match (&args.move_from, args.no_move, &invoker) {
        (Some(dir), _, _) => Some(dir.clone()),
        (None, true, _) => None,
        (None, false, Some(user)) => {
            Some(default_user_state(user)).filter(|d| migrate::has_identity(d))
        }
        (None, false, None) => None,
    };
    if let Some(source) = &source {
        if is_running(source) {
            bail!(
                "The repeater in {} is running. Stop it first (Ctrl-C, or `systemctl --user \
                 disable --now {SERVICE_NAME}` as that person), then install again.",
                source.display()
            );
        }
        match migrate::move_state(source, &state)? {
            Moved::Moved => {
                let marker = source.join(SERVICE_MARKER);
                write_file(
                    &marker,
                    "This repeater's identity moved to the system service \
                     (/var/lib/streetcryptid-repeater).\n",
                    0o644,
                )?;
                if let Some(owner) = lookup_owner(source) {
                    let _ = std::os::unix::fs::lchown(&marker, Some(owner.0), Some(owner.1));
                }
                println!(
                    "Moved the repeater identity from {} into the system service.",
                    source.display()
                );
            }
            Moved::Nothing => {}
        }
    }
    migrate::create_private_dir(&state)?;
    apply_settings(&state, args.telemetry, args.keep_awake)?;
    migrate::chown_tree(&state, account.uid, account.gid)?;

    write_file(
        Path::new(SYSTEM_UNIT),
        &unit_text(&exe, paths::Mode::Service, &state),
        0o644,
    )?;
    // Only where polkit's JavaScript rules are read (polkit 0.106 and later); older systems keep
    // the setting and report that it is not held.
    if Path::new(POLKIT_RULES_DIR).is_dir() {
        write_file(Path::new(POLKIT_RULE), &polkit_rule(), 0o644)?;
    }
    systemctl(false, &["daemon-reload"])?;
    systemctl(false, &["enable", SERVICE_NAME])?;

    let admin = args
        .admin
        .clone()
        .or_else(|| invoker.as_ref().map(|u| u.name.clone()));
    if let Some(admin) = admin {
        if lookup_user(&admin).is_none() {
            bail!("There is no account named {admin}");
        }
        run("usermod", &["-a", "-G", SYSTEM_USER, &admin])
            .with_context(|| format!("letting {admin} manage the repeater"))?;
        println!(
            "{admin} may now manage the repeater without sudo (after signing in again: group \
             `{SYSTEM_USER}`)."
        );
    }
    println!("Installed the machine's repeater ({}).", exe.display());
    if args.no_start {
        println!("Start it with `sudo systemctl start {SERVICE_NAME}`.");
        return Ok(());
    }
    systemctl(false, &["restart", SERVICE_NAME])?;
    after_start(Some(
        Path::new(paths::SYSTEM_RUNTIME_DIR).join(paths::SOCKET_NAME),
    ))
}

/// After a start: the status, and the claim QR if nobody has claimed it yet. Only at a terminal.
fn after_start(socket: Option<PathBuf>) -> Result<()> {
    if !std::io::stdout().is_terminal() {
        return Ok(());
    }
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    runtime.block_on(async {
        let mut connection = crate::client::Connection::open(socket.clone()).await?;
        let state = connection.snapshot().await?;
        println!();
        print!("{}", crate::client::describe(&state, &connection.socket));
        if state["claimed"].as_bool() != Some(true) {
            println!();
            crate::client::claim(socket, true, false).await?;
            println!("`streetcryptid-repeater claim` shows a fresh code at any time.");
        }
        Ok(())
    })
}

/// The owner of `path`, for files root writes into someone else's directory.
fn lookup_owner(path: &Path) -> Option<(u32, u32)> {
    use std::os::unix::fs::MetadataExt;
    std::fs::metadata(path).ok().map(|m| (m.uid(), m.gid()))
}

/// The service's own system account (and its group), created on first install.
fn ensure_account() -> Result<User> {
    if let Some(user) = lookup_user(SYSTEM_USER) {
        return Ok(user);
    }
    let shell = ["/usr/sbin/nologin", "/sbin/nologin", "/bin/false"]
        .into_iter()
        .find(|p| Path::new(p).exists())
        .unwrap_or("/bin/false");
    run(
        "useradd",
        &[
            "--system",
            "--user-group",
            "--no-create-home",
            "--home-dir",
            SYSTEM_STATE_DIR,
            "--shell",
            shell,
            "--comment",
            "streetCryptid repeater",
            SYSTEM_USER,
        ],
    )
    .context("creating the repeater's system account")?;
    lookup_user(SYSTEM_USER).context("the repeater's system account was not created")
}

pub fn uninstall(args: UninstallArgs) -> Result<()> {
    require_systemd()?;
    if args.system {
        uninstall_system(args)
    } else if is_root() {
        bail!("As root, remove the machine's repeater with `uninstall --system`.")
    } else {
        uninstall_user()
    }
}

fn uninstall_user() -> Result<()> {
    let unit = user_unit_path()?;
    let _ = systemctl(true, &["disable", "--now", SERVICE_NAME]);
    if unit.exists() {
        std::fs::remove_file(&unit)?;
    }
    let _ = systemctl(true, &["daemon-reload"]);
    let lib = user_lib_dir()?;
    if lib.exists() {
        std::fs::remove_dir_all(&lib)?;
    }
    println!(
        "Removed the daemon. The repeater's identity stays in {}, so `streetcryptid-repeater run` \
         (or installing again) comes back as the same, claimed repeater.",
        paths::user_state_dir()?.display()
    );
    Ok(())
}

fn uninstall_system(args: UninstallArgs) -> Result<()> {
    if !is_root() {
        bail!("Removing the machine's repeater needs root: `sudo streetcryptid-repeater uninstall --system`.");
    }
    let _ = systemctl(false, &["disable", "--now", SERVICE_NAME]);
    if Path::new(SYSTEM_UNIT).exists() {
        std::fs::remove_file(SYSTEM_UNIT)?;
    }
    let _ = systemctl(false, &["daemon-reload"]);
    let _ = std::fs::remove_file(POLKIT_RULE);
    if Path::new(SYSTEM_LIB_DIR).exists() {
        std::fs::remove_dir_all(SYSTEM_LIB_DIR)?;
    }
    println!("Removed the system daemon.");

    let state = Path::new(SYSTEM_STATE_DIR);
    // Back to whoever it came from: the named directory, else the sudo user's if it is marked.
    let (target, owner) = match (&args.move_to, args.keep_state, sudo_user()) {
        (_, true, _) => (None, None),
        (Some(dir), _, user) => (Some(dir.clone()), user),
        (None, false, Some(user)) => {
            let dir = default_user_state(&user);
            if dir.join(SERVICE_MARKER).exists() {
                (Some(dir), Some(user))
            } else {
                (None, None)
            }
        }
        (None, false, None) => (None, None),
    };
    let Some(target) = target else {
        if migrate::has_identity(state) {
            println!(
                "The identity stays in {SYSTEM_STATE_DIR}; installing again comes back as the same \
                 repeater. Pass --move-to DIR to hand it to a person instead."
            );
        }
        return Ok(());
    };
    match migrate::move_state(state, &target)? {
        Moved::Moved => {
            let _ = std::fs::remove_file(target.join(SERVICE_MARKER));
            if let Some(user) = owner {
                migrate::chown_tree(&target, user.uid, user.gid)?;
                // Directories root created on the way down to it belong to them too.
                let mut parent = target.parent();
                while let Some(dir) = parent {
                    if dir == user.home || !dir.starts_with(&user.home) {
                        break;
                    }
                    let _ = std::os::unix::fs::lchown(dir, Some(user.uid), Some(user.gid));
                    parent = dir.parent();
                }
            }
            println!(
                "Moved the repeater identity back to {}. `streetcryptid-repeater run` (or \
                 `install`) there brings it back as the same, claimed repeater.",
                target.display()
            );
        }
        Moved::Nothing => println!("There was no identity in {SYSTEM_STATE_DIR} to move."),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_system_unit_is_sandboxed_and_runs_the_installed_copy() {
        let unit = unit_text(
            Path::new("/usr/local/lib/streetcryptid-repeater/streetcryptid-repeater"),
            paths::Mode::Service,
            Path::new(SYSTEM_STATE_DIR),
        );
        assert!(unit.contains(
            "ExecStart=/usr/local/lib/streetcryptid-repeater/streetcryptid-repeater run --mode service --state-dir /var/lib/streetcryptid-repeater"
        ));
        for line in [
            "Type=notify",
            "User=streetcryptid-repeater",
            "ProtectSystem=strict",
            "ProtectHome=yes",
            "NoNewPrivileges=yes",
            "CapabilityBoundingSet=\n",
            "RuntimeDirectoryMode=0750",
            "StateDirectoryMode=0700",
            "WantedBy=multi-user.target",
        ] {
            assert!(unit.contains(line), "missing {line:?}");
        }
    }

    #[test]
    fn the_polkit_rule_grants_only_the_inhibitors_to_only_the_service() {
        let rule = polkit_rule();
        assert!(rule.contains("subject.user == \"streetcryptid-repeater\""));
        assert!(rule.contains("org.freedesktop.login1.inhibit-block-sleep"));
        assert_eq!(rule.matches("action.id ==").count(), 1);
        assert!(rule.ends_with("});\n"));
    }

    #[test]
    fn the_user_unit_has_no_system_settings() {
        let unit = unit_text(
            Path::new("/home/a/.local/lib/streetcryptid-repeater/streetcryptid-repeater"),
            paths::Mode::User,
            Path::new("/home/a/.local/state/streetcryptid/repeater"),
        );
        assert!(unit.contains("--mode user"));
        assert!(unit.contains("WantedBy=default.target"));
        assert!(!unit.contains("User="));
        assert!(!unit.contains("ProtectHome"));
    }

    #[test]
    fn settings_flags_merge_with_what_is_saved() {
        let dir = tempfile::tempdir().unwrap();
        apply_settings(dir.path(), None, Some(true)).unwrap();
        apply_settings(dir.path(), Some(true), None).unwrap();
        assert_eq!(
            Settings::open(dir.path()).get(),
            HostSettings {
                telemetry: true,
                keep_awake: true
            }
        );
    }

    #[test]
    fn a_held_lock_reads_as_running() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!is_running(dir.path()));
        let lock = streetcryptid_repeater_host::claim_directory(dir.path()).unwrap();
        assert!(is_running(dir.path()));
        drop(lock);
        assert!(!is_running(dir.path()));
    }
}
