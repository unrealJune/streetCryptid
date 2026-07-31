import { scaleFor } from '../../core/camera';
import { computeRegionSpec } from '../../core/region';
import type { CameraState, MapGeometry, Viewport, WorldPoint } from '../../core/types';
import { packGeometry } from '../../tiles/packed-geometry';
import { buildTransitPaths } from '../transit-paths';

const camera: CameraState = { center: [0.3, 0.3], zoom: 15 };
const viewport: Viewport = { width: 400, height: 800 };
const spec = computeRegionSpec(camera, viewport, { dataZooms: { min: 0, max: 14 } });
const { minX, minY, maxX, maxY } = spec.rect;
const lx = (t: number): number => minX + (maxX - minX) * t;
const ly = (t: number): number => minY + (maxY - minY) * t;

function geometry(transit: MapGeometry['transit']) {
  return packGeometry({
    streets: [],
    transit,
    rivers: [],
    water: [],
    parks: [],
    places: [],
  });
}

const line = (a: number, b: number): readonly WorldPoint[] => [
  [lx(a), ly(a)],
  [lx(b), ly(b)],
];

describe('buildTransitPaths', () => {
  it('returns nothing for empty geometry', () => {
    expect(buildTransitPaths(geometry([]), spec)).toEqual({});
  });

  it('batches one path per mode', () => {
    const paths = buildTransitPaths(
      geometry([
        { mode: 'subway', points: line(0.2, 0.4) },
        { mode: 'subway', points: line(0.4, 0.6) },
        { mode: 'ferry', points: line(0.1, 0.9) },
      ]),
      spec
    );
    expect(Object.keys(paths).sort()).toEqual(['ferry', 'subway']);
    expect(paths.subway?.match(/M/g)).toHaveLength(2);
    expect(paths.ferry?.match(/M/g)).toHaveLength(1);
  });

  it('projects into region-logical px (0 at rect.min)', () => {
    const paths = buildTransitPaths(geometry([{ mode: 'rail', points: line(0, 0.5) }]), spec);
    const scale = scaleFor(spec.zoom);
    // f32 world coords cost ~0.1px here, so compare the parsed numbers.
    const [, start, end] = paths.rail!.match(/^M([\d.-]+ [\d.-]+)L([\d.-]+ [\d.-]+)$/)!;
    const [x0, y0] = start.split(' ').map(Number);
    const [x1, y1] = end.split(' ').map(Number);
    expect(x0).toBeCloseTo(0, 0);
    expect(y0).toBeCloseTo(0, 0);
    expect(x1).toBeCloseTo((maxX - minX) * 0.5 * scale, 0);
    expect(y1).toBeCloseTo((maxY - minY) * 0.5 * scale, 0);
  });

  it('omits modes the zoom LOD drops (funicular only draws from z13)', () => {
    const zoomedOut = computeRegionSpec({ center: camera.center, zoom: 10 }, viewport, {
      dataZooms: { min: 0, max: 14 },
    });
    const geo = geometry([
      { mode: 'funicular', points: line(0.2, 0.4) },
      { mode: 'rail', points: line(0.2, 0.4) },
    ]);
    expect(Object.keys(buildTransitPaths(geo, zoomedOut))).toEqual(['rail']);
    expect(Object.keys(buildTransitPaths(geo, spec)).sort()).toEqual(['funicular', 'rail']);
  });

  it('skips degenerate single-point lines', () => {
    const paths = buildTransitPaths(
      geometry([{ mode: 'tram', points: [[lx(0.5), ly(0.5)]] }]),
      spec
    );
    expect(paths.tram).toBeUndefined();
  });
});
