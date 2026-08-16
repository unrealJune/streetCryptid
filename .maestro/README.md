# Maestro E2E flows

Requires [Maestro](https://maestro.mobile.dev) on `PATH` and iOS Simulators with
the app already built and installed (`just run-ios`, or `bunx expo run:ios` /
`bunx expo run:ios --configuration Release`).

- `onboarding/ensure-onboarded.yaml` — idempotent: brings the app the rest of the
  way to the live map from whatever state it's in (fresh install, mid-onboarding,
  or already done), without wiping existing data.
- `onboarding/fresh-onboard.yaml` — always wipes local state first
  (`clearState: true`). Use this to test onboarding itself, not as a pairing
  prerequisite.
- `pairing/` — flows for driving the invite-link pairing UI. See
  `scripts/e2e/pairing-e2e.sh` for the full two-device orchestration (run via
  `just e2e-pairing <device-a-udid> <device-b-udid>`).
- `background-location/background-app.yaml` — launches, dismisses dev-menu/backgrounding
  dialogs if present, and backgrounds the app. Used directly by
  `scripts/e2e/ios-background-location-e2e.sh` and `ios-location-benchmark.sh`, and indirectly
  (via `scripts/e2e/lib/devices.sh`) by `run-matrix.sh` and `soak.sh` — the scenario-matrix and
  soak-test harness for background sharing. `just e2e-matrix` runs the declarative scenarios in
  `scripts/e2e/scenarios/*.yaml` across a pool of simulators; `just e2e-matrix-list` lists them;
  `just e2e-soak` runs one long-form. `pairing/pair-device.yaml` drives a whole SAS handshake as a
  single flow (both devices concurrently, meeting through `scripts/e2e/lib/rendezvous.py`) — a
  flow START restarts the app under both runners, so anything holding in-app session state has to
  live in one flow. `just e2e-reconcile` proves a device recovers what it missed while away, and
  `just e2e-relay` that a friend can serve an absent author's fix — read
  `scripts/e2e/PEER-RELAY-STATUS.md` before trusting a red run from the latter.
  See `scripts/e2e/PHYSICAL-DEVICE-CHECKLIST.md` for what
  that matrix structurally cannot cover on Simulator alone. `chaos-*.yaml` scenarios additionally
  need a local trail-stash (`just e2e-local-stash`) and pf (`scripts/e2e/lib/netchaos.sh`, needs
  sudo) to prove the app survives — and recovers from — the stash going unreachable mid-share.

## Gotchas this harness works around

**`tapOn` by label/placeholder text does not focus TextInputs.** It works fine
for `Pressable` buttons, but under Maestro's synthetic iOS taps, this app's
`TextInput`s never actually gain focus that way (no keyboard, no cursor, no
typed text, no error — it just silently does nothing). Give the field a `testID`
and select it with `id:` instead — see `onboarding/ensure-onboarded.yaml`.

**`launchApp` restarts the app even with `clearState: false`.** On iOS, Maestro's
`launchApp` appears to force a terminate+relaunch rather than just foregrounding
an already-running process. That's fine before any pairing session exists, but
calling it _during_ a live pairing handshake tears down the native module's
in-memory session state. None of the `pairing/*.yaml` flows that run mid-session
(`pick-figure.yaml`, `confirm-match.yaml`, `acknowledge-friend.yaml`) call
`launchApp` for this reason — they rely on Maestro already being attached to the
foregrounded app from the previous step in the same test run.

**The iOS Simulator's pasteboard does not reliably reflect what the Share
Sheet's Copy action writes.** Confirmed independently, twice: `simctl pbpaste`
(and the host `pbpaste`) read empty immediately after a verified, successful tap
on the Share Sheet's "Copy" button. `create-invite.yaml` works around this by
reading the invite token from a DEBUG-only on-screen mirror
(`id: debug-invite-link`, Settings → DEBUG section) via `maestro hierarchy`
instead of the clipboard.

**Reading data out of a flow.** Maestro flows can't return values to the
orchestrating shell script directly. `scripts/e2e/hierarchy_text.py` pulls a
value out of `maestro --udid <udid> hierarchy` JSON by `testID`
(`resource-id` in the dump) — used both for the invite token and for reading
which ASCII figure name the "displayer" side is showing, so the "picker" side
can be told which option to tap.

**SAS role (displayer vs. picker) is not determined by who created the
invite.** It's derived from comparing the two endpoints' raw key bytes, so it
can land either way regardless of invite direction. `pairing-e2e.sh` polls both
devices after redemption to find out which is which.
