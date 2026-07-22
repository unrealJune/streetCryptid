import { CryptidThemes } from '@/constants/cryptid-theme';

import { packGeometry } from '../../tiles/packed-geometry';
import { visibleWorldRect, worldToScreen } from '../camera';
import { buildFeatureMasks } from '../masks';
import {
  LUT_WIDTH,
  buildPaletteLut,
  computeRegionSpec,
  coversView,
  needsNewRegion,
  packMaskTexture,
  padFor,
  PREFETCH_MARGIN,
  regionMaskCamera,
  shouldPrefetchRegion,
} from '../region';
import { ramp } from '../color';
import { resForZoom } from '../cell-ladder';
import type { CameraState, Viewport } from '../types';

const viewport: Viewport = { width: 390, height: 780 };
const camera: CameraState = { center: [0.1596, 0.3565], zoom: 15 };
const dataZooms = { min: 12, max: 14 };

describe('computeRegionSpec', () => {
  it('pads the visible rect symmetrically', () => {
    const spec = computeRegionSpec(camera, viewport, { dataZooms, pad: 0.75 });
    const view = visibleWorldRect(camera, viewport);
    const vw = view.maxX - view.minX;
    expect(spec.rect.maxX - spec.rect.minX).toBeCloseTo(vw * 2.5, 12);
    expect((spec.rect.minX + spec.rect.maxX) / 2).toBeCloseTo(camera.center[0], 12);
    expect(spec.zoom).toBe(15);
  });

  it('sizes masks by viewport × factor, capped at maxDim', () => {
    const spec = computeRegionSpec(camera, viewport, { dataZooms, pad: 0.75, maskScale: 1 });
    expect(spec.maskWidth).toBe(Math.round(390 * 2.5));
    expect(spec.maskHeight).toBe(Math.round(780 * 2.5));

    const capped = computeRegionSpec(camera, viewport, {
      dataZooms,
      pad: 0.75,
      maskScale: 4,
      maxDim: 2048,
    });
    expect(Math.max(capped.maskWidth, capped.maskHeight)).toBeLessThanOrEqual(2048);
    // aspect preserved
    expect(capped.maskWidth / capped.maskHeight).toBeCloseTo(390 / 780, 2);
  });
});

describe('regionMaskCamera', () => {
  it('maps the region rect corners onto the mask raster corners', () => {
    const spec = computeRegionSpec(camera, viewport, { dataZooms });
    const { camera: maskCam, viewport: maskVp } = regionMaskCamera(spec);
    const [x0, y0] = worldToScreen(maskCam, maskVp, [spec.rect.minX, spec.rect.minY]);
    const [x1] = worldToScreen(maskCam, maskVp, [spec.rect.maxX, spec.rect.maxY]);
    expect(x0).toBeCloseTo(0, 4);
    expect(y0).toBeCloseTo(0, 4);
    expect(x1).toBeCloseTo(spec.maskWidth, 4);
  });
});

describe('needsNewRegion', () => {
  const spec = computeRegionSpec(camera, viewport, { dataZooms });

  it('is false for the camera it was built for', () => {
    expect(needsNewRegion(spec, camera, viewport, dataZooms)).toBe(false);
  });

  it('is false for small pans inside the padding', () => {
    const view = visibleWorldRect(camera, viewport);
    const nudged: CameraState = {
      center: [camera.center[0] + (view.maxX - view.minX) * 0.3, camera.center[1]],
      zoom: camera.zoom,
    };
    expect(needsNewRegion(spec, nudged, viewport, dataZooms)).toBe(false);
  });

  it('is true when the view exits the region', () => {
    const view = visibleWorldRect(camera, viewport);
    const far: CameraState = {
      center: [camera.center[0] + (view.maxX - view.minX) * 2, camera.center[1]],
      zoom: camera.zoom,
    };
    expect(needsNewRegion(spec, far, viewport, dataZooms)).toBe(true);
  });

  it('is true when zoom leaves the resolution band', () => {
    expect(needsNewRegion(spec, { ...camera, zoom: 15.9 }, viewport, dataZooms)).toBe(true);
    expect(needsNewRegion(spec, { ...camera, zoom: 15.3 }, viewport, dataZooms)).toBe(false);
  });
});

describe('coversView', () => {
  const spec = computeRegionSpec(camera, viewport, { dataZooms });

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
  const spec = computeRegionSpec(camera, viewport, { dataZooms });

  it('is false deep inside the region', () => {
    expect(shouldPrefetchRegion(spec, camera, viewport, dataZooms)).toBe(false);
  });

  it('fires before the edge, while the view is still covered (compute-ahead)', () => {
    const view = visibleWorldRect(camera, viewport);
    // Pad defaults to 1.0, so ~0.75 view of pan leaves < PREFETCH_MARGIN headroom
    // but the view still lies inside the region rect.
    const nearEdge: CameraState = {
      center: [camera.center[0] + (view.maxX - view.minX) * 0.75, camera.center[1]],
      zoom: camera.zoom,
    };
    expect(shouldPrefetchRegion(spec, nearEdge, viewport, dataZooms)).toBe(true);
    expect(coversView(spec, nearEdge, viewport)).toBe(true);
  });

  it('fires on a zoom drift before the rebuild band (compute-ahead for zoom-out)', () => {
    // Below the 0.75 rebuild band but past PREFETCH_ZOOM_DELTA → prefetch, not rebuild.
    const drifted: CameraState = { ...camera, zoom: camera.zoom - 0.5 };
    expect(needsNewRegion(spec, drifted, viewport, dataZooms)).toBe(false);
    expect(shouldPrefetchRegion(spec, drifted, viewport, dataZooms)).toBe(true);
  });

  it('subsumes needsNewRegion (stale zoom band)', () => {
    expect(shouldPrefetchRegion(spec, { ...camera, zoom: 15.9 }, viewport, dataZooms)).toBe(true);
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
    const spec = computeRegionSpec(camera, viewport, { dataZooms, pad: 0.25 });
    const { camera: maskCam, viewport: maskVp } = regionMaskCamera(spec);
    const masks = buildFeatureMasks(packGeometry(geometry), maskCam, maskVp);
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

describe('buildPaletteLut', () => {
  it('bakes each ramp into its LUT row', () => {
    const palette = CryptidThemes.daybreak.canvas;
    const lut = buildPaletteLut(palette);
    expect(lut.length).toBe(LUT_WIDTH * 3 * 4);
    // spot-check row 0 (terr) endpoints against the ramp directly
    const [r0, g0, b0] = ramp(palette.terr, 0);
    expect(lut[0]).toBe(Math.round(r0));
    expect(lut[1]).toBe(Math.round(g0));
    expect(lut[2]).toBe(Math.round(b0));
    const o = (LUT_WIDTH - 1) * 4;
    const [r1, g1, b1] = ramp(palette.terr, 1);
    expect(lut[o]).toBe(Math.round(r1));
    expect(lut[o + 1]).toBe(Math.round(g1));
    expect(lut[o + 2]).toBe(Math.round(b1));
  });
});

describe('data zooms + cell ladder in region specs', () => {
  const planet = { min: 0, max: 14 };

  it('stamps cellRes from the ladder and tileZoom from the range clamp', () => {
    const spec = computeRegionSpec(camera, viewport, { dataZooms: planet });
    expect(spec.cellRes).toBe(resForZoom(camera.zoom));
    expect(spec.tileZoom).toBe(13); // z15 camera → z14 display − bias

    const globe = computeRegionSpec({ center: [0.6, 0.6], zoom: 3 }, viewport, {
      dataZooms: planet,
    });
    expect(globe.cellRes).toBe(resForZoom(3));
    expect(globe.tileZoom).toBe(2); // z3 → floor 3 − bias
  });

  it('needsNewRegion fires on a ladder-rung change even within the zoom band', () => {
    // z12.6 → res 9; z12.4 → res 8. The 0.2 zoom delta is inside the 0.75
    // mask band, so only the cellRes clause can trigger the rebuild.
    const spec = computeRegionSpec({ ...camera, zoom: 12.6 }, viewport, { dataZooms });
    expect(needsNewRegion(spec, { ...camera, zoom: 12.4 }, viewport, dataZooms)).toBe(true);
    expect(needsNewRegion(spec, { ...camera, zoom: 12.55 }, viewport, dataZooms)).toBe(false);
  });

  it('needsNewRegion fires when the data zoom steps within the planet range', () => {
    // z8.9 → data z7, z9.2 → data z8, same ladder rung (res 6), zoom delta
    // 0.3 < 0.75 — only the tileZoom clause can trigger this rebuild.
    const spec = computeRegionSpec({ ...camera, zoom: 8.9 }, viewport, { dataZooms: planet });
    expect(needsNewRegion(spec, { ...camera, zoom: 9.2 }, viewport, planet)).toBe(true);
  });
});

describe('padFor across the full zoom range', () => {
  it('keeps the city taper and regrows headroom at globe zooms', () => {
    expect(padFor(14)).toBeCloseTo(1.0, 12); // street: full headroom
    expect(padFor(11)).toBeCloseTo(0.2, 12); // city: tile budget pinch
    expect(padFor(7)).toBeCloseTo(0.8, 12); // coarse planet tiles: cheap, grow again
    expect(padFor(3)).toBeCloseTo(1.0, 12); // globe: max headroom
  });
});
