import { CryptidThemes } from '@/constants/cryptid-theme';

import { visibleWorldRect, worldToScreen } from '../camera';
import { createHexGrid, hexKeyOf } from '../hex';
import { buildFeatureMasks } from '../masks';
import {
  LUT_WIDTH,
  axialOriginFor,
  buildHexTable,
  buildPaletteLut,
  computeRegionSpec,
  coversView,
  needsNewRegion,
  packMaskTexture,
  PREFETCH_MARGIN,
  regionMaskCamera,
  shouldPrefetchRegion,
} from '../region';
import { ramp } from '../color';
import type { CameraState, Viewport } from '../types';

const viewport: Viewport = { width: 390, height: 780 };
const camera: CameraState = { center: [0.1596, 0.3565], zoom: 15 };

describe('computeRegionSpec', () => {
  it('pads the visible rect symmetrically', () => {
    const spec = computeRegionSpec(camera, viewport, { pad: 0.75 });
    const view = visibleWorldRect(camera, viewport);
    const vw = view.maxX - view.minX;
    expect(spec.rect.maxX - spec.rect.minX).toBeCloseTo(vw * 2.5, 12);
    expect((spec.rect.minX + spec.rect.maxX) / 2).toBeCloseTo(camera.center[0], 12);
    expect(spec.zoom).toBe(15);
  });

  it('sizes masks by viewport × factor, capped at maxDim', () => {
    const spec = computeRegionSpec(camera, viewport, { pad: 0.75, maskScale: 1 });
    expect(spec.maskWidth).toBe(Math.round(390 * 2.5));
    expect(spec.maskHeight).toBe(Math.round(780 * 2.5));

    const capped = computeRegionSpec(camera, viewport, { pad: 0.75, maskScale: 4, maxDim: 2048 });
    expect(Math.max(capped.maskWidth, capped.maskHeight)).toBeLessThanOrEqual(2048);
    // aspect preserved
    expect(capped.maskWidth / capped.maskHeight).toBeCloseTo(390 / 780, 2);
  });
});

describe('regionMaskCamera', () => {
  it('maps the region rect corners onto the mask raster corners', () => {
    const spec = computeRegionSpec(camera, viewport);
    const { camera: maskCam, viewport: maskVp } = regionMaskCamera(spec);
    const [x0, y0] = worldToScreen(maskCam, maskVp, [spec.rect.minX, spec.rect.minY]);
    const [x1] = worldToScreen(maskCam, maskVp, [spec.rect.maxX, spec.rect.maxY]);
    expect(x0).toBeCloseTo(0, 4);
    expect(y0).toBeCloseTo(0, 4);
    expect(x1).toBeCloseTo(spec.maskWidth, 4);
  });
});

describe('needsNewRegion', () => {
  const spec = computeRegionSpec(camera, viewport);

  it('is false for the camera it was built for', () => {
    expect(needsNewRegion(spec, camera, viewport)).toBe(false);
  });

  it('is false for small pans inside the padding', () => {
    const view = visibleWorldRect(camera, viewport);
    const nudged: CameraState = {
      center: [camera.center[0] + (view.maxX - view.minX) * 0.3, camera.center[1]],
      zoom: camera.zoom,
    };
    expect(needsNewRegion(spec, nudged, viewport)).toBe(false);
  });

  it('is true when the view exits the region', () => {
    const view = visibleWorldRect(camera, viewport);
    const far: CameraState = {
      center: [camera.center[0] + (view.maxX - view.minX) * 2, camera.center[1]],
      zoom: camera.zoom,
    };
    expect(needsNewRegion(spec, far, viewport)).toBe(true);
  });

  it('is true when zoom leaves the resolution band', () => {
    expect(needsNewRegion(spec, { ...camera, zoom: 15.9 }, viewport)).toBe(true);
    expect(needsNewRegion(spec, { ...camera, zoom: 15.3 }, viewport)).toBe(false);
  });
});

describe('coversView', () => {
  const spec = computeRegionSpec(camera, viewport);

  it('is true for the build camera and small in-region pans', () => {
    expect(coversView(spec, camera, viewport)).toBe(true);
    const view = visibleWorldRect(camera, viewport);
    const nudged: CameraState = {
      center: [camera.center[0] + (view.maxX - view.minX) * 0.1, camera.center[1]],
      zoom: camera.zoom,
    };
    expect(coversView(spec, nudged, viewport)).toBe(true);
  });

  it('is false once the view pokes outside the region rect', () => {
    const view = visibleWorldRect(camera, viewport);
    const far: CameraState = {
      center: [camera.center[0] + (view.maxX - view.minX) * 2, camera.center[1]],
      zoom: camera.zoom,
    };
    expect(coversView(spec, far, viewport)).toBe(false);
  });

  it('ignores the zoom band (a zoom change only scales the bitmap)', () => {
    expect(coversView(spec, { ...camera, zoom: 15.9 }, viewport)).toBe(true);
  });
});

describe('shouldPrefetchRegion', () => {
  const spec = computeRegionSpec(camera, viewport);

  it('is false deep inside the region', () => {
    expect(shouldPrefetchRegion(spec, camera, viewport)).toBe(false);
  });

  it('fires before the edge, while the view is still covered (compute-ahead)', () => {
    const view = visibleWorldRect(camera, viewport);
    // Pad defaults to 1.0, so ~0.75 view of pan leaves < PREFETCH_MARGIN headroom
    // but the view still lies inside the region rect.
    const nearEdge: CameraState = {
      center: [camera.center[0] + (view.maxX - view.minX) * 0.75, camera.center[1]],
      zoom: camera.zoom,
    };
    expect(shouldPrefetchRegion(spec, nearEdge, viewport)).toBe(true);
    expect(coversView(spec, nearEdge, viewport)).toBe(true);
  });

  it('fires on a zoom drift before the rebuild band (compute-ahead for zoom-out)', () => {
    // Below the 0.75 rebuild band but past PREFETCH_ZOOM_DELTA → prefetch, not rebuild.
    const drifted: CameraState = { ...camera, zoom: camera.zoom - 0.5 };
    expect(needsNewRegion(spec, drifted, viewport)).toBe(false);
    expect(shouldPrefetchRegion(spec, drifted, viewport)).toBe(true);
  });

  it('subsumes needsNewRegion (stale zoom band)', () => {
    expect(shouldPrefetchRegion(spec, { ...camera, zoom: 15.9 }, viewport)).toBe(true);
  });

  it('exposes a sane prefetch margin', () => {
    expect(PREFETCH_MARGIN).toBeGreaterThan(0);
    expect(PREFETCH_MARGIN).toBeLessThan(0.4); // less than the region pad, so it can fire in-region
  });
});

describe('packMaskTexture', () => {
  it('interleaves street/park/water into RGBA', () => {
    const geometry = {
      streets: [
        { roadClass: 4 as const, points: [camera.center, [0.1597, 0.3565]] as [number, number][] },
      ],
      rivers: [],
      water: [],
      parks: [],
      places: [],
    };
    const spec = computeRegionSpec(camera, viewport, { pad: 0.25 });
    const { camera: maskCam, viewport: maskVp } = regionMaskCamera(spec);
    const masks = buildFeatureMasks(geometry, maskCam, maskVp);
    const packed = packMaskTexture(masks);
    expect(packed.length).toBe(masks.streets.width * masks.streets.height * 4);
    // find a texel with street coverage: R > 0, G = B = 0, A = 255
    let found = false;
    for (let i = 0, o = 0; i < masks.streets.data.length; i++, o += 4) {
      expect(packed[o]).toBe(masks.streets.data[i]);
      if (packed[o] > 200) {
        expect(packed[o + 1]).toBe(0);
        expect(packed[o + 2]).toBe(0);
        expect(packed[o + 3]).toBe(255);
        found = true;
      }
    }
    expect(found).toBe(true);
  });
});

describe('buildHexTable', () => {
  const grid = createHexGrid(0.005);
  const rect = { minX: 0, minY: 0, maxX: 0.1, maxY: 0.1 };

  it('marks discovered and frontier cells at their axial index', () => {
    const home = grid.keyAt([0.05, 0.05]);
    const discovered = new Set([home, ...grid.neighbors(home)]);
    const table = buildHexTable(grid, rect, discovered);

    const at = (key: string) => {
      const [q, r] = key.split(',').map(Number);
      const o = ((r - table.r0) * table.cols + (q - table.q0)) * 4;
      return [table.data[o], table.data[o + 1]];
    };

    // center: discovered, fully surrounded → not frontier
    expect(at(home)).toEqual([255, 0]);
    // ring: discovered with undiscovered outside neighbors → frontier
    for (const n of grid.neighbors(home)) expect(at(n)).toEqual([255, 255]);
    // far cell: undiscovered
    expect(at(grid.keyAt([0.09, 0.09]))).toEqual([0, 0]);
  });

  it('covers every cell of the rect in its bounds', () => {
    const table = buildHexTable(grid, rect, new Set());
    for (const key of grid.cellsIn(rect)) {
      const [q, r] = key.split(',').map(Number);
      expect(q).toBeGreaterThanOrEqual(table.q0);
      expect(q).toBeLessThan(table.q0 + table.cols);
      expect(r).toBeGreaterThanOrEqual(table.r0);
      expect(r).toBeLessThan(table.r0 + table.rows);
    }
  });
});

describe('buildPaletteLut', () => {
  const palette = CryptidThemes.daybreak.canvas;

  it('bakes each ramp into its row', () => {
    const lut = buildPaletteLut(palette);
    expect(lut.length).toBe(LUT_WIDTH * 3 * 4);
    // terr row endpoints
    expect([lut[0], lut[1], lut[2]]).toEqual([176, 190, 200]);
    const lastTerr = (LUT_WIDTH - 1) * 4;
    expect([lut[lastTerr], lut[lastTerr + 1], lut[lastTerr + 2]]).toEqual([20, 44, 64]);
    // water row midpoint matches ramp()
    const midWater = (LUT_WIDTH + Math.floor(LUT_WIDTH / 2)) * 4;
    const expected = ramp(palette.water, Math.floor(LUT_WIDTH / 2) / (LUT_WIDTH - 1));
    expect(lut[midWater]).toBeCloseTo(expected[0], -1);
  });
});

describe('axialOriginFor', () => {
  it('reconstructs absolute axial coords from local shader math', () => {
    const grid = createHexGrid(0.005);
    const rect = { minX: 0.02, minY: 0.03, maxX: 0.1, maxY: 0.1 };
    const table = buildHexTable(grid, rect, new Set());
    const [aq, ar] = axialOriginFor(rect, grid.radius, table);

    // pick a world point, compute its cell the shader way (local axial + cube
    // round + table anchor) and compare with the grid's own answer
    const w: [number, number] = [0.055, 0.062];
    const relX = w[0] - rect.minX;
    const relY = w[1] - rect.minY;
    const q = aq + ((2 / 3) * relX) / grid.radius;
    const r = ar + ((-1 / 3) * relX + (Math.sqrt(3) / 3) * relY) / grid.radius;
    const s = -q - r;
    let rq = Math.round(q);
    let rr = Math.round(r);
    const rs = Math.round(s);
    const dq = Math.abs(rq - q);
    const dr = Math.abs(rr - r);
    const ds = Math.abs(rs - s);
    if (dq > dr && dq > ds) rq = -rr - rs;
    else if (dr > ds) rr = -rq - rs;

    expect(hexKeyOf(rq + table.q0, rr + table.r0)).toBe(grid.keyAt(w));
  });
});
