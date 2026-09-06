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
import { CLASS_MIN_ZOOM } from './road-lod';
import type { WorldPoint } from './types';
import type { PackedAreas, PackedGeometry, PackedStreets } from '../tiles/packed-geometry';

export type MapLabelKind = 'street' | 'area' | 'poi' | 'transit' | 'housenumber';

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

/** Extra breathing room around each placed chip when testing for collisions. */
const COLLISION_MARGIN_PX = 3;

/** Rendered width of a label chip, logical px. */
export function labelWidthPx(text: string): number {
  return text.length * LABEL_CHAR_PX + LABEL_PAD_PX;
}

interface Candidate {
  readonly id: string;
  readonly kind: MapLabelKind;
  readonly text: string;
  readonly world: WorldPoint;
  readonly angle: number;
  /** Sort weight within a kind — road class for streets, on-screen area for parks. */
  readonly priority: number;
}

interface PlacedBox {
  readonly cx: number;
  readonly cy: number;
  readonly halfW: number;
  readonly halfH: number;
}

/**
 * Choose the labels for one built region. Area (park) names are placed first —
 * there are few of them and they anchor the map — then street names by class and
 * length, each rejected if it would collide with anything already placed.
 */
export function selectMapLabels(geometry: PackedGeometry, spec: RegionSpec): MapLabel[] {
  const pxPerWorld = scaleFor(spec.zoom);
  const areas = areaCandidates(geometry, spec, pxPerWorld).slice(0, MAX_AREA_LABELS);
  const streets = streetCandidates(geometry, spec, pxPerWorld);
  const pois = poiCandidates(geometry, spec);
  const transitStops = transitStopCandidates(geometry, spec);
  const houseNumbers = houseNumberCandidates(geometry, spec);

  const placed: PlacedBox[] = [];
  const out: MapLabel[] = [];

  const tryPlace = (candidate: Candidate): boolean => {
    const box = boxFor(candidate, spec, pxPerWorld);
    for (const other of placed) if (overlaps(box, other)) return false;
    placed.push(box);
    out.push({
      id: candidate.id,
      kind: candidate.kind,
      text: candidate.text,
      world: candidate.world,
      angle: candidate.angle,
      ...(candidate.kind === 'street' ? { roadClass: candidate.priority } : {}),
    });
    return true;
  };

  for (const candidate of areas) tryPlace(candidate);

  // POIs before streets: past `POI_LABEL_MIN_ZOOM` a named landmark is what a
  // person is actually looking for, and a service road's name is not worth
  // suppressing "Harborview Medical Center" for. Both still lose to a park.
  let poiCount = 0;
  for (const candidate of pois) {
    if (poiCount >= MAX_POI_LABELS) break;
    if (tryPlace(candidate)) poiCount++;
  }

  let streetCount = 0;
  for (const candidate of streets) {
    if (streetCount >= MAX_STREET_LABELS) break;
    if (tryPlace(candidate)) streetCount++;
  }

  // Transit stops after the streets they stand on: useful, but a stop name is
  // navigation furniture and must not outrank the road or the building.
  let transitCount = 0;
  for (const candidate of transitStops) {
    if (transitCount >= MAX_TRANSIT_STOP_LABELS) break;
    if (tryPlace(candidate)) transitCount++;
  }

  // House numbers last, filling whatever gaps are left — they are the least
  // important thing on the map and must never displace a name.
  let numberCount = 0;
  for (const candidate of houseNumbers) {
    if (numberCount >= MAX_HOUSENUMBER_LABELS) break;
    if (tryPlace(candidate)) numberCount++;
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
function poiCandidates(geometry: PackedGeometry, spec: RegionSpec): Candidate[] {
  if (spec.zoom < POI_LABEL_MIN_ZOOM) return [];
  const budget = poiRankBudget(spec.zoom);

  // One chip per name: a POI on a tile seam arrives from both tiles.
  const best = new Map<string, Candidate>();
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
      const existing = best.get(text);
      if (existing && existing.priority >= -rank) continue;
      best.set(text, {
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

  // Nearest the camera first, rank only breaking ties.
  //
  // This ordering is load-bearing, not cosmetic. A region is 3x the viewport on
  // each axis (see `padFor`), so the view is about a ninth of its area — and a
  // POI is a POINT, so unlike a street it has no length to reach into frame with.
  // Ranking these by importance alone spends the whole cap on padding the user
  // cannot see: measured downtown at z17, 1275 candidates were under budget, 14
  // were placed, and ZERO of them landed on screen. `computeRegionSpec` builds
  // the rect symmetrically around the camera, so distance from the region centre
  // IS distance from what the user is looking at.
  const cx = (spec.rect.minX + spec.rect.maxX) / 2;
  const cy = (spec.rect.minY + spec.rect.maxY) / 2;
  const distSq = (c: Candidate) => (c.world[0] - cx) ** 2 + (c.world[1] - cy) ** 2;
  return [...best.values()].sort(
    (a, b) => distSq(a) - distSq(b) || b.priority - a.priority || a.text.length - b.text.length
  );
}

/**
 * Stops on the transit network, drawn in the transit ink beside the lines they
 * belong to. Kept apart from places for the reason {@link TRANSIT_STOP_SUBCLASSES}
 * documents; the render layer hides these with the transit layer toggle, exactly
 * as highway chips hide with their roads.
 */
function transitStopCandidates(geometry: PackedGeometry, spec: RegionSpec): Candidate[] {
  if (spec.zoom < TRANSIT_STOP_MIN_ZOOM) return [];

  // One chip per name: a route's stops repeat the same intersection name on both
  // sides of the street, and a stop on a tile seam arrives twice.
  const best = new Map<string, Candidate>();
  for (const part of geometry.parts) {
    for (const poi of part.pois) {
      if (!poi.name || !isTransitStop(poi)) continue;
      const text = poi.name.toUpperCase();
      if (best.has(text)) continue;
      best.set(text, {
        id: `transit:${text}`,
        kind: 'transit',
        text,
        world: poi.world,
        angle: 0,
        priority: -(poi.rank ?? 0),
      });
    }
  }

  const cx = (spec.rect.minX + spec.rect.maxX) / 2;
  const cy = (spec.rect.minY + spec.rect.maxY) / 2;
  const distSq = (c: Candidate) => (c.world[0] - cx) ** 2 + (c.world[1] - cy) ** 2;
  return [...best.values()].sort((a, b) => distSq(a) - distSq(b) || b.priority - a.priority);
}

/** Street numbers, drawn only at the deepest zoom and only where nothing else is. */
function houseNumberCandidates(geometry: PackedGeometry, spec: RegionSpec): Candidate[] {
  if (spec.zoom < HOUSENUMBER_MIN_ZOOM) return [];
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const part of geometry.parts) {
    for (const entry of part.houseNumbers) {
      if (!entry.number) continue;
      // Numbers repeat constantly; key on position so two different buildings
      // sharing "1200" both survive, but a seam duplicate does not.
      const id = `housenumber:${entry.number}@${entry.world[0].toFixed(6)},${entry.world[1].toFixed(6)}`;
      if (seen.has(id)) continue;
      seen.add(id);
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
  // Nearest the camera first, for the reason `poiCandidates` documents — with
  // ~1100 numbers per z14 tile this is the difference between numbering the
  // block on screen and numbering one two viewports away.
  const cx = (spec.rect.minX + spec.rect.maxX) / 2;
  const cy = (spec.rect.minY + spec.rect.maxY) / 2;
  return out.sort(
    (a, b) =>
      (a.world[0] - cx) ** 2 +
      (a.world[1] - cy) ** 2 -
      ((b.world[0] - cx) ** 2 + (b.world[1] - cy) ** 2)
  );
}

// ---------------------------------------------------------------------------
// Streets
// ---------------------------------------------------------------------------

interface StreetPick {
  readonly text: string;
  readonly roadClass: number;
  readonly lengthWorld: number;
  readonly world: WorldPoint;
  readonly angle: number;
}

function streetCandidates(
  geometry: PackedGeometry,
  spec: RegionSpec,
  pxPerWorld: number
): Candidate[] {
  // One label per unique NAME, not per way: a road crossing four tiles arrives as
  // four unrelated features, and the mock's rule — keep the longest, highest-class
  // way for each name — collapses them back into the single street a human sees.
  const best = new Map<string, StreetPick>();

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
        const current = best.get(text);
        if (
          current &&
          (current.roadClass > roadClass ||
            (current.roadClass === roadClass && current.lengthWorld >= measured.lengthWorld))
        ) {
          continue;
        }
        best.set(text, {
          text,
          roadClass,
          lengthWorld: measured.lengthWorld,
          world: measured.mid,
          angle: measured.angle,
        });
      }
    }
  }

  const candidates: Candidate[] = [];
  for (const pick of best.values()) {
    const lengthPx = pick.lengthWorld * pxPerWorld;
    // The fit gate: no chip may claim more road than the road actually has on
    // screen. This is what silently sheds names as the map zooms out.
    if (lengthPx < labelWidthPx(pick.text)) continue;
    candidates.push({
      id: `street:${pick.text}`,
      kind: 'street',
      text: pick.text,
      world: pick.world,
      angle: pick.angle,
      priority: pick.roadClass,
    });
  }

  // Biggest roads first, then the longest of each class — the greedy collision
  // pass below keeps whichever it reaches first, so this ordering IS the ranking.
  return candidates.sort((a, b) => b.priority - a.priority || b.text.length - a.text.length);
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
  spec: RegionSpec,
  pxPerWorld: number
): Candidate[] {
  if (spec.zoom < AREA_LABEL_MIN_ZOOM) return [];
  const pxPerWorldSq = pxPerWorld * pxPerWorld;
  const best = new Map<string, { areaPx: number; world: WorldPoint }>();

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
      const current = best.get(text);
      if (current && current.areaPx >= areaPx) continue;
      best.set(text, { areaPx, world: shape.centroid });
    }
  }

  return [...best.entries()]
    .map(([text, pick]) => ({
      id: `area:${text}`,
      kind: 'area' as const,
      text,
      world: pick.world,
      angle: 0,
      priority: pick.areaPx,
    }))
    .sort((a, b) => b.priority - a.priority);
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
function boxFor(candidate: Candidate, spec: RegionSpec, pxPerWorld: number): PlacedBox {
  const halfW = labelWidthPx(candidate.text) / 2;
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
