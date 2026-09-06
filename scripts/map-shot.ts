/**
 * Headless map screenshotter — renders the real dot-field pipeline to a PNG on
 * the host, with no simulator.
 *
 * It runs exactly the code the app runs (`computeRegionSpec` → `buildMaskPaths`
 * → `DOT_FIELD_SKSL`), just against CanvasKit (the WASM build of Skia that ships
 * with react-native-skia) instead of the device GPU, so a rendering change can
 * be eyeballed at several zooms and places before/after without a build.
 *
 * Needs EXPO_PUBLIC_TILE_URL (see .env.local); tiles are fetched straight from
 * the tileset — the privacy bundle path is a client concern, not a render one.
 *
 *   bun scripts/map-shot.ts --out /tmp/shots --places westcoast,europe --zooms 4,8,12
 *   bun scripts/map-shot.ts --scheme tokyo --mode dark --places westcoast --zooms 13
 *   bun scripts/map-shot.ts --out /tmp/shots --highways   # keep motorways on
 *   bun scripts/map-shot.ts --places seatac --no-structures  # buildings/aeroway off
 *   bun scripts/map-shot.ts --places seattle --zooms 13,15 --highways --transit
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

import { scaleFor, visibleWorldRect } from '../src/features/map/core/camera';
import { latLonToWorld } from '../src/features/map/core/mercator';
import {
  buildPaletteLut,
  computeRegionSpec,
  type RegionSpec,
} from '../src/features/map/core/region';
import { roadWidthFor, type RoadLayerOptions } from '../src/features/map/core/road-lod';
import { riverWidthFor } from '../src/features/map/core/water-lod';
import { FERRY_DASH, transitColorFor, transitWidthFor } from '../src/features/map/core/transit-lod';
import { TRANSIT_MODES } from '../src/features/map/core/types';
import { ROAD_VALUES } from '../src/features/map/core/masks';
import type {
  AeroAreaKind,
  AeroLineKind,
  CameraState,
  MapPalette,
  Viewport,
} from '../src/features/map/core/types';
import { DOT_FIELD_SKSL } from '../src/features/map/render/dot-field-sksl';
import { buildMaskPaths } from '../src/features/map/render/mask-paths';
import { buildTransitPaths } from '../src/features/map/render/transit-paths';
import { buildHatchPath, buildStructurePaths } from '../src/features/map/render/structure-paths';
import {
  AERODROME_DASH,
  AERODROME_STROKE_WIDTH,
  AERO_AREA_STYLE,
  AERO_LINE_ALPHA,
  aeroLineWidthFor,
  BUILDING_FILL_ALPHA,
  BUILDING_HATCH_ALPHA,
  BUILDING_HATCH_WIDTH,
  BUILDING_STROKE_ALPHA,
  buildingHatchVisible,
  buildingStrokeWidthFor,
} from '../src/features/map/core/structure-lod';
import { lodForZoom } from '../src/features/map/render/shader-uniforms';
import { mergePacked, type PackedGeometry } from '../src/features/map/tiles/packed-geometry';
import { BundleFetchByteSource } from '../src/features/map/tiles/bundle-fetch';
import { DecodingGeometrySource } from '../src/features/map/tiles/decode-source';
import type { GeometrySource } from '../src/features/map/tiles/geometry-source';
import { MartinByteSource } from '../src/features/map/tiles/martin-source';
import { createTileByteStore, InMemoryTileDb } from '../src/features/map/tiles/sqlite-tile-store';
import { CachedGeometrySource } from '../src/features/map/tiles/tile-cache';
import {
  MartinTileBundleSource,
  TILE_BUNDLE_ANCHOR_ZOOM,
} from '../src/features/map/tiles/tile-bundle';
import { tilesCovering, type DataZoomRange } from '../src/features/map/tiles/tile-math';
import { CryptidThemes } from '../src/constants/cryptid-theme';
import { BUILT_IN_MAP_COLOR_SCHEMES } from '../src/features/map/theme/map-color-schemes';

/** The planet bake's data zooms (mirrors `features/map/config.ts`, which pulls in RN). */
const PLANET_DATA_ZOOMS: DataZoomRange = { min: 0, max: 14 };

interface Place {
  readonly id: string;
  readonly label: string;
  readonly lat: number;
  readonly lon: number;
}

/**
 * The four river-heavy regions this harness is pointed at by default. Each is a
 * city standing on a major river, so one center works at street zoom (the city
 * grid for scale next to the river) and at continental zoom (its whole basin).
 */
const PLACES: readonly Place[] = [
  { id: 'westcoast', label: 'US west coast — Sacramento', lat: 38.58, lon: -121.49 },
  { id: 'africa', label: 'Central Africa — Kinshasa / Congo', lat: -4.3, lon: 15.31 },
  { id: 'india', label: 'Northern India — Varanasi / Ganges', lat: 25.32, lon: 83.01 },
  { id: 'europe', label: 'Europe — Cologne / Rhine', lat: 50.94, lon: 6.96 },
  // Not a river city: the case the building/aeroway layer exists for. A big
  // terminal, a huge apron, and runways that are otherwise blank ground.
  { id: 'seatac', label: 'SeaTac airport — Seattle', lat: 47.4435, lon: -122.3016 },
  // Home, and the densest built ground in the fixture set: downtown towers on
  // one side of I-5, Capitol Hill's blocks on the other.
  { id: 'seattle', label: 'Seattle — downtown / Capitol Hill', lat: 47.6097, lon: -122.3331 },
];

/**
 * z4 is as far out as rivers exist at all (OpenMapTiles starts the `waterway`
 * layer at z3 tiles, and the region fetches one zoom coarser); z13 is street
 * zoom. Everything between is where the report said it looked worst.
 */
const DEFAULT_ZOOMS = [4, 7, 10, 13];
const VIEWPORT: Viewport = { width: 390, height: 780 };
const PIXEL_RATIO = 2;

/**
 * The pre-fix river width: a flat 5 mask px at every zoom, with no taper.
 * `--legacy-rivers` restores it so a before/after pair comes out of one build.
 */
const LEGACY_RIVER_WIDTH = 5;

const args = parseArgs(process.argv.slice(2));
const tileUrl = process.env.EXPO_PUBLIC_TILE_URL;
if (!tileUrl) {
  console.error('EXPO_PUBLIC_TILE_URL is unset — `set -a && . ./.env.local` first.');
  process.exit(2);
}

const require_ = createRequire(import.meta.url);
const CanvasKitInit = require_('canvaskit-wasm');
const canvasKitDir = dirname(require_.resolve('canvaskit-wasm'));

async function main(): Promise<void> {
  const CanvasKit = await CanvasKitInit({
    locateFile: (file: string) => join(canvasKitDir, file),
  });
  const effect = CanvasKit.RuntimeEffect.Make(DOT_FIELD_SKSL);
  if (!effect) throw new Error('dot-field shader failed to compile under CanvasKit');

  const outDir = resolve(args.out ?? '/tmp/map-shots');
  await mkdir(outDir, { recursive: true });

  const places = args.places ? PLACES.filter((p) => args.places!.includes(p.id)) : PLACES;
  const zooms = args.zooms ?? DEFAULT_ZOOMS;
  const layers: RoadLayerOptions = { highways: args.highways ?? false };
  const selectedScheme = args.scheme
    ? BUILT_IN_MAP_COLOR_SCHEMES.find((scheme) => scheme.id === args.scheme)
    : null;
  if (args.scheme && !selectedScheme) {
    throw new Error(`unknown scheme ${args.scheme}`);
  }
  const palette = selectedScheme
    ? selectedScheme[args.mode ?? 'light']
    : CryptidThemes.daybreak.canvas;
  const lut = imageFrom(CanvasKit, buildPaletteLut(palette), 256, 3);
  const source = createSource(tileUrl!);

  for (const place of places) {
    for (const zoom of zooms) {
      const camera: CameraState = {
        center: latLonToWorld({ lat: place.lat, lon: place.lon }),
        zoom,
      };
      const spec = computeRegionSpec(camera, VIEWPORT, { dataZooms: PLANET_DATA_ZOOMS });
      const geometry = await loadGeometry(source, spec);
      const png = renderShot({ CanvasKit, effect, lut, geometry, spec, camera, palette, layers });
      const suffix = selectedScheme ? `-${selectedScheme.id}-${args.mode ?? 'light'}` : '';
      const file = join(outDir, `${place.id}-z${zoom}${suffix}.png`);
      await writeFile(file, png);
      console.log(`${file}  ${place.label} z${zoom}  mask ${spec.maskWidth}x${spec.maskHeight}`);
    }
  }
}

// ─── geometry ────────────────────────────────────────────────────────────────

/**
 * The app's own source chain, minus the native decoder. It matters that this is
 * the real thing: the tileset only serves z0–10 as plain XYZ, and everything
 * from z11 up arrives through the privacy bundle endpoint, so a naive
 * `{url}/{z}/{x}/{y}` fetch renders street zooms as empty ground.
 */
function createSource(url: string): GeometrySource {
  return new CachedGeometrySource(
    new DecodingGeometrySource(
      new BundleFetchByteSource({
        coarseUpstream: new MartinByteSource(url),
        bundleUpstream: new MartinTileBundleSource(url),
        store: createTileByteStore({ openDb: async () => new InMemoryTileDb() }),
        sourceId: 'planet-z10-v1',
        anchorZoom: TILE_BUNDLE_ANCHOR_ZOOM,
        ttlMs: 30 * 24 * 60 * 60 * 1000,
      })
    ),
    256
  );
}

async function loadGeometry(source: GeometrySource, spec: RegionSpec): Promise<PackedGeometry> {
  const tiles = tilesCovering(spec.rect, spec.tileZoom);
  const parts = await Promise.all(tiles.map((tile) => source.getTile(tile)));
  return mergePacked(parts);
}

// ─── render ──────────────────────────────────────────────────────────────────

interface ShotInput {
  CanvasKit: any;
  effect: any;
  lut: any;
  geometry: PackedGeometry;
  spec: RegionSpec;
  camera: CameraState;
  palette: MapPalette;
  layers: RoadLayerOptions;
}

function renderShot({
  CanvasKit,
  effect,
  lut,
  geometry,
  spec,
  camera,
  palette,
  layers,
}: ShotInput): Uint8Array {
  const mask = buildMask(CanvasKit, geometry, spec, layers);
  const transit = args.transit ? buildTransitMask(CanvasKit, geometry, spec, palette) : null;
  // Exploration is off in these shots, so an all-black cell texture is exactly
  // what the shader wants: explored is ignored (uExploration=0) and reveal
  // order 0 means "fully revealed" at uReveal=1.
  const cells = imageFrom(
    CanvasKit,
    blackRgba(spec.maskWidth, spec.maskHeight),
    spec.maskWidth,
    spec.maskHeight
  );

  const scale = scaleFor(spec.zoom);
  const rectW = spec.rect.maxX - spec.rect.minX;
  const rectH = spec.rect.maxY - spec.rect.minY;
  const uniforms = [
    PIXEL_RATIO,
    scale,
    rectW,
    rectH,
    spec.maskWidth,
    spec.maskHeight,
    2.0, // DOT_STEP
    palette.bg[0] / 255,
    palette.bg[1] / 255,
    palette.bg[2] / 255,
    1, // uReveal
    lodForZoom(spec.zoom), // uLod
    0, // uExploration — plain city render, no fog of war
    palette.effects?.neonGlow ?? 0,
    palette.effects?.scanlines ?? 0,
    args.transit ? 1 : 0, // uTransit
  ];

  const shader = effect.makeShaderWithChildren(uniforms, [
    mask.makeShaderOptions(
      CanvasKit.TileMode.Clamp,
      CanvasKit.TileMode.Clamp,
      CanvasKit.FilterMode.Nearest,
      CanvasKit.MipmapMode.None
    ),
    cells.makeShaderOptions(
      CanvasKit.TileMode.Clamp,
      CanvasKit.TileMode.Clamp,
      CanvasKit.FilterMode.Nearest,
      CanvasKit.MipmapMode.None
    ),
    lut.makeShaderOptions(
      CanvasKit.TileMode.Clamp,
      CanvasKit.TileMode.Clamp,
      CanvasKit.FilterMode.Linear,
      CanvasKit.MipmapMode.None
    ),
    (transit ?? mask).makeShaderOptions(
      CanvasKit.TileMode.Clamp,
      CanvasKit.TileMode.Clamp,
      CanvasKit.FilterMode.Nearest,
      CanvasKit.MipmapMode.None
    ),
  ]);

  // The region bitmap covers the whole padded rect at anchor zoom; the shot is
  // the viewport window out of it (region-logical px are screen px at anchor).
  const view = visibleWorldRect(camera, VIEWPORT);
  const offX = (view.minX - spec.rect.minX) * scale;
  const offY = (view.minY - spec.rect.minY) * scale;

  const surface = CanvasKit.MakeSurface(
    VIEWPORT.width * PIXEL_RATIO,
    VIEWPORT.height * PIXEL_RATIO
  );
  if (!surface) throw new Error('CanvasKit.MakeSurface failed');
  const canvas = surface.getCanvas();
  const paint = new CanvasKit.Paint();
  paint.setShader(shader);
  canvas.save();
  canvas.translate(-offX * PIXEL_RATIO, -offY * PIXEL_RATIO);
  canvas.drawRect(
    CanvasKit.XYWHRect(0, 0, rectW * scale * PIXEL_RATIO, rectH * scale * PIXEL_RATIO),
    paint
  );
  if (!args.noStructures) drawStructures(CanvasKit, canvas, geometry, spec, palette);
  canvas.restore();

  const snapshot = surface.makeImageSnapshot();
  const png = snapshot.encodeToBytes();
  snapshot.delete();
  paint.delete();
  surface.delete();
  mask.delete();
  transit?.delete();
  cells.delete();
  return png as Uint8Array;
}

/**
 * Buildings + aeroway over the dot field, mirroring `drawStructures` in
 * `render/region-shader.ts`. Called inside the region translate, so it only has
 * to scale region-logical px up to device px.
 */
function drawStructures(
  CanvasKit: any,
  canvas: any,
  geometry: PackedGeometry,
  spec: RegionSpec,
  palette: MapPalette
): void {
  const paths = buildStructurePaths(geometry, spec);
  const ink = palette.building;

  const paintOf = (alpha: number, width: number | null, dash?: readonly [number, number]) => {
    const paint = new CanvasKit.Paint();
    paint.setColor(CanvasKit.Color(ink[0], ink[1], ink[2], alpha));
    paint.setAntiAlias(true);
    if (width === null) {
      paint.setStyle(CanvasKit.PaintStyle.Fill);
    } else {
      paint.setStyle(CanvasKit.PaintStyle.Stroke);
      paint.setStrokeWidth(width);
      paint.setStrokeJoin(CanvasKit.StrokeJoin.Round);
      paint.setStrokeCap(CanvasKit.StrokeCap.Round);
      if (dash) paint.setPathEffect(CanvasKit.PathEffect.MakeDash([dash[0], dash[1]]));
    }
    return paint;
  };
  const draw = (
    svg: string,
    alpha: number,
    width: number | null,
    dash?: readonly [number, number]
  ) => {
    if (!svg || alpha <= 0) return;
    const path = CanvasKit.Path.MakeFromSVGString(svg);
    if (!path) return;
    if (width === null) path.setFillType(CanvasKit.FillType.Winding);
    const paint = paintOf(alpha, width, dash);
    canvas.drawPath(path, paint);
    paint.delete();
    path.delete();
  };

  canvas.save();
  canvas.scale(PIXEL_RATIO, PIXEL_RATIO);

  // Same painter's order as `drawStructures` in render/region-shader.ts.
  for (const kind of ['apron', 'aerodrome'] as const satisfies readonly AeroAreaKind[]) {
    const svg = paths.aeroAreas[kind];
    if (!svg) continue;
    const style = AERO_AREA_STYLE[kind];
    draw(svg, style.fillAlpha, null);
    draw(
      svg,
      style.strokeAlpha,
      AERODROME_STROKE_WIDTH,
      kind === 'aerodrome' ? AERODROME_DASH : undefined
    );
  }
  for (const kind of ['taxiway', 'runway'] as const satisfies readonly AeroLineKind[]) {
    const svg = paths.aeroLines[kind];
    if (svg) draw(svg, AERO_LINE_ALPHA[kind], aeroLineWidthFor(kind, spec.zoom));
  }
  const buildingWidth = buildingStrokeWidthFor(spec.zoom);
  if (buildingWidth !== null && paths.buildings) {
    draw(paths.buildings, BUILDING_FILL_ALPHA, null);
    // Hatch clipped to the footprints — mirrors `drawBuildingHatch`.
    if (buildingHatchVisible(spec.zoom)) {
      const clip = CanvasKit.Path.MakeFromSVGString(paths.buildings);
      const hatch = CanvasKit.Path.MakeFromSVGString(buildHatchPath(spec));
      if (clip && hatch) {
        clip.setFillType(CanvasKit.FillType.Winding);
        canvas.save();
        canvas.clipPath(clip, CanvasKit.ClipOp.Intersect, true);
        const paint = paintOf(BUILDING_HATCH_ALPHA, BUILDING_HATCH_WIDTH);
        canvas.drawPath(hatch, paint);
        paint.delete();
        canvas.restore();
      }
      clip?.delete();
      hatch?.delete();
    }
    draw(paths.buildings, BUILDING_STROKE_ALPHA, buildingWidth);
  }

  canvas.restore();
}

/** The feature mask, built exactly like `render/mask-image.ts` but on CanvasKit. */
function buildMask(
  CanvasKit: any,
  geometry: PackedGeometry,
  spec: RegionSpec,
  layers: RoadLayerOptions
) {
  const paths = buildMaskPaths(geometry, spec, layers);
  const surface = CanvasKit.MakeSurface(spec.maskWidth, spec.maskHeight);
  if (!surface) throw new Error('mask surface failed');
  const canvas = surface.getCanvas();
  canvas.clear(CanvasKit.BLACK);

  const stroke = (svg: string, rgb: [number, number, number], width: number) => {
    if (!svg) return;
    const path = CanvasKit.Path.MakeFromSVGString(svg);
    if (!path) return;
    const paint = new CanvasKit.Paint();
    paint.setColor(CanvasKit.Color(rgb[0], rgb[1], rgb[2], 1));
    paint.setStyle(CanvasKit.PaintStyle.Stroke);
    paint.setStrokeWidth(width);
    paint.setStrokeCap(CanvasKit.StrokeCap.Round);
    paint.setStrokeJoin(CanvasKit.StrokeJoin.Round);
    paint.setBlendMode(CanvasKit.BlendMode.Lighten);
    paint.setAntiAlias(true);
    canvas.drawPath(path, paint);
    paint.delete();
    path.delete();
  };
  const fill = (svg: string, rgb: [number, number, number]) => {
    if (!svg) return;
    const path = CanvasKit.Path.MakeFromSVGString(svg);
    if (!path) return;
    path.setFillType(CanvasKit.FillType.Winding);
    const paint = new CanvasKit.Paint();
    paint.setColor(CanvasKit.Color(rgb[0], rgb[1], rgb[2], 1));
    paint.setStyle(CanvasKit.PaintStyle.Fill);
    paint.setBlendMode(CanvasKit.BlendMode.Lighten);
    paint.setAntiAlias(true);
    canvas.drawPath(path, paint);
    paint.delete();
    path.delete();
  };

  for (let cls = 0; cls < paths.streets.length; cls++) {
    const width = roadWidthFor(cls, spec.zoom);
    if (width === null) continue;
    stroke(paths.streets[cls], [ROAD_VALUES[cls], 0, 0], width);
  }
  fill(paths.park, [0, 255, 0]);
  fill(paths.water, [0, 0, 255]);
  const riverWidth = args.legacyRivers ? LEGACY_RIVER_WIDTH : riverWidthFor(spec.zoom);
  if (riverWidth !== null) stroke(paths.rivers, [0, 0, 255], riverWidth);

  const image = surface.makeImageSnapshot();
  surface.delete();
  return image;
}

/** Mirrors the mode-colored coverage texture in `render/mask-image.ts`. */
function buildTransitMask(
  CanvasKit: any,
  geometry: PackedGeometry,
  spec: RegionSpec,
  palette: MapPalette
) {
  const paths = buildTransitPaths(geometry, spec);
  const surface = CanvasKit.MakeSurface(spec.maskWidth, spec.maskHeight);
  if (!surface) throw new Error('transit mask surface failed');
  const canvas = surface.getCanvas();
  canvas.clear(CanvasKit.TRANSPARENT);
  for (const mode of TRANSIT_MODES) {
    const svg = paths[mode];
    const width = transitWidthFor(mode, spec.zoom);
    if (!svg || width === null) continue;
    const path = CanvasKit.Path.MakeFromSVGString(svg);
    if (!path) continue;
    const ink = transitColorFor(mode, palette).map(Math.round);
    const paint = new CanvasKit.Paint();
    paint.setColor(CanvasKit.Color(ink[0], ink[1], ink[2], 1));
    paint.setStyle(CanvasKit.PaintStyle.Stroke);
    paint.setStrokeWidth(width);
    paint.setStrokeCap(CanvasKit.StrokeCap.Round);
    paint.setStrokeJoin(CanvasKit.StrokeJoin.Round);
    paint.setAntiAlias(true);
    if (mode === 'ferry') paint.setPathEffect(CanvasKit.PathEffect.MakeDash([...FERRY_DASH]));
    canvas.drawPath(path, paint);
    paint.delete();
    path.delete();
  }
  const image = surface.makeImageSnapshot();
  surface.delete();
  return image;
}

function imageFrom(CanvasKit: any, data: Uint8Array, width: number, height: number) {
  const image = CanvasKit.MakeImage(
    {
      width,
      height,
      colorType: CanvasKit.ColorType.RGBA_8888,
      alphaType: CanvasKit.AlphaType.Opaque,
      colorSpace: CanvasKit.ColorSpace.SRGB,
    },
    data,
    width * 4
  );
  if (!image) throw new Error('CanvasKit.MakeImage failed');
  return image;
}

function blackRgba(width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  for (let i = 3; i < out.length; i += 4) out[i] = 0xff;
  return out;
}

// ─── args ────────────────────────────────────────────────────────────────────

interface Args {
  out?: string;
  places?: string[];
  zooms?: number[];
  highways?: boolean;
  transit?: boolean;
  noStructures?: boolean;
  legacyRivers?: boolean;
  scheme?: string;
  mode?: 'light' | 'dark';
}

function parseArgs(argv: readonly string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out') out.out = argv[++i];
    else if (arg === '--places') out.places = argv[++i].split(',');
    else if (arg === '--zooms') out.zooms = argv[++i].split(',').map(Number);
    else if (arg === '--scheme') out.scheme = argv[++i];
    else if (arg === '--mode') {
      const mode = argv[++i];
      if (mode !== 'light' && mode !== 'dark') throw new Error('--mode expects light or dark');
      out.mode = mode;
    } else if (arg === '--highways') out.highways = true;
    else if (arg === '--transit') out.transit = true;
    else if (arg === '--no-structures') out.noStructures = true;
    else if (arg === '--legacy-rivers') out.legacyRivers = true;
    else throw new Error(`unknown flag ${arg}`);
  }
  return out;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(tileUrl ? message.replaceAll(tileUrl, '<tile-url>') : message);
  process.exitCode = 1;
});
