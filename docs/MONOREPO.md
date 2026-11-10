# Bringing the repeater into this repo

> Plan of record, 2026-11-09, for folding [trail-stash](https://github.com/unrealJune/trail-stash)
> and the Windows repeater into this repository: one Cargo workspace, one CI entry point with a
> lane per product, and a tag namespace per product. The design is
> [`docs/social/REPEATERS.md`](social/REPEATERS.md); this document only moves code.

## Why

The repeater's code was reaching the phone, the hosted stash and the Windows client three
different ways, and they had already drifted apart:

| Consumer                        | How it got the code                                   | iroh / noq                  |
| ------------------------------- | ----------------------------------------------------- | --------------------------- |
| App core (`iroh-location`)      | git dependency on the trail-stash tag `v0.3.0`        | 1.4.1 / 1.4.0 **patched**   |
| Hosted stash (trail-stash repo) | the source itself                                     | 1.0.2 / 1.0.1               |
| Windows repeater (`apps/`)      | trail-stash checked out at a SHA + a 1,547-line patch | 1.4.1 / 1.4.0 **unpatched** |

Concretely:

- **The Windows host has the noq `read_to_end` regression** our own `third_party/noq` fixes, and
  the stash still has the iroh 1.0.2 `VecDeque::grow` abort that 1.4 fixed. `[patch.crates-io]`
  applies only at a workspace root, so it reached one of three builds.
- **`memory-repeater.patch` is a private fork of the stash core.** It carries fixes the hosted
  stash and the Linux daemon need too ("register namespace watchers before starting live sync",
  "releasing one namespace must not abandon another's missing shared content"), and it is pinned
  to v0.3.0, behind trail-stash #9's roster closing rule.
- **The claim URL format exists twice** (the daemon's console QR and the Windows host).
- Every protocol change was a PR in each repo, a tag, and a bump.

Long term the stash is a repeater too, so the coupling only grows. Both repos are
AGPL-3.0-or-later; nothing about licensing changes.

## Layout

The Expo app stays at the root. Moving it to `apps/mobile` would touch Expo, EAS, Metro, every
path in `AGENTS.md`, and caches whose digests are built from relative paths, for nothing.

```
/                                 Expo app (src/, modules/, app.json, eas.json, …) — unchanged
├─ Cargo.toml                     virtual workspace: one Cargo.lock, one [patch.crates-io]
├─ rustfmt.toml  .editorconfig
├─ third_party/noq/               moved up from modules/iroh-location/rust/third_party/noq
├─ modules/iroh-location/rust/    workspace member (path unchanged)
├─ modules/iroh-location/rust-wasm/  workspace member
└─ repeater/
   ├─ protocol/                   crate `streetcryptid-repeater` (roster + wire, pure, no I/O)
   │                              ← trail-stash/rust/repeater
   ├─ server/                     crate `trail-stash` (lib + bin), Dockerfile, charts/trail-stash,
   │                              AGENTS.md, justfile   ← trail-stash/rust + charts
   └─ windows/                    ← apps/repeater
      ├─ app/                     WinUI 3 shell          (was windows/)
      ├─ core/  tests/            C# model + tests       (unchanged)
      ├─ host/                    Rust host, workspace member (was native/)
      └─ scripts/  justfile  NOTICE  README.md
```

- **`repeater/server`, not `services/` or `infra/`.** `infra/*` is gitignored, which is how
  trail-stash became a separate repo in the first place. The server is the hosted stash today and
  the Linux/Docker repeater daemon; the Windows client is one shell around the same crate.
- **`repeater/protocol` sits beside its three users** — the phone, the server and the Windows host
  — not inside one of them.
- **`apps/` goes away.** It only ever held the Windows client.
- **Names that do NOT change here:** the crate and binary `trail-stash`, the image
  `ghcr.io/unrealjune/trail-stash`, the chart `trail-stash`, the `TRAIL_STASH_*` environment
  variables and the `contact.role = stash` telemetry. Buttercup's Flux, Helm values and secrets
  name all of them. Renaming the product to "repeater" end to end is its own decision, later.
- **`blew` and `iroh-ble-transport` stay vendored under the mobile crate** and are `exclude`d from
  the workspace: they are only the phone's, and keep their own SimRadio test workspace.

## The Cargo workspace

```toml
# /Cargo.toml
[workspace]
resolver = "2"
members = [
  "modules/iroh-location/rust",
  "modules/iroh-location/rust-wasm",
  "repeater/protocol",
  "repeater/server",
  "repeater/windows/host",
]
exclude = [
  "modules/iroh-location/rust/third_party/iroh-ble-transport",
  "modules/iroh-location/rust/third_party/blew",
]
# A bare `cargo test` at the root stays the stash's fast pure-core run, and never builds the
# mobile crate on a laptop by accident.
default-members = ["repeater/protocol", "repeater/server"]

[workspace.dependencies]
iroh = "1.4.1"
iroh-docs = "0.101"
iroh-blobs = "0.103"
iroh-gossip = "0.101"
opentelemetry = "0.31"
# …every dependency more than one member names

[patch.crates-io]
noq = { path = "third_party/noq" }
```

Rules that come with it:

- **CI always builds with `-p`, never `--workspace` with features.** The Windows host turns on
  `trail-stash/live`; resolver 2 unifies features across everything in one invocation, so a
  workspace-wide build would quietly test the server's pure core with iroh compiled in.
- **The app depends on the protocol by path** (`streetcryptid-repeater = { path =
"../../../repeater/protocol" }`); the git tag dependency goes.
- **The tag pin was also a compatibility checkpoint, so replace it.** In one repo the phone and the
  server change together, but phones in the field lag the server. Add golden vectors in
  `repeater/protocol/tests/fixtures/` — every roster op, `Grant`, `RepeaterCert` and card as each
  released version encodes it — and a test that today's code decodes all of them. Same rule as the
  location wire: append-only, `Option`-only, end-only.
- **`target/` moves to the root.** References to update: `.github/actions/eas-rust-cache`
  (`CARGO_TARGET_DIR`, `workspaces:`), `justfile` (`bindgen-*`, `reset`), `metro.config.js`'s
  blocklist comment and rule, and the e2e scripts that run `trail-stash-client`
  (`ensure-stash-observer.sh`, `ios-location-benchmark.sh`, `lib/devices.sh`, `trio-e2e.sh`).
- **The native artifact cache digest MUST follow the new inputs.** `eas-build-pre-install.sh`
  hashes `src third_party Cargo.toml Cargo.lock` relative to the mobile crate, and
  `eas-native-cache`'s key hashes the same files. With the protocol a path dependency, a change to
  `repeater/protocol/` would otherwise reuse a stale `.so` whose UniFFI checksums still match — a
  phone shipping an old roster rule with no error anywhere. Add the root `Cargo.toml`,
  `Cargo.lock`, `third_party/noq/` and `repeater/protocol/` to both, keep the paths relative, and
  extend `scripts/test-native-cache.sh` with a protocol-only change that must miss. A server-only
  dependency bump now also invalidates the mobile cache through the shared lockfile; that is rare
  and accepted.
- **The wasm crate's own `Cargo.lock` goes** — update the `wasm-output` cache keys in `ci.yml` and
  `copilot-setup-steps.yml` to hash the root lockfile.
- **One toolchain.** Add `rust-toolchain.toml` (1.97.0) at the root; pin the server Dockerfile's
  `rust:1-slim-bookworm` to `rust:1.97-slim-bookworm`.
- **The server's Docker build context becomes the repo root.** Cargo needs every member's manifest
  present to load the workspace, so `.dockerignore` becomes an allowlist (`*`, then `!Cargo.toml`,
  `!Cargo.lock`, `!rust-toolchain.toml`, `!third_party/`, `!repeater/protocol/`,
  `!repeater/server/`, and the member manifests) and the build runs
  `cargo build --locked --release -p trail-stash --features live,otel`. Without the allowlist the
  context includes `node_modules` and every `target/`.

## CI: one entry point, a lane per product

A path-filtered workflow that does not run leaves a required check pending forever, and
`release.yml`'s `workflow_run` and branch protection both key on the names `CI` and `Required`.
So `ci.yml` keeps both and dispatches reusable workflows:

```
ci.yml                      name: CI
  changes                   git diff against the merge base → area flags (a script, no action)
  app      → ci-app.yml              quality, typecheck, native (+ bindings push), ble-transport
  server   → ci-repeater-server.yml  fmt, pure-core test, live test, helm lint, image build (no push)
  windows  → ci-repeater-windows.yml today's repeater-ci.yml, now workflow_call only
  Required                  needs all; `skipped` passes, `failure`/`cancelled` fail
```

| Changed paths                                                                                           | Lanes                  |
| ------------------------------------------------------------------------------------------------------- | ---------------------- |
| `src/` `modules/` `app.json` `app.config.ts` `package.json` `bun.lock` `patches/` `plugins/` `scripts/` | app                    |
| `repeater/server/`                                                                                      | server                 |
| `repeater/windows/`                                                                                     | windows                |
| `repeater/protocol/` root `Cargo.toml` `Cargo.lock` `rust-toolchain.toml` `third_party/`                | app + server + windows |
| `.github/`                                                                                              | all                    |

- The `app` lane is today's four jobs moved verbatim, `native`'s write permission and head-SHA
  checkout included (it pushes refreshed bindings).
- The Windows lane is ~90 minutes on two runners; it runs only when its area changes.
- `pr-development-builds.yml` gets the same `changes` gate, so a server-only PR builds no IPA.
- Today every PR runs the whole mobile suite whatever it touches; this is also a speed-up.

## Releases: one tag namespace per product

| Product | Tag                    | Workflow                       | Publishes                                                                   |
| ------- | ---------------------- | ------------------------------ | --------------------------------------------------------------------------- |
| App     | `v*` (unchanged)       | `release.yml`                  | TestFlight + Play internal                                                  |
| Server  | `server-v*`            | `release-repeater-server.yml`  | image `trail-stash:{x.y.z,x.y,latest}`, chart `x.y.z` (prefix stripped)     |
| Windows | `windows-v*-preview.N` | `release-repeater-windows.yml` | `repeater-preview` Velopack feed (unchanged; was `repeater-v*`, never used) |

- **A push to `main` that changes the server lane still publishes `:latest`, `:sha-<short>` and
  chart `0.0.0-<short>`** — production tracks exactly that (`buttercup/apps/trail-stash`: the
  chart pinned to `0.0.0-<sha>`, the pod following `:latest` by digest image policy). Only when
  the server lane ran, or every app commit would roll the stash pod. `<short>` is now a commit of
  this repo; the HelmRelease pin is bumped the same way as before.
- **Two traps in `scripts/next-version.sh`:**
  1. It finds the previous release with `git describe --match 'v[0-9]*.[0-9]*.[0-9]*'`, which
     would match the imported trail-stash tags. They are renamed to `server-v*` on import.
  2. It counts every commit since that tag, so a `feat(server):` would cut a store release.
     Scope the range with `-- . ':!repeater/server' ':!repeater/windows'`. `repeater/protocol/`
     still counts: the phone links it. Add both cases to `scripts/test-next-version.sh`.
- **GHCR:** the `trail-stash` image and `charts/trail-stash` packages belong to the old repo.
  Grant this repo **write** under each package's _Manage Actions access_ before the first publish
  from here, or it fails with a 403. Update the Dockerfile's `org.opencontainers.image.source`.

## Formatting and tooling

- **Root `.editorconfig`** for TypeScript, Rust, C#, YAML and Markdown; **root `rustfmt.toml`**, so
  `cargo fmt --all --check` covers every member (the server lane already runs it).
- **Prettier** keeps the app, Markdown and YAML; ignore `repeater/server/charts/*/templates/` (Go
  templates are not YAML until rendered) and the Windows build outputs (already listed, under
  their new paths).
- **`dotnet format --verify-no-changes`** in the Windows lane; **`actionlint`** over `.github/` in
  the app lane's `quality` job; **`helm lint`** in the server lane.
- **just modules** (just ≥ 1.31; CI pins 1.57): the root `justfile` declares
  `mod server 'repeater/server'` and `mod windows 'repeater/windows'`, giving
  `just server::test`, `just server::run`, `just windows::build x64`, `just windows::package x64 <v>`.
  The repeater recipes currently uncommitted in the root `justfile` move into
  `repeater/windows/justfile`. `just check` stays the app's pre-commit gate; `just check-all` gains
  the server and (on Windows) the Windows checks.
- **Agent docs:** `repeater/server/AGENTS.md` (trail-stash's, with its "the streetCryptid repo's
  `infra/otel/README.md`" made a relative link) and `repeater/windows/AGENTS.md`, each beside a
  `CLAUDE.md` containing `@AGENTS.md`. The root `AGENTS.md` gains a short repository map at the
  top and its iroh/noq paragraph points at `third_party/noq`. `THIRD_PARTY_NOTICES.md` follows noq.
- **Local stash for e2e:** `ensure-local-stash.sh` stops expecting a `~/trail-stash` checkout
  (`TRAIL_STASH_REPO`) and builds `-p trail-stash` from this tree.
- trail-stash's `PUBLISHING.md` is obsolete (it describes splitting the repo out) and is deleted;
  `INSTALL.md`, `PLAN.md` and the chart README move with the server.

## Sequence

### 0. Close out trail-stash (June)

1. Land or close what is open. **#9 should land**: it carries the roster closing rule
   (an uninvited `Enroll` concurrent with `SetPolicy(Invite)` ends) and the console claim QR.
   Merging deploys as usual (`:latest`).
2. Optionally tag `v0.3.1` so the archived repo ends on a release that matches the last image.
3. Note the final `main` SHA; it goes in the import PR's description.
4. **Archive** the repo (Settings → Archive), with a README line pointing here. **Do not delete
   it**: the GHCR packages are linked to it, and this repo's `Cargo.toml` resolves
   `streetcryptid-repeater` from its `v0.3.0` tag until PR B lands. Archived repos still clone.
5. Grant this repo write access on both GHCR packages (above).

### PR A — import, with history

In a scratch clone of trail-stash:

```bash
# pass 1: drop what this repo already has, or what no longer applies
git filter-repo --invert-paths   --path .github --path LICENSE --path PUBLISHING.md --path .gitignore --path .gitattributes
# pass 2: move everything into place and rename the tags
git filter-repo   --path-rename rust/repeater/:repeater/protocol/   --path-rename rust/:repeater/server/   --path-rename charts/:repeater/server/charts/   --path-rename AGENTS.md:repeater/server/AGENTS.md   --path-rename CLAUDE.md:repeater/server/CLAUDE.md   --path-rename README.md:repeater/server/README.md   --path-rename INSTALL.md:repeater/server/INSTALL.md   --path-rename PLAN.md:repeater/server/PLAN.md   --path-rename NOTICE:repeater/server/NOTICE   --tag-rename v:server-v
```

The order of the first two renames matters: `rust/repeater/` must be claimed before `rust/`.
Then, here, on a branch from `main`:
`git fetch <scratch> 'refs/tags/*:refs/tags/*' main && git merge --allow-unrelated-histories`.
Check `git tag -l 'v0.*'` is empty afterwards.

On top, in the same PR:

- a fix-up commit so the tip builds: the server's `[workspace] members = ["repeater"]` and its
  path dependency now point at `../protocol`; for this PR the server stays its **own** workspace
  with its own `Cargo.lock` (still iroh 1.0.2), so the merge is deploy-neutral;
- the CI dispatcher (`ci.yml` → `ci-app.yml` + `ci-repeater-server.yml`, `Required` accepting
  skips) and `release-repeater-server.yml` (moved `publish.yml`, path-gated, `server-v*`);
- the `next-version.sh` scoping and tests.

Historical commits under `repeater/server/` will not build at their own revision (the protocol
crate moved beside them); only the tip has to.

### PR B — one workspace

- The root `Cargo.toml`, `rust-toolchain.toml`, `rustfmt.toml`; noq moved to `third_party/`; the
  server's and the wasm crate's lockfiles deleted; the app's protocol dependency by path; the
  `target/` references; the native-cache digest and its test; the Dockerfile and `.dockerignore`.
- Protocol golden vectors.
- **Merging this deploys the hosted stash on iroh 1.4.1 with the noq patch** (main push →
  `:latest` → digest policy). Before merging, run the server against the phones locally
  (`just e2e-local-stash`, the network-chaos scenarios) and watch `peer.contact{role=stash}` and
  the stash's `content_missing` after rollout.

### PR C — the Windows client

- `apps/repeater` lands as `repeater/windows` (`windows/` → `app/`, `native/` → `host/`, a
  workspace member). It has never been committed, so the vendor/patch machinery never enters
  history: `prepare-runtime.ps1`, `test-prepare-runtime.ps1`, `vendor/`, `native/upstream/` and
  `memory-repeater.patch` are not added. `NOTICE` drops the pinned-SHA paragraph.
- The patch lands on `repeater/server` as reviewable commits, each with its tests:
  1. `Storage::MemoryRepeater` — RAM ciphertext and replica, durable roster and grants;
  2. register namespace watchers before starting live sync (fix; benefits the hosted stash);
  3. releasing one namespace keeps another's missing shared content tracked (fix);
  4. bounded arrival notifications;
  5. local receive opt-outs (see below — land it, or drop it, deliberately);
  6. the multi-writer/multi-reader forwarding and restart tests.
- The claim URL comes from the server crate instead of being formatted again in the host.
- `ci-repeater-windows.yml` and `release-repeater-windows.yml` (`windows-v*`).

### PR D — tidy

`.editorconfig`, `actionlint`, `dotnet format`, just modules, the agent docs, the e2e scripts, the
`docs/social/REPEATERS.md` header (which still says "trail-stash PR #7/#8"), and memory/README
references to the old repo.

## Not in this plan

These came out of the same review and are design questions, not moves:

- **The Windows client keeps less than §5.1 says a repeater keeps** — RAM only, the stash's
  latest-fix/48 h retention, against "everything granted, on disk, until released". Either
  record it in `REPEATERS.md` as the desktop's mode or give the desktop disk storage.
- **A local "unsubscribe" contradicts the signed roster**: the member's cards and "Available
  through friends" keep saying this machine carries them. Make it a roster-visible operation or
  drop it.
- **The Windows host has no telemetry at all.** Compile the server's `otel` feature into our own
  builds only, the same build-time gate the phone uses.
- **The host lives and dies with a logged-in UI**; `REPEATERS.md` §9 lists a Windows service.
- **Unsigned auto-updates** on a machine holding an identity key make code signing a release gate.
- Renaming `trail-stash` (crate, image, chart, env) to the repeater it has become.
