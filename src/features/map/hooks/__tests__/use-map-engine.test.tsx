import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { CryptidThemes } from '@/constants/cryptid-theme';

import { createMapDataset, type MapDataset } from '../../config';
import { viewTransformFor } from '../../core/camera';
import { createExplorationIndex } from '../../core/exploration-index';
import {
  computeRegionSpec,
  coversView,
  needsNewRegion,
  shouldPrefetchRegion,
} from '../../core/region';
import type { Viewport, WorldPoint } from '../../core/types';
import {
  MapEngine,
  type BuildProgressListener,
  type MapRegion,
  type RegionRequest,
} from '../../engine/map-engine';
import {
  createDemoExplorationSource,
  type ExplorationSource,
} from '../../exploration/exploration-source';
import { EMPTY_GEOMETRY } from '../../tiles/geometry-source';
import { useMapEngine, type MapEngineState } from '../use-map-engine';
import { useMapTheme } from '../use-map-theme';

jest.mock('../../config', () => ({
  CAMERA_INITIAL_ZOOM: 15,
  createMapDataset: jest.fn(),
}));
jest.mock('../../engine/map-engine', () => ({ MapEngine: jest.fn() }));
jest.mock('../use-map-theme', () => ({ useMapTheme: jest.fn() }));
// Enough grid for the loading skeleton to measure a lattice off: one regular hexagon per cell,
// on a coarse snap. The engine asks for this on every commit, so a bare {} now throws.
jest.mock('../../core/h3-grid', () => {
  const SNAP = 1e4;
  const RADIUS = 1e-4;
  return {
    createH3Grid: jest.fn(() => ({
      cellAt: ([x, y]: [number, number]) =>
        `${Math.round(x * SNAP) / SNAP}:${Math.round(y * SNAP) / SNAP}`,
      centerWorld: (cell: string) => cell.split(':').map(Number) as [number, number],
      boundaryWorld: (cell: string) => {
        const [cx, cy] = cell.split(':').map(Number);
        return Array.from({ length: 6 }, (_, i) => {
          const angle = (Math.PI / 3) * i + Math.PI / 6;
          return [cx + RADIUS * Math.cos(angle), cy + RADIUS * Math.sin(angle)] as [number, number];
        });
      },
    })),
    realH3: jest.fn(() => ({})),
  };
});
jest.mock('../../core/native-h3-enumerator', () => ({
  createNativeH3Enumerator: () => null,
}));
jest.mock('../../core/readout', () => ({
  coverageInView: () => 0,
  coverageMeasurable: () => true,
  nearestPlaceName: () => null,
}));
jest.mock('../../exploration/exploration-source', () => ({
  createDemoExplorationSource: jest.fn(),
  createLiveExplorationSource: jest.fn(),
}));
jest.mock('../../exploration/exploration-store', () => ({
  sharedExplorationStore: jest.fn(),
}));
jest.mock('@/features/social/net/persistence', () => ({
  createPersistentTrailStorage: jest.fn(),
}));
jest.mock('../../perf/map-perf', () => ({ emitMapPerfEvent: jest.fn() }));

const VIEWPORT: Viewport = { width: 390, height: 844 };
const FRIENDS: readonly WorldPoint[] = [];
const DATA_ZOOMS = { min: 0, max: 14 };
const DATASET: MapDataset = {
  source: { getTile: async () => EMPTY_GEOMETRY },
  dataZooms: DATA_ZOOMS,
  bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
  minZoom: 1,
  maxZoom: 18,
  home: [0.5, 0.5],
  explorationMode: 'demo',
};

interface BuildCall {
  readonly request: RegionRequest;
  readonly onProgress?: BuildProgressListener;
  readonly onPreview?: (region: MapRegion) => void;
  readonly resolve: (region: MapRegion | null) => void;
  readonly reject: (error: Error) => void;
}

function regionFor(request: RegionRequest, publication: number, tileZoom?: number): MapRegion {
  const spec = computeRegionSpec(request.camera, request.viewport, { dataZooms: DATA_ZOOMS });
  return {
    publication,
    spec: { ...spec, tileZoom: tileZoom ?? spec.tileZoom },
    geometry: EMPTY_GEOMETRY,
    cellField: { res: 9, cells: [] },
    places: [],
    labels: [],
    explorationVersion: request.explorationVersion,
    timing: {
      tiles: 1,
      coldStart: false,
      cellFieldCacheHit: false,
      sourceMs: 0,
      mergeMs: 0,
      yieldMs: 0,
      cellFieldMs: 0,
      cellEnumerateMs: 0,
      cellCentersMs: 0,
      cellAnnotateMs: 0,
      totalMs: 0,
      fetchMs: 0,
      buildMs: 0,
    },
  };
}

describe('useMapEngine publication and recovery', () => {
  let renderer: ReactTestRenderer | undefined;
  let latest: MapEngineState;
  let calls: BuildCall[];
  let exploration: ExplorationSource;
  const buildRegion = jest.fn<
    ReturnType<MapEngine['buildRegion']>,
    Parameters<MapEngine['buildRegion']>
  >();
  const prefetchAround = jest.fn(async () => {});
  const prefetchPoints = jest.fn(async () => {});

  function Harness() {
    latest = useMapEngine(VIEWPORT, null, null, FRIENDS);
    return null;
  }

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    calls = [];
    const index = createExplorationIndex([]);
    exploration = {
      ready: Promise.resolve(),
      index: () => index,
      version: () => 0,
      subscribe: () => () => {},
      noteSelfFix: jest.fn(),
      backfill: jest.fn(async () => {}),
      dispose: jest.fn(),
    };
    jest.mocked(createMapDataset).mockReturnValue(DATASET);
    jest.mocked(createDemoExplorationSource).mockReturnValue(exploration);
    jest.mocked(useMapTheme).mockReturnValue(CryptidThemes.daybreak);
    buildRegion.mockImplementation(
      (request, onProgress, onPreview) =>
        new Promise((resolve, reject) => {
          calls.push({ request, onProgress, onPreview, resolve, reject });
        })
    );
    jest.mocked(MapEngine).mockImplementation(
      () =>
        ({
          buildRegion,
          prefetchAround,
          prefetchPoints,
        }) as unknown as MapEngine
    );
  });

  afterEach(() => {
    act(() => renderer?.unmount());
    renderer = undefined;
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  async function mount() {
    await act(async () => {
      renderer = create(<Harness />);
    });
    expect(calls).toHaveLength(1);
  }

  async function finish(index: number, region = regionFor(calls[index].request, index + 1)) {
    await act(async () => calls[index].resolve(region));
    return region;
  }

  async function fail(index: number) {
    await act(async () => calls[index].reject(new Error('tile request failed')));
  }

  async function advance(ms: number) {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(ms);
    });
  }

  function transformFor(zoom: number) {
    return viewTransformFor(latest.anchor, VIEWPORT, { ...latest.anchor, zoom });
  }

  function commitZoom(zoom: number) {
    act(() => latest.commit(transformFor(zoom)));
  }

  function prefetchZoom(zoom: number) {
    let pending!: Promise<void>;
    act(() => {
      pending = latest.prefetchAt(transformFor(zoom));
    });
    return pending;
  }

  it('does not let an older prefetch completion replace a newer queued-build preview', async () => {
    await mount();
    await finish(0);
    const olderPrefetch = prefetchZoom(16);
    commitZoom(18);
    expect(calls).toHaveLength(3);
    const preview = regionFor(calls[2].request, 3, 13);
    act(() => calls[2].onPreview!(preview));
    expect(latest.region).toBe(preview);
    expect(latest.camera.zoom).toBe(18);

    await act(async () => {
      calls[1].resolve(regionFor(calls[1].request, 2));
      await olderPrefetch;
    });

    expect(latest.region).toBe(preview);
    expect(latest.region?.spec).toMatchObject({ zoom: 18, tileZoom: 13 });

    const detailed = await finish(2, regionFor(calls[2].request, 4));
    expect(latest.region).toBe(detailed);
    expect(latest.region?.spec.tileZoom).toBe(14);
  });

  it('warms coarse bundles while idle even when the visible camera has full detail', async () => {
    await mount();
    await finish(0);
    commitZoom(18);
    await finish(1);
    await advance(1200);
    expect(prefetchAround).toHaveBeenLastCalledWith(
      expect.objectContaining({ zoom: 15 }),
      VIEWPORT,
      expect.any(AbortSignal)
    );
    expect(prefetchPoints).toHaveBeenLastCalledWith(FRIENDS, 15, VIEWPORT, expect.any(AbortSignal));
  });

  it('also preserves the newer preview when both requests come from live prefetch', async () => {
    await mount();
    await finish(0);
    const older = prefetchZoom(16);
    const newer = prefetchZoom(18);
    const preview = regionFor(calls[2].request, 3, 13);
    act(() => calls[2].onPreview!(preview));

    await act(async () => {
      calls[1].resolve(regionFor(calls[1].request, 2));
      await older;
    });
    expect(latest.region).toBe(preview);
    expect(latest.camera.zoom).toBe(15);

    const detailed = regionFor(calls[2].request, 4);
    await act(async () => {
      calls[2].resolve(detailed);
      await newer;
    });
    expect(latest.region).toBe(detailed);
  });

  it('keeps retrying an uncovered initial region after the fast recovery attempts', async () => {
    await mount();
    await fail(0);
    for (const [index, delay] of [1000, 3000, 10_000].entries()) {
      await advance(delay - 1);
      expect(calls).toHaveLength(index + 1);
      await advance(1);
      expect(calls).toHaveLength(index + 2);
      expect(calls[index + 1].request.camera).toEqual(calls[0].request.camera);
      await fail(index + 1);
    }
    await advance(29_999);
    expect(calls).toHaveLength(4);
    await advance(1);
    expect(calls).toHaveLength(5);
    await fail(4);
    await advance(30_000);
    expect(calls).toHaveLength(6);
    expect(latest.region).toBeNull();
    expect(latest.pending).not.toBeNull();
  });

  it('keeps retrying when a distant jump can only retain the old region', async () => {
    await mount();
    const home = await finish(0);
    const distantCamera = { center: [0.8, 0.5] as WorldPoint, zoom: 15 };

    act(() => latest.commit(viewTransformFor(latest.anchor, VIEWPORT, distantCamera)));
    expect(calls).toHaveLength(2);
    expect(coversView(home.spec, distantCamera, VIEWPORT)).toBe(false);

    await finish(1, home);
    for (const [index, delay] of [1000, 3000, 10_000, 30_000, 30_000].entries()) {
      await advance(delay - 1);
      expect(calls).toHaveLength(index + 2);
      await advance(1);
      expect(calls).toHaveLength(index + 3);
      expect(calls[index + 2].request.camera).toEqual(distantCamera);
      await finish(index + 2, home);
    }
  });

  it('keeps a coarse-tile preview visible while retrying detail on the same bounded schedule', async () => {
    await mount();
    await finish(0);
    commitZoom(18);
    const preview = regionFor(calls[1].request, 2, 13);
    act(() => calls[1].onPreview!(preview));
    await finish(1, preview);
    for (const [index, delay] of [1000, 3000, 10_000].entries()) {
      expect(latest.region).toBe(preview);
      await advance(delay - 1);
      expect(calls).toHaveLength(index + 2);
      await advance(1);
      expect(calls).toHaveLength(index + 3);
      expect(calls[index + 2].request.camera.zoom).toBe(18);
      await finish(index + 2, preview);
    }
    await advance(60_000);
    expect(calls).toHaveLength(5);
    expect(latest.region).toBe(preview);
    expect(latest.camera.zoom).toBe(18);
  });

  it('stops retrying after recovery and gives a new target a fresh retry budget', async () => {
    await mount();
    await fail(0);
    await advance(1000);
    const recovered = await finish(1);
    await advance(60_000);
    expect(calls).toHaveLength(2);
    expect(latest.region).toBe(recovered);

    commitZoom(18);
    await fail(2);
    await advance(999);
    expect(calls).toHaveLength(3);
    await advance(1);
    expect(calls).toHaveLength(4);
    expect(calls[3].request.camera.zoom).toBe(18);
  });

  it('does not auto-retry a complete z10 region whose small padding still invites prefetch', async () => {
    await mount();
    await finish(0);
    commitZoom(10);
    const request = calls[1].request;
    const complete = regionFor(request, 2);
    expect(shouldPrefetchRegion(complete.spec, request.camera, VIEWPORT, DATA_ZOOMS)).toBe(true);
    expect(needsNewRegion(complete.spec, request.camera, VIEWPORT, DATA_ZOOMS)).toBe(false);

    await finish(1, complete);
    for (const delay of [1000, 3000, 10_000, 60_000]) {
      await advance(delay);
      expect(calls).toHaveLength(2);
      expect(latest.region).toBe(complete);
    }
  });

  it('cancels a scheduled old-target retry when the target changes', async () => {
    await mount();
    await fail(0);
    await advance(500);
    commitZoom(18);
    expect(calls).toHaveLength(2);
    await advance(500);
    expect(calls).toHaveLength(2);

    await fail(1);
    await advance(999);
    expect(calls).toHaveLength(2);
    await advance(1);
    expect(calls).toHaveLength(3);
    expect(calls[2].request.camera.zoom).toBe(18);
  });

  it('does not arm a retry when a superseded target fails after the target changes', async () => {
    await mount();
    commitZoom(18);
    await fail(0);
    await advance(15_000);
    expect(calls).toHaveLength(2);
    await finish(1);
  });

  it.each(['scheduled', 'in-flight'])(
    'cancels %s old-target recovery when live prefetch starts',
    async (stage) => {
      await mount();
      if (stage === 'scheduled') await fail(0);
      const prefetch = prefetchZoom(18);
      if (stage === 'in-flight') await fail(0);
      await advance(15_000);
      expect(calls).toHaveLength(2);

      await act(async () => {
        calls[1].resolve(regionFor(calls[1].request, 1));
        await prefetch;
      });
    }
  );

  it.each(['before', 'after'])(
    'does not retry degraded A when its result arrives %s a 1200px live pan to B',
    async (completion) => {
      await mount();
      await finish(0);
      commitZoom(18);
      const requestA = calls[1].request;
      const degradedA = regionFor(requestA, 2, 13);
      act(() => calls[1].onPreview!(degradedA));
      if (completion === 'before') await finish(1, degradedA);

      const transform = transformFor(18);
      let pan!: Promise<void>;
      act(() => {
        pan = latest.prefetchAt({ ...transform, tx: transform.tx - 1200 });
      });
      const completeB = regionFor(calls[2].request, 3);
      expect(coversView(completeB.spec, requestA.camera, VIEWPORT)).toBe(false);
      await act(async () => {
        calls[2].resolve(completeB);
        await pan;
      });
      if (completion === 'after') await finish(1, degradedA);
      expect(latest.camera).toEqual(requestA.camera);
      expect(latest.region).toBe(completeB);

      await advance(999);
      expect(calls).toHaveLength(3);
      await advance(1);
      expect(calls).toHaveLength(3);
      await advance(14_000);
      expect(calls).toHaveLength(3);
      expect(latest.region).toBe(completeB);
    }
  );

  it.each(['scheduled', 'in-flight'])('cancels %s recovery on unmount', async (stage) => {
    await mount();
    if (stage === 'scheduled') await fail(0);
    act(() => renderer!.unmount());
    renderer = undefined;
    if (stage === 'in-flight') await fail(0);
    await advance(15_000);
    expect(calls).toHaveLength(1);
    expect(exploration.dispose).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });
});
