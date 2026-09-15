import { Skia, type SkImage } from '@shopify/react-native-skia';

import { CryptidThemes } from '@/constants/cryptid-theme';

import { scaleFor } from '../../core/camera';
import { lineDotIntervals } from '../../core/dot-style';
import { computeRegionSpec } from '../../core/region';
import { AERODROME_DASH, aeroLineWidthFor } from '../../core/structure-lod';
import { transitWidthFor } from '../../core/transit-lod';
import { TRANSIT_MODES, type MapGeometry, type WorldPoint } from '../../core/types';
import type { MapRegion } from '../../engine/map-engine';
import { packGeometry } from '../../tiles/packed-geometry';
import { buildMaskPaths } from '../mask-paths';
import { renderRegionImage } from '../region-shader';
import { buildHatchPath, buildStructurePaths } from '../structure-paths';
import { buildTransitPaths } from '../transit-paths';

jest.mock('../dot-field-shader', () => ({
  getDotFieldEffect: () => ({ makeShaderWithChildren: () => ({}) }),
}));

jest.mock('@shopify/react-native-skia', () => {
  const canvas = {
    drawPaint: jest.fn(),
    drawPath: jest.fn(),
    save: jest.fn(),
    restore: jest.fn(),
    scale: jest.fn(),
    clipPath: jest.fn(),
  };
  return {
    ClipOp: { Intersect: 'intersect', Difference: 'difference' },
    PaintStyle: { Fill: 'fill', Stroke: 'stroke' },
    StrokeCap: { Round: 'round' },
    StrokeJoin: { Round: 'round' },
    FillType: { Winding: 'winding' },
    FilterMode: { Nearest: 0, Linear: 1 },
    TileMode: { Clamp: 0 },
    MipmapMode: { None: 0 },
    drawAsImageFromPicture: () => canvas,
    Skia: {
      Color: (color: string) => color,
      XYWHRect: jest.fn(),
      Paint: () => {
        const state: Record<string, unknown> = {};
        return {
          state,
          setShader: jest.fn(),
          setAntiAlias: jest.fn(),
          setColor: (value: string) => (state.color = value),
          setStyle: (value: string) => (state.style = value),
          setStrokeWidth: (value: number) => (state.width = value),
          setStrokeCap: (value: string) => (state.cap = value),
          setStrokeJoin: (value: string) => (state.join = value),
          setPathEffect: (value: number[]) => (state.intervals = value),
        };
      },
      Path: {
        MakeFromSVGString: (svg: string) => ({ svg, setFillType: jest.fn() }),
      },
      PathEffect: { MakeDash: jest.fn((intervals: number[]) => intervals) },
      PictureRecorder: () => ({
        beginRecording: () => canvas,
        finishRecordingAsPicture: jest.fn(),
      }),
    },
  };
});

const spec = computeRegionSpec(
  { center: [0.3, 0.3], zoom: 15 },
  { width: 390, height: 780 },
  {
    dataZooms: { min: 0, max: 14 },
  }
);
const point = (x: number, y: number): WorldPoint => [
  spec.rect.minX + x / scaleFor(spec.zoom),
  spec.rect.minY + y / scaleFor(spec.zoom),
];
const line = (y: number): readonly WorldPoint[] => [
  point(10, y),
  point(100, y),
  point(140, y + 20),
];
const ring = [point(20, 200), point(60, 200), point(60, 240), point(20, 240), point(20, 200)];
const base: MapGeometry = {
  streets: [],
  transit: [],
  rivers: [],
  parks: [],
  water: [],
  places: [],
};
const geometry = packGeometry({
  ...base,
  transit: TRANSIT_MODES.flatMap((mode, index) => [
    { mode, points: line(20 + index * 10) },
    { mode, points: line(100 + index * 10) },
  ]),
  buildings: [{ rings: [ring] }],
  aeroAreas: [
    { kind: 'apron', rings: [ring] },
    { kind: 'aerodrome', rings: [ring] },
  ],
  aeroLines: [
    { kind: 'runway', points: line(300) },
    { kind: 'taxiway', points: line(320) },
  ],
});
const region: MapRegion = {
  publication: 1,
  spec,
  geometry,
  cellField: { res: 9, cells: [] },
  places: [],
  labels: [],
  explorationVersion: 0,
  timing: {
    tiles: 0,
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
const image = { makeShaderOptions: () => ({}) } as unknown as SkImage;
interface Draw {
  svg: string;
  style: string;
  width?: number;
  cap?: string;
  intervals?: number[];
}
function draw(transitEnabled = true, structuresEnabled = true): Draw[] {
  const canvas = renderRegionImage({
    region,
    palette: CryptidThemes.daybreak.canvas,
    maskImage: image,
    cellImage: image,
    lutImage: image,
    explorationEnabled: false,
    transitEnabled,
    structuresEnabled,
  }) as unknown as { drawPath: jest.Mock };
  return canvas.drawPath.mock.calls.map(([path, paint]) => ({ svg: path.svg, ...paint.state }));
}

beforeEach(() => jest.clearAllMocks());

describe('dotted region overlays', () => {
  it('renders every transit mode, including ferries, as a casing plus round dots', () => {
    const paths = buildTransitPaths(geometry, spec);
    const draws = draw(true, false);
    expect(draws).toHaveLength(TRANSIT_MODES.length * 2);
    for (const mode of TRANSIT_MODES) {
      const width = transitWidthFor(mode, spec.zoom)!;
      // Casing first, dots over it: the continuous stroke is what makes the
      // chain read as one route rather than a row of unrelated marks.
      const [casing, dots] = draws.filter((entry) => entry.svg === paths[mode]);
      expect(casing).toMatchObject({ style: 'stroke', width, cap: 'round' });
      expect(casing.intervals).toBeUndefined();
      expect(dots).toMatchObject({
        style: 'stroke',
        width,
        cap: 'round',
        intervals: lineDotIntervals(width),
      });
      expect(paths[mode]!.match(/M/g)).toHaveLength(2);
    }
  });

  // A runway is a road that happens to be very straight. Drawn as a chain of
  // 4px beads it was the loudest mark on any region containing an airport.
  it('strokes runways and taxiways solid, dashing only the aerodrome boundary', () => {
    const paths = buildStructurePaths(geometry, spec);
    const draws = draw(false, true);
    const runway = draws.find((entry) => entry.svg === paths.aeroLines.runway)!;
    expect(runway).toMatchObject({
      style: 'stroke',
      cap: 'round',
      width: aeroLineWidthFor('runway', spec.zoom),
    });
    expect(runway.intervals).toBeUndefined();
    const taxiway = draws.find((entry) => entry.svg === paths.aeroLines.taxiway)!;
    expect(taxiway.width).toBe(aeroLineWidthFor('taxiway', spec.zoom));
    expect(taxiway.intervals).toBeUndefined();
    expect(draws.filter((entry) => entry.intervals)).toEqual([
      expect.objectContaining({ intervals: [...AERODROME_DASH] }),
    ]);
    expect(draws.find((entry) => entry.svg === buildHatchPath(spec))).toMatchObject({
      style: 'stroke',
    });
    expect(draws.filter((entry) => entry.style === 'fill')).toHaveLength(2);
  });

  it('keeps both overlay toggles effective', () => {
    expect(draw(false, false)).toEqual([]);
    expect(Skia.PathEffect.MakeDash).not.toHaveBeenCalled();
  });

  // A solid route is a worse transit line than a dotted one; an ABSENT one is
  // worse still, so a failed dot effect costs the mode its texture, not its line.
  it('keeps the casing when a mode cannot build its dot effect', () => {
    jest.mocked(Skia.PathEffect.MakeDash).mockReturnValueOnce(null as never);
    const draws = draw(true, false);
    expect(draws).toHaveLength(TRANSIT_MODES.length * 2 - 1);
    expect(draws.filter((entry) => entry.intervals)).toHaveLength(TRANSIT_MODES.length - 1);
  });

  it('keeps transit and runways out of the street, park and water feature masks', () => {
    expect(buildMaskPaths(geometry, spec)).toEqual(buildMaskPaths(packGeometry(base), spec));
  });
});
