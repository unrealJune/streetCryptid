import { Skia, type SkImage } from '@shopify/react-native-skia';

import { CryptidThemes } from '@/constants/cryptid-theme';

import { scaleFor } from '../../core/camera';
import { lineDotIntervals } from '../../core/dot-style';
import { computeRegionSpec } from '../../core/region';
import { AERODROME_DASH, aeroLineWidthFor, BUILDING_TILE_ZOOM } from '../../core/structure-lod';
import { transitWidthFor } from '../../core/transit-lod';
import {
  AERO_LINE_KINDS,
  TRANSIT_MODES,
  type MapGeometry,
  type WorldPoint,
} from '../../core/types';
import type { MapRegion } from '../../engine/map-engine';
import { packGeometry } from '../../tiles/packed-geometry';
import { buildMaskPaths } from '../mask-paths';
import { renderRegionImage } from '../region-shader';
import { buildHatchPath } from '../structure-paths';
import { linesSvg, TILE_PATH_UNITS } from '../tile-path-svg';

const mockResources: { dispose: jest.Mock }[] = [];
let mockAtlasFails = false;
function mockResource<T extends object>(value: T) {
  const resource = { ...value, dispose: jest.fn() };
  mockResources.push(resource);
  return resource;
}

jest.mock('../dot-field-shader', () => ({
  getDotFieldEffect: () => ({ makeShaderWithChildren: () => mockResource({}) }),
  getDotMaterialEffect: () => ({ makeShaderWithChildren: () => mockResource({}) }),
}));

// The "image" is the recording canvas, so a test can read back what was drawn.
jest.mock('../offscreen', () => ({
  renderPicture: (_picture: unknown, _width: number, _height: number, consumer: string) =>
    consumer === 'same-thread'
      ? mockAtlasFails
        ? null
        : mockResource({ makeShaderOptions: () => mockResource({}) })
      : jest.requireMock('@shopify/react-native-skia').drawAsImageFromPicture(),
}));

jest.mock('@shopify/react-native-skia', () => {
  const canvas = {
    drawPaint: jest.fn(),
    drawPath: jest.fn(),
    save: jest.fn(),
    restore: jest.fn(),
    scale: jest.fn(),
    translate: jest.fn(),
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
        return mockResource({
          state,
          setShader: jest.fn(),
          setAntiAlias: jest.fn(),
          setColor: (value: string) => (state.color = value),
          setStyle: (value: string) => (state.style = value),
          setStrokeWidth: (value: number) => (state.width = value),
          setStrokeCap: (value: string) => (state.cap = value),
          setStrokeJoin: (value: string) => (state.join = value),
          setPathEffect: (value: number[]) => (state.intervals = value),
        });
      },
      Path: {
        MakeFromSVGString: (svg: string) => ({ svg, setFillType: jest.fn() }),
        // An assembled region path names the tile paths it was built from.
        Make: () => {
          const parts: string[] = [];
          return {
            get svg() {
              return parts.join(' ');
            },
            setFillType: jest.fn(),
            addPath: (src: { svg: string }) => parts.push(src.svg),
            dispose: jest.fn(),
          };
        },
      },
      Matrix: jest.fn(),
      PathEffect: { MakeDash: jest.fn((intervals: number[]) => intervals) },
      PictureRecorder: () =>
        mockResource({
          beginRecording: () => canvas,
          finishRecordingAsPicture: () => mockResource({}),
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
const image = { makeShaderOptions: () => mockResource({}) } as unknown as SkImage;
interface Draw {
  svg: string;
  style: string;
  width?: number;
  cap?: string;
  intervals?: number[];
}
function draw(transitEnabled = true, structuresEnabled = true, at: MapRegion = region): Draw[] {
  const canvas = renderRegionImage({
    region: at,
    palette: CryptidThemes.daybreak.canvas,
    maskImage: image,
    groundImage: image,
    terrainImage: image,
    cellImage: image,
    lutImage: image,
    explorationEnabled: false,
    transitEnabled,
    structuresEnabled,
  }) as unknown as { drawPath: jest.Mock };
  return canvas.drawPath.mock.calls.map(([path, paint]) => ({ svg: path.svg, ...paint.state }));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockResources.length = 0;
  mockAtlasFails = false;
});

describe('temporary shader resources', () => {
  it('releases the atlas and every picture/shader holding it after the final readback', () => {
    draw(false, false);
    expect(mockResources.length).toBeGreaterThan(10);
    for (const resource of mockResources) expect(resource.dispose).toHaveBeenCalledTimes(1);
  });

  it('reports allocation failure and releases the material pass even without an atlas', () => {
    mockAtlasFails = true;
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(
        renderRegionImage({
          region,
          palette: CryptidThemes.daybreak.canvas,
          maskImage: image,
          groundImage: image,
          terrainImage: image,
          cellImage: image,
          lutImage: image,
        })
      ).toBeNull();
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('dot atlas raster failed'));
      for (const resource of mockResources) expect(resource.dispose).toHaveBeenCalledTimes(1);
    } finally {
      warning.mockRestore();
    }
  });
});

/** Canvas units per tile-path unit: what every width and interval is divided by. */
const k = scaleFor(spec.zoom) / TILE_PATH_UNITS;
const tile = geometry.parts[0];
const transitSvg = (index: number) => linesSvg(tile.transit, (i) => tile.transit.mode[i] === index);
const aeroLineSvg = (kind: number) =>
  linesSvg(tile.aeroLines, (i) => tile.aeroLines.kind[i] === kind);

describe('dotted region overlays', () => {
  it('renders every transit mode, including ferries, as a casing plus round dots', () => {
    const draws = draw(true, false);
    expect(draws).toHaveLength(TRANSIT_MODES.length * 2);
    TRANSIT_MODES.forEach((mode, index) => {
      const width = transitWidthFor(mode, spec.zoom)!;
      // Casing first, dots over it: the continuous stroke is what makes the
      // chain read as one route rather than a row of unrelated marks.
      const [casing, dots] = draws.filter((entry) => entry.svg === transitSvg(index));
      expect(casing).toMatchObject({ style: 'stroke', width: width / k, cap: 'round' });
      expect(casing.intervals).toBeUndefined();
      expect(dots).toMatchObject({ style: 'stroke', width: width / k, cap: 'round' });
      // Widths and dash intervals are in tile-path units under the tile transform.
      lineDotIntervals(width).forEach((v, i) => expect(dots.intervals![i]).toBeCloseTo(v / k, 6));
      expect(transitSvg(index).match(/M/g)).toHaveLength(2);
    });
  });

  // A runway is a road that happens to be very straight. Drawn as a chain of
  // 4px beads it was the loudest mark on any region containing an airport.
  it('strokes runways and taxiways solid, dashing only the aerodrome boundary', () => {
    const draws = draw(false, true);
    const runway = draws.find(
      (entry) => entry.svg === aeroLineSvg(AERO_LINE_KINDS.indexOf('runway'))
    )!;
    expect(runway).toMatchObject({
      style: 'stroke',
      cap: 'round',
      width: aeroLineWidthFor('runway', spec.zoom)! / k,
    });
    expect(runway.intervals).toBeUndefined();
    const taxiway = draws.find(
      (entry) => entry.svg === aeroLineSvg(AERO_LINE_KINDS.indexOf('taxiway'))
    )!;
    expect(taxiway.width).toBe(aeroLineWidthFor('taxiway', spec.zoom)! / k);
    expect(taxiway.intervals).toBeUndefined();
    const dashed = draws.filter((entry) => entry.intervals);
    expect(dashed).toHaveLength(1);
    AERODROME_DASH.forEach((v, i) => expect(dashed[0].intervals![i]).toBeCloseTo(v / k, 6));
    expect(draws.find((entry) => entry.svg === buildHatchPath(spec))).toMatchObject({
      style: 'stroke',
    });
    expect(draws.filter((entry) => entry.style === 'fill')).toHaveLength(2);
  });

  // OpenMapTiles merges z13 buildings into ragged block-sized blobs: a z13
  // overview stage previewing a street view must not draw them as footprints.
  it('draws buildings only from z14 tiles', () => {
    expect(spec.tileZoom).toBe(BUILDING_TILE_ZOOM);
    const coarse = draw(false, true, { ...region, spec: { ...spec, tileZoom: 13 } });
    expect(coarse.find((entry) => entry.svg === buildHatchPath(spec))).toBeUndefined();
    // Only the apron fill is left.
    expect(coarse.filter((entry) => entry.style === 'fill')).toHaveLength(1);
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
