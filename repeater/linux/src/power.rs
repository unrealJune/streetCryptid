//! Keeping the machine awake while it is on mains power — the Windows host's `ES_SYSTEM_REQUIRED`,
//! done the Linux way: a logind sleep inhibitor, held by a `systemd-inhibit` child for as long as
//! it is wanted. A repeater that sleeps carries nothing; on battery the person's battery wins.
//!
//! The pulse reports what is actually held, not what was asked for: logind may refuse an
//! inhibitor (polkit, or no logind at all in a container), and then `systemd-inhibit` exits and
//! `holding` reads false.

use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use streetcryptid_repeater_host::PowerState;

pub struct KeepAwake {
    on_ac: AtomicBool,
    holding: AtomicBool,
}

impl PowerState for KeepAwake {
    fn on_ac(&self) -> bool {
        self.on_ac.load(Ordering::Relaxed)
    }

    fn holding(&self) -> bool {
        self.holding.load(Ordering::Relaxed)
    }
}

impl KeepAwake {
    /// One thread owns the inhibitor for the life of the process and re-evaluates every half
    /// minute, like the Windows host's.
    pub fn spawn(wanted: Arc<AtomicBool>) -> Arc<Self> {
        let state = Arc::new(Self {
            on_ac: AtomicBool::new(on_ac(Path::new(SYSFS_POWER))),
            holding: AtomicBool::new(false),
        });
        let shared = state.clone();
        std::thread::spawn(move || {
            let mut inhibitor: Option<Child> = None;
            loop {
                let on_ac = on_ac(Path::new(SYSFS_POWER));
                shared.on_ac.store(on_ac, Ordering::Relaxed);
                let want = wanted.load(Ordering::Relaxed) && on_ac;
                // A refused or killed inhibitor has exited; reap it so the next pass may retry.
                if let Some(child) = inhibitor.as_mut() {
                    if !matches!(child.try_wait(), Ok(None)) {
                        inhibitor = None;
                    }
                }
                match (want, inhibitor.is_some()) {
                    (true, false) => inhibitor = inhibit(),
                    (false, true) => {
                        if let Some(mut child) = inhibitor.take() {
                            let _ = child.kill();
                            let _ = child.wait();
                        }
                    }
                    _ => {}
                }
                shared.holding.store(inhibitor.is_some(), Ordering::Relaxed);
                std::thread::sleep(Duration::from_secs(30));
            }
        });
        state
    }
}

/// `systemd-inhibit` holding a sleep lock around a `sleep` that never ends. It dies with us:
/// `PR_SET_PDEATHSIG` on the child, and the inhibitor's lock is released when its fd closes.
fn inhibit() -> Option<Child> {
    use std::os::unix::process::CommandExt;
    let mut command = Command::new("systemd-inhibit");
    command
        .args([
            // Sleep alone: an idle-triggered suspend is a sleep too, and logind judges a combined
            // `sleep:idle` request by a stricter rule than either half.
            "--what=sleep",
            "--who=streetCryptid repeater",
            "--why=Carrying friends' locations while on mains power",
            "--mode=block",
            "sleep",
            "infinity",
        ])
        // It must not answer systemd for us: under `Type=notify` the unit's notify socket is in our
        // environment, and only the main process may use it.
        .env_remove("NOTIFY_SOCKET")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // SAFETY: prctl is async-signal-safe and touches nothing but the calling (child) process.
    unsafe {
        command.pre_exec(|| {
            libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM);
            Ok(())
        });
    }
    let mut child = command.spawn().ok()?;
    // logind answers at once; a refusal is an exit within the first moments.
    std::thread::sleep(Duration::from_millis(500));
    match child.try_wait() {
        Ok(None) => Some(child),
        _ => None,
    }
}

const SYSFS_POWER: &str = "/sys/class/power_supply";

/// Mains, unless the machine says it is on battery: a supply of type `Mains`/`USB` online is AC,
/// and a machine with no battery at all (a desktop, a server, a Pi) is AC too. Only batteries
/// with every external supply offline read as battery.
pub fn on_ac(root: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(root) else {
        return true;
    };
    let read = |dir: &Path, name: &str| {
        std::fs::read_to_string(dir.join(name))
            .map(|s| s.trim().to_string())
            .unwrap_or_default()
    };
    let mut battery = false;
    for entry in entries.flatten() {
        let dir = entry.path();
        match read(&dir, "type").as_str() {
            "Battery" => {
                // Peripherals (a mouse, a headset) report batteries scoped to themselves.
                if read(&dir, "scope") != "Device" {
                    battery = true;
                }
            }
            "Mains" | "USB" | "USB_C" | "USB_PD" if read(&dir, "online") == "1" => return true,
            _ => {}
        }
    }
    !battery
}

#[cfg(test)]
mod tests {
    use super::*;

    fn supply(root: &Path, name: &str, kind: &str, extra: &[(&str, &str)]) {
        let dir = root.join(name);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("type"), format!("{kind}\n")).unwrap();
        for (file, value) in extra {
            std::fs::write(dir.join(file), format!("{value}\n")).unwrap();
        }
    }

    #[test]
    fn a_machine_without_a_battery_is_on_mains() {
        let root = tempfile::tempdir().unwrap();
        assert!(on_ac(root.path()));
        assert!(on_ac(&root.path().join("missing")));
    }

    #[test]
    fn a_laptop_is_on_battery_only_with_every_supply_offline() {
        let root = tempfile::tempdir().unwrap();
        supply(root.path(), "BAT0", "Battery", &[]);
        supply(root.path(), "AC", "Mains", &[("online", "0")]);
        assert!(!on_ac(root.path()));
        supply(root.path(), "AC", "Mains", &[("online", "1")]);
        assert!(on_ac(root.path()));
    }

    #[test]
    fn a_wireless_mouse_battery_is_not_the_machines() {
        let root = tempfile::tempdir().unwrap();
        supply(
            root.path(),
            "hidpp_battery_0",
            "Battery",
            &[("scope", "Device")],
        );
        assert!(on_ac(root.path()));
    }
}
