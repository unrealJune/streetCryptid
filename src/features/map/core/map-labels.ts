/**
 * Map label selection — the "street names at the right zoom" half of the design
 * archive's map (`docs/design/mock_real.html`, `renders/zoom-*`).
 *
 * Pure: packed geometry + a region spec in, a small list of placed labels out.
 * Nothing here touches Skia or React; the render layer (`render/map-labels.tsx`)
 * only positions what this returns.
 *
 * Three independent gates decide whether a name is drawn, and together they are
 * what makes small roads stay quiet until you are actually standing on them:
 *
 * 1. **Class tier** — a road class only earns a name at {@link LABEL_MIN_ZOOM},
 *    deliberately several zooms later than {@link CLASS_MIN_ZOOM} (where the road
 *    first draws at all). A residential street reads as geometry across a whole
 *    neighbourhood view; it is only worth *naming* once it fills the screen.
 * 2. **Fit** — the label must physically fit along the way's on-screen length.
 *    This is the continuous half of the LOD: the same street silently drops its
 *    name as you zoom out, before its class tier cuts it off entirely.
 * 3. **Collision** — greedy rejection against already-placed labels, highest
 *    priority first, so the field never turns into overlapping mush.
 */

import { scaleFor } from './camera';
import type { RegionSpec } from './region';
import { CLASS_MIN_ZOOM, HIGHWAY_CLASS } from './road-lod';
import type { WorldPoint } from './types';
import type {
  PackedAreas,
  PackedGeometry,
  PackedStreets,
  PackedTile,
} from '../tiles/packed-geometry';

export type MapLabelKind = 'street' | 'area' | 'poi' | 'transit' | 'housenumber' | 'place' | 'peak';

/** One placed label: where it goes in world space and how it is turned. */
export interface MapLabel {
  readonly id: string;
  readonly kind: MapLabelKind;
  /** Display text, already uppercased (the mock's mono chip style). */
  readonly text: string;
  readonly world: WorldPoint;
  /** Baseline rotation in radians, clamped to ±90° so text is never upside down. */
  readonly angle: number;
  /** Road class 0–4 for street labels; undefined for areas. Lets the render
   *  layer hide a class's chips with its roads (the highways layer toggle). */
  readonly roadClass?: number;
}

/**
 * Zoom at which a road class earns a NAME, indexed by road class 0–4. Compare
 * with {@link CLASS_MIN_ZOOM} (when the class first draws): naming trails
 * drawing by ~3 zoom levels, so an arterial is labelled from the city view down
 * while a service road only gets a name at the very bottom of the zoom range.
 *
 * Calibrated against the camera range in `config.ts` (z1–z16, opening at z15):
 * a default street-level view labels motorways through residential streets, and
 * zooming out sheds them class by class.
 */
export const LABEL_MIN_ZOOM = [15.5, 14.0, 12.5, 11.0, 9.0] as const;

/** Below this zoom even a large park goes unnamed — the city has no room for it. */
export const AREA_LABEL_MIN_ZOOM = 11;

/**
 * Below this zoom no POI is named. The `poi` layer exists from data zoom 13, but
 * the tileset rank-filters it hard there (a handful of landmarks per tile), so
 * this tier shows exactly those — and then opens up on its own as the camera
 * crosses `DATA_ZOOM_FULL_DETAIL_ZOOM` and the dense z14 layer arrives.
 */
export const POI_LABEL_MIN_ZOOM = 13.5;

/**
 * Below this zoom house numbers are not drawn. They are the last thing a map
 * should say, and there are ~1100 per z14 tile — they only make sense once a
 * single block fills the screen.
 */
export const HOUSENUMBER_MIN_ZOOM = 17;

/**
 * Camera-zoom band in which an OMT `place` class earns a chip — the "city nodes" half of
 * DESIGN.md's region view, which the tiles have always carried and nothing ever drew.
 *
 * A BAND, not a floor, which is what makes this different from every other label kind here. The
 * rest of the map's names appear as you come down and stay; a place name is only useful while the
 * thing it names is bigger than the screen is showing. SEATTLE across a Puget Sound view is the
 * map telling you what you are looking at; the same chip pinned to a downtown block is noise on
 * top of the street names that have by then arrived to say it better. The upper bounds are
 * therefore set where the next kind of name takes over — `city` ends at 12.5, exactly where
 * {@link LABEL_MIN_ZOOM} starts naming secondary roads.
 *
 * Localities finer than `town` are deliberately absent. They would land at the default opening
 * zoom (z15) on top of a view that is already labelled, and nothing here needs them yet.
 */
export const PLACE_LABEL_BANDS: Readonly<Record<string, readonly [number, number]>> = {
  country: [0, 5.0],
  state: [3.5, 9.0],
  province: [3.5, 9.0],
  region: [3.5, 9.0],
  island: [6.0, 11.0],
  city: [4.5, 12.5],
  town: [7.5, 12.5],
};

/**
 * Coarsest-first, so a state chip is placed before the cities inside it and a city before the
 * towns around it. The collision pass is greedy, so this order IS the priority.
 */
const PLACE_CLASS_ORDER: readonly string[] = [
  'country',
  'state',
  'province',
  'region',
  'island',
  'city',
  'town',
];

/** At most this many place chips — the region view is a shape to recognize, not a gazetteer. */
const MAX_PLACE_LABELS = 12;

/**
 * How many OMT place ranks to admit at `zoom` (1-based, lower = more prominent). Doubling every
 * two zoom levels: a continental view shows the two or three names that carry it, and a county
 * view shows the towns as well as the cities.
 */
export function placeRankBudget(zoom: number): number {
  return Math.max(1, Math.round(2 * Math.pow(2, (zoom - 4) / 2)));
}

/**
 * OMT `poi` classes that are street furniture, and never earn a name at all.
 */
const POI_EXCLUDED_CLASSES: ReadonlySet<string> = new Set(['waste_basket', 'bench']);

/**
 * `subclass` values that make a POI a TRANSIT STOP rather than a place.
 *
 * These are not dropped — they become their own label kind, drawn in the transit
 * ink alongside the transit lines. Separating them is what keeps them usable:
 * every corner bus stop is a POI named for its intersection AT RANK 1, so mixed
 * in with places they win every tie-break and bury the actual buildings under
 * the longest strings on screen (measured downtown, four of them crowded out
 * most of a block). A light-rail STATION stays a place — it is a landmark, not
 * a pole on a corner.
 */
const TRANSIT_STOP_SUBCLASSES: ReadonlySet<string> = new Set([
  'tram_stop',
  'bus_stop',
  'platform',
  'stop_position',
  'halt',
]);

/**
 * Below this zoom transit stops go unnamed. Far denser than places — a downtown
 * z14 tile carries a stop on nearly every corner — so they only make sense once
 * you are close enough to walk to one.
 */
export const TRANSIT_STOP_MIN_ZOOM = 16;

/** True when a POI is a stop on a line rather than a place in a building. */
export function isTransitStop(poi: { readonly kind: string; readonly subclass: string }): boolean {
  return poi.kind === 'bus' || TRANSIT_STOP_SUBCLASSES.has(poi.subclass);
}

/**
 * How many POI ranks to admit at `zoom` (OMT `rank` is 1-based, lower = more
 * prominent). Doubles per zoom level, so the city view names only the couple of
 * landmarks the tileset kept at z13 and the deepest view names most of a block.
 */
export function poiRankBudget(zoom: number): number {
  return Math.max(1, Math.round(2 * Math.pow(2, zoom - POI_LABEL_MIN_ZOOM)));
}

/**
 * Mono chip metrics, logical px. These MUST stay in step with the styles in
 * `render/map-labels.tsx`: the fit and collision gates are measured here but
 * the text is laid out there, and a mismatch shows up as overlap.
 */
export const LABEL_FONT_SIZE = 9;
export const LABEL_LETTER_SPACING = 0.9;
/** Advance per character: IBM Plex Mono is 0.6 em, plus the tracking. */
export const LABEL_CHAR_PX = LABEL_FONT_SIZE * 0.6 + LABEL_LETTER_SPACING;
/** Total horizontal chip padding, and the chip's height. */
export const LABEL_PAD_PX = 10;
export const LABEL_HEIGHT_PX = 15;

/** Smallest on-screen park (px²) worth naming — below this the chip covers it. */
const MIN_AREA_PX = 2600;

/** Hard caps, so a dense downtown region can't spend the frame on chips. */
const MAX_STREET_LABELS = 16;
const MAX_AREA_LABELS = 5;
const MAX_POI_LABELS = 14;
const MAX_TRANSIT_STOP_LABELS = 10;
const MAX_HOUSENUMBER_LABELS = 24;
const MAX_PEAK_LABELS = 8;

/** Extra breathing room around each placed chip when testing for collisions. */
const COLLISION_MARGIN_PX = 3;

/**
 * Advance of a full-width character (CJK, kana, Hangul, fullwidth forms) in the
 * system fallback face — Plex Mono has none of these glyphs — plus the tracking.
 */
export const LABEL_WIDE_CHAR_PX = LABEL_FONT_SIZE + LABEL_LETTER_SPACING;

const WIDE_CHAR =
  /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u{20000}-\u{3fffd}]/u;
const ZERO_WIDTH = /[\u0300-\u036f\u200b-\u200d]/u;

/**
 * Rendered width of a label chip, logical px. Counts code points, not UTF-16
 * units, and gives full-width scripts their full em so a local-script name
 * (map-name.ts falls back to one) is not clipped by `numberOfLines={1}`.
 */
export function labelWidthPx(text: string): number {
  let width = LABEL_PAD_PX;
  for (const ch of text) {
    if (ZERO_WIDTH.test(ch)) continue;
    width += WIDE_CHAR.test(ch) ? LABEL_WIDE_CHAR_PX : LABEL_CHAR_PX;
  }
  return width;
}

/**
 * Room a peak chip reserves for its summit marker (a drawn triangle — IBM Plex
 * Mono has no ▲ glyph), logical px: the 7 px mark plus the gap after it.
 */
export const PEAK_MARKER_PX = 10;

/** Rendered width of a whole chip of `kind`, marker included, logical px. */
export function chipWidthPx(kind: MapLabelKind, text: string): number {
  return labelWidthPx(text) + (kind === 'peak' ? PEAK_MARKER_PX : 0);
}

/**
 * Below this zoom summits go unnamed. A peak is a landmark at the scale of a
 * whole range, so — unlike POIs — it belongs to the zoomed-out views; the
 * tileset's per-cell `rank` keeps the count sane there.
 */
export const PEAK_LABEL_MIN_ZOOM = 9;

/** OMT `mountain_peak` classes worth a chip (saddles, ridges and the like are not). */
const PEAK_CLASSES: ReadonlySet<string> = new Set(['peak', 'volcano']);

/**
 * How many OMT peak ranks to admit at `zoom` (1-based within the tileset's grid
 * cell, lower = more prominent). Two at the range view, doubling every two zoom
 * levels, so the hills around a city get named once you are looking at them.
 */
export function peakRankBudget(zoom: number): number {
  return Math.max(1, Math.round(2 * Math.pow(2, (zoom - PEAK_LABEL_MIN_ZOOM) / 2)));
}

/**
 * The elevation half of a peak chip. Metres everywhere except where OMT flags feet
 * as the customary unit (`customary_ft`), which is what someone there reads on a
 * trail sign. Empty when the tile carried no elevation.
 */
export function peakElevationText(peak: {
  readonly ele?: number;
  readonly eleFt?: number;
  readonly customaryFt: boolean;
}): string {
  if (peak.customaryFt && peak.eleFt !== undefined) return `${peak.eleFt} FT`;
  if (peak.ele !== undefined) return `${peak.ele} M`;
  return '';
}

interface Candidate {
  readonly id: string;
  readonly kind: MapLabelKind;
  readonly text: string;
  readonly world: WorldPoint;
  readonly angle: number;
  /** Sort weight within a kind — road class for streets, on-screen area for parks. */
  readonly priority: number;
  readonly lengthWorld?: number;
}

type LabelView = Pick<RegionSpec, 'rect' | 'zoom'>;

export interface LabelOptions {
  readonly previous?: readonly MapLabel[];
  readonly highwaysEnabled?: boolean;
  readonly transitEnabled?: boolean;
  readonly peaksEnabled?: boolean;
}

const LIMITS: Record<MapLabelKind, number> = {
  place: MAX_PLACE_LABELS,
  area: MAX_AREA_LABELS,
  peak: MAX_PEAK_LABELS,
  poi: MAX_POI_LABELS,
  street: MAX_STREET_LABELS,
  transit: MAX_TRANSIT_STOP_LABELS,
  housenumber: MAX_HOUSENUMBER_LABELS,
};
const KIND_ORDER: readonly MapLabelKind[] = [
  'place',
  'area',
  'peak',
  'poi',
  'street',
  'transit',
  'housenumber',
];
const candidatesByTile = new WeakMap<
  PackedTile,
  {
    zoom: number;
    candidates: readonly Candidate[];
  }
>();

interface PlacedBox {
  readonly cx: number;
  readonly cy: number;
  readonly halfW: number;
  readonly halfH: number;
}

/**
 * Place against the DISPLAYED viewport, never the padded/prefetched region.
 * Keep eligible visible labels first; newcomers cannot evict them just by
 * becoming closer to the centre. Caps and collisions only see enabled layers.
 */
export function selectMapLabels(
  geometry: PackedGeometry,
  spec: LabelView,
  options: LabelOptions = {}
): MapLabel[] {
  const pxPerWorld = scaleFor(spec.zoom);
  const width = (spec.rect.maxX - spec.rect.minX) * pxPerWorld;
  const height = (spec.rect.maxY - spec.rect.minY) * pxPerWorld;
  const candidates = candidatesFor(geometry, spec, pxPerWorld)
    .filter(
      (c) =>
        !(
          options.highwaysEnabled === false &&
          c.kind === 'street' &&
          c.priority === HIGHWAY_CLASS
        ) &&
        !(options.transitEnabled === false && c.kind === 'transit') &&
        !(options.peaksEnabled === false && c.kind === 'peak')
    )
    .map((candidate) => ({ candidate, box: boxFor(candidate, spec, pxPerWorld) }))
    .filter(
      ({ box }) =>
        box.cx + box.halfW >= 0 &&
        box.cy + box.halfH >= 0 &&
        box.cx - box.halfW <= width &&
        box.cy - box.halfH <= height
    );
  type Entry = (typeof candidates)[number];
  const byId = new Map<string, Entry[]>();
  for (const entry of candidates) {
    const group = byId.get(entry.candidate.id);
    if (group) group.push(entry);
    else byId.set(entry.candidate.id, [entry]);
  }
  const placed: PlacedBox[] = [];
  const seen = new Set<string>();
  const counts = new Map<MapLabelKind, number>();
  const out: MapLabel[] = [];

  const tryPlace = ({ candidate, box }: Entry, previous?: MapLabel): boolean => {
    const count = counts.get(candidate.kind) ?? 0;
    if (seen.has(candidate.id) || count >= LIMITS[candidate.kind]) return false;
    for (const other of placed) if (overlaps(box, other)) return false;
    placed.push(box);
    seen.add(candidate.id);
    counts.set(candidate.kind, count + 1);
    const unchanged =
      previous &&
      previous.text === candidate.text &&
      previous.world[0] === candidate.world[0] &&
      previous.world[1] === candidate.world[1] &&
      previous.angle === candidate.angle &&
      previous.roadClass === (candidate.kind === 'street' ? candidate.priority : undefined);
    out.push(
      unchanged
        ? previous
        : {
            id: candidate.id,
            kind: candidate.kind,
            text: candidate.text,
            world: candidate.world,
            angle: candidate.angle,
            ...(candidate.kind === 'street' ? { roadClass: candidate.priority } : {}),
          }
    );
    return true;
  };

  for (const previous of options.previous ?? []) {
    const matches = byId.get(previous.id);
    if (!matches) continue;
    // A street can have several tile fragments. Keep the one already labelled
    // while it is present, rather than jumping to a newly loaded longer fragment.
    const closest = matches.reduce((a, b) =>
      distanceSq(a.candidate.world, previous.world) <= distanceSq(b.candidate.world, previous.world)
        ? a
        : b
    );
    tryPlace(closest, previous);
  }

  const centre: WorldPoint = [
    (spec.rect.minX + spec.rect.maxX) / 2,
    (spec.rect.minY + spec.rect.maxY) / 2,
  ];
  candidates.sort(({ candidate: a }, { candidate: b }) => {
    const kind = KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
    if (kind) return kind;
    const priority = b.priority - a.priority;
    const distance = distanceSq(a.world, centre) - distanceSq(b.world, centre);
    const order =
      a.kind === 'street'
        ? priority || (b.lengthWorld ?? 0) - (a.lengthWorld ?? 0)
        : a.kind === 'area' || a.kind === 'place'
          ? priority || distance
          : distance || priority;
    return (
      order ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) ||
      a.world[0] - b.world[0] ||
      a.world[1] - b.world[1]
    );
  });
  for (const entry of candidates) tryPlace(entry);
  return out;
}

function distanceSq(a: WorldPoint, b: WorldPoint): number {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
}

function candidatesFor(geometry: PackedGeometry, spec: LabelView, scale: number): Candidate[] {
  const out = placeCandidates(geometry, spec);
  for (const tile of geometry.parts) {
    let cached = candidatesByTile.get(tile);
    if (!cached || cached.zoom !== spec.zoom) {
      const part = { parts: [tile], places: [] };
      cached = {
        zoom: spec.zoom,
        candidates: [
          ...areaCandidates(part, spec, scale),
          ...streetCandidates(part, spec, scale),
          ...poiCandidates(part, spec),
          ...transitStopCandidates(part, spec),
          ...houseNumberCandidates(part, spec),
          ...peakCandidates(part, spec),
        ],
      };
      candidatesByTile.set(tile, cached);
    }
    out.push(...cached.candidates);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Places (OpenMapTiles `place` points)
// ---------------------------------------------------------------------------

/**
 * City, town and state names for the zoomed-out map.
 *
 * Reads `geometry.places`, which the tile decoders have always produced and which until now only
 * the drawer headline consumed (`readout.ts`). Upright, unrotated, no fit gate — a point has no
 * length to measure a name against — so what keeps the field clean is the class band, the rank
 * budget and the shared collision pass.
 */
function placeCandidates(geometry: PackedGeometry, spec: LabelView): Candidate[] {
  const budget = placeRankBudget(spec.zoom);

  // Deduplicate at placement, after viewport filtering: a distant namesake in
  // prefetch padding must not hide the visible place or move its existing chip.
  const out: Candidate[] = [];
  for (const place of geometry.places) {
    if (!place.name) continue;
    const band = PLACE_LABEL_BANDS[place.kind];
    if (!band) continue;
    if (spec.zoom < band[0] || spec.zoom > band[1]) continue;
    // An absent rank means the tileset did not rank it; treat it as lowest priority rather than
    // dropping it, so a bake without ranks still labels.
    if ((place.rank ?? budget) > budget) continue;
    const text = place.name.toUpperCase();
    const priority = -PLACE_CLASS_ORDER.indexOf(place.kind);
    out.push({
      id: `place:${text}`,
      kind: 'place',
      text,
      world: place.world,
      angle: 0,
      priority,
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// POIs and house numbers (OpenMapTiles `poi` / `housenumber` points)
// ---------------------------------------------------------------------------

/**
 * Named points inside buildings — the only source of a building label, since the
 * `building` layer carries footprints and heights but never a name.
 *
 * No fit gate (a point has no length to measure against) and no rotation: these
 * sit upright on their anchor and rely purely on the rank budget, the cap, and
 * the shared collision pass.
 */
function poiCandidates(geometry: PackedGeometry, spec: LabelView): Candidate[] {
  if (spec.zoom < POI_LABEL_MIN_ZOOM) return [];
  const budget = poiRankBudget(spec.zoom);

  const out: Candidate[] = [];
  for (const part of geometry.parts) {
    for (const poi of part.pois) {
      if (!poi.name) continue;
      if (POI_EXCLUDED_CLASSES.has(poi.kind)) continue;
      if (isTransitStop(poi)) continue; // drawn by `transitStopCandidates` instead
      // An absent rank means the tileset did not rank it; treat it as lowest
      // priority rather than dropping it, so a bake without ranks still labels.
      const rank = poi.rank ?? budget;
      if (rank > budget) continue;
      const text = poi.name.toUpperCase();
      out.push({
        id: `poi:${text}`,
        kind: 'poi',
        text,
        world: poi.world,
        angle: 0,
        // Lower OMT rank = more prominent, but the collision pass sorts by
        // DESCENDING priority — so negate.
        priority: -rank,
      });
    }
  }

  return out;
}

/**
 * Stops on the transit network, drawn in the transit ink beside the lines they
 * belong to. Kept apart from places for the reason {@link TRANSIT_STOP_SUBCLASSES}
 * documents; the render layer hides these with the transit layer toggle, exactly
 * as highway chips hide with their roads.
 */
function transitStopCandidates(geometry: PackedGeometry, spec: LabelView): Candidate[] {
  if (spec.zoom < TRANSIT_STOP_MIN_ZOOM) return [];

  const out: Candidate[] = [];
  for (const part of geometry.parts) {
    for (const poi of part.pois) {
      if (!poi.name || !isTransitStop(poi)) continue;
      const text = poi.name.toUpperCase();
      out.push({
        id: `transit:${text}`,
        kind: 'transit',
        text,
        world: poi.world,
        angle: 0,
        priority: -(poi.rank ?? 0),
      });
    }
  }

  return out;
}

/**
 * Named summits from OpenMapTiles `mountain_peak`, upright with their elevation.
 * Ordered like POIs — nearest the camera first, because a region is nine times
 * the view — with the higher summit winning ties.
 */
function peakCandidates(geometry: PackedGeometry, spec: LabelView): Candidate[] {
  if (spec.zoom < PEAK_LABEL_MIN_ZOOM) return [];
  const budget = peakRankBudget(spec.zoom);

  const out: Candidate[] = [];
  for (const part of geometry.parts) {
    for (const peak of part.peaks) {
      if (!peak.name || !PEAK_CLASSES.has(peak.kind)) continue;
      if ((peak.rank ?? budget) > budget) continue;
      const name = peak.name.toUpperCase();
      const elevation = peakElevationText(peak);
      const text = elevation ? `${name} · ${elevation}` : name;
      out.push({
        id: `peak:${name}`,
        kind: 'peak',
        text,
        world: peak.world,
        angle: 0,
        priority: peak.ele ?? 0,
      });
    }
  }

  return out;
}

/** Street numbers, drawn only at the deepest zoom and only where nothing else is. */
function houseNumberCandidates(geometry: PackedGeometry, spec: LabelView): Candidate[] {
  if (spec.zoom < HOUSENUMBER_MIN_ZOOM) return [];
  const out: Candidate[] = [];
  for (const part of geometry.parts) {
    for (const entry of part.houseNumbers) {
      if (!entry.number) continue;
      // Numbers repeat constantly; key on position so two different buildings
      // sharing "1200" both survive, but a seam duplicate does not.
      const id = `housenumber:${entry.number}@${entry.world[0].toFixed(6)},${entry.world[1].toFixed(6)}`;
      out.push({
        id,
        kind: 'housenumber',
        text: entry.number,
        world: entry.world,
        angle: 0,
        priority: 0,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Streets
// ---------------------------------------------------------------------------

function streetCandidates(
  geometry: PackedGeometry,
  spec: LabelView,
  pxPerWorld: number
): Candidate[] {
  const candidates: Candidate[] = [];

  for (const part of geometry.parts) {
    for (const s of [part.streets, part.labelStreets] satisfies readonly PackedStreets[]) {
      for (let i = 0; i < s.count; i++) {
        const raw = s.names[i];
        if (!raw) continue;
        const roadClass = s.roadClass[i];
        if (spec.zoom < labelMinZoom(roadClass)) continue;

        const from = s.pointOff[i];
        const to = s.pointOff[i + 1];
        if (to - from < 2) continue;

        const measured = measurePolyline(s.coords, from, to, part.originX, part.originY);
        if (measured === null) continue;

        const text = raw.toUpperCase();
        // A chip must fit its fragment; which visible fragment wins belongs to
        // the shared placement pass, not extraction from the padded tile.
        if (measured.lengthWorld * pxPerWorld < labelWidthPx(text)) continue;
        candidates.push({
          id: `street:${text}`,
          kind: 'street',
          text,
          priority: roadClass,
          lengthWorld: measured.lengthWorld,
          world: measured.mid,
          angle: measured.angle,
        });
      }
    }
  }

  return candidates;
}

/** The label tier for a class, never earlier than the zoom the class draws at. */
function labelMinZoom(roadClass: number): number {
  const index = Math.max(0, Math.min(LABEL_MIN_ZOOM.length - 1, roadClass));
  return Math.max(LABEL_MIN_ZOOM[index], CLASS_MIN_ZOOM[index]);
}

interface MeasuredLine {
  readonly lengthWorld: number;
  readonly mid: WorldPoint;
  readonly angle: number;
}

/**
 * Total length of a packed polyline plus its arc-length midpoint and the
 * direction of the segment straddling that midpoint — where the chip sits and
 * how it is turned. Returns null for degenerate (zero-length) geometry.
 */
function measurePolyline(
  coords: Float32Array,
  from: number,
  to: number,
  originX: number,
  originY: number
): MeasuredLine | null {
  let total = 0;
  for (let j = from; j < to - 1; j++) {
    const dx = coords[(j + 1) * 2] - coords[j * 2];
    const dy = coords[(j + 1) * 2 + 1] - coords[j * 2 + 1];
    total += Math.hypot(dx, dy);
  }
  if (!(total > 0)) return null;

  const target = total / 2;
  let walked = 0;
  for (let j = from; j < to - 1; j++) {
    const ax = coords[j * 2];
    const ay = coords[j * 2 + 1];
    const bx = coords[(j + 1) * 2];
    const by = coords[(j + 1) * 2 + 1];
    const seg = Math.hypot(bx - ax, by - ay);
    if (seg <= 0) continue;
    if (walked + seg < target) {
      walked += seg;
      continue;
    }
    const t = (target - walked) / seg;
    return {
      lengthWorld: total,
      mid: [originX + ax + (bx - ax) * t, originY + ay + (by - ay) * t],
      angle: normalizeAngle(Math.atan2(by - ay, bx - ax)),
    };
  }
  return null;
}

/** Fold a heading into ±90° so a label never renders upside down. */
function normalizeAngle(angle: number): number {
  let a = angle;
  while (a > Math.PI / 2) a -= Math.PI;
  while (a < -Math.PI / 2) a += Math.PI;
  return a;
}

// ---------------------------------------------------------------------------
// Areas (parks)
// ---------------------------------------------------------------------------

function areaCandidates(
  geometry: PackedGeometry,
  spec: LabelView,
  pxPerWorld: number
): Candidate[] {
  if (spec.zoom < AREA_LABEL_MIN_ZOOM) return [];
  const pxPerWorldSq = pxPerWorld * pxPerWorld;
  const out: Candidate[] = [];

  for (const part of geometry.parts) {
    const areas: PackedAreas = part.parks;
    for (let i = 0; i < areas.count; i++) {
      const raw = areas.names[i];
      if (!raw) continue;
      const ring = areas.ringOff[i];
      if (ring >= areas.ringOff[i + 1]) continue;
      // Ring 0 is the outer boundary; holes never carry the name's centroid.
      const shape = measureRing(
        areas.coords,
        areas.pointOff[ring],
        areas.pointOff[ring + 1],
        part.originX,
        part.originY
      );
      if (shape === null) continue;

      const areaPx = shape.areaWorld * pxPerWorldSq;
      if (areaPx < MIN_AREA_PX) continue;

      const text = raw.toUpperCase();
      out.push({
        id: `area:${text}`,
        kind: 'area',
        text,
        world: shape.centroid,
        angle: 0,
        priority: areaPx,
      });
    }
  }

  return out;
}

/** Shoelace area + centroid of one ring. Null when the ring is degenerate. */
function measureRing(
  coords: Float32Array,
  from: number,
  to: number,
  originX: number,
  originY: number
): { areaWorld: number; centroid: WorldPoint } | null {
  const n = to - from;
  if (n < 3) return null;
  let twiceArea = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    const a = from + i;
    const b = from + ((i + 1) % n);
    const ax = coords[a * 2];
    const ay = coords[a * 2 + 1];
    const bx = coords[b * 2];
    const by = coords[b * 2 + 1];
    const cross = ax * by - bx * ay;
    twiceArea += cross;
    cx += (ax + bx) * cross;
    cy += (ay + by) * cross;
  }
  if (twiceArea === 0) return null;
  return {
    areaWorld: Math.abs(twiceArea) / 2,
    centroid: [originX + cx / (3 * twiceArea), originY + cy / (3 * twiceArea)],
  };
}

// ---------------------------------------------------------------------------
// Collision
// ---------------------------------------------------------------------------

/**
 * Axis-aligned bounds of the (possibly rotated) chip, in pixels at the region's
 * build zoom relative to the region origin. Rotating a w×h box grows its AABB to
 * (w·|cos| + h·|sin|) × (w·|sin| + h·|cos|) — cheap, and slightly conservative,
 * which is the right way to err for label spacing.
 */
function boxFor(candidate: Candidate, spec: LabelView, pxPerWorld: number): PlacedBox {
  const halfW = chipWidthPx(candidate.kind, candidate.text) / 2;
  const halfH = LABEL_HEIGHT_PX / 2;
  const cos = Math.abs(Math.cos(candidate.angle));
  const sin = Math.abs(Math.sin(candidate.angle));
  return {
    cx: (candidate.world[0] - spec.rect.minX) * pxPerWorld,
    cy: (candidate.world[1] - spec.rect.minY) * pxPerWorld,
    halfW: halfW * cos + halfH * sin + COLLISION_MARGIN_PX,
    halfH: halfW * sin + halfH * cos + COLLISION_MARGIN_PX,
  };
}

function overlaps(a: PlacedBox, b: PlacedBox): boolean {
  return Math.abs(a.cx - b.cx) < a.halfW + b.halfW && Math.abs(a.cy - b.cy) < a.halfH + b.halfH;
}
