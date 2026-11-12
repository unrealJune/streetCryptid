# Windows repeater (preview)

A native C# / WinUI 3 app and a Windows service supervising the existing Rust repeater. There is
no WebView, no localhost management server, and nothing on the machine can decrypt a location.

```
WinUI app ──stdio──────────────────────────────▶ Rust host        (per user: lives with the app)
WinUI app ──named pipe──▶ Windows service ──stdio──▶ Rust host    (service: before and after sign-in)
```

- `app/` — the WinUI app: setup, claim QR, status, tray, updates.
- `service/` — `StreetCryptid.Repeater.Service.exe`, a native-AOT supervisor. `run` is what the
  Service Control Manager starts; `install` and `uninstall` are run elevated by the app.
- `core/` — what both share and what the tests cover: the line protocol, the identity move,
  preferences, the SCM calls.
- `host/` — the Rust host, on the repeater server crate (`repeater/server`, crate `trail-stash`)
  in its `Storage::MemoryRepeater` mode. A member of the repository's Cargo workspace.

## Build

Use Windows 10 2004 or newer, PowerShell 7, .NET SDK 10.0.403, Rust 1.97.0 (the repository's
`rust-toolchain.toml`), and Visual Studio C++ desktop tools with a Windows SDK (native AOT links
with them). ARM64 builds additionally need the ARM64 MSVC toolchain and `aarch64-pc-windows-msvc`
Rust target. The checked-in NuGet lockfiles and the repository's one `Cargo.lock` pin
dependencies.

From the repository root:

```powershell
just repeater-test
just repeater-build x64
just repeater-package x64 0.1.0-preview.1
just repeater-package arm64 0.1.0-preview.1
```

The equivalent entry point is `repeater\windows\scripts\build.ps1`. Application files land in
`repeater\windows\artifacts\win-<architecture>\app`; installers and feed files land in the adjacent
`releases` directory. Run `StreetCryptid.Repeater.exe` from the application directory, not the
Rust executable alone.

The host builds against the server crate in this repository (`repeater/server`), so a change
to the stash is a change to the desktop repeater too; there is no vendored copy or patch to keep
in step. It builds with the workspace's `desktop-release` profile into the root `target/`.

The host links the phones' patched noq (`third_party/noq`, the workspace's `[patch.crates-io]`):
unpatched, iroh-docs reports most syncs as failed closes and content pulls stop before their bytes
land.

`scripts\make-icons.py` renders `app\Assets\repeater.ico` from the app's mothman sigil, with
thickened small sizes for the tray and title bar. Re-run it when the sigil changes.

### Tests

`just repeater-test` runs the Rust host tests, the desktop tests in the server crate (real
iroh nodes: claim, grant, receive, serve, a restart that keeps the claim and grants but no content,
removal), the C# tests (protocol,
preferences, the identity move), format checks, and `test-host.ps1` against the built host.
CI also runs `test-service.ps1`, which installs the real service on the (elevated, disposable)
runner, moves a per-user identity into it, talks to it over its pipe, and moves the identity back
— checking it is byte-identical. Do not run that script on a machine you care about.

## Operation

First-run setup offers: run as a Windows service, keep the PC awake on mains power, send
diagnostics, open the app with Windows, start in the tray, keep running when closed, automatic
updates. Nothing is registered or installed until Continue is pressed.

### As a Windows service (the default for new setups)

Turning it on asks for administrator approval once. The installer then:

- copies the service and the host under `%ProgramFiles%\streetCryptid Repeater` — never runs them
  from the per-user install, which the person could replace under a service account;
- registers `StreetCryptidRepeater` as its own virtual account (`NT SERVICE\StreetCryptidRepeater`),
  delayed automatic start, restart on failure, holding only `SeChangeNotifyPrivilege` — in
  particular not `SeImpersonatePrivilege`;
- secures `%ProgramData%\streetCryptid` to SYSTEM, Administrators and the service (ProgramData lets
  any user pre-create folders, so it takes ownership first);
- **moves** the identity and everything the node keeps from the per-user directory into
  `%ProgramData%\streetCryptid\Repeater`, and marks the per-user directory so a per-user host can
  never mint a second identity there (`moved-to-service`).

The move copies into a staging directory, swaps it into place with the key last, and only then
deletes the source; an interrupted move is finished by running it again. Two different identities
are never merged or overwritten: the installer stops and says so.

The app talks to the service over the `streetcryptid-repeater` pipe, which only the installing
account (plus SYSTEM and the service) may open, and which refuses remote clients. Before trusting
it the app checks that the process serving the pipe is the running service. The service forwards
exactly one command to the host — settings — and drops a client that sends anything else.

An app update does not replace the service's copy: when the versions differ the app offers
**Update service**, which runs the installer again (administrator approval again). Turning the
service off in Settings moves the identity back. Uninstalling the app tries to do the same,
best effort, within Velopack's 25-second budget; if the prompt is declined the service keeps
running, and `StreetCryptid.Repeater.Service.exe uninstall --to "%LOCALAPPDATA%\streetCryptid\Repeater"`
from an elevated prompt finishes it.

### Per user

The app starts the host as its child, bound by inherited pipes and a kill-on-close job; it runs
while the app does. Setups finished before the service existed stay per user until the service is
turned on in Settings.

### Claiming and members

Scan the actual claim QR with streetCryptid on the owner phone. Claim links are single-use and
rotate every 30 minutes. **Do not publish screenshots of an unclaimed QR or copy its link into
logs.** The owner phone signs roster and policy changes and member removal; the PC shows who it
carries and never changes the roster on its own — a local opt-out would leave every phone's
repeater card claiming a carrier that refuses them. To stop carrying someone, remove them on the
phone (Settings → Repeaters).

The status shows people carried, encrypted items ready to forward (including control records) and
missing content labelled "waiting for data". Received location updates
count newly servable fixes, not status polls. Received/sent bytes and connection counts come from
the endpoint's transport counters, include sync/protocol overhead and reset when the host restarts;
they are not proof that a friend decrypted a location.

The base dot lattice is stationary. Individual dots pop in a staggered wave outward from each ping.
Idle pings are green; newly available encrypted fixes generate randomly coloured pings. Colours do
not identify people or indicate GPS freshness. Hidden/minimized/locked windows discard visual
activity; reduced motion stops animation, and high contrast omits the decorative field.

## Storage and recovery

What the repeater carries lives in memory only, like every repeater (`docs/social/REPEATERS.md`
§1): the iroh-docs replica and the ciphertext are never written to disk
(`Storage::MemoryRepeater`). On disk, in `%LOCALAPPDATA%\streetCryptid\Repeater` per user or
`%ProgramData%\streetCryptid\Repeater` under the service, are only what makes it the same repeater:
the private identity, the signed roster, the namespace grants (read capabilities) and the settings.
A restart — for a Windows update, most often — comes back claimed and carrying the same people,
holding nothing until their phones sync again. Retention follows the trail-stash defaults (latest
fix per author, 48-hour stale backstop, 15-minute pruning, five-minute sibling synchronization),
and released ciphertext is reclaimed by the in-memory store's garbage collection.

If the identity or settings are damaged, restore them rather than deleting them or claiming a
replacement. Preserve the whole state directory when migrating an installation by hand. Only one
host can hold it. The app checks startup and ongoing IPC deadlines, retries failures three times,
and then offers manual Retry.

## Diagnostics

Builds made with `SC_REPEATER_OTEL_ENDPOINT` set (CI sets it from the `REPEATER_OTEL_ENDPOINT`
repository variable) compile the trail-stash OTLP exporter in; others have none. Even then nothing
is sent until the person leaves **Send diagnostics** on at setup: the host starts with it off, and
the choice is enforced per span, so turning it off stops export at once. What is sent: the stash's
own `repeater.*` spans and `repeater.host.start` / `.pulse` / `.stop` (every five minutes: roster
size, tracked/missing content, arrivals, connections, bytes in/out, power state, uptime), keyed by the short endpoint id as `service.instance.id`. A silent gap between pulses is
how a sleeping, powered-off or wedged repeater shows up. Never a location: everything carried is
ciphertext the PC cannot read.

## Power

**Keep this PC awake on mains power** holds `ES_SYSTEM_REQUIRED` from the host while the PC is on
AC, and releases it on battery. A sleeping PC carries nothing; the pulse reports whether the hold
is active.

## Releases and updates

`ci-repeater-windows.yml` builds/tests/packages x64 and ARM64 on matching Windows runners; it is
CI's Windows lane, run when `repeater/windows`, the protocol or the workspace's shared files change
(`scripts/ci-changes.sh`). `release-repeater-windows.yml` cuts releases: a push to main that
touches what the host is built from resolves the next `windows-vX.Y.Z-preview.1` by the
repository's Conventional Commit rules (`scripts/next-repeater-version.sh windows`), runs the same
build gates on that commit, then creates the tag with the release. A `windows-v*` tag pushed by
hand publishes that version; the workflow's dispatch can force a bump.

Versioned releases include the desktop source archive (the host, the server and protocol crates,
the workspace files and the noq fix), notices and source commit. The `repeater-preview` prerelease provides two distinct Velopack channels,
`repeater-win-x64` and `repeater-win-arm64`. Packages upload before feed manifests. Do not mix
mobile artifacts into this feed.

These installers are **unsigned previews** unless the `REPEATER_SIGN_PARAMS` repository secret is
set (signtool parameters handed to `vpk pack --signParams`, e.g. Azure Trusted Signing's dlib and
metadata file). Never describe them as signed production releases or bypass Windows trust warnings
automatically. Because updates replace binaries on a machine that holds an identity key, signing
is a gate for any release beyond our own preview group; the workflow refuses non-preview tags.

Automatic updates download in the background and apply on restart; manual checks are available in
Settings and the tray. Restart stops a per-user host before replacement; the service keeps running
and is updated separately. Installation does not opt users into startup. Upgrade state lives
outside the installation directory.

## Release acceptance still required

Build/test success alone is not device or installer acceptance. Before promoting an initial
release, record clean-install and two-version update results (including **Update service**),
verify startup and Explorer-restart tray recovery, scan the QR from a real phone, and exercise
receipt/serve/removal with that phone — once per user and once under the service, including a
reboot with nobody signed in. Verify native ARM64 UI, Windows themes/high contrast/reduced motion,
keyboard navigation, 100/150/200% DPI, the icon at each size, and sleep/resume with and without
keep-awake. Do not count unavailable hardware or unrun GitHub jobs as passes.
