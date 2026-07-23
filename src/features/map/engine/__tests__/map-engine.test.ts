import { H3_DISPLAY_RES, resForZoom } from '../../core/cell-ladder';
import { createExplorationIndex } from '../../core/exploration-index';
import { createH3Grid, realH3 } from '../../core/h3-grid';
import { latLonToWorld } from '../../core/mercator';
import { computeRegionSpec } from '../../core/region';
import type { CameraState, Viewport, WorldPoint, WorldRect } from '../../core/types';
import type { PackedGeometry } from '../../tiles/packed-geometry';
import { EMPTY_GEOMETRY, type GeometrySource } from '../../tiles/geometry-source';
import { tileKeyOf, tilesCovering, type TileCoord } from '../../tiles/tile-math';
import { MapEngine, type RegionRequest, type RegionTiming } from '../map-engine';

const viewport: Viewport = { width: 100, height: 100 };
const camera: CameraState = { center: latLonToWorld({ lat: 47.6205, lon: -122.3169 }), zoom: 14 };
const grid = createH3Grid(realH3());
const dataZooms = { min: 0, max: 14 } as const;

const baseRequest: RegionRequest = {
  camera,
  viewport,
  exploration: createExplorationIndex(grid, []),
  explorationVersion: 0,
};

/** A controllable fake source: records requests, resolves on demand. */
class FakeSource implements GeometrySource {
  requests: string[] = [];
  private pending = new Map<string, (g: PackedGeometry) => void>();
  private failures = new Map<string, Error>();
  /** Keys reported as already cached by `has` (undefined ⇒ no `has` support). */
  cached?: Set<string>;
  auto = true;
  geometryFor: (tile: TileCoord) => PackedGeometry = () => EMPTY_GEOMETRY;

  failNext(key: string, error: Error) {
    this.failures.set(key, error);
  }

  has(tile: TileCoord): boolean {
    return this.cached?.has(tileKeyOf(tile.z, tile.x, tile.y)) ?? false;
  }

  getTile(tile: TileCoord): Promise<PackedGeometry> {
    const key = tileKeyOf(tile.z, tile.x, tile.y);
    this.requests.push(key);
    const failure = this.failures.get(key);
    if (failure) {
      this.failures.delete(key);
      return Promise.reject(failure);
    }
    if (this.auto) return Promise.resolve(this.geometryFor(tile));
    return new Promise((resolve) => this.pending.set(key, resolve));
  }

  resolveAll(geometry: PackedGeometry = EMPTY_GEOMETRY) {
    for (const resolve of this.pending.values()) resolve(geometry);
    this.pending.clear();
  }

  /** Tiles handed to prefetch, in order (deduped keys computed by the caller). */
  prefetched: string[] = [];
  async prefetch(tiles: readonly TileCoord[], signal?: AbortSignal): Promise<void> {
    for (const tile of tiles) {
      if (signal?.aborted) return;
      this.prefetched.push(tileKeyOf(tile.z, tile.x, tile.y));
    }
  }
}

function makeEngine(source: GeometrySource) {
  return new MapEngine({ source, grid, dataZooms });
}

describe('MapEngine.buildRegion', () => {
  it('fetches exactly the tiles covering the region at its selected data zoom', async () => {
    const source = new FakeSource();
    const engine = makeEngine(source);
    await engine.buildRegion(baseRequest);

    const spec = computeRegionSpec(camera, viewport, { dataZooms });
    const expected = tilesCovering(spec.rect, spec.tileZoom).map((t) => tileKeyOf(t.z, t.x, t.y));
    expect(source.requests.sort()).toEqual(expected.sort());
    expect(expected.length).toBeGreaterThan(0);
  });

  it('uses the same source for coarse globe geometry', async () => {
    const source = new FakeSource();
    const engine = makeEngine(source);
    const coarseRequest = {
      ...baseRequest,
      camera: { ...camera, zoom: 4 },
    };
    await engine.buildRegion(coarseRequest);

    const spec = computeRegionSpec(coarseRequest.camera, viewport, { dataZooms });
    expect(spec.tileZoom).toBe(3);
    const expected = tilesCovering(spec.rect, spec.tileZoom).map((t) => tileKeyOf(t.z, t.x, t.y));
    expect(source.requests.sort()).toEqual(expected.sort());
  });

  it('builds the fixed-resolution cell field and passes places through', async () => {
    const source = new FakeSource();
    source.geometryFor = () => ({
      ...EMPTY_GEOMETRY,
      places: [{ name: 'Regionville', world: camera.center, kind: 'suburb' }],
    });

    it('skips cell enumeration below the exploration render threshold', async () => {
      const source = new FakeSource();
      const engine = makeEngine(source);
      const region = await engine.buildRegion({
        ...baseRequest,
        camera: { ...camera, zoom: 4 },
      });

      expect(region?.spec.cellRes).toBeNull();
      expect(region?.cellField.cells).toEqual([]);
      expect(region?.timing.cellEnumerateMs).toBe(0);
    });
    const engine = makeEngine(source);

    const region = await engine.buildRegion(baseRequest);
    expect(region).not.toBeNull();
    expect(region!.geometry).toBeDefined();
    expect(region!.cellField.res).toBe(resForZoom(camera.zoom));
    expect(region!.cellField.cells.length).toBeGreaterThan(0);
    expect(region!.places.some((p) => p.name === 'Regionville')).toBe(true);
    expect(engine.lastRegion).toBe(region);
  });

  it('reports source, merge, cell-field, and total build timings', async () => {
    const source = new FakeSource();
    const timings: RegionTiming[] = [];
    const engine = new MapEngine({
      source,
      grid,
      dataZooms,
      onTiming: (timing) => timings.push(timing),
    });

    const region = await engine.buildRegion(baseRequest);
    expect(timings).toHaveLength(1);
    expect(region?.timing).toBe(timings[0]);
    expect(timings[0]).toMatchObject({
      tiles: expect.any(Number),
      coldStart: true,
      cellFieldCacheHit: false,
      sourceMs: expect.any(Number),
      mergeMs: expect.any(Number),
      cellFieldMs: expect.any(Number),
      cellEnumerateMs: expect.any(Number),
      cellCentersMs: expect.any(Number),
      cellAnnotateMs: expect.any(Number),
      totalMs: expect.any(Number),
    });

    expect(timings[0].fetchMs).toBeCloseTo(timings[0].sourceMs + timings[0].mergeMs, 6);
    expect(timings[0].buildMs).toBe(timings[0].cellFieldMs);
    expect(timings[0].totalMs).toBeCloseTo(
      timings[0].sourceMs + timings[0].mergeMs + timings[0].cellFieldMs,
      6
    );
  });

  it('reuses an exact cell field for the same exploration revision', async () => {
    const source = new FakeSource();
    const timings: RegionTiming[] = [];
    const engine = new MapEngine({
      source,
      grid,
      dataZooms,
      onTiming: (timing) => timings.push(timing),
    });

    const first = await engine.buildRegion(baseRequest);
    const second = await engine.buildRegion(baseRequest);

    expect(first?.cellField).toBe(second?.cellField);
    expect(timings.map((timing) => timing.cellFieldCacheHit)).toEqual([false, true]);
  });

  it('rebuilds the cell field when exploration advances', async () => {
    const source = new FakeSource();
    const engine = makeEngine(source);
    const exploration = createExplorationIndex(grid, []);
    const first = await engine.buildRegion({ ...baseRequest, exploration });
    exploration.add(grid.cellAt(camera.center, H3_DISPLAY_RES));
    const second = await engine.buildRegion({
      ...baseRequest,
      exploration,
      explorationVersion: 1,
    });

    expect(first?.cellField).not.toBe(second?.cellField);
    expect(second?.cellField.cells.some((cell) => cell.fraction > 0)).toBe(true);
    expect(second?.timing.cellFieldCacheHit).toBe(false);
  });

  it('marks exploration in the cell field', async () => {
    const source = new FakeSource();
    const engine = makeEngine(source);
    const home = grid.cellAt(camera.center, H3_DISPLAY_RES);
    const region = await engine.buildRegion({
      ...baseRequest,
      exploration: createExplorationIndex(grid, [home]),
    });

    const cell = region!.cellField.cells.find((c) => c.cell === home);
    expect(cell).toBeDefined();
    expect(cell!.fraction).toBe(1); // discovered
    expect(cell!.frontier).toBe(true); // lone cell → frontier
    expect(region!.cellField.cells.filter((c) => c.fraction > 0)).toHaveLength(1);
  });

  it('pipelines: the in-flight build completes; a newer request replaces the QUEUED one', async () => {
    const source = new FakeSource();
    source.auto = false;
    const engine = makeEngine(source);

    const first = engine.buildRegion(baseRequest); // in flight — will complete
    const second = engine.buildRegion({
      ...baseRequest,
      camera: { center: [0.16, 0.357], zoom: 13 },
    }); // waiting behind first
    const third = engine.buildRegion({
      ...baseRequest,
      camera: { center: [0.161, 0.358], zoom: 13 },
    }); // replaces second in the queue

    await expect(second).resolves.toBeNull(); // superseded while waiting

    source.resolveAll();
    const builtFirst = await first;
    expect(builtFirst).not.toBeNull(); // never aborted — it lands

    source.resolveAll(); // third's fetches started when first finished
    const builtThird = await third;
    expect(builtThird).not.toBeNull();
    expect(engine.lastRegion).toBe(builtThird);
  });

  it('coalesces a queued camera already served by the build that just landed', async () => {
    const source = new FakeSource();
    source.auto = false;
    const timings: RegionTiming[] = [];
    const engine = new MapEngine({
      source,
      grid,
      dataZooms,
      onTiming: (timing) => timings.push(timing),
    });
    const spec = computeRegionSpec(camera, viewport, { dataZooms });

    const first = engine.buildRegion(baseRequest);
    const coveredQueued = engine.buildRegion(baseRequest);
    source.resolveAll();

    const built = await first;
    await expect(coveredQueued).resolves.toBe(built);
    expect(timings).toHaveLength(1);
    expect(source.requests).toHaveLength(tilesCovering(spec.rect, spec.tileZoom).length);
  });

  it('does not coalesce a queued exploration revision into a stale cell field', async () => {
    const source = new FakeSource();
    source.auto = false;
    const engine = makeEngine(source);
    const home = grid.cellAt(camera.center, H3_DISPLAY_RES);

    const first = engine.buildRegion(baseRequest);
    const updated = engine.buildRegion({
      ...baseRequest,
      exploration: createExplorationIndex(grid, [home]),
      explorationVersion: 1,
    });
    source.resolveAll();
    await first;
    source.resolveAll();

    const built = await updated;
    expect(built?.explorationVersion).toBe(1);
    expect(built?.cellField.cells.some((cell) => cell.fraction > 0)).toBe(true);
  });

  it('degrades to the last good region when a fetch fails', async () => {
    const source = new FakeSource();
    const engine = makeEngine(source);

    const good = await engine.buildRegion(baseRequest);
    expect(good).not.toBeNull();

    source.failNext(source.requests[0], new Error('network down'));
    const degraded = await engine.buildRegion({
      ...baseRequest,
      camera: { ...camera, zoom: 14.4 },
    });
    expect(degraded).toBe(good);
  });

  it('rethrows a fetch failure when there is no region to fall back to', async () => {
    const source = new FakeSource();
    const engine = makeEngine(source);
    const spec = computeRegionSpec(camera, viewport, { dataZooms });
    const tile = tilesCovering(spec.rect, spec.tileZoom)[0];
    source.failNext(tileKeyOf(tile.z, tile.x, tile.y), new Error('boom'));

    await expect(engine.buildRegion(baseRequest)).rejects.toThrow('boom');
    expect(engine.lastRegion).toBeNull();
  });

  it('degrades to the last good region when cell-field construction fails', async () => {
    let failCells = false;
    const flakyGrid = {
      ...grid,
      cellsInRectAsync: (rect: WorldRect, resolution: number) =>
        failCells
          ? Promise.reject(new Error('h3 unavailable'))
          : grid.cellsInRectAsync(rect, resolution),
    };
    const source = new FakeSource();
    const engine = new MapEngine({ source, grid: flakyGrid, dataZooms });
    const good = await engine.buildRegion(baseRequest);
    failCells = true;

    const degraded = await engine.buildRegion({
      ...baseRequest,
      camera: { ...camera, zoom: 13 },
    });
    expect(degraded).toBe(good);
  });
});

describe('MapEngine build progress', () => {
  const specOf = (c: CameraState = camera) => computeRegionSpec(c, viewport, { dataZooms });
  const tileKeys = (c: CameraState = camera) => {
    const spec = specOf(c);
    return tilesCovering(spec.rect, spec.tileZoom).map((t) => tileKeyOf(t.z, t.x, t.y));
  };

  it('emits an initial 0/total then one step per landed tile', async () => {
    const source = new FakeSource();
    const engine = makeEngine(source);
    const total = tileKeys().length;
    const progress: number[] = [];

    await engine.buildRegion(baseRequest, (p) => {
      expect(p.total).toBe(total);
      expect(p.rect).toEqual(specOf().rect);
      progress.push(p.loaded);
    });

    expect(progress[0]).toBe(0);
    expect(progress[progress.length - 1]).toBe(total);
    // Monotonic non-decreasing, one emission per tile plus the initial.
    expect(progress).toHaveLength(total + 1);
    for (let i = 1; i < progress.length; i++) expect(progress[i]).toBeGreaterThan(progress[i - 1]);
  });

  it('reports coldStart when a tile is not cached, warm when all are', async () => {
    const source = new FakeSource();
    const engine = makeEngine(source);

    let cold: boolean | null = null;
    await engine.buildRegion(baseRequest, (p) => {
      cold = p.coldStart;
    });
    expect(cold).toBe(true); // nothing cached yet

    // Mark every tile of the region as cached → the next build is warm.
    source.cached = new Set(tileKeys());
    cold = null;
    await engine.buildRegion(baseRequest, (p) => {
      cold = p.coldStart;
    });
    expect(cold).toBe(false);
  });

  it('is cold when only some tiles are cached (a partial warm still reveals)', async () => {
    const source = new FakeSource();
    const engine = makeEngine(source);
    // A wide viewport spans many tiles, so "all but one cached" is a real case.
    const wideViewport: Viewport = { width: 800, height: 800 };
    const wideRequest = { ...baseRequest, viewport: wideViewport };
    const spec = computeRegionSpec(camera, wideViewport, { dataZooms });
    const keys = tilesCovering(spec.rect, spec.tileZoom).map((t) => tileKeyOf(t.z, t.x, t.y));
    expect(keys.length).toBeGreaterThan(1);
    source.cached = new Set(keys.slice(1)); // all but the first

    let cold: boolean | null = null;
    await engine.buildRegion(wideRequest, (p) => {
      cold = p.coldStart;
    });
    expect(cold).toBe(true);
  });

  it('never emits progress for a superseded (queued-then-replaced) request', async () => {
    const source = new FakeSource();
    source.auto = false;
    const engine = makeEngine(source);

    const first = engine.buildRegion(baseRequest); // in flight
    let secondEmitted = false;
    const second = engine.buildRegion(
      { ...baseRequest, camera: { center: [0.16, 0.357], zoom: 13 } },
      () => {
        secondEmitted = true;
      }
    );
    engine.buildRegion({ ...baseRequest, camera: { center: [0.161, 0.358], zoom: 13 } }); // replaces second

    await expect(second).resolves.toBeNull();
    source.resolveAll();
    await first;
    source.resolveAll();
    expect(secondEmitted).toBe(false);
  });
});

describe('MapEngine.prefetchPoints', () => {
  const farFriend: WorldPoint = latLonToWorld({ lat: 40.7128, lon: -74.006 }); // NYC
  const nearFriend: WorldPoint = latLonToWorld({ lat: 47.63, lon: -122.34 }); // near Seattle

  it('warms the tiles covering each friend location at the current zoom', async () => {
    const source = new FakeSource();
    const engine = makeEngine(source);
    await engine.prefetchPoints([farFriend], camera.zoom, viewport);

    const spec = computeRegionSpec({ center: farFriend, zoom: camera.zoom }, viewport, {
      dataZooms,
    });
    const expected = tilesCovering(spec.rect, spec.tileZoom).map((t) => tileKeyOf(t.z, t.x, t.y));
    expect(expected.length).toBeGreaterThan(0);
    expect(source.prefetched.sort()).toEqual(expected.sort());
  });

  it('dedupes tiles shared by overlapping friend points', async () => {
    const source = new FakeSource();
    const engine = makeEngine(source);
    // Two points at the same location must not warm the same tile twice.
    await engine.prefetchPoints([nearFriend, nearFriend], camera.zoom, viewport);
    expect(source.prefetched.length).toBe(new Set(source.prefetched).size);
  });

  it('is a no-op for an empty point list', async () => {
    const source = new FakeSource();
    const engine = makeEngine(source);
    await engine.prefetchPoints([], camera.zoom, viewport);
    expect(source.prefetched).toHaveLength(0);
  });

  it('does nothing when the source cannot prefetch', async () => {
    const noPrefetch: GeometrySource = { getTile: () => Promise.resolve(EMPTY_GEOMETRY) };
    const engine = makeEngine(noPrefetch);
    await expect(
      engine.prefetchPoints([nearFriend], camera.zoom, viewport)
    ).resolves.toBeUndefined();
  });

  it('stops early once the signal aborts', async () => {
    const source = new FakeSource();
    const engine = makeEngine(source);
    const controller = new AbortController();
    controller.abort();
    await engine.prefetchPoints([nearFriend, farFriend], camera.zoom, viewport, controller.signal);
    expect(source.prefetched).toHaveLength(0);
  });
});
