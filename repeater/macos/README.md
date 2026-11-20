# macOS repeater

A native SwiftUI/AppKit app for **macOS 13+, Apple Silicon and Intel**, using the same Rust host
and in-memory encrypted storage as the Windows repeater. No WebView or localhost management port.

```
SwiftUI window + menu bar + Sparkle updates ──inherited stdio──▶ shared Rust host
```

## Install and use

Download a `macos-v*` release's `streetcryptid-repeater-<version>-universal-macos.zip`, expand it,
move **streetCryptid Repeater.app** into Applications, and open it. Only Developer ID signed,
notarized builds are published by the release workflow. Never disable Gatekeeper to install it.

Complete setup, choosing launch at login, mains-only keep-awake, diagnostics and automatic updates.
Nothing registers at login or enables diagnostics/updates until you press **Continue**. Scan the
claim QR with the owner phone, or copy its link into streetCryptid's Settings > Repeaters.
Claim links rotate and are capabilities: do not publish them or screenshots containing them.

Closing the window keeps the app and host running in the menu bar. **Quit Repeater** stops both.
Launch at login starts in the menu bar. The app runs only within your signed-in session, not
before login or after logout. macOS may ask you to approve its login item in System Settings;
Settings reports the actual registration status rather than assuming approval.

The keep-awake choice prevents idle system sleep on AC power, not display sleep, lid closure,
explicit sleep or shutdown. It releases on battery; unknown power status is treated conservatively.
The host reports whether the assertion was actually acquired. A sleeping Mac carries nothing.

The window uses native macOS controls and a unified toolbar, with the Windows app's mothman
and wordmark. The settings gear becomes a back arrow. Settings save automatically; name edits
are coalesced and native commands serialized. Back waits for pending changes and stays in Settings
if a save fails. Template icons contain only the transparent mothman glyph, not the app icon's tile.
Member identifiers are not personal names.
Roster membership is managed by the owner phone, not edited locally.

## State and lifecycle

State is in `~/Library/Application Support/streetCryptid/Repeater` (0700), outside the app bundle.
The identity key is 0600. The host alone owns its lock, identity, signed roster, grants and
settings. Carried ciphertext is memory-only and refills from phones after a restart. Preserve
the entire state directory; never delete a damaged identity to make startup succeed.

The app speaks host protocol 2 through inherited pipes. Commands are correlated and bounded;
oversized or incompatible messages fail closed. It waits 45 seconds for startup, 20 seconds for
ongoing snapshots and 10 seconds for a command. Sleep/resume resets the snapshot watchdog.
Host failures retry three times with backoff, reset only after five minutes of healthy snapshots.
After that, the window offers Retry. Neither stdout (which carries claims) nor dependency errors
are forwarded to system logs.

Quitting, including a Sparkle restart, finishes pending settings before closing stdin so the host shuts down and releases its state
lock. After five seconds the app sends SIGTERM and two seconds later SIGKILL if necessary.
The host also observes pipe EOF if the app crashes.

Diagnostics are off by default. A build without `SC_REPEATER_OTEL_ENDPOINT` cannot enable them;
release builds obtain it from the `REPEATER_OTEL_ENDPOINT` repository variable. The shared host's
existing diagnostics report `host.platform=macos`; there is no new telemetry collection path.

## Build

Use Xcode with Swift 5.9 or newer and the repository's Rust toolchain. The Swift package pins
Sparkle in both `Package.swift` and `Package.resolved`.

```sh
rustup target add aarch64-apple-darwin x86_64-apple-darwin
just macos::test
just macos::check
just macos::build 0.0.0             # universal, both Rust and Swift
just macos::smoke
# Faster local build on Apple Silicon:
just macos::build 0.0.0 arm64
just macos::smoke arm64
```

The app lands in `repeater/macos/artifacts/<arch>/streetCryptid Repeater.app`. Local builds use
ad-hoc signatures and have no updater unless a public update key is supplied. They are not
signed distribution builds. `smoke` uses temporary state and never registers a login item.

## Releases and automatic updates

`ci-repeater-macos.yml` tests Swift and Rust and builds the release host natively on both
architectures in parallel. Apple Silicon combines those hosts into one universal app; the Intel
smoke job and release signer use that same bundle.
`release-repeater-macos.yml` uses Conventional Commits and the separate `macos-v*`
tag namespace. Shared Rust, icon and font inputs count toward macOS releases too.

The release workflow signs all nested Sparkle executables, the host and app with Developer ID,
notarizes and staples the app, and signs its ZIP with Sparkle's Ed25519 key. An archive, SHA256SUMS
and full corresponding source are published before updating `macos-updates/appcast.xml`. It never
uses GitHub's repository-wide "latest" release, which belongs to multiple products.
Older manually tagged releases do not replace the newest feed.

Automatic checks run every six hours when enabled. Downloaded updates wait behind **Install Update**
while the window is open; closing it installs and relaunches in the menu bar without a prompt.
Sparkle also installs prepared updates on quit. Manual checks are in Settings and the menu bar.
Updates stop the host before replacement and retain its state outside the bundle.

Release configuration (use repository/environment secrets, never files in source):

| Name                         | Kind                | Value                                                        |
| ---------------------------- | ------------------- | ------------------------------------------------------------ |
| `MACOS_SPARKLE_PUBLIC_KEY`   | Repository variable | Public key printed by Sparkle `generate_keys`                |
| `MACOS_SPARKLE_PRIVATE_KEY`  | Secret              | Exported Sparkle private key file's contents                 |
| `MACOS_CERTIFICATE_P12`      | Secret              | Base64 Developer ID Application certificate with private key |
| `MACOS_CERTIFICATE_PASSWORD` | Secret              | P12 password                                                 |
| `MACOS_SIGN_IDENTITY`        | Secret              | Developer ID Application signing identity                    |
| `MACOS_NOTARY_KEY`           | Secret              | App Store Connect API key's P8 contents                      |
| `MACOS_NOTARY_KEY_ID`        | Secret              | API key ID                                                   |
| `MACOS_NOTARY_ISSUER`        | Secret              | API issuer ID                                                |

Signing runs only in the protected `production-release` environment on a disposable runner and
uses a temporary keychain. Missing credentials fail the release; there is no unsigned fallback.
For an already-configured local signing machine, `just macos::package <version>` takes
`MACOS_SIGN_IDENTITY`, `MACOS_NOTARY_PROFILE`, `MACOS_SPARKLE_PUBLIC_KEY` and
`MACOS_SPARKLE_PRIVATE_KEY_FILE` instead. Build with the same public key first.

## Acceptance before distribution

Compilation and host smoke checks are not clean-install or update acceptance. Before the first
public release, exercise the signed app on macOS 13 and a current macOS, on Intel and Apple Silicon:
clean install, login-item approval/revocation, logout/login, close/reopen/Quit, crash recovery,
sleep/resume, AC/battery keep-awake, VoiceOver and increased contrast. Claim it from a real phone,
receive and serve encrypted content, rename it, and remove a member from the owner phone.
Perform a two-version signed Sparkle update and verify the identity, roster and settings survive.
Do not count unavailable machines, unrun CI jobs or an unsigned local build as these passes.
