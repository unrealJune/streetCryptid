# Third-Party Notices

This repository is distributed under the MIT license (see [`LICENSE`](./LICENSE)),
**except** for the vendored third-party components listed below, which retain
their own upstream licenses. Where a vendored component uses a copyleft license,
that license governs that component and can carry obligations for distributions
that link or include it.

## iroh-ble-transport (vendored, modified)

- **Location:** `modules/iroh-location/rust/third_party/iroh-ble-transport/`
- **Upstream:** <https://github.com/mcginty/iroh-ble-transport> (tag `iroh-ble-transport-v0.3.1`)
- **Original author:** Jake McGinty &lt;me@jakebot.org&gt;
- **License:** GNU Affero General Public License v3.0 or later (**AGPL-3.0-or-later**)
- **Full license text:** `modules/iroh-location/rust/third_party/iroh-ble-transport/LICENSE`
- **List of modifications:** `modules/iroh-location/rust/third_party/iroh-ble-transport/NOTICE`

This subtree is an experimental Bluetooth Low Energy transport for iroh. It was
vendored and ported from iroh 0.98.2 to iroh 1.0.2 for use by the
`iroh-location` native module. It is licensed under **AGPL-3.0-or-later**, a
strong copyleft license that is different from the MIT license covering the rest
of this repository.

The `iroh-location` crate can be compiled with this subtree as a dependency (it
is declared as a dependency only for the Android and Apple targets, which are the
platforms its BLE backend supports and where this module ships natively).
Consequently, native artifacts produced from those targets — for example the
per-ABI `libiroh_location.so` bundled into the Android app, or the static
library linked into the iOS XCFramework — can incorporate AGPL-3.0-or-later
code. Distributing such artifacts carries the obligations of the
AGPL-3.0-or-later license (including its source-availability and network-use
provisions) for that component, in addition to the MIT terms that cover the rest
of this repository.

As of this checkpoint the crate is vendored, compiles against iroh 1.0.2, and is
declared as a build dependency of `iroh-location`, but it is **not yet
referenced by any runtime code** (it is not wired into `LocationNode`).

> This notice is informational only and is not legal advice. Refer to the full
> license texts to understand the obligations that apply before distributing
> builds that include this component.

## blew Android runtime (vendored)

- **Location:** `modules/iroh-location/android/src/main/java/org/jakebot/blew/`
- **Notice/license:** `modules/iroh-location/android/third_party/blew/`
- **Upstream:** <https://github.com/mcginty/blew>
- **License:** GNU Affero General Public License v3.0 or later (**AGPL-3.0-or-later**)

The Kotlin central/peripheral managers are the Android runtime half of the Rust
`blew` dependency. They are vendored unchanged so Rust BLE threads can call into
Android's Bluetooth APIs through JNI.
