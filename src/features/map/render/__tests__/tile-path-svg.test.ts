import { scaleFor, worldToScreen } from '../../core/camera';
import { computeRegionSpec, regionMaskCamera } from '../../core/region';
import { BUILDING_MIN_PX, BUILDING_MIN_ZOOM } from '../../core/structure-lod';
import { maskProjection } from '../mask-image';
import {
  areasSvg,
  buildingBinSvgs,
  linesSvg,
  localPolyline,
  TILE_PATH_UNITS,
} from '../tile-path-svg';

jest.mock('@shopify/react-native-skia', () => ({}));

const U = TILE_PATH_UNITS;
const f32 = (...xs: number[]) => new Float32Array(xs);

describe('localPolyline', () => {
  it('writes one absolute move and integer relative line-tos', () => {
    expect(localPolyline(f32(0, 0, 3 / U, 4 / U, 3 / U, -2 / U), 0, 3)).toBe('M0 0l3 4 0 -6 ');
  });

  it('skips a polyline of fewer than two points', () => {
    expect(localPolyline(f32(1, 1), 0, 1)).toBe('');
  });

  it('accumulates rounded positions, so the deltas never drift', () => {
    // Each point is 0.4 units on: rounding each DELTA would lose all of them.
    const coords = f32(0, 0, 0.4 / U, 0, 0.8 / U, 0, 1.2 / U, 0);
    const svg = localPolyline(coords, 0, 4);
    const sum = svg
      .slice(svg.indexOf('l') + 1)
      .trim()
      .split(' ')
      .filter((_, i) => i % 2 === 0)
      .reduce((a, d) => a + Number(d), 0);
    expect(sum).toBe(Math.round(1.2));
  });
});

describe('linesSvg / areasSvg', () => {
  const lines = {
    count: 2,
    pointOff: new Uint32Array([0, 2, 4]),
    coords: f32(0, 0, 1 / U, 0, 0, 0, 0, 1 / U),
  };

  it('batches every kept feature', () => {
    expect(linesSvg(lines)).toBe('M0 0l1 0  M0 0l0 1 ');
    expect(linesSvg(lines, (i) => i === 1)).toBe('M0 0l0 1 ');
  });

  it('closes every ring, holes included, in decoded order', () => {
    const areas = {
      count: 1,
      names: [],
      ringOff: new Uint32Array([0, 2]),
      pointOff: new Uint32Array([0, 3, 6]),
      coords: f32(0, 0, 4 / U, 0, 4 / U, 4 / U, 1 / U, 1 / U, 2 / U, 1 / U, 2 / U, 2 / U),
    };
    expect(areasSvg(areas).match(/Z/g)).toHaveLength(2);
  });
});

describe('buildingBinSvgs', () => {
  /** A square footprint whose side is `px` region-logical px at `zoom`. */
  const square = (px: number, zoom: number) => {
    const s = px / scaleFor(zoom);
    return f32(0, 0, s, 0, s, s, 0, s, 0, 0);
  };
  const footprints = (...rings: Float32Array[]) => {
    const coords = new Float32Array(rings.reduce((n, r) => n + r.length, 0));
    const pointOff = [0];
    let at = 0;
    for (const r of rings) {
      coords.set(r, at);
      at += r.length;
      pointOff.push(at / 2);
    }
    return {
      count: rings.length,
      names: [],
      ringOff: new Uint32Array(rings.map((_, i) => i).concat(rings.length)),
      pointOff: new Uint32Array(pointOff),
      coords,
    };
  };

  it('bins each footprint by the zoom where it reaches the minimum size', () => {
    const bins = buildingBinSvgs(
      footprints(square(BUILDING_MIN_PX, 16), square(BUILDING_MIN_PX * 64, 16))
    );
    // The big one is drawn from the tileset's floor; the small one from z16.
    expect(bins.map((b) => b.minZoom)).toEqual([BUILDING_MIN_ZOOM, 16]);
  });

  it('never shows a footprint earlier than the old per-region filter did', () => {
    // Exactly the minimum at z15.6: the bin rounds UP, to z15.75.
    const [bin] = buildingBinSvgs(footprints(square(BUILDING_MIN_PX, 15.6)));
    expect(bin.minZoom).toBe(15.75);
  });

  it('drops degenerate outer rings', () => {
    expect(buildingBinSvgs(footprints(f32(0, 0, 1e-6, 0)))).toEqual([]);
  });
});

describe('maskProjection', () => {
  it('is the affine form of the mask camera', () => {
    const spec = computeRegionSpec(
      { center: [0.16, 0.35], zoom: 15.3 },
      { width: 393, height: 852 },
      { dataZooms: { min: 0, max: 14 } }
    );
    const { camera, viewport } = regionMaskCamera(spec);
    const { origin, scale } = maskProjection(spec);
    for (const point of [
      [spec.rect.minX, spec.rect.minY],
      [spec.rect.maxX, spec.rect.maxY],
      [0.1601, 0.3502],
    ] as const) {
      const [x, y] = worldToScreen(camera, viewport, point);
      expect((point[0] - origin[0]) * scale).toBeCloseTo(x, 6);
      expect((point[1] - origin[1]) * scale).toBeCloseTo(y, 6);
    }
  });
});
