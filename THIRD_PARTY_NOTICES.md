# Third-Party Notices

This repository is licensed under **AGPL-3.0-or-later** (see [`LICENSE`](./LICENSE)).
The components listed below are third-party work under the same license but held by
**different copyright holders**, so they carry their own notices and attribution
requirements. They are listed here because AGPL-3.0-or-later requires preserving those
notices, not because their terms differ from the rest of the project.

## iroh-ble-transport (vendored, modified)

- **Location:** `modules/iroh-location/rust/third_party/iroh-ble-transport/`
- **Upstream:** <https://github.com/mcginty/iroh-ble-transport> (tag `iroh-ble-transport-v0.5.1-beta.7`; first vendored at v0.3.1)
- **Original author:** Jake McGinty &lt;me@jakebot.org&gt;
- **License:** GNU Affero General Public License v3.0 or later (**AGPL-3.0-or-later**)
- **Full license text:** `modules/iroh-location/rust/third_party/iroh-ble-transport/LICENSE`
- **List of modifications:** `modules/iroh-location/rust/third_party/iroh-ble-transport/NOTICE`

An experimental Bluetooth Low Energy transport for iroh, vendored for use by the
`iroh-location` native module and modified for its pairing and telemetry needs.

It is a dependency on the Android and Apple targets only — the platforms its `blew`
BLE backend supports and where this module ships natively (`Cargo.toml`, the
`cfg(any(target_os = "android", target_vendor = "apple"))` block). Keeping it off the
host target is what lets `cargo test` and the `uniffi-bindgen` CLI build on
Windows/Linux, where `blew` refuses to compile.

**It is on the live code path.** `src/ble.rs` wraps it as a custom iroh transport
(dedup hook, address lookup, and the invite-less stranger bootstrap's identity GATT
service), and `LocationNode::start` installs it via `ble::attach` (`src/lib.rs:1761`).
Bump peer resolution depends on it as well. Every shipped native artifact for those
targets — the per-ABI `libiroh_location.so` in the Android app, the static library in
the iOS XCFramework — therefore contains and executes this code.

## blew (Rust crate + vendored Android runtime)

- **Vendored Rust crate:** `modules/iroh-location/rust/third_party/blew/` (upstream 0.5.1-beta.8; first vendored at 0.3.0), used by
  `iroh-ble-transport` and, on Android, by `iroh-location` directly
- **List of Rust modifications:** `modules/iroh-location/rust/third_party/blew/NOTICE`
- **Vendored Android runtime:** `modules/iroh-location/android/src/main/java/org/jakebot/blew/`
- **Notice/license:** `modules/iroh-location/android/third_party/blew/`
- **Upstream:** <https://github.com/mcginty/blew>
- **License:** GNU Affero General Public License v3.0 or later (**AGPL-3.0-or-later**)

The Kotlin central/peripheral managers are the Android runtime half of the Rust `blew`
dependency. They are vendored so Rust BLE threads can call into Android's Bluetooth APIs
through JNI (modified: the central asks for a high-priority connection; see that
directory's NOTICE), and are reached from `com/unrealjune/irohlocation/IrohAndroidBootstrap.kt`.

The Rust crate was vendored on 2026-10-31 to fix flow control in its CoreBluetooth
backend, and rebased onto upstream 0.5.1-beta.8 on 2026-11-02, which fixes most of the
same problems itself; its NOTICE lists what is still ours.

## noq (vendored, modified)

- **Location:** `modules/iroh-location/rust/third_party/noq/`
- **Upstream:** <https://github.com/n0-computer/noq> (crates.io `noq` 1.4.0)
- **Copyright:** n0, inc. and the noq / Quinn contributors
- **License:** MIT OR Apache-2.0
- **List of modifications:** `modules/iroh-location/rust/third_party/noq/NOTICE`

Applied with `[patch.crates-io]` for a single fix: `read_to_end` on a stream already read to its
end failed, which made most iroh-docs syncs report failure. Remove it once noq fixes it.

## iroh-blobs (vendored, modified)

- **Location:** `modules/iroh-location/rust/third_party/iroh-blobs/`
- **Upstream:** <https://github.com/n0-computer/iroh-blobs> (crates.io `iroh-blobs` 0.103.0)
- **Copyright:** n0, inc. and contributors
- **License:** MIT OR Apache-2.0
- **List of modifications:** `modules/iroh-location/rust/third_party/iroh-blobs/NOTICE`

An optional local download-completion hook correlates an encrypted update with its actual
supplier and receive-path evidence. No wire or download-policy changes.

## Distribution obligation

Distributing a build — including to TestFlight and Play testers — obliges you to offer
those recipients the corresponding source for that exact build, under
AGPL-3.0-or-later. `app.config.ts` stamps the commit SHA into every build, which is
what makes a specific binary traceable to a specific revision.

> This notice is informational and is not legal advice. Refer to the full license texts
> to understand the obligations that apply before distributing builds.
