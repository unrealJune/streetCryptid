# Map renderer performance over time

## Headline

The first accepted pass keeps the UI-thread bitmap transform at 60 fps and cuts measured zoom
latency by 49-81% by coalescing scale-motion prefetches. It is not yet a smooth map experience:
the best cached zoom still takes 1.47 seconds and pan prefetch can starve Hermes for tens of
seconds. The dominant remaining cost is synchronous H3 region construction, not tile merging
or the final Skia raster.

| Accepted point                        |  Launch | Zoom out, new | Zoom in | Zoom out, cached | Pan, new | Pan, cached |
| ------------------------------------- | ------: | ------------: | ------: | ---------------: | -------: | ----------: |
| Baseline (`copilot/map-perf-harness`) | 3.076 s |       5.963 s | 7.999 s |          7.747 s |  5.847 s |     6.253 s |
| Coalesced zoom prefetch               |       - |       3.065 s | 1.833 s |          1.465 s |     open |        open |

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

## Experiment journal

| Branch / attempt                                        | Hypothesis                                                            | Result                                                                                                                                                                                | Decision                                                                                                                                                     |
| ------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Pre-harness `scripts/profile-scene.ts`                  | Existing script could supply a baseline.                              | Failed under Bun on React Native's Flow-only `import typeof`. It also measured only one camera.                                                                                       | Replaced with a pure six-scenario host harness that does not import native React Native modules.                                                             |
| `copilot/map-perf-harness`, pilot `ios-baseline-cold-1` | First automated camera sequence would cover all scenarios.            | Zoom/pan data exposed the bottleneck, but horizontal pan timed out because completion was attached to unchanged Y translation. Async metrics could also spill into the next scenario. | Corrected callback selection, distance-based pans, target coverage checks, and per-scenario async metric scopes; pilot numbers are not used as the baseline. |
| Instruments `Animation Hitches`                         | Native hitch counts could supplement UI frame callbacks.              | Recording failed because the template is unsupported on iOS Simulator.                                                                                                                | Retained the failure here; use Time Profiler plus Reanimated UI frame data on simulator.                                                                     |
| Instruments `Time Profiler`                             | A native CPU trace can validate the thread-level profile.             | Recorded successfully for 45 seconds. No `>250 ms` main-thread hang rows were emitted; the long stalls are on the React Native JavaScript thread.                                     | Retained as the native baseline artifact.                                                                                                                    |
| `copilot/map-perf-zoom-prefetch`, naive                 | Skip all scale-motion region builds and render only the final target. | Zoom latency fell, but extreme zoom-out exposed 20 blank frames before the final build landed.                                                                                        | Rejected; retained coverage is mandatory.                                                                                                                    |
| `copilot/map-perf-zoom-prefetch`, thresholded           | Coalesce scale builds to one coverage prefetch plus the final commit. | Zoom latency fell 49-81%, UI remained 60 fps, and all zero-gap simulations passed.                                                                                                    | Accepted.                                                                                                                                                    |

## Next measured hypotheses

1. Coalesce translation prefetch so a deliberate pan cannot queue region builds faster than
   Hermes can construct them.
2. Cache complete H3 region fields or move immutable field construction out of Hermes so a
   warm final region does not spend about one second rebuilding identical cells.
3. Batch SQLite bundle writes in an exclusive WAL transaction and measure cold source time.
4. Remove SVG string construction/parsing from lattice, rim, and feature masks if Skia remains
   above the post-H3 budget.
5. Stabilize trail/locator geometry identity and batch trail dots to eliminate asynchronous
   overlay remounts and the reported visual jump.
