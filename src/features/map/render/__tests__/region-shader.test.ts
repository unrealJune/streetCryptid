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
  it('renders every transit mode, including ferries, as round dots in one draw per mode', () => {
    const paths = buildTransitPaths(geometry, spec);
    const draws = draw(true, false);
    expect(draws).toHaveLength(TRANSIT_MODES.length);
    for (const mode of TRANSIT_MODES) {
      const width = transitWidthFor(mode, spec.zoom)!;
      expect(draws.filter((entry) => entry.svg === paths[mode])).toEqual([
        expect.objectContaining({
          style: 'stroke',
          width,
          cap: 'round',
          intervals: lineDotIntervals(width),
        }),
      ]);
      expect(paths[mode]!.match(/M/g)).toHaveLength(2);
    }
  });

  it('dots only runways, leaving taxiways, area boundaries and building hatching unchanged', () => {
    const paths = buildStructurePaths(geometry, spec);
    const draws = draw(false, true);
    const runway = draws.find((entry) => entry.svg === paths.aeroLines.runway)!;
    const width = aeroLineWidthFor('runway', spec.zoom)!;
    expect(runway).toMatchObject({
      style: 'stroke',
      cap: 'round',
      width,
      intervals: lineDotIntervals(width),
    });
    const taxiway = draws.find((entry) => entry.svg === paths.aeroLines.taxiway)!;
    expect(taxiway.width).toBe(aeroLineWidthFor('taxiway', spec.zoom));
    expect(taxiway.intervals).toBeUndefined();
    expect(draws.filter((entry) => entry.intervals)).toEqual([
      expect.objectContaining({ intervals: [...AERODROME_DASH] }),
      runway,
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

  it('never falls back to solid transit or runway strokes when a dot effect fails', () => {
    jest.mocked(Skia.PathEffect.MakeDash).mockReturnValueOnce(null as never);
    expect(draw(true, false)).toHaveLength(TRANSIT_MODES.length - 1);
    jest.clearAllMocks();
    // Aerodrome dash succeeds; runway dots fail.
    jest
      .mocked(Skia.PathEffect.MakeDash)
      .mockReturnValueOnce({} as never)
      .mockReturnValueOnce(null as never);
    const paths = buildStructurePaths(geometry, spec);
    expect(draw(false, true).some((entry) => entry.svg === paths.aeroLines.runway)).toBe(false);
  });

  it('keeps transit and runways out of the street, park and water feature masks', () => {
    expect(buildMaskPaths(geometry, spec)).toEqual(buildMaskPaths(packGeometry(base), spec));
  });
});
