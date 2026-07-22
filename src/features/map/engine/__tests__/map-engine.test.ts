import { H3_DISPLAY_RES, resForZoom } from '../../core/cell-ladder';
import { createExplorationIndex } from '../../core/exploration-index';
import { createH3Grid, realH3 } from '../../core/h3-grid';
import { latLonToWorld } from '../../core/mercator';
import { computeRegionSpec } from '../../core/region';
import type { CameraState, Viewport } from '../../core/types';
import type { PackedGeometry } from '../../tiles/packed-geometry';
import { EMPTY_GEOMETRY, type GeometrySource } from '../../tiles/geometry-source';
import { tileKeyOf, tilesCovering, type TileCoord } from '../../tiles/tile-math';
import { MapEngine, type RegionRequest } from '../map-engine';

const viewport: Viewport = { width: 100, height: 100 };
const camera: CameraState = { center: latLonToWorld({ lat: 47.6205, lon: -122.3169 }), zoom: 14 };
const grid = createH3Grid(realH3());
const dataZooms = { min: 0, max: 14 } as const;

const baseRequest: RegionRequest = {
  camera,
  viewport,
  exploration: createExplorationIndex(grid, []),
};

/** A controllable fake source: records requests, resolves on demand. */
class FakeSource implements GeometrySource {
  requests: string[] = [];
  private pending = new Map<string, (g: PackedGeometry) => void>();
  private failures = new Map<string, Error>();
  auto = true;
  geometryFor: (tile: TileCoord) => PackedGeometry = () => EMPTY_GEOMETRY;

  failNext(key: string, error: Error) {
    this.failures.set(key, error);
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

  it('builds the cell field at the spec ladder rung and passes places through', async () => {
    const source = new FakeSource();
    source.geometryFor = () => ({
      ...EMPTY_GEOMETRY,
      places: [{ name: 'Regionville', world: camera.center, kind: 'suburb' }],
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
});
