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
 * 2 = secondary/tertiary, 3 = primary, 4 = motorway/trunk. Higher classes draw
 * wider and brighter.
 */
export type RoadClass = 0 | 1 | 2 | 3 | 4;

/** A drivable/walkable way, rendered as a stroked polyline into the street mask. */
export interface StreetWay {
  readonly roadClass: RoadClass;
  readonly name?: string;
  readonly points: readonly WorldPoint[];
}

/** A river/stream centerline, rendered as a stroked polyline into the water mask. */
export interface RiverWay {
  readonly points: readonly WorldPoint[];
}

/**
 * A filled area (water body or park). `rings` follow the even-odd rule: outer
 * boundaries and holes are all listed here, exactly as they come out of an MVT
 * polygon feature.
 */
export interface AreaFeature {
  readonly name?: string;
  readonly rings: readonly (readonly WorldPoint[])[];
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
  readonly rivers: readonly RiverWay[];
  readonly water: readonly AreaFeature[];
  readonly parks: readonly AreaFeature[];
  readonly places: readonly Place[];
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
  /** Hex-lattice / street-label ink. */
  readonly streetLabel: Rgb;
  readonly parkLabel: Rgb;
}

/** The compact "where you are" readout surfaced to the chrome each frame. */
export interface MapReadout {
  /** Discovered fraction of the hex sectors in view, 0–1. */
  readonly coverage: number;
  /** Nearest prominent place name to the camera center, or null. */
  readonly placeName: string | null;
}
