import { scaleFor } from '../core/camera';
import type { CameraState, Viewport } from '../core/types';

export const MAP_PERF_LOG_PREFIX = '[map-perf] ';
export const MAP_PERF_FRAME_BUDGET_MS = 1000 / 60;

export type MapPerfScenarioName =
  'launch' | 'zoom-out-new' | 'zoom-in' | 'zoom-out-cached' | 'pan-new' | 'pan-cached';

export interface MapPerfScenario {
  readonly name: Exclude<MapPerfScenarioName, 'launch'>;
  readonly camera: CameraState;
  readonly durationMs: number;
}

export interface MapPipelineMetrics {
  memoryCacheHits: number;
  memoryCacheMisses: number;
  memoryInFlightHits: number;
  storeFreshHits: number;
  storeStaleHits: number;
  storeMisses: number;
  storeReadMs: number;
  storeWriteMs: number;
  coarseRequests: number;
  bundleRequests: number;
  networkMs: number;
  bundleParseMs: number;
  responseBytes: number;
  byteLoadMs: number;
  tileDecodeCalls: number;
  tileDecodeMs: number;
  nativeDecodeCalls: number;
  nativeDecodeMs: number;
  nativeH3Calls: number;
  nativeH3Ms: number;
  nativeH3Cells: number;
  unalignedScg1Copies: number;
}

export interface MapPerfMetricScope {
  metrics: MapPipelineMetrics;
}

export interface RegionRenderTiming {
  readonly cacheHit: boolean;
  readonly maskMs: number;
  readonly cellTextureMs: number;
  readonly rasterMs: number;
  readonly totalMs: number;
}

export interface FrameSummary {
  readonly frames: number;
  readonly averageFrameMs: number;
  readonly maxFrameMs: number;
  readonly overBudgetFrames: number;
  readonly estimatedDroppedFrames: number;
}

const DEV = typeof __DEV__ !== 'undefined' ? __DEV__ : process.env.NODE_ENV !== 'production';
let runId = process.env.EXPO_PUBLIC_MAP_PERF_RUN?.trim() ?? '';

let scenario: MapPerfScenarioName = 'launch';
let metricScope: MapPerfMetricScope = { metrics: emptyPipeline() };

export function isMapPerfRunEnabled(): boolean {
  return DEV && runId.length > 0;
}

export function mapPerfRunId(): string | null {
  return isMapPerfRunEnabled() ? runId : null;
}

/** Host harness override; the app uses the statically inlined EXPO_PUBLIC value. */
export function configureMapPerfRun(nextRunId: string): void {
  runId = nextRunId.trim();
}

export function beginMapPerfScenario(next: MapPerfScenarioName): void {
  if (!isMapPerfRunEnabled()) return;
  scenario = next;
  metricScope = { metrics: emptyPipeline() };
  emitMapPerfEvent('scenario-start', {});
}

export function captureMapPerfMetricScope(): MapPerfMetricScope | null {
  return isMapPerfRunEnabled() ? metricScope : null;
}

export function addMapPerfMetric<K extends keyof MapPipelineMetrics>(
  key: K,
  value = 1,
  scope: MapPerfMetricScope | null = captureMapPerfMetricScope()
): void {
  if (!scope) return;
  scope.metrics[key] += value;
}

export function snapshotMapPerfPipeline(): Readonly<MapPipelineMetrics> {
  return { ...metricScope.metrics };
}

export function emitMapPerfEvent(type: string, detail: Readonly<Record<string, unknown>>): void {
  if (!isMapPerfRunEnabled()) return;
  console.log(
    `${MAP_PERF_LOG_PREFIX}${JSON.stringify({
      version: 1,
      runId,
      scenario,
      type,
      atMs: perfNow(),
      ...detail,
    })}`
  );
}

export function perfNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export function summarizeFrameDeltas(
  deltas: readonly number[],
  budgetMs = MAP_PERF_FRAME_BUDGET_MS
): FrameSummary {
  if (deltas.length === 0) {
    return {
      frames: 0,
      averageFrameMs: 0,
      maxFrameMs: 0,
      overBudgetFrames: 0,
      estimatedDroppedFrames: 0,
    };
  }

  let total = 0;
  let max = 0;
  let overBudget = 0;
  let dropped = 0;
  for (const delta of deltas) {
    total += delta;
    max = Math.max(max, delta);
    if (delta > budgetMs * 1.25) overBudget++;
    dropped += Math.max(0, Math.round(delta / budgetMs) - 1);
  }
  return {
    frames: deltas.length,
    averageFrameMs: total / deltas.length,
    maxFrameMs: max,
    overBudgetFrames: overBudget,
    estimatedDroppedFrames: dropped,
  };
}

/**
 * One deterministic camera sequence used by the host and simulator harnesses.
 * The cold pan crosses into the adjacent fixed z10 privacy bucket; no fine tile
 * coordinate is ever logged. Its duration is distance-based so it models a
 * deliberate pan rather than teleporting several screen widths in 550 ms.
 */
export function createMapPerfScenarios(
  anchor: CameraState,
  _viewport: Viewport
): readonly MapPerfScenario[] {
  const zoomedOut: CameraState = {
    center: anchor.center,
    zoom: Math.max(1, anchor.zoom - 1.4),
  };
  const privacyTiles = 1 << 10;
  const anchorX = Math.floor(anchor.center[0] * privacyTiles);
  const direction = anchorX + 1 < privacyTiles ? 1 : -1;
  const farAnchorX = anchorX + direction;
  const farCenterX = (farAnchorX + 0.5) / privacyTiles;
  const panDistancePx = Math.abs(farCenterX - anchor.center[0]) * scaleFor(zoomedOut.zoom);
  const panDurationMs = Math.max(800, Math.min(3000, (panDistancePx / 1200) * 1000));

  return [
    { name: 'zoom-out-new', camera: zoomedOut, durationMs: 550 },
    { name: 'zoom-in', camera: anchor, durationMs: 550 },
    { name: 'zoom-out-cached', camera: zoomedOut, durationMs: 550 },
    {
      name: 'pan-new',
      camera: { center: [farCenterX, zoomedOut.center[1]], zoom: zoomedOut.zoom },
      durationMs: panDurationMs,
    },
    { name: 'pan-cached', camera: zoomedOut, durationMs: panDurationMs },
  ];
}

function emptyPipeline(): MapPipelineMetrics {
  return {
    memoryCacheHits: 0,
    memoryCacheMisses: 0,
    memoryInFlightHits: 0,
    storeFreshHits: 0,
    storeStaleHits: 0,
    storeMisses: 0,
    storeReadMs: 0,
    storeWriteMs: 0,
    coarseRequests: 0,
    bundleRequests: 0,
    networkMs: 0,
    bundleParseMs: 0,
    responseBytes: 0,
    byteLoadMs: 0,
    tileDecodeCalls: 0,
    tileDecodeMs: 0,
    nativeDecodeCalls: 0,
    nativeDecodeMs: 0,
    nativeH3Calls: 0,
    nativeH3Ms: 0,
    nativeH3Cells: 0,
    unalignedScg1Copies: 0,
  };
}
