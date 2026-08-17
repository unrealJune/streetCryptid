# Physical-device checklist

`run-matrix.sh` and `soak.sh` run entirely on iOS Simulators, which is fast and fully scriptable
but structurally cannot reproduce some of the conditions that actually determine background
reliability in the field. This is not a checklist of things the matrix runner is "missing" and
should eventually grow into covering — these are Simulator limitations with no scriptable
workaround, so they stay a manual/physical-device exercise indefinitely.

Run these by hand, on real hardware, before trusting a background-sharing change:

- **A real SLC-triggered relaunch after the user force-quits the app.** The Simulator has no
  significant-location-change radio to wake a terminated process the way a physical device does.
  `scenarios/force-quit-relaunch.yaml` runs this shape of scenario anyway (marked
  `simulator_limited: true` so a failure there is reported as a warning, not a build-breaking
  result) purely so the harness has a place to demonstrate the gap — treat a pass there as
  "didn't crash," never as "relaunch works."
- **Low Power Mode.** There is no supported `simctl` toggle for it, and the app's own
  `suspendBelowLevel` gate (`sampling-policy.ts`) is meant to react to real battery state.
  Toggle it by hand in Settings on a physical device mid-share and confirm the app degrades
  (reduced cadence / accuracy) rather than silently going dark.
- **True radio toggles (Airplane Mode, Wi-Fi-only, cellular-only, a real Wi-Fi↔cellular roam).**
  Simulators share the host machine's network stack — there is no radio to switch. Phase 2's
  chaos scripts approximate this at the network-reachability level (blocking the stash/relay
  host), which is a different failure mode than an actual interface change; only a physical
  device roaming between networks exercises the real `net_report`/`network_change` path
  documented in `infra/otel/README.md`.
- **Real background-suspension timing.** iOS's actual background execution budget, and how long
  the OS keeps a `CLLocationManager`-holding process alive before suspending it, is not
  reproduced by the Simulator's background state. A multi-hour soak (`soak.sh`) on the Simulator
  measures wake _cadence_ under the OS's simulated background delivery, not real suspension
  pressure — pair it with an actual overnight soak on a physical device before shipping a cadence
  or battery-profile change.
- **`launchApp` force-kills and cold-relaunches on iOS, even with `clearState: false`**
  (`.maestro/README.md`). Every matrix scenario that backgrounds the app therefore starts from a
  fresh process, and `rapid-thrash.yaml` is a repeated-restart stress test, not a same-process
  foreground/background race test — there is no Maestro primitive available to bring an
  already-backgrounded app back to the foreground without a kill. If you need to validate the
  live-process foreground/background transition specifically (not a restart), do it by hand.

None of the above blocks using the Simulator matrix day-to-day — it catches the large majority of
regressions faster and more cheaply than physical hardware. Treat it as the first gate, not the
last one.
