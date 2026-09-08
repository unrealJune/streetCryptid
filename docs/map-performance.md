# Map renderer performance over time

## September 7: buildings, deep zoom, and stalled tile loading

Baseline: `96aafe6` (v2.8.1). These results are separate from the older simulator
campaign below; its headline is not a measurement of current main.

The September building layer exposed whole-tile SVG work on every region swap.
OpenMapTiles batches hundreds of disconnected footprints into a single
MultiPolygon, so feature-level culling alone was insufficient. Cached tile-local
feature AND ring bounds now reject geometry outside the padded render region,
including stroke/antialiasing margins. Crossing lines, enclosing polygons, holes,
and non-zero winding remain intact. The building fill, hatch clip, and outline
also reuse one parsed Skia path instead of parsing the same SVG three times.

### Frozen-tile CPU comparison (host, not frame rate)

Downtown Seattle, 390 x 780 logical viewport, unchanged layer settings and zooms.
Real MVT inputs were saved once and replayed before/after, excluding network and
decode. Each path builder ran once to warm up, then 25 timed iterations; the table
reports medians in Bun 1.3.14 on the same Mac.

| Work                       |   Before |   After | Reduction |
| -------------------------- | -------: | ------: | --------: |
| z15 feature-mask paths     | 10.46 ms | 3.95 ms |       62% |
| z15 building/aeroway paths | 26.28 ms | 8.02 ms |       69% |
| z16 feature-mask paths     | 13.59 ms | 6.14 ms |       55% |
| z16 building/aeroway paths | 29.07 ms | 6.85 ms |       76% |
| z18 feature-mask paths     |  4.00 ms | 0.62 ms |       84% |
| z18 building/aeroway paths |  4.52 ms | 0.60 ms |       87% |

Structure SVG output shrank from 1,923,929 to 560,418 characters at z15 and from
2,216,088 to 445,029 at z16. This reduces both JS string work and native path
parsing; the host timings above measure only the former, not Skia/GPU or device
FPS. Matching `just map-shot --places seattle --zooms 15,17,18 --labels --highways`
renders were pixel-identical at z15/z17. At z18, 38 of 4,867,200 RGBA channels
differed, by at most 2/255 (raster-edge rounding), without a quality reduction.

### Loading and close-zoom recovery

The new camera-z16 detail threshold requests data-z14 rather than z13. A measured
fixed-z10 Seattle bundle grows from 3,364,329 to 22,340,257 bytes (6.64x). An
unloaded/failed detail bundle previously left the z15 bitmap magnified at z18.
Cold zoom-ins now publish a target-resolution raster of already-covered vectors
before detailed bytes arrive. Its actual data zoom remains unchanged, so it does
not masquerade as full detail. Missing detail and initial load failures retry
after 1, 3, and 10 seconds, bounded and cancelled when the target changes or the
screen unmounts. Monotonic publications prevent older prefetch completions from
overwriting a newer sharp preview.

HTTP deadlines cover headers AND body and explicitly reject even if native
fetch ignores abort: 30 seconds for coarse tiles and 60 seconds for bundles.
Supplying a cancellation signal no longer disables the coarse timeout; each
shared-cache waiter can cancel independently. A rejected request releases its
in-flight entry so retry is possible. Stale offline bytes remain usable.

SQLite persists the complete validated bundle atomically, but batches up to 124
rows per statement (992 parameters, below the portable 999 limit). Concurrent
bundle writes are serialized to avoid competing exclusive transactions.

| Bundle         | INSERT statements, before → after | Expo prepare/execute/finalize calls | Host SQLite median, before → after |
| -------------- | --------------------------------: | ----------------------------------: | ---------------------------------: |
| z13, 64 tiles  |                            64 → 1 |                             192 → 3 |                     1.50 → 1.23 ms |
| z14, 256 tiles |                           256 → 3 |                             768 → 9 |                     6.78 → 5.88 ms |

The SQLite timings are five-run medians using real in-memory SQLite under Bun,
with all persisted bytes compared, not Hermes/bridge measurements. Native-call
counts follow Expo SQLite's three calls per `runAsync`; they are not a claim of
an equivalent wall-clock speedup. Observed live network fetches were 1.04/1.15 s
for z13/z14 respectively: that single sample does not establish server-load
history or explain every field report. Privacy remains fixed-z10 bundles; no
fine-child XYZ requests, TTL reductions, or dropped descendants were introduced.

### Native comparison, first iteration

Three warm, interleaved pairs on the same iPhone 16 Pro simulator, iOS 18.3.1,
402 x 874 logical viewport, Hermes/Skia/Reanimated and native MVT/H3 enabled.
Each sample starts a fresh process with the same isolated public-Seattle harness.
Baseline is `96aafe6`; first implementation is `65bd286`. All 12 scenarios
completed, all timed scenarios had zero tile-network requests, and wall-clock
versus monotonic elapsed drift was at most 1 ms. Samples ran September 8,
15:30-15:34 UTC, after measurement resumed. These are simulator measurements,
not measurements from the physical phone.

| Median metric                        |   Before | First iteration |
| ------------------------------------ | -------: | --------------: |
| Warm launch to painted map           |   608 ms |          579 ms |
| z18 final Skia build                 |  67.4 ms |         41.4 ms |
| Cached z16 final Skia build          | 170.7 ms |        120.4 ms |
| Cached z18 pan, worst JS frame gap   |   265 ms |           87 ms |
| Broad cached pan, worst JS frame gap | 2,220 ms |        2,118 ms |
| Broad cached pan, motion + settle    | 3,283 ms |        3,283 ms |
| First z16 zoom, motion + settle      |   899 ms |          932 ms |

The first z16 zoom regressed by 33 ms: a decoded-cache miss now paints a coarse
preview and then the fine region, even when bytes are already on disk. This is
the cost of keeping slow/offline deep zoom sharp, not a hidden win. Broad-pan
responsiveness also remains a problem: smaller SVG work did not break the
back-to-back JS work, and a roughly 2.1-second RAF gap remains despite a mostly
smooth UI-thread transform. The next experiment targets that scheduling chain.
Launch's JS sampler begins after some synchronous setup and understates initial
blocking, so its tiny RAF gaps are not used as launch responsiveness claims.

Raw samples are `native-{baseline,after}-clean-{2,3,4}.jsonl`, summarized in
`native-map-report.json` in the session artifacts. Pair 1 is warm-up; earlier
non-clean/paused recordings are excluded. A warm-up zoom callback failed to fire
once despite covered geometry; it is retained as a harness anomaly, not reported
as a proven tile-load failure.

### Second iteration: give the JS event loop a frame between region builds

Cached pans were chaining 7-8 region builds and React/Skia renders through
immediately resolved promises. Reducing each SVG did not stop the chain from
starving input and JS RAF callbacks. The engine now yields to the next animation
frame before cell/region assembly, keeping the existing one-deep queue occupied
so there is no parallel-build burst. `yieldMs` records scheduling time separately
from H3 work. No geometry, quality setting, or pan headroom was removed.

The first yield pilot exposed a measurement bug: a sharp z13-data preview could
satisfy the z16 camera/coverage checks before z14 detail arrived. Those apparent
~717 ms z16 completions are **not accepted full-detail timings**. The harness now
requires the dataset's actual requested tile zoom, and the same corrected
harness was applied to main, iteration one, and the yield variant.

The authoritative comparison is nine accepted runs: three interleaved triplets
with alternating order, fresh native processes and the same simulator/harness
as above. The warm-up triplet is discarded. All 108 measured scenarios completed
at their required detail, all used native decoding, and timed tile-network
requests were zero. Maximum wall/monotonic drift was 13 ms (guard: 50 ms).
Measurement window: September 8, 16:04-16:08 UTC.

| Median metric                                   |     Main | First iteration | Second iteration |
| ----------------------------------------------- | -------: | --------------: | ---------------: |
| Warm launch to painted map                      |   616 ms |          597 ms |           605 ms |
| Broad cached pan, worst JS gap                  | 2,246 ms |        2,105 ms |       **316 ms** |
| Broad pan into new decoded ground, worst JS gap |   782 ms |          742 ms |       **541 ms** |
| Broad cached pan, motion + settle               | 3,266 ms |        3,283 ms |         3,282 ms |
| Cached z18 pan, worst JS gap                    |   282 ms |           89 ms |        **81 ms** |
| Cached z16 zoom, motion + settle                |   849 ms |          798 ms |       **777 ms** |
| z18 final Skia build                            |  63.9 ms |         46.1 ms |          50.5 ms |
| Cached z16 final Skia build                     | 176.5 ms |        123.7 ms |         114.8 ms |
| First z16 zoom, full-detail motion + settle     |   915 ms |          935 ms |       **982 ms** |

The broad cached-pan JS gap is **86% smaller than main** and **85% smaller than
iteration one**, without lengthening the requested three-second pan materially.
All three yield runs recorded zero dropped UI frames during pan/zoom scenarios.
This is not a claim of a 60 fps JS thread: zoom-out still has ~500-620 ms JS
gaps, and some individual renders remain ~200 ms. The first z16 detail load is
67 ms slower than main because preview + detail + scheduling is more work;
the preview remains worth keeping for slow/offline loads, but that tradeoff is
explicit. Launch's RAF metric is not comparable because yielding makes setup
work visible to a sampler that previously missed it.

Accepted run metadata, per-scenario samples, medians, exclusions, and the measured
engine SHA-256 are committed in
[`map-performance-2026-09-08.json`](map-performance-2026-09-08.json).
Raw session files are `native-v3-{baseline,iteration-one,yield}-{1,2,3}.jsonl`
with `native-v3-manifest.json`.

For reproduction, use `scripts/native-map-perf.tsx` as the entry **in isolated
source copies**, not the production entry. Set `EXPO_PUBLIC_MAP_PERF_RUN` and
`EXPO_PUBLIC_MAP_PERF_DEEP_ZOOM=1`, explicitly load the live tile configuration,
and capture `[map-perf]` JSON while restarting the same native dev shell between
variants. Warm all three variants before timing; verify native decoder calls,
full-detail target completion, and wall/monotonic drift before admitting samples.

### Experiment notebook

| Experiment                                                                   | Observation                                                                                                              | Decision                                                                                                  |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Cull whole features only                                                     | z15 structure SVG stayed at 1.92 million characters: OMT combines hundreds of disconnected buildings into one feature.   | Rejected as insufficient; add conservative per-ring bounds.                                               |
| Cull features and rings; reuse the building path                             | z15/z16 building-path CPU fell 69%/76%, with unchanged visible geometry.                                                 | Keep; measure the actual native renderer separately.                                                      |
| Treat a prefetch headroom check as failed-build detection                    | Successful z10 builds retried because their intentional 0.2 padding is smaller than the 0.35 prefetch margin.            | Rejected; recovery uses region validity, not proactive headroom.                                          |
| Retry only against the last committed camera                                 | A live pan could succeed, then an old retry could rebuild the previous camera.                                           | Rejected; live movement invalidates the retry episode.                                                    |
| Assume newer callbacks always carry newer regions                            | An older prefetch completion could replace a queued, sharper preview.                                                    | Rejected; all publications carry a monotonic engine sequence.                                             |
| Attribute cached-pan stalls to server load                                   | Diagnostic native runs showed multi-second JS frame gaps with zero network requests and 7-8 back-to-back region renders. | Server load is not the sole cause; profile JS scheduling and per-build work next.                         |
| Use every recorded native run as a comparison                                | Some runs contain long wall-clock gaps, timeouts, or uncertain timing relative to the requested pause.                   | Preserve raw data, exclude these from performance claims, and collect fresh matched runs.                 |
| Yield between cached region builds                                           | Corrected native comparison cuts broad cached-pan JS gaps from 2,105 to 316 ms versus iteration one.                     | Keep; the queue remains bounded and pan duration is effectively unchanged.                                |
| Finish a benchmark when only camera zoom/coverage matches                    | The sharper coarse preview ended z16 timing before fine detail arrived.                                                  | Reject those apparent zoom wins; require actual data zoom and rerun all variants with the same predicate. |
| Launch isolated copies without explicitly loading tile configuration         | The fixture fallback clamped broad pans to fixture bounds and timed out.                                                 | Exclude the pilot; load the live environment explicitly and reject runs without native tile decode.       |
| Interpret the increased launch RAF gap after yielding as a launch regression | The old sampler missed synchronous setup; total launch remains ~600 ms.                                                  | Do not compare that RAF metric across variants; report time to painted map instead.                       |

## Headline

Eight accepted passes keep the UI-thread bitmap transform at 60 fps, cut measured zoom latency
by up to 90%, and bring both pans to about 3.27 seconds including their requested 3-second
motion. Warm launch is 1.03 seconds, an exact zoom revisit is 0.77 seconds, and cached region
settles are now 201-266 ms. The dominant remaining synchronous cost is the 165-266 ms Skia
bitmap build plus first-visit H3 annotation; polygon enumeration no longer blocks Hermes.

| Accepted point                        |  Launch | Zoom out, new | Zoom in | Zoom out, cached | Pan, new | Pan, cached |
| ------------------------------------- | ------: | ------------: | ------: | ---------------: | -------: | ----------: |
| Baseline (`copilot/map-perf-harness`) | 3.076 s |       5.963 s | 7.999 s |          7.747 s |  5.847 s |     6.253 s |
| Coalesced zoom prefetch               |       - |       3.065 s | 1.833 s |          1.465 s |     open |        open |
| Coalesced engine queue                |       - |       1.964 s | 1.884 s |          1.497 s |     open |        open |
| UI-to-JS prefetch backpressure        |       - |             - |       - |                - |  4.431 s |     4.225 s |
| Exact cell-field LRU                  |       - |             - | 0.931 s |                - |        - |           - |
| Native H3 enumeration                 | 1.031 s |       1.998 s | 0.919 s |          0.882 s |  3.266 s |     3.262 s |
| Rendered-bundle LRU                   |       - |             - | 0.766 s |                - |        - |           - |
| Final iOS integration                 | 1.031 s |       1.998 s | 0.766 s |          0.882 s |  3.266 s |     3.262 s |

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

## Pass 8: bounded rendered-bundle reuse

Run ID: `ios-render-cache-1`.

`MapView` now retains three rendered bundles and reuses one only when region bounds, build zoom,
mask dimensions, immutable packed tile parts, cell-field object, palette texture, and
exploration mode all match exactly. Exact zoom-in revisit fell from 919 ms to 766 ms (-16.6%).
Its post-motion settle fell from 366 ms to 201 ms (-45.1%), render work fell to zero, and the
worst JS frame fell from 347 ms to 172 ms. Non-identical zoom and pan regions correctly missed
the cache and stayed within noise. Capacity is fixed at three GPU bundles.

## Cross-platform final validation

### Android API 36 emulator

The merged app was compiled with the arm64 Rust library, installed on an API 36 ARM emulator,
and run through the same automated camera sequence. The final run used the host Apple M2
Vulkan/Metal backend and already-persisted tile bytes after one-time profile, disclosure, and
permission onboarding.

| Scenario         | Android total | Post-motion settle | UI dropped |
| ---------------- | ------------: | -----------------: | ---------: |
| Warm launch      |       2752 ms |            2752 ms |         10 |
| Zoom out, warm   |        921 ms |             291 ms |          0 |
| Zoom in          |       1064 ms |             484 ms |          0 |
| Zoom out, cached |        927 ms |             133 ms |          0 |
| Pan, new         |       3238 ms |             204 ms |          0 |
| Pan, cached      |       3192 ms |              23 ms |          2 |

Native H3 enumeration is active on Android (typically 6-13 ms per final region). Zoom and cold
pan animation stay at 60 fps on the host-GPU emulator; cached pan recorded two dropped frames.
Android Skia remains slower than iOS in this debug emulator (roughly 222-342 ms for settled
regions), while the camera stays responsive because the bitmap transform remains UI-thread
owned.

An earlier headless SwiftShader run averaged 22-34 ms UI frames and took 0.8-2.3 seconds per
Skia render. It was rejected as a platform comparison: the software GPU, not app code, was the
bottleneck. The host-GPU rerun above is the Android result used for final validation.

Kotlin and Swift UniFFI bindings match the Rust API. The native core cross-compiles for Android
arm64-v8a, armeabi-v7a, and x86_64; the iOS XCFramework and Android debug app both compile and
load the new export.

### Network interpretation

Cold network timings vary independently of renderer work (observed launch network spans ranged
from about 1.1 to 5.3 seconds). New areas keep the previous bitmap interactive and show the
existing pulsing requested-area tint followed by the hex reveal. Warm operations issue no tile
request; z11-z14 cold misses still expose only one fixed z10 SCB1 ancestor per data zoom.

## Rejected: direct Skia feature-mask paths

Run ID: `ios-direct-mask-1`.

Replacing SVG path strings and `MakeFromSVGString` with direct `moveTo`/`lineTo` calls was not
consistently faster. Launch mask time regressed from 84.1 ms to 94.9 ms, cached zoom from
119.1 ms to 126.8 ms, and cold zoom from 110.0 ms to 115.9 ms. One cached-pan sample improved
from 159.0 ms to 125.7 ms, but that did not offset the other regressions. Thousands of
JS-to-JSI calls cost at least as much as the batched SVG parse, so branch
`copilot/map-perf-direct-mask-paths` is retained but unmerged.

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
| `copilot/map-perf-render-bundle-cache`                  | Reuse exact immutable GPU region bundles in a three-entry LRU.                    | Exact zoom settle fell 45.1%, with zero reraster work and no effect on non-identical regions.                                                                                         | Accepted.                                                                                                                                                    |
| `copilot/map-perf-direct-mask-paths`                    | Avoid SVG construction/parsing with direct Skia path commands.                    | Three mask scenarios regressed 5-13%; one improved 21%, consistent with per-point JSI overhead.                                                                                       | Rejected and left unmerged.                                                                                                                                  |

## Remaining device validation

Physical-device GPU/thermal profiling remains valuable before changing the now-sub-300 ms
cached settle path. Simulator `Animation Hitches` is unsupported, so this work used Reanimated
UI-frame timestamps plus an iOS Time Profiler trace. The retained batched SVG masks should not
be replaced without device evidence.
