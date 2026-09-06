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
 *   bun scripts/map-shot.ts --places seattle --zooms 12,10,8 --exploration
 *   bun scripts/map-shot.ts --places seattle --zooms 17 --labels
 *   bun scripts/map-shot.ts --places pacific --zooms 3 --cryptids
 *   bun scripts/map-shot.ts --places seattle --zooms 17 --labels --transit
 *
 * `--exploration` seeds the deterministic demo walk at the place and renders the
 * real exploration layer — the same `buildCellField` → cell-state texture →
 * ghost lattice + amber rim path the app runs — so the resolution ladder
 * (`core/cell-ladder.ts`) can be eyeballed rung by rung.
 *
 * `--labels` and `--cryptids` draw the two React overlays the shotter otherwise
 * cannot show: the name chips `selectMapLabels` places (street, park, POI, house
 * number) and the sea cryptids `visibleOceanCryptids` places. Both call the same
 * pure selectors the app calls and reuse the app's own metrics, so what comes
 * out is the real placement — the only difference is CanvasKit drawing the glyphs
 * instead of react-native <Text>.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
import { ROAD_VALUES } from '../src/features/map/core/masks';
import type {
  AeroAreaKind,
  AeroLineKind,
  CameraState,
  MapPalette,
  Viewport,
} from '../src/features/map/core/types';
import { buildCellField } from '../src/features/map/core/cell-field';
import {
  createExplorationIndex,
  demoExploration,
} from '../src/features/map/core/exploration-index';
import { createExplorationRollup } from '../src/features/map/core/exploration-rollup';
import { createH3Grid, realH3 } from '../src/features/map/core/h3-grid';
import {
  labelWidthPx,
  selectMapLabels,
  LABEL_FONT_SIZE,
  LABEL_HEIGHT_PX,
  LABEL_LETTER_SPACING,
  type MapLabel,
} from '../src/features/map/core/map-labels';
import { oceanCryptidOpacity, visibleOceanCryptids } from '../src/features/map/core/ocean-cryptids';
import {
  cellLatticePath,
  cellRimPath,
  cellStateFills,
} from '../src/features/map/render/cell-overlay-paths';
import { DOT_FIELD_SKSL } from '../src/features/map/render/dot-field-sksl';
import { buildMaskPaths } from '../src/features/map/render/mask-paths';
import { buildHatchPath, buildStructurePaths } from '../src/features/map/render/structure-paths';
import { buildTransitPaths } from '../src/features/map/render/transit-paths';
import { FERRY_DASH, transitWidthFor } from '../src/features/map/core/transit-lod';
import type { TransitMode } from '../src/features/map/core/types';
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
  // Open water at globe zoom: what `--cryptids` exists to show, and the one view
  // where the exploration ladder has deliberately gone dark.
  { id: 'pacific', label: 'North Pacific — open water', lat: 25, lon: -150 },
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

/** Line break inside a cryptid's ASCII art. */
const NEWLINE = '\n';

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

  // One grid + one rollup for the whole run, exactly as `MapEngine` holds them,
  // so the coarse-rung ancestor sets are built once and reused across zooms.
  const grid = createH3Grid(realH3());
  const rollup = args.exploration ? createExplorationRollup(grid) : null;

  // The overlays are type, so they need a real face. IBM Plex Mono 500 is the
  // one `render/map-labels.tsx` and `render/ocean-cryptid-layer.tsx` both name.
  const typeface =
    args.labels || args.cryptids
      ? CanvasKit.Typeface.MakeFreeTypeFaceFromData(
          (
            await readFile(
              'node_modules/@expo-google-fonts/ibm-plex-mono/500Medium/IBMPlexMono_500Medium.ttf'
            )
          ).buffer
        )
      : null;
  if ((args.labels || args.cryptids) && !typeface) throw new Error('failed to load IBM Plex Mono');

  for (const place of places) {
    const home = latLonToWorld({ lat: place.lat, lon: place.lon });
    // The same deterministic walk the fixture dataset uses, so the shot shows a
    // plausible territory rather than a blank or a contrived blob.
    const exploration = args.exploration
      ? createExplorationIndex(demoExploration(grid, home))
      : null;

    for (const zoom of zooms) {
      const camera: CameraState = { center: home, zoom };
      const spec = computeRegionSpec(camera, VIEWPORT, { dataZooms: PLANET_DATA_ZOOMS });
      const geometry = await loadGeometry(source, spec);
      // The ladder decides the resolution; `spec.cellRes` is null once the
      // camera drops below its coarsest rung, which is exactly when the layer
      // should vanish from the shot too.
      const cellField =
        args.exploration && spec.cellRes !== null
          ? buildCellField(grid, spec.rect, spec.cellRes, exploration!, rollup!)
          : null;
      const png = renderShot({
        CanvasKit,
        effect,
        lut,
        geometry,
        spec,
        camera,
        palette,
        layers,
        cellField,
        typeface,
        // The real selectors, called exactly as the app calls them.
        // Mirrors `map-view.tsx`: a stop name hides with the lines it belongs to.
        labels: args.labels
          ? selectMapLabels(geometry, spec).filter(
              (label) => args.transit || label.kind !== 'transit'
            )
          : null,
        cryptids: args.cryptids ? visibleOceanCryptids(camera, VIEWPORT) : null,
        chrome: CryptidThemes.daybreak.chrome,
      });
      const suffix = selectedScheme ? `-${selectedScheme.id}-${args.mode ?? 'light'}` : '';
      const file = join(outDir, `${place.id}-z${zoom}${suffix}.png`);
      await writeFile(file, png);
      console.log(
        `${file}  ${place.label} z${zoom}  mask ${spec.maskWidth}x${spec.maskHeight}` +
          (args.exploration
            ? `  cellRes ${spec.cellRes ?? 'hidden'} (${cellField?.cells.length ?? 0} cells)`
            : '')
      );
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
  /** Baked exploration cells for this region, or null for a plain city render. */
  cellField: ReturnType<typeof buildCellField> | null;
  typeface: any;
  /** Name chips to draw over the field (--labels), or null. */
  labels: readonly MapLabel[] | null;
  /** Sea cryptids to draw (--cryptids), or null. */
  cryptids: ReturnType<typeof visibleOceanCryptids> | null;
  chrome: { readonly island: string; readonly ink: string };
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
  cellField,
  typeface,
  labels,
  cryptids,
  chrome,
}: ShotInput): Uint8Array {
  const mask = buildMask(CanvasKit, geometry, spec, layers);
  // Without --exploration an all-black cell texture is exactly what the shader
  // wants: explored is ignored (uExploration=0) and reveal order 0 means "fully
  // revealed" at uReveal=1. With it, the real baked cell state goes in instead.
  const field = cellField;
  const cells = field
    ? buildCellTexture(CanvasKit, field, spec)
    : imageFrom(
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
    cellField ? 1 : 0, // uExploration — fog of war only with --exploration
    palette.effects?.neonGlow ?? 0,
    palette.effects?.scanlines ?? 0,
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
  if (args.transit) drawTransitLines(CanvasKit, canvas, geometry, spec, palette);
  if (cellField) drawCellOverlays(CanvasKit, canvas, cellField, spec, palette);
  canvas.restore();

  // The React overlays sit in SCREEN space, not region space — so they are drawn
  // after the region translate is popped, positioned the way the layers position
  // them (anchor-space point minus the region offset).
  if (labels && typeface) {
    drawLabels(CanvasKit, canvas, labels, spec, palette, chrome, typeface, offX, offY);
  }
  if (cryptids && typeface) {
    drawCryptids(CanvasKit, canvas, cryptids, spec, camera, palette, typeface, offX, offY);
  }

  const snapshot = surface.makeImageSnapshot();
  const png = snapshot.encodeToBytes();
  snapshot.delete();
  paint.delete();
  surface.delete();
  mask.delete();
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
/**
 * Transit lines over the dot field, mirroring `drawTransitLines` in
 * `render/region-shader.ts` (same widths, same per-mode alphas, same ferry dash).
 */
function drawTransitLines(
  CanvasKit: any,
  canvas: any,
  geometry: PackedGeometry,
  spec: RegionSpec,
  palette: MapPalette
): void {
  const alphas: Record<TransitMode, number> = {
    rail: 0.5,
    subway: 0.82,
    light_rail: 0.82,
    tram: 0.58,
    monorail: 0.72,
    funicular: 0.58,
    ferry: 0.5,
  };
  const paths = buildTransitPaths(geometry, spec);

  canvas.save();
  canvas.scale(PIXEL_RATIO, PIXEL_RATIO);
  for (const [mode, svg] of Object.entries(paths) as [TransitMode, string][]) {
    const width = transitWidthFor(mode, spec.zoom);
    if (width === null || !svg) continue;
    const path = CanvasKit.Path.MakeFromSVGString(svg);
    if (!path) continue;
    const ink = palette.transit;
    const paint = new CanvasKit.Paint();
    paint.setColor(CanvasKit.Color(ink[0], ink[1], ink[2], alphas[mode]));
    paint.setStyle(CanvasKit.PaintStyle.Stroke);
    paint.setStrokeWidth(width);
    paint.setStrokeJoin(CanvasKit.StrokeJoin.Round);
    paint.setStrokeCap(CanvasKit.StrokeCap.Round);
    paint.setAntiAlias(true);
    if (mode === 'ferry') {
      paint.setPathEffect(CanvasKit.PathEffect.MakeDash([FERRY_DASH[0], FERRY_DASH[1]]));
    }
    canvas.drawPath(path, paint);
    paint.delete();
    path.delete();
  }
  canvas.restore();
}

/**
 * Name chips over the dot field — the CanvasKit twin of `render/map-labels.tsx`.
 *
 * The placement is not re-derived: `selectMapLabels` already chose and collided
 * these, and the chip geometry here reuses `labelWidthPx` and `LABEL_HEIGHT_PX`,
 * the very constants the RN styles are built from. So a chip that overlaps here
 * would overlap on the phone.
 */
function drawLabels(
  CanvasKit: any,
  canvas: any,
  labels: readonly MapLabel[],
  spec: RegionSpec,
  palette: MapPalette,
  chrome: { readonly island: string; readonly ink: string },
  typeface: any,
  offX: number,
  offY: number
): void {
  const scale = scaleFor(spec.zoom);
  const font = new CanvasKit.Font(typeface, LABEL_FONT_SIZE);
  const chipPaint = new CanvasKit.Paint();
  chipPaint.setAntiAlias(true);
  // The island surface is a translucent rgba() in the theme; approximate it with
  // the near-white it resolves to over the daybreak canvas.
  chipPaint.setColor(CanvasKit.Color(255, 255, 255, 0.9));

  canvas.save();
  canvas.scale(PIXEL_RATIO, PIXEL_RATIO);
  for (const label of labels) {
    const width = labelWidthPx(label.text);
    const cx = (label.world[0] - spec.rect.minX) * scale - offX;
    const cy = (label.world[1] - spec.rect.minY) * scale - offY;
    if (cx < -width || cy < -LABEL_HEIGHT_PX || cx > VIEWPORT.width + width) continue;

    const rgb =
      label.kind === 'area'
        ? palette.parkLabel
        : label.kind === 'poi' || label.kind === 'housenumber'
          ? palette.building
          : palette.streetLabel;
    const alpha = label.kind === 'housenumber' ? 0.62 : 1;

    canvas.save();
    canvas.translate(cx, cy);
    canvas.rotate((label.angle * 180) / Math.PI, 0, 0);
    chipPaint.setAlphaf(0.9 * alpha);
    canvas.drawRRect(
      CanvasKit.RRectXY(
        CanvasKit.XYWHRect(-width / 2, -LABEL_HEIGHT_PX / 2, width, LABEL_HEIGHT_PX),
        3,
        3
      ),
      chipPaint
    );

    // Mono + letter spacing: place each glyph on the same advance the RN text
    // layout uses (LABEL_CHAR_PX), rather than letting Skia shape it.
    const textPaint = new CanvasKit.Paint();
    textPaint.setColor(CanvasKit.Color(rgb[0], rgb[1], rgb[2], alpha));
    textPaint.setAntiAlias(true);
    const advance = LABEL_FONT_SIZE * 0.6 + LABEL_LETTER_SPACING;
    let x = -((label.text.length * advance) / 2);
    for (const ch of label.text) {
      canvas.drawText(ch, x, LABEL_FONT_SIZE * 0.36, textPaint, font);
      x += advance;
    }
    textPaint.delete();
    canvas.restore();
  }
  chipPaint.delete();
  font.delete();
  canvas.restore();
}

/**
 * Sea cryptids — the CanvasKit twin of `render/ocean-cryptid-layer.tsx`, at the
 * layer's own fade and ink. Drawn at their resting position: the drift is a
 * UI-thread animation and a still frame is one moment of it.
 */
function drawCryptids(
  CanvasKit: any,
  canvas: any,
  cryptids: ReturnType<typeof visibleOceanCryptids>,
  spec: RegionSpec,
  camera: CameraState,
  palette: MapPalette,
  typeface: any,
  offX: number,
  offY: number
): void {
  const scale = scaleFor(spec.zoom);
  const opacity = oceanCryptidOpacity(camera.zoom) * 0.55;
  if (opacity <= 0) return;
  const [r, g, b] = palette.streetLabel;

  const font = new CanvasKit.Font(typeface, 11);
  const paint = new CanvasKit.Paint();
  paint.setColor(CanvasKit.Color(r, g, b, opacity));
  paint.setAntiAlias(true);

  canvas.save();
  canvas.scale(PIXEL_RATIO, PIXEL_RATIO);
  for (const cryptid of cryptids) {
    const x = (cryptid.world[0] - spec.rect.minX) * scale - offX;
    const y = (cryptid.world[1] - spec.rect.minY) * scale - offY;
    cryptid.art.split(NEWLINE).forEach((line, i) => {
      canvas.drawText(line, x, y + i * 12 + 9, paint, font);
    });
  }
  paint.delete();
  font.delete();
  canvas.restore();
}

/**
 * The region's cell field baked into the RGBA texture the shader samples
 * (R = occupancy, G = jitter, B = reveal order) — the CanvasKit twin of
 * `render/cell-state-image.ts`, driven by the same pure geometry builder.
 */
function buildCellTexture(
  CanvasKit: any,
  field: ReturnType<typeof buildCellField>,
  spec: RegionSpec
) {
  const surface = CanvasKit.MakeSurface(spec.maskWidth, spec.maskHeight);
  if (!surface) throw new Error('cell surface failed');
  const canvas = surface.getCanvas();
  canvas.clear(CanvasKit.BLACK);

  const paint = new CanvasKit.Paint();
  paint.setStyle(CanvasKit.PaintStyle.Fill);
  // Off, exactly as in the app: a blended edge texel would smear one cell's
  // occupancy and reveal order into its neighbour.
  paint.setAntiAlias(false);

  // The SVG-string builder rather than the geometry one the app uses: CanvasKit
  // only exposes `Path.MakeFromSVGString` here. Same channel encoding either way.
  for (const fill of cellStateFills(field, spec)) {
    const [r, g, b] = fill.color.match(/\d+/g)!.map(Number);
    paint.setColor(CanvasKit.Color(r, g, b, 1));
    const path = CanvasKit.Path.MakeFromSVGString(fill.path);
    if (!path) continue;
    canvas.drawPath(path, paint);
    path.delete();
  }
  paint.delete();

  const snapshot = surface.makeImageSnapshot();
  surface.delete();
  return snapshot;
}

/**
 * Ghost lattice + amber frontier rim, mirroring `drawCellOverlays` in
 * `render/region-shader.ts` (same paths, same alphas, same LOD fade).
 */
function drawCellOverlays(
  CanvasKit: any,
  canvas: any,
  field: ReturnType<typeof buildCellField>,
  spec: RegionSpec,
  palette: MapPalette
): void {
  const lod = lodForZoom(spec.zoom);
  const latticeAlpha = 0.09 * (1 - lod * 0.7);
  const rimAlpha = 0.42;

  canvas.save();
  canvas.scale(PIXEL_RATIO, PIXEL_RATIO);
  const stroke = (svg: string, rgb: readonly number[], width: number, alpha: number) => {
    if (!svg || alpha <= 0) return;
    const path = CanvasKit.Path.MakeFromSVGString(svg);
    if (!path) return;
    const paint = new CanvasKit.Paint();
    paint.setColor(CanvasKit.Color(rgb[0], rgb[1], rgb[2], alpha));
    paint.setStyle(CanvasKit.PaintStyle.Stroke);
    paint.setStrokeWidth(width);
    paint.setStrokeJoin(CanvasKit.StrokeJoin.Round);
    paint.setAntiAlias(true);
    canvas.drawPath(path, paint);
    paint.delete();
    path.delete();
  };
  stroke(cellLatticePath(field, spec), palette.streetLabel, 1.0, latticeAlpha);
  stroke(cellRimPath(field, spec), palette.accent, 1.25, rimAlpha);
  canvas.restore();
}

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
  exploration?: boolean;
  labels?: boolean;
  cryptids?: boolean;
  transit?: boolean;
  highways?: boolean;
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
    else if (arg === '--exploration') out.exploration = true;
    else if (arg === '--labels') out.labels = true;
    else if (arg === '--cryptids') out.cryptids = true;
    else if (arg === '--transit') out.transit = true;
    else if (arg === '--zooms') out.zooms = argv[++i].split(',').map(Number);
    else if (arg === '--scheme') out.scheme = argv[++i];
    else if (arg === '--mode') {
      const mode = argv[++i];
      if (mode !== 'light' && mode !== 'dark') throw new Error('--mode expects light or dark');
      out.mode = mode;
    } else if (arg === '--highways') out.highways = true;
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
