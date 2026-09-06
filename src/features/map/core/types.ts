/**
 * Core data contracts for the map feature.
 *
 * Everything in `core/` is pure TypeScript: plain data in, plain data out. The world
 * coordinate system is normalized Web Mercator — the whole planet spans [0,1]² at
 * zoom 0, x grows east, y grows south — so tile math, hex sectors, exploration state,
 * and the camera all share one space that is independent of any screen.
 */

/** RGB color, each channel 0–255. */
export type Rgb = readonly [number, number, number];

/** A point in normalized Web Mercator world space ([0,1]² at z0). */
export type WorldPoint = readonly [number, number];

/** A point in logical screen pixels. */
export type ScreenPoint = readonly [number, number];

/** Geographic coordinate, degrees. */
export interface LatLon {
  readonly lat: number;
  readonly lon: number;
}

/** Axis-aligned rectangle in world space. */
export interface WorldRect {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/** Logical (density-independent) pixel size of the drawing surface. */
export interface Viewport {
  readonly width: number;
  readonly height: number;
}

/**
 * Road class, matching the mock's 0–4 scale: 0 = service/path, 1 = residential,
 * 2 = secondary/tertiary, 3 = primary/trunk, 4 = motorway. Higher classes draw
 * wider and brighter.
 */
export type RoadClass = 0 | 1 | 2 | 3 | 4;

/** A drivable/walkable way, rendered as a stroked polyline into the street mask. */
export interface StreetWay {
  readonly roadClass: RoadClass;
  readonly name?: string;
  readonly points: readonly WorldPoint[];
}

/**
 * Fixed-rail transit mode, from the OMT `transportation` layer's rail/transit/
 * ferry classes. Ordered coarse→fine so the numeric code (the index in
 * {@link TRANSIT_MODES}) is what the packed geometry and the SCG1 buffer carry.
 *
 * Buses are deliberately absent: OMT ships physical infrastructure only, so a
 * bus *route* has no geometry in these tiles (`busway` is a bus lane and stays a
 * road). Adding them means baking GTFS shapes into the tileset.
 */
export const TRANSIT_MODES = [
  'rail',
  'subway',
  'light_rail',
  'tram',
  'monorail',
  'funicular',
  'ferry',
] as const;

export type TransitMode = (typeof TRANSIT_MODES)[number];

/** A transit line, rendered as a stroked polyline over the dot field. */
export interface TransitWay {
  readonly mode: TransitMode;
  readonly name?: string;
  readonly points: readonly WorldPoint[];
}

/** A river/stream centerline, rendered as a stroked polyline into the water mask. */
export interface RiverWay {
  readonly points: readonly WorldPoint[];
}

/**
 * OMT `aeroway` polygon classes we draw, ordered coarse→fine so the numeric code
 * (the index here) is what the packed geometry and the SCG1 buffer carry.
 *
 * `aerodrome` is the airport's whole property boundary — an outline only, because
 * filling it would tint a region-sized area. `apron` is the paved ground planes
 * stand on, and OMT's small `helipad` polygons fold into it: same surface, and a
 * separate kind for eighteen features in a metro area buys nothing.
 */
export const AERO_AREA_KINDS = ['aerodrome', 'apron'] as const;

export type AeroAreaKind = (typeof AERO_AREA_KINDS)[number];

/**
 * OMT `aeroway` line classes we draw. Runways also arrive as the occasional
 * polygon (1 of 20 around SeaTac); those contribute their rings here as closed
 * lines rather than earning a section of their own.
 *
 * `gate` is deliberately absent: it is a point layer with no geometry to stroke.
 */
export const AERO_LINE_KINDS = ['runway', 'taxiway'] as const;

export type AeroLineKind = (typeof AERO_LINE_KINDS)[number];

/**
 * A filled area (water body or park). `rings` follow the even-odd rule: outer
 * boundaries and holes are all listed here, exactly as they come out of an MVT
 * polygon feature.
 */
export interface AreaFeature {
  readonly name?: string;
  readonly rings: readonly (readonly WorldPoint[])[];
}

/** An {@link AreaFeature} carrying the aeroway class it was decoded from. */
export interface AeroArea extends AreaFeature {
  readonly kind: AeroAreaKind;
}

/** A runway/taxiway centerline, stroked as a vector over the dot field. */
export interface AeroWay {
  readonly kind: AeroLineKind;
  readonly points: readonly WorldPoint[];
}

/** A named locality (city/town/suburb/neighbourhood) used for the island readout. */
export interface Place {
  readonly name: string;
  readonly world: WorldPoint;
  /** OMT place class, e.g. 'city' | 'town' | 'suburb' | 'neighbourhood'. */
  readonly kind: string;
  /** Lower rank = more prominent. Absent when the source omits it. */
  readonly rank?: number;
}

/** Everything the renderer needs to draw one patch of the world. */
export interface MapGeometry {
  readonly streets: readonly StreetWay[];
  /** OpenMapTiles `transportation_name` lines, used only for label placement. */
  readonly labelStreets?: readonly StreetWay[];
  readonly transit: readonly TransitWay[];
  readonly rivers: readonly RiverWay[];
  readonly water: readonly AreaFeature[];
  readonly parks: readonly AreaFeature[];
  /**
   * OpenMapTiles `building` footprints. Optional like {@link labelStreets}: the
   * layer only exists from z13, and a pre-buildings SCG1 buffer carries none.
   */
  readonly buildings?: readonly AreaFeature[];
  /** OpenMapTiles `aeroway` polygons (aerodrome boundary, apron/helipad). */
  readonly aeroAreas?: readonly AeroArea[];
  /** OpenMapTiles `aeroway` lines (runway, taxiway). */
  readonly aeroLines?: readonly AeroWay[];
  readonly places: readonly Place[];
  /**
   * OpenMapTiles `poi` points. Optional like {@link buildings}: the layer starts
   * at z13 (rank-filtered to landmarks) and only gets dense at z14, and a
   * pre-POI SCG1 buffer carries none. This is where building labels come from —
   * the `building` layer has geometry and heights but no name.
   */
  readonly pois?: readonly MapPoiFeature[];
  /** OpenMapTiles `housenumber` points — z14 only. */
  readonly houseNumbers?: readonly HouseNumberFeature[];
}

/** A named point of interest in world space (OpenMapTiles `poi`). */
export interface MapPoiFeature {
  readonly name: string;
  readonly world: WorldPoint;
  readonly kind: string;
  readonly subclass: string;
  readonly rank?: number;
}

/** A street number stamped on a building (OpenMapTiles `housenumber`). */
export interface HouseNumberFeature {
  readonly number: string;
  readonly world: WorldPoint;
}

/**
 * Map camera. `zoom` follows the standard web-map convention: at zoom z the world
 * square is 256·2^z logical pixels wide, so integer zooms line up with tile levels.
 */
export interface CameraState {
  readonly center: WorldPoint;
  readonly zoom: number;
}

/** An 8-bit single-channel raster (coverage mask) at logical-pixel resolution. */
export interface Mask {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

/** The three feature masks the dot field samples. */
export interface FeatureMasks {
  readonly streets: Mask;
  readonly parks: Mask;
  readonly water: Mask;
}

/** A color ramp stop: `t` in [0,1] → `rgb`. */
export interface RampStop {
  readonly t: number;
  readonly rgb: Rgb;
}

/** Optional renderer treatment layered over the palette's feature colors. */
export interface MapRenderEffects {
  /** Soft additive halo sampled around road geometry, 0–1. */
  readonly neonGlow?: number;
  /** Subtle map-anchored CRT scanline modulation, 0–1. */
  readonly scanlines?: number;
}

/**
 * Canvas palette for one theme — the map half of the single THEME source of truth
 * (the chrome half lives in `src/constants/theme.ts`).
 */
export interface MapPalette {
  /** Canvas background fill. */
  readonly bg: Rgb;
  /** The single accent: YOU locator + frontier rim (amber on daybreak/deepsea). */
  readonly accent: Rgb;
  /** Street ramp, unexplored→explored. */
  readonly terr: readonly RampStop[];
  /** Water ramp, shallow→deep. */
  readonly water: readonly RampStop[];
  /** Park ramp, faded→lush. */
  readonly park: readonly RampStop[];
  /** Transit-line ink — its own accent, never the amber reserved for YOU/frontier. */
  readonly transit: Rgb;
  /**
   * Built-ground ink: building footprints and airport surfaces. Its own entry
   * rather than a reuse of {@link streetLabel} because it has to read as a
   * *material* against the dot field, not as a label over it — usually the
   * darkest step of the scheme's terrain family in light mode, and a mid-bright
   * one in dark mode.
   */
  readonly building: Rgb;
  /** Hex-lattice / street-label ink. */
  readonly streetLabel: Rgb;
  readonly parkLabel: Rgb;
  readonly effects?: MapRenderEffects;
}

/** The compact "where you are" readout surfaced to the chrome each frame. */
export interface MapReadout {
  /** Discovered fraction of the hex sectors in view, 0–1. */
  readonly coverage: number;
  /**
   * Whether the exploration layer is drawn at this zoom. When false, `coverage`
   * is a placeholder 0 and chrome should hide the sector readout entirely
   * rather than claim nothing has been explored.
   */
  readonly sectorsVisible: boolean;
  /** Nearest prominent place name to the camera center, or null. */
  readonly placeName: string | null;
}
