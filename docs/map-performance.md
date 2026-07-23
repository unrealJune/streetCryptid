# Map renderer performance over time

## Headline

Five accepted passes keep the UI-thread bitmap transform at 60 fps, cut measured zoom latency
by up to 89%, and bring both pans to about 3.27 seconds including their requested 3-second
motion. Warm launch is 1.03 seconds and cached region settles are now 247-266 ms. The dominant
remaining synchronous cost is the 165-266 ms Skia bitmap build plus first-visit H3 annotation;
polygon enumeration no longer blocks Hermes.

| Accepted point                        |  Launch | Zoom out, new | Zoom in | Zoom out, cached | Pan, new | Pan, cached |
| ------------------------------------- | ------: | ------------: | ------: | ---------------: | -------: | ----------: |
| Baseline (`copilot/map-perf-harness`) | 3.076 s |       5.963 s | 7.999 s |          7.747 s |  5.847 s |     6.253 s |
| Coalesced zoom prefetch               |       - |       3.065 s | 1.833 s |          1.465 s |     open |        open |
| Coalesced engine queue                |       - |       1.964 s | 1.884 s |          1.497 s |     open |        open |
| UI-to-JS prefetch backpressure        |       - |             - |       - |                - |  4.431 s |     4.225 s |
| Exact cell-field LRU                  |       - |             - | 0.931 s |                - |        - |           - |
| Native H3 enumeration                 | 1.031 s |       1.998 s | 0.919 s |          0.882 s |  3.266 s |     3.262 s |

Target: a 60 fps UI and responsive JS thread throughout every operation, with cached settles
below 300 ms and cold network/decode hidden behind retained coverage plus the hex loading
reveal. Every later experiment is appended below, including rejected attempts.

## Measurement protocol

### Environment

- App: Expo SDK 57.0.7 dev client, React Native 0.86.0, Hermes, Skia 2.6.2,
  Reanimated 4.5.0.
- iOS: simulated iPhone 16 Pro, iOS 18.3.1, Xcode/Instruments 26.0.
- Host: Apple Silicon MacBook Air, macOS 15.7.3, Bun 1.3.14, Rust 1.97.1.
- Dataset: live global tile source with an empty durable tile cache for the cold run.
- Run ID: `ios-baseline-cold-3`.
- The Metro bundle was warm before timing. App-process launch and dev-client loading are not
  included in the in-app launch number; the timer begins when `MapView` mounts.

### Deterministic sequence

The in-app harness drives the production Reanimated transform and region lifecycle:

1. Initial region to first painted bitmap.
2. Zoom out 1.4 levels into uncached data.
3. Zoom back in to the initial area.
4. Repeat the same zoom out with decoded tiles cached.
5. Deliberately pan into the adjacent fixed z10 privacy bucket.
6. Pan back to the already visited area.

The zoom animations request 550 ms. Pans use a distance-based duration at about 1200 px/s.
Each result ends only after a new region covering the target camera is painted. JS frame gaps
come from `requestAnimationFrame`; UI frame gaps come from Reanimated's UI-thread
`useFrameCallback`. Engine, cache/network, native decode, and Skia phases use monotonic clocks.

### Privacy and rendering invariants

- z11-z14 misses still issue one SCB1 request identified only by the fixed z10 ancestor and
  requested data zoom.
- Every bundle descendant, including empty tiles, is validated and persisted before use.
- Fine child coordinates are not emitted in profile logs.
- The same MVT bytes, native SCG1 output, H3 cells, dot-field shader, palette, and reveal are
  rendered. No quality or aesthetic setting is reduced for profiling.
- The current and previous region bitmaps remain mounted while new ground loads.

## Baseline detail

### iOS simulator

| Scenario         |   Total | Requested motion |              Post-motion settle | Final engine: source / H3 | Final Skia | Worst JS frame | UI dropped |
| ---------------- | ------: | ---------------: | ------------------------------: | ------------------------: | ---------: | -------------: | ---------: |
| Launch           | 3076 ms |             0 ms |                         3076 ms |            1237 / 1184 ms |     214 ms |        1463 ms |          0 |
| Zoom out, new    | 5963 ms |           550 ms |                         4168 ms |             631 / 1018 ms |     254 ms |        4263 ms |          0 |
| Zoom in          | 7999 ms |           550 ms | 345 ms after a delayed callback |                0 / 792 ms |     173 ms |        7742 ms |          0 |
| Zoom out, cached | 7747 ms |           550 ms | 506 ms after a delayed callback |                0 / 735 ms |     256 ms |        7458 ms |          0 |
| Pan, new         | 5847 ms |          3000 ms |                         2834 ms |             340 / 1023 ms |     145 ms |        3873 ms |          0 |
| Pan, cached      | 6253 ms |          3000 ms |                         2266 ms |                0 / 777 ms |     261 ms |        5582 ms |          1 |

The requested 550 ms zoom callbacks arrive 7.2-7.7 seconds late because the JS thread is
running serial intermediate region builds. Reanimated keeps the already-rendered bitmap
moving at 60 fps, but JS-owned work, data swaps, controls, and overlay reconciliation cannot
respond. The cached zoom is almost as slow as the cold zoom, proving that network is not the
primary interactive bottleneck.

The final region alone spends 0.73-1.18 seconds in `buildCellField` and 0.17-0.26 seconds in
Skia preparation/raster. A single cold launch also spends 1.24 seconds in the tile source.
Native decode for its nine completed tile calls totals 57.9 ms; all returned SCG1 buffers were
4-byte aligned, so the JS alignment-copy fallback did not run.

`Animation Hitches` cannot record against this simulator runtime (`Hitches is not supported on
this platform`). A 45-second `Time Profiler` trace was recorded successfully at
`files/ios-baseline-time-profiler.trace`; the Reanimated sampler is the numeric UI-frame
source for simulator comparisons.

### Host live-pipeline control

The same camera sequence with the live privacy-bundle source, in-memory persistence, JS MVT
decode, and no Skia/native bridge measured:

| Scenario         |     Total | Network requests | Network time (summed) |      H3 |
| ---------------- | --------: | ---------------: | --------------------: | ------: |
| Launch           | 1721.9 ms |         1 bundle |             1666.2 ms | 38.7 ms |
| Zoom out, new    |  622.9 ms |        2 bundles |              757.4 ms | 21.3 ms |
| Zoom in          |    8.4 ms |                0 |                     0 |  8.3 ms |
| Zoom out, cached |    7.6 ms |                0 |                     0 |  7.5 ms |
| Pan, new         |  111.8 ms |         1 bundle |               97.8 ms | 12.8 ms |
| Pan, cached      |    7.2 ms |                0 |                     0 |  7.1 ms |

Network time is summed across concurrent requests and can exceed wall time. The host/simulator
H3 gap (roughly 7-39 ms vs 0.73-1.18 s for final regions) makes Hermes-specific allocation and
interpreter cost a required optimization target.

### Rust protobuf/SCG1 control

Release-mode benchmark (`just profile-mvt`) over committed fixtures:

| Input                                        | Iterations |       p50 |       p95 |       Max |
| -------------------------------------------- | ---------: | --------: | --------: | --------: |
| One 114,460-byte z10 MVT tile                |        200 |  1.093 ms |  1.186 ms |  2.460 ms |
| SCB1 z12 bundle with 16 stress-fixture tiles |         20 | 17.392 ms | 22.421 ms | 24.247 ms |

Pure Rust protobuf parsing and SCG1 encoding are not the current top-level bottleneck. The
simulator still measures the UniFFI/Expo round trip because that cost is absent from this host
control.

## Pass 1: coalesced zoom prefetch

Run ID: `ios-zoom-prefetch-3`.

The first naive variant suppressed every scale-motion prefetch. It reduced build churn but
failed the existing extreme zoom-out simulation with 20 blank frames, so it was rejected.
The accepted variant:

- never prefetches while zooming in because a shrinking viewport cannot expose an outer edge;
- starts one zoom-out prefetch after cumulative scale reaches 0.45x, before the retained
  3x-padded region can expose an edge;
- builds the final committed target normally;
- resets the translation stride origin after scale motion so pan does not inherit stale scale
  distance.

| Scenario         | Baseline |  Pass 1 | Change | Region builds | Worst JS frame | UI dropped |
| ---------------- | -------: | ------: | -----: | ------------: | -------------: | ---------: |
| Zoom out, new    |  5963 ms | 3065 ms | -48.6% |        3 -> 2 |        2100 ms |          0 |
| Zoom in          |  7999 ms | 1833 ms | -77.1% |        5 -> 1 |        1261 ms |          0 |
| Zoom out, cached |  7747 ms | 1465 ms | -81.1% |        5 -> 1 |        1055 ms |          0 |

The cold zoom's requested 550 ms animation callback now arrives in 564 ms instead of 1796 ms.
The zoom-in callback arrives in 565 ms instead of 7653 ms. Coverage simulation still reports
zero blank frames for the extreme zoom-out and every existing pan/fling trajectory.

Pan is intentionally not claimed in this pass. The same run exposed independent translation
prefetch churn: a 3-second cold pan took 9.12 seconds, and the return pan starved the JS callback
past the 30-second harness deadline. That is the next isolated branch, not evidence that tile
fetching or zoom coalescing regressed.

## Pass 2: coalesced engine queue

Run ID: `ios-queue-coalescing-1`.

After an in-flight region lands, the engine now resolves a queued request from that immutable
region when it already satisfies the production coverage and prefetch margins. This removes a
redundant queued final build without changing the one-deep pipeline or canceling useful work.

The cold zoom-out dropped from 3065 ms to 1964 ms (-35.9%) and from two region builds to one.
Zoom-in and cached zoom stayed within noise at 1884 ms and 1497 ms. All engine, interaction,
coverage, and rendering tests passed.

This did not improve pan: the cold pan built nine regions and took 9.23 seconds; the cached
return built 39 regions and crossed the 30-second harness deadline. The profile exposed a
different mechanism. While Hermes constructs H3 fields, Reanimated continues enqueueing
`runOnJS(prefetchAt)` calls. They arrive one at a time after each block, when the engine is no
longer busy, so queue replacement cannot see or supersede the newer callbacks. UI-to-JS
backpressure is required before the engine boundary.

## Pass 3: UI-to-JS prefetch backpressure

Run ID: `ios-pan-backpressure-1`.

The UI thread now marks a region prefetch outstanding before calling `runOnJS`. Additional
translation strides update the local stride origin but do not enqueue more bridge calls until
the prior promise settles. The final camera commit remains independent, so ending a pan while a
prefetch is outstanding still builds or reuses the exact destination.

| Scenario    | Baseline | Before pass 3 |  Pass 3 | Baseline change | Builds before -> after | Worst JS frame | UI dropped |
| ----------- | -------: | ------------: | ------: | --------------: | ---------------------: | -------------: | ---------: |
| Pan, new    |  5847 ms |       9231 ms | 4431 ms |          -24.2% |                 9 -> 3 |        2660 ms |          0 |
| Pan, cached |  6253 ms |     >31909 ms | 4225 ms |          -32.4% |                39 -> 3 |        3586 ms |          0 |

The 3-second cold-pan animation callback now arrives in 3015 ms instead of 6390 ms. The cached
return callback arrives in 3688 ms instead of being starved for more than 31 seconds. No request
pattern changed: the cold pan still made one fixed-z10 SCB1 bundle request and the cached return
made none.

## Pass 4: exact cell-field LRU

Run ID: `ios-cell-cache-1`.

`MapEngine` now retains eight complete immutable H3 fields, keyed by exact region geometry and
the exploration source's monotonic revision. Revisited regions share the same field object.
Advancing exploration changes the key and rebuilds immediately, so discovery state, frontier
rims, and reveal ordering cannot go stale.

The exact launch-region revisit on zoom-in fell from 1884 ms to 931 ms (-50.6%). Its engine H3
phase fell from 941 ms to 0.017 ms, and the worst JS frame fell from 1313 ms to 340 ms. Skia
still spent 169 ms producing the identical-quality bitmap. The UI thread dropped no frames.

The cache deliberately did not claim non-identical regions: zoom-out and pan specs differed at
their edges and remained within noise. This is evidence for profiling H3 enumeration and
annotation separately before attempting canonical regions or native offload.

## H3 phase breakdown

Run ID: `ios-h3-breakdown-1` (warm durable tile bytes).

| Scenario         | Total H3 | Polygon enumeration | Cached centers | Annotation/boundaries | Enumeration share |
| ---------------- | -------: | ------------------: | -------------: | --------------------: | ----------------: |
| Launch           |  1183 ms |              938 ms |          46 ms |                199 ms |             79.3% |
| Zoom out, cached |   654 ms |              639 ms |           2 ms |                 13 ms |             97.8% |
| Pan, new         |  1012 ms |              778 ms |          43 ms |                191 ms |             76.9% |
| Pan, cached      |   815 ms |              779 ms |           6 ms |                 30 ms |             95.6% |

`h3-js` polygon enumeration is 77-98% of uncached cell-field time. On revisited cell geometry,
the remaining JS annotation work is only 13-30 ms. The next optimization should therefore move
polygon-to-cell enumeration off Hermes; rewriting the annotation loops cannot reach the target.

## Pass 5: native H3 enumeration

Run IDs: `ios-native-h3-1` (cold durable bytes) and `ios-native-h3-warm-1`.

The same padded latitude/longitude polygon now runs through Rust `h3o` in an Expo
`AsyncFunction`. It returns sorted canonical H3 IDs; centers, boundaries, exploration
fractions, frontier state, jitter, and reveal order remain in the existing JS/render pipeline.
Web, Expo Go, and older iOS binaries use the unchanged `h3-js` fallback. iOS access is guarded
with `typeof mod.h3CellsForPolygon === 'function'`.

| Scenario         | Before native H3 | Native H3 | Change | Enumeration | Final H3 total | Post-motion settle | UI dropped |
| ---------------- | ---------------: | --------: | -----: | ----------: | -------------: | -----------------: | ---------: |
| Warm launch      |          1967 ms |   1031 ms | -47.6% |      7.0 ms |         273 ms |            1031 ms |          0 |
| Zoom out, cached |          1465 ms |    882 ms | -39.8% |      7.3 ms |          36 ms |             248 ms |          0 |
| Pan, new         |          4431 ms |   3266 ms | -26.3% |      6.5 ms |          27 ms |             250 ms |          0 |
| Pan, cached      |          4225 ms |   3282 ms | -22.3% |      7.0 ms |          48 ms |             266 ms |          1 |

Launch polygon enumeration fell from 938 ms to 8.8 ms in the cold run. Warm zoom-out fell from
639 ms to 7.3 ms. The native launch returned exactly 2,651 cells, matching the JS baseline for
the same region. Native calls are 4-9 ms for one region on this simulator; no fine tile or
location coordinate is logged or sent off-device.

Swift and Kotlin UniFFI bindings were regenerated. The iOS XCFramework/dev client was rebuilt
and profiled. Android arm64-v8a, armeabi-v7a, and x86_64 libraries cross-compile from the same
Rust implementation; the JS fallback remains available when an installed binary predates the
new export.

## Pass 6: exclusive SQLite bundle writes

Run IDs: `ios-sqlite-tx-1` and `ios-sqlite-tx-2`.

Each privacy bundle is now persisted inside one Expo SQLite
`withExclusiveTransactionAsync` scope. Older/native-incompatible implementations retain the
sequential fallback. This does not combine bundles, defer persistence, or change cache keys:
every descendant and known-empty tile is still durable before the requested tile resolves.

Cold launch persistence fell from 63.2 ms to 41.1/30.2 ms (35-52%). The repeated cold zoom
persisted in 26.9/32.6 ms versus 39.4 ms before this pass. One first-run pan showed a 698 ms
contention outlier, but an identical clean-cache repeat completed its bundle writes in 28.7 ms
and the scenario remained 3.27 seconds. Network variance dominates cold wall time, so no
headline camera latency is claimed for this pass.

## Pass 7: stable trails and location overlays

The reported overlay jump had two data/identity causes independent of region placement:

- Uniform resampling recalculated a fractional stride from the latest trail length, replacing
  about half of the immutable interior points after every append.
- First GPS lock changed the React key from `default-centered` to `gps-centered`, destroying
  the complete map, camera transform, trail, and locator subtree.

Sampling now uses a deterministic binary hierarchy ranked by monotonic publish sequence.
Appending a fix can replace at most one previously selected interior point; the first and newest
fix remain guaranteed. Stable `author:seq` IDs flow through to Skia circle keys, so unchanged
historical dots update in place instead of remounting. The default map session key is now
persistent; GPS available before first mount still sets the initial center, while GPS arriving
later updates the live marker without resetting the camera.

For a 200-point trail rendered at a 32-point limit over 60 successive appends, the old sampler
removed exactly 15 historical interior points per append. The new sampler removed 0.13 on
average and never more than one. Existing fixed-anchor interaction tests still report zero
content motion when regions land.

## Experiment journal

| Branch / attempt                                        | Hypothesis                                                                        | Result                                                                                                                                                                                | Decision                                                                                                                                                     |
| ------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Pre-harness `scripts/profile-scene.ts`                  | Existing script could supply a baseline.                                          | Failed under Bun on React Native's Flow-only `import typeof`. It also measured only one camera.                                                                                       | Replaced with a pure six-scenario host harness that does not import native React Native modules.                                                             |
| `copilot/map-perf-harness`, pilot `ios-baseline-cold-1` | First automated camera sequence would cover all scenarios.                        | Zoom/pan data exposed the bottleneck, but horizontal pan timed out because completion was attached to unchanged Y translation. Async metrics could also spill into the next scenario. | Corrected callback selection, distance-based pans, target coverage checks, and per-scenario async metric scopes; pilot numbers are not used as the baseline. |
| Instruments `Animation Hitches`                         | Native hitch counts could supplement UI frame callbacks.                          | Recording failed because the template is unsupported on iOS Simulator.                                                                                                                | Retained the failure here; use Time Profiler plus Reanimated UI frame data on simulator.                                                                     |
| Instruments `Time Profiler`                             | A native CPU trace can validate the thread-level profile.                         | Recorded successfully for 45 seconds. No `>250 ms` main-thread hang rows were emitted; the long stalls are on the React Native JavaScript thread.                                     | Retained as the native baseline artifact.                                                                                                                    |
| `copilot/map-perf-zoom-prefetch`, naive                 | Skip all scale-motion region builds and render only the final target.             | Zoom latency fell, but extreme zoom-out exposed 20 blank frames before the final build landed.                                                                                        | Rejected; retained coverage is mandatory.                                                                                                                    |
| `copilot/map-perf-zoom-prefetch`, thresholded           | Coalesce scale builds to one coverage prefetch plus the final commit.             | Zoom latency fell 49-81%, UI remained 60 fps, and all zero-gap simulations passed.                                                                                                    | Accepted.                                                                                                                                                    |
| `copilot/map-perf-queue-coalescing`                     | Reuse the just-built padded region when it already serves the queued camera.      | Cold zoom-out fell another 35.9%; pan still built 9/39 regions because bridge callbacks reached the engine serially.                                                                  | Accepted for redundant engine work; rejected as the pan solution.                                                                                            |
| `copilot/map-perf-pan-backpressure`                     | Allow only one UI-to-JS prefetch bridge call while a region build is outstanding. | Pan builds fell from 9/39 to 3/3, both scenarios completed, and UI stayed at 60 fps.                                                                                                  | Accepted.                                                                                                                                                    |
| `copilot/map-perf-cell-field-cache`                     | Reuse complete immutable H3 fields for exact region and exploration revisions.    | Exact zoom revisit fell 50.6%; H3 work fell from 941 ms to 0.017 ms without stale exploration.                                                                                        | Accepted.                                                                                                                                                    |
| `copilot/map-perf-h3-breakdown`                         | Time H3 enumeration, centers, and annotation independently.                       | Polygon enumeration is 77-98% of uncached H3 time; warm annotation is only 13-30 ms.                                                                                                  | Accepted instrumentation; native enumeration is the next pass.                                                                                               |
| `copilot/map-perf-native-h3`                            | Run exact center-containment H3 enumeration in Rust off Hermes.                   | Enumeration fell to 4-9 ms, cached settles reached 247-266 ms, and native/JS launch coverage matched at 2,651 cells.                                                                  | Accepted.                                                                                                                                                    |
| `copilot/map-perf-sqlite-transaction`                   | Persist each SCB1 descendant set in one exclusive transaction.                    | Launch writes fell 35-52%; a contention outlier did not reproduce, while request and durability semantics stayed unchanged.                                                           | Accepted as a modest cold-cache win.                                                                                                                         |
| `copilot/map-perf-stable-overlays`                      | Make trail sampling and map component identity stable across appends/first GPS.   | Historical replacements fell from 15 per append to 0.13 average (max 1); first GPS no longer remounts the map.                                                                        | Accepted; fixes the reported trail/location jump.                                                                                                            |

## Next measured hypotheses

1. Remove SVG string construction/parsing from lattice, rim, and feature masks now that Skia is
   above the post-H3 budget.
