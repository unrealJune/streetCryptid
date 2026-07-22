/**
 * Typed-array geometry the renderer walks directly — the Phase-C payload that
 * keeps decoded tiles off the JS heap as flat `Float32Array` coordinate pools
 * instead of millions of `WorldPoint` tuples.
 *
 * A {@link PackedGeometry} is a *composite*: a list of per-tile {@link PackedTile}
 * parts, each holding zero-copy views into the native SCG1 buffer (or a packed
 * copy of the JS decoder's output on web/iOS-fallback). Coordinates are f32
 * **deltas from the tile's (originX, originY)** — the consumer adds the origin
 * when projecting, so precision stays sub-pixel at any zoom and merging tiles is
 * just concatenating the parts array (no coordinate copies, no re-basing).
 *
 * Only the cheap per-feature data (road class, names, the handful of places)
 * is materialized; the millions of coordinates never leave their typed arrays.
 */

import type {
  AreaFeature,
  MapGeometry,
  Place,
  RiverWay,
  RoadClass,
  StreetWay,
  WorldPoint,
} from '../core/types';

/** Struct-of-arrays polylines (streets add road class + names). */
export interface PackedLines {
  readonly count: number;
  /** Prefix sums into `coords`; feature i spans points [pointOff[i], pointOff[i+1]). */
  readonly pointOff: Uint32Array;
  /** Interleaved (dx, dy) f32 deltas from the tile origin. */
  readonly coords: Float32Array;
}

export interface PackedStreets extends PackedLines {
  readonly roadClass: Uint8Array;
  readonly names: readonly (string | undefined)[];
}

/** Struct-of-arrays even-odd fill features (water, parks) with rings. */
export interface PackedAreas {
  readonly count: number;
  readonly names: readonly (string | undefined)[];
  /** Feature i owns rings [ringOff[i], ringOff[i+1]). */
  readonly ringOff: Uint32Array;
  /** Ring j owns points [pointOff[j], pointOff[j+1]). */
  readonly pointOff: Uint32Array;
  readonly coords: Float32Array;
}

/** One decoded tile: coordinate pools plus the origin their deltas are relative to. */
export interface PackedTile {
  readonly originX: number;
  readonly originY: number;
  readonly streets: PackedStreets;
  readonly rivers: PackedLines;
  readonly water: PackedAreas;
  readonly parks: PackedAreas;
  readonly places: readonly Place[];
}

/** A region's worth of geometry: per-tile parts plus their merged places. */
export interface PackedGeometry {
  readonly parts: readonly PackedTile[];
  readonly places: readonly Place[];
}

export const EMPTY_PACKED: PackedGeometry = { parts: [], places: [] };

/** Concatenate per-tile geometry into one region batch — just list joins. */
export function mergePacked(parts: readonly PackedGeometry[]): PackedGeometry {
  if (parts.length === 1) return parts[0];
  return {
    parts: parts.flatMap((p) => p.parts),
    places: parts.flatMap((p) => p.places),
  };
}

/** Wrap a single tile's parts into a region geometry (one part). */
export function packedTileToGeometry(tile: PackedTile): PackedGeometry {
  const empty =
    tile.streets.count === 0 &&
    tile.rivers.count === 0 &&
    tile.water.count === 0 &&
    tile.parks.count === 0 &&
    tile.places.length === 0;
  return empty ? EMPTY_PACKED : { parts: [tile], places: tile.places };
}

// ---------------------------------------------------------------------------
// Fallback packer: JS decoder (MapGeometry) → PackedTile.
// Used on web and on iOS until the native UniFFI bindings ship. Coordinates are
// stored as absolute world f32 (origin 0) — the JS decoder already works in
// absolute world space and these targets are precision-tolerant (V8/Skia web).
// ---------------------------------------------------------------------------

export function packGeometry(g: MapGeometry): PackedGeometry {
  const streets = (() => {
    const count = g.streets.length;
    const roadClass = new Uint8Array(count);
    const names: (string | undefined)[] = new Array(count);
    const pointOff = new Uint32Array(count + 1);
    let total = 0;
    for (let i = 0; i < count; i++) {
      roadClass[i] = g.streets[i].roadClass;
      names[i] = g.streets[i].name;
      pointOff[i] = total;
      total += g.streets[i].points.length;
    }
    pointOff[count] = total;
    const coords = new Float32Array(total * 2);
    let k = 0;
    for (const s of g.streets)
      for (const [x, y] of s.points) {
        coords[k++] = x;
        coords[k++] = y;
      }
    return { count, roadClass, names, pointOff, coords };
  })();

  const packLines = (
    lines: readonly { points: readonly (readonly [number, number])[] }[]
  ): PackedLines => {
    const count = lines.length;
    const pointOff = new Uint32Array(count + 1);
    let total = 0;
    for (let i = 0; i < count; i++) {
      pointOff[i] = total;
      total += lines[i].points.length;
    }
    pointOff[count] = total;
    const coords = new Float32Array(total * 2);
    let k = 0;
    for (const l of lines)
      for (const [x, y] of l.points) {
        coords[k++] = x;
        coords[k++] = y;
      }
    return { count, pointOff, coords };
  };

  const packAreas = (areas: readonly AreaFeature[]): PackedAreas => {
    const count = areas.length;
    const names: (string | undefined)[] = new Array(count);
    const ringOff = new Uint32Array(count + 1);
    let totalRings = 0;
    for (let i = 0; i < count; i++) {
      names[i] = areas[i].name;
      ringOff[i] = totalRings;
      totalRings += areas[i].rings.length;
    }
    ringOff[count] = totalRings;
    const pointOff = new Uint32Array(totalRings + 1);
    let r = 0;
    let total = 0;
    for (const a of areas)
      for (const ring of a.rings) {
        pointOff[r++] = total;
        total += ring.length;
      }
    pointOff[totalRings] = total;
    const coords = new Float32Array(total * 2);
    let k = 0;
    for (const a of areas)
      for (const ring of a.rings)
        for (const [x, y] of ring) {
          coords[k++] = x;
          coords[k++] = y;
        }
    return { count, names, ringOff, pointOff, coords };
  };

  const tile: PackedTile = {
    originX: 0,
    originY: 0,
    streets,
    rivers: packLines(g.rivers),
    water: packAreas(g.water),
    parks: packAreas(g.parks),
    places: g.places,
  };
  return packedTileToGeometry(tile);
}

/** Narrow a raw road-class byte to the {@link RoadClass} union for callers. */
export function asRoadClass(v: number): RoadClass {
  return (v > 4 ? 4 : v) as RoadClass;
}

/**
 * Materialize a {@link PackedGeometry} back into {@link MapGeometry} (tuples).
 * The inverse of {@link packGeometry} — for tests and diagnostic scripts that
 * assert on named fields; the render path never calls this.
 */
export function unpackPacked(g: PackedGeometry): MapGeometry {
  const streets: StreetWay[] = [];
  const rivers: RiverWay[] = [];
  const water: AreaFeature[] = [];
  const parks: AreaFeature[] = [];

  for (const part of g.parts) {
    const { originX, originY } = part;
    const pts = (coords: Float32Array, from: number, to: number): WorldPoint[] => {
      const out: WorldPoint[] = new Array(to - from);
      for (let j = from; j < to; j++)
        out[j - from] = [originX + coords[j * 2], originY + coords[j * 2 + 1]];
      return out;
    };

    const s = part.streets;
    for (let i = 0; i < s.count; i++) {
      streets.push({
        roadClass: asRoadClass(s.roadClass[i]),
        name: s.names[i],
        points: pts(s.coords, s.pointOff[i], s.pointOff[i + 1]),
      });
    }
    const r = part.rivers;
    for (let i = 0; i < r.count; i++)
      rivers.push({ points: pts(r.coords, r.pointOff[i], r.pointOff[i + 1]) });

    for (const [areas, dst] of [
      [part.water, water],
      [part.parks, parks],
    ] as const) {
      for (let i = 0; i < areas.count; i++) {
        const rings: WorldPoint[][] = [];
        for (let rr = areas.ringOff[i]; rr < areas.ringOff[i + 1]; rr++) {
          rings.push(pts(areas.coords, areas.pointOff[rr], areas.pointOff[rr + 1]));
        }
        dst.push({ name: areas.names[i], rings });
      }
    }
  }

  return { streets, rivers, water, parks, places: [...g.places] };
}
