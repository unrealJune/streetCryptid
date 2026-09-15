/**
 * The app's chrome, retinted from whichever map palette is selected.
 *
 * Chrome used to be fixed — `daybreak` in light, `deepsea` in dark — while only the Skia canvas
 * followed the chosen scheme. Picking Kyoto therefore repainted the map and left the islands, the
 * FABs and every Settings row in Seattle's steel-blue, which read as two apps stacked on top of
 * each other. The palette is now the single choice and the chrome is derived from it.
 *
 * THE RETINT IS A DELTA, NOT AN ABSOLUTE. Each theme was authored against a specific canvas —
 * `daybreak.canvas` and `seattle.light` are the same numbers, transcribed from the same mock — so
 * rather than assigning chrome the selected palette's hues outright, this measures how far the
 * selected palette has moved from the authored one and rotates the chrome by that much. Three
 * things fall out of that which the absolute version got wrong:
 *
 * - Seattle is an exact identity. The default look cannot drift, and the test says so.
 * - Relationships inside a theme survive. `dot` is a teal a little greener than daybreak's water
 *   and stays a little greener than Kyoto's; an absolute mapping collapsed it onto the water hue
 *   and turned the pairing screen's signal field blue in the default scheme.
 * - Chroma compares like with like. `amberDark` is a deliberately dark, deliberately duller amber;
 *   blending its absolute chroma toward a bright accent's oversaturated it, because chroma is not
 *   comparable across lightness. A ratio against the authored accent is.
 *
 * LIGHTNESS IS NEVER TOUCHED. Every token in `daybreak`/`deepsea` was contrast-tuned by hand —
 * `amberDark` exists for no other reason — so a derivation that moved lightness would be
 * re-litigating those ratios against a palette nobody has seen yet, which on Android 12+ is
 * literally someone's wallpaper.
 *
 * This is deliberately NOT a general theming engine: it is one function over the twenty tokens in
 * `CryptidChrome`, and the table in {@link deriveChrome} is the whole of its policy.
 */

import type { CryptidChrome, CryptidTheme } from '@/constants/cryptid-theme';

import { clamp, ramp } from '../core/color';
import type { MapPalette, Rgb } from '../core/types';

/**
 * Hue moves the whole way; saturation barely moves at all.
 *
 * They are split because they are different kinds of statement. A scheme's HUE is the thing it is
 * actually saying — Kyoto is a rose and a lilac, Reykjavík is a cold teal — and taking a fraction
 * of that reads as neither one nor the other, a rendering fault rather than a decision. Its
 * SATURATION is the app's own voice: daybreak's amber is as loud as the design wants an accent to
 * be, and handing that dial to the map (or, on Material You, to a wallpaper) is how an interface
 * ends up either shouting or washed out. So the chrome goes fully to the scheme's hue at close to
 * the theme's own chroma, leaning a third of the way toward the scheme's relative saturation so a
 * muted palette still reads muted.
 */
const HUE_BLEND = 1;
const CHROMA_BLEND = 0.35;

/**
 * Below this chroma a colour has no hue worth measuring — the angle is whatever rounding left in
 * the last bit. It is deliberately tiny: the ground of a pale scheme (Kyoto's `#F2ECF6`) sits
 * around 0.008 and that lilac is entirely intentional, so a threshold tuned for "is this grey"
 * has to be below one 8-bit step, not below "is this colourful".
 */
const NEUTRAL_CHROMA = 0.002;

/** How far a scheme's saturation may pull a token's, either way. */
const CHROMA_RATIO_RANGE = [0.3, 2.2] as const;

interface Oklch {
  readonly l: number;
  readonly c: number;
  /** Radians. Meaningless when `c` is at or below {@link NEUTRAL_CHROMA}. */
  readonly h: number;
}

function srgbToLinear(channel: number): number {
  const v = channel / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(channel: number): number {
  const v = channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055;
  return v * 255;
}

export function srgbToOklch([red, green, blue]: Rgb): Oklch {
  const r = srgbToLinear(red);
  const g = srgbToLinear(green);
  const b = srgbToLinear(blue);

  const lCone = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const mCone = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const sCone = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);

  const l = 0.2104542553 * lCone + 0.793617785 * mCone - 0.0040720468 * sCone;
  const a = 1.9779984951 * lCone - 2.428592205 * mCone + 0.4505937099 * sCone;
  const bb = 0.0259040371 * lCone + 0.7827717662 * mCone - 0.808675766 * sCone;

  return { l, c: Math.hypot(a, bb), h: Math.atan2(bb, a) };
}

function oklchToSrgbUnclamped({ l, c, h }: Oklch): readonly [number, number, number] {
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);

  const lCone = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mCone = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const sCone = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;

  return [
    linearToSrgb(4.0767416621 * lCone - 3.3077115913 * mCone + 0.2309699292 * sCone),
    linearToSrgb(-1.2684380046 * lCone + 2.6097574011 * mCone - 0.3413193965 * sCone),
    linearToSrgb(-0.0041960863 * lCone - 0.7034186147 * mCone + 1.707614701 * sCone),
  ];
}

/** Whether every channel lands inside sRGB, with a half-bit of slack for the round trip. */
function inGamut(rgb: readonly [number, number, number]): boolean {
  return rgb.every((channel) => channel >= -0.5 && channel <= 255.5);
}

/**
 * OKLCh → sRGB, reducing chroma until the colour fits rather than clipping channels.
 *
 * Clipping is the cheap version and it is wrong here: it drags an out-of-gamut colour toward a
 * corner of the cube, which changes its hue — so a saturated accent would come back a different
 * colour than the one asked for. Desaturating along the hue line keeps L and H, which are the two
 * things this module promises.
 */
export function oklchToSrgb(lch: Oklch): Rgb {
  let direct = oklchToSrgbUnclamped(lch);
  if (!inGamut(direct)) {
    let lo = 0;
    let hi = lch.c;
    // Eight halvings resolve chroma past the point where a rounded 8-bit channel could tell.
    for (let i = 0; i < 8; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(oklchToSrgbUnclamped({ ...lch, c: mid }))) lo = mid;
      else hi = mid;
    }
    direct = oklchToSrgbUnclamped({ ...lch, c: lo });
  }
  return [
    clamp(Math.round(direct[0]), 0, 255),
    clamp(Math.round(direct[1]), 0, 255),
    clamp(Math.round(direct[2]), 0, 255),
  ] as const;
}

interface ParsedColor {
  readonly rgb: Rgb;
  /** `null` for a `#rrggbb` token, so the retint writes back the notation it was handed. */
  readonly alpha: number | null;
}

const HEX = /^#([0-9a-f]{6})$/i;
const RGBA = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]*)\s*)?\)$/i;

/**
 * `#rrggbb` and `rgba(r,g,b,a)` — the only two notations `CryptidChrome` uses, and both have to
 * survive a round trip. Seven of the twenty tokens are translucent (`island`, `scrim`, `edge`…),
 * and a retint that dropped their alpha would turn the drawer into an opaque slab.
 */
export function parseColor(value: string): ParsedColor | null {
  const hex = HEX.exec(value);
  if (hex) {
    const n = Number.parseInt(hex[1], 16);
    return { rgb: [(n >> 16) & 255, (n >> 8) & 255, n & 255], alpha: null };
  }
  const rgba = RGBA.exec(value);
  if (!rgba) return null;
  const alpha = rgba[4] === undefined || rgba[4] === '' ? 1 : Number.parseFloat(rgba[4]);
  if (!Number.isFinite(alpha)) return null;
  return {
    rgb: [Number.parseFloat(rgba[1]), Number.parseFloat(rgba[2]), Number.parseFloat(rgba[3])],
    alpha: clamp(alpha, 0, 1),
  };
}

export function formatColor(rgb: Rgb, alpha: number | null): string {
  const [r, g, b] = rgb.map((channel) => clamp(Math.round(channel), 0, 255));
  if (alpha === null) {
    return `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
  }
  // Three places is finer than an 8-bit alpha channel can represent, and `parseFloat` drops the
  // trailing zeros so `.9` survives as `0.9` rather than `0.900`.
  return `rgba(${r},${g},${b},${Number.parseFloat(alpha.toFixed(3))})`;
}

/**
 * How far one hue group has moved, measured between the palette the theme was authored against and
 * the palette that is selected.
 */
interface Shift {
  /** Radians to rotate, already blended. Zero when either end is too neutral to have a hue. */
  readonly rotate: number;
  /** Multiplier on chroma, already blended. 1 when the comparison is not meaningful. */
  readonly scale: number;
}

/** Signed shortest angle from `a` to `b`. */
function angleBetween(a: number, b: number): number {
  return Math.atan2(Math.sin(b - a), Math.cos(b - a));
}

function shift(reference: Rgb, selected: Rgb): Shift {
  const from = srgbToOklch(reference);
  const to = srgbToOklch(selected);
  const comparable = from.c > NEUTRAL_CHROMA && to.c > NEUTRAL_CHROMA;
  const ratio = comparable
    ? clamp(to.c / from.c, CHROMA_RATIO_RANGE[0], CHROMA_RATIO_RANGE[1])
    : // One end has no chroma to compare. If it is the SELECTED palette that is grey, that is a
      // real statement — a monochrome scheme should quiet the chrome — so the ratio floors out.
      // If it is the authored one, there is nothing to measure against and chroma stays put.
      from.c > NEUTRAL_CHROMA
      ? CHROMA_RATIO_RANGE[0]
      : 1;
  return {
    rotate: comparable ? angleBetween(from.h, to.h) * HUE_BLEND : 0,
    scale: 1 + (ratio - 1) * CHROMA_BLEND,
  };
}

/**
 * One token, moved by its group's shift.
 *
 * Anything this cannot parse is returned untouched — a chrome token is a colour the app is about
 * to paint with, and a half-understood one is worse than the original.
 */
function retint(token: string, by: Shift): string {
  // Nothing moved, so nothing is rewritten. This is what makes the authored palette an exact
  // identity rather than an almost-one: a round trip through OKLCh and back to eight bits can
  // land a channel a step off, and `formatColor` would normalise `#C6791A` and `.28` besides.
  if (by.rotate === 0 && by.scale === 1) return token;
  const parsed = parseColor(token);
  if (!parsed) return token;
  const base = srgbToOklch(parsed.rgb);
  return formatColor(
    oklchToSrgb({ l: base.l, c: Math.max(0, base.c * by.scale), h: base.h + by.rotate }),
    parsed.alpha
  );
}

/** WCAG 2.x relative luminance. Not Rec. 601 — `core/color.ts`'s `luminance` is the fog's, and
 *  mixing the two up is how a contrast assertion ends up meaning nothing. */
export function relativeLuminance([r, g, b]: Rgb): number {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

/** WCAG 2.x contrast ratio, 1–21. Used by the tests that hold this module to its promise. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const cache = new WeakMap<CryptidTheme, WeakMap<MapPalette, CryptidChrome>>();

/**
 * Retint `base`'s chrome by however far `palette` sits from the canvas `base` was authored for.
 *
 * The grouping below is the policy: neutrals follow the map's ground, so surfaces sit in the same
 * light as the terrain behind them; text follows the map's own label ink; the accent pair follows
 * the map's accent, which is what keeps the amber frontier rim and the amber FAB one colour.
 *
 * `amber` and `green` move even though DESIGN.md pins them to meanings (you / friends). That is
 * safe because neither is ever a signal: both are the FALLBACK behind `resolveSignalColor` for
 * someone who has not chosen a colour, and a user-chosen signal passes through untouched.
 *
 * `shadow` does not move. It is black at an alpha, it reads as depth rather than as colour, and a
 * hue in it only ever shows up as mud around the island's edge.
 */
export function deriveChrome(base: CryptidTheme, palette: MapPalette): CryptidChrome {
  const byPalette = cache.get(base) ?? new WeakMap<MapPalette, CryptidChrome>();
  const hit = byPalette.get(palette);
  if (hit) return hit;

  const chrome = base.chrome;
  const authored = base.canvas;

  const ground = shift(authored.bg, palette.bg);
  const ink = shift(authored.streetLabel, palette.streetLabel);
  const accent = shift(authored.accent, palette.accent);
  const life = shift(ramp(authored.park, 1), ramp(palette.park, 1));
  // The map's cool accent. NOT `transit`, which is the rail/tram stroke and is a free colour in
  // every scheme — Seattle's is violet, and the pairing screen's signal field is not.
  const cool = shift(ramp(authored.water, 1), ramp(palette.water, 1));

  const derived: CryptidChrome = {
    void: retint(chrome.void, ground),
    bg: retint(chrome.bg, ground),
    panel: retint(chrome.panel, ground),
    hairline: retint(chrome.hairline, ground),
    edge: retint(chrome.edge, ground),
    scrim: retint(chrome.scrim, ground),
    glass: retint(chrome.glass, ground),
    glassBorder: retint(chrome.glassBorder, ground),
    island: retint(chrome.island, ground),
    islandBorder: retint(chrome.islandBorder, ground),
    seg: retint(chrome.seg, ground),

    ink: retint(chrome.ink, ink),
    steel: retint(chrome.steel, ink),
    steelDark: retint(chrome.steelDark, ink),

    amber: retint(chrome.amber, accent),
    amberDark: retint(chrome.amberDark, accent),
    segHi: retint(chrome.segHi, accent),

    green: retint(chrome.green, life),
    dot: retint(chrome.dot, cool),

    shadow: chrome.shadow,
  };

  byPalette.set(palette, derived);
  cache.set(base, byPalette);
  return derived;
}
