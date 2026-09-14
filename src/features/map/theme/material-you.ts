/**
 * The phone's own wallpaper palette, as a map colour scheme.
 *
 * Android 12+ derives a full Material 3 tonal system from the user's wallpaper, and SDK 57 exposes
 * it — the thing that makes this cheap is that `Color.android.dynamic.*` does NOT hand back an
 * opaque `PlatformColor`. `expo-router`'s Kotlin (`ExpoRouterModule.kt`) resolves the attribute
 * and returns `String.format("#%02x%02x%02x", …)`, a plain hex string, which is exactly what
 * `mapPaletteFromHex` already eats. So "System" is a `MapColorScheme` like Seattle or Kyoto, the
 * Skia canvas needs no new plumbing, and the chrome retint in `derive-chrome.ts` follows it for
 * free.
 *
 * TWO THINGS ARE READ THE HARD WAY ON PURPOSE.
 *
 * 1. The scheme is passed explicitly rather than going through `Color.android.dynamic.*`, whose JS
 *    wrapper resolves through `Appearance.getColorScheme()` — the SYSTEM scheme. That is the wrong
 *    answer twice over: the app has its own light/dark override (`use-color-scheme.ts`), so
 *    someone running the app dark on a light phone would get a light map; and the settings picker
 *    previews every scheme's light and dark side by side, which needs both at once regardless of
 *    what the phone is doing. The native function has taken the scheme as an argument all along.
 *
 * 2. Availability is decided by comparing the dynamic roles against the STATIC Material 3
 *    baseline, not by the API level alone. Below API 31 — and on OEM builds that do not apply
 *    wallpaper colours — `Theme_Material3_DynamicColors_Light` silently resolves to Google's
 *    baseline purple. Offering that as "System" would be offering a theme the user's phone has
 *    nothing to do with.
 */

import { requireNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

import { mapPaletteFromHex, type MapColorScheme, type MapPaletteInput } from './map-color-schemes';

export const MATERIAL_YOU_SCHEME_ID = 'material-you';

/** Dynamic colours are a Material You feature, and Material You is Android 12. */
const MIN_ANDROID_API = 31;

type Scheme = 'light' | 'dark';

interface ExpoRouterNative {
  Material3DynamicColor(name: string, scheme: string): string | null;
  Material3Color(name: string, scheme: string): string | null;
}

const HEX = /^#[0-9a-f]{6}$/i;

let cachedNative: ExpoRouterNative | null | undefined;

/**
 * The `ExpoRouter` module, or `null` everywhere it is not a thing.
 *
 * Guarded past what bindgen alone would need: a phone can be running an older binary than the JS
 * bundle, so the functions are checked individually rather than assumed present because the module
 * resolved.
 */
function native(): ExpoRouterNative | null {
  if (cachedNative !== undefined) return cachedNative;
  cachedNative = null;
  if (Platform.OS !== 'android') return cachedNative;
  try {
    const module = requireNativeModule('ExpoRouter') as Partial<ExpoRouterNative> | null;
    if (
      typeof module?.Material3DynamicColor === 'function' &&
      typeof module?.Material3Color === 'function'
    ) {
      cachedNative = module as ExpoRouterNative;
    }
  } catch {
    // No native module: iOS, web, jest, or a build predating expo-router's colour support.
  }
  return cachedNative;
}

function read(
  module: ExpoRouterNative,
  kind: 'dynamic' | 'static',
  name: string,
  scheme: Scheme
): string | null {
  try {
    const value =
      kind === 'dynamic'
        ? module.Material3DynamicColor(name, scheme)
        : module.Material3Color(name, scheme);
    return typeof value === 'string' && HEX.test(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Whether this phone is actually generating colours from its wallpaper.
 *
 * `primary` is the role a wallpaper moves furthest; if it still matches the static baseline the
 * device is handing out Google's default purple, which is a theme, but not the user's.
 */
export function isMaterialYouAvailable(): boolean {
  const module = native();
  if (!module) return false;
  if (typeof Platform.Version === 'number' && Platform.Version < MIN_ANDROID_API) return false;
  const dynamic = read(module, 'dynamic', 'primary', 'light');
  const baseline = read(module, 'static', 'primary', 'light');
  return dynamic !== null && baseline !== null && dynamic.toLowerCase() !== baseline.toLowerCase();
}

/**
 * Which Material 3 role supplies each part of the map.
 *
 * The ramps are the interesting half. A map ramp runs from least to most emphatic, which in light
 * mode means getting darker and in dark mode means getting lighter — and M3's tonal roles already
 * flip that way between schemes (`onSurface` is tone 10 in light and tone 90 in dark), so ONE role
 * list gives the right direction in both. Terrain takes the widest span the system offers, because
 * the dot field's whole legibility is the spread between a residential street and a motorway.
 *
 * Water and park take the secondary and tertiary families rather than two shades of the accent:
 * M3 rotates tertiary off the source hue specifically so a scheme has a third colour, and a map
 * whose parks and water were the same hue would be unreadable. Transit takes `error` — the only
 * remaining role M3 guarantees is a distinct hue, which is exactly what a rail line drawn over
 * everything else needs to be.
 */
const ROLES = {
  bg: 'surface',
  accent: 'primary',
  terrain: ['surfaceContainerHighest', 'outlineVariant', 'outline', 'onSurface'],
  water: ['secondaryContainer', 'secondary', 'onSecondaryContainer'],
  park: ['tertiaryContainer', 'tertiary', 'onTertiaryContainer'],
  transit: 'error',
  building: 'onSurfaceVariant',
  streetLabel: 'onSurface',
  parkLabel: 'onTertiaryContainer',
} as const;

function paletteInput(module: ExpoRouterNative, scheme: Scheme): MapPaletteInput | null {
  const one = (role: string) => read(module, 'dynamic', role, scheme);
  const many = (roles: readonly string[]) => {
    const resolved = roles.map(one);
    return resolved.every((value): value is string => value !== null) ? resolved : null;
  };

  const bg = one(ROLES.bg);
  const accent = one(ROLES.accent);
  const terrain = many(ROLES.terrain);
  const water = many(ROLES.water);
  const park = many(ROLES.park);
  const transit = one(ROLES.transit);
  const building = one(ROLES.building);
  const streetLabel = one(ROLES.streetLabel);
  const parkLabel = one(ROLES.parkLabel);

  // All or nothing. A palette with a hole in it would render as black, which is worse than not
  // offering the scheme at all.
  if (
    !bg ||
    !accent ||
    !terrain ||
    !water ||
    !park ||
    !transit ||
    !building ||
    !streetLabel ||
    !parkLabel
  ) {
    return null;
  }
  return { bg, accent, terrain, water, park, transit, building, streetLabel, parkLabel };
}

/**
 * Read the wallpaper palette now, or `null` if this phone does not have one.
 *
 * Called again whenever the OS might have changed it — see `use-map-color-scheme.ts`. A wallpaper
 * change does not necessarily restart the JS context, so nothing here may be cached beyond the
 * call.
 */
export function readMaterialYouScheme(): MapColorScheme | null {
  const module = native();
  if (!module || !isMaterialYouAvailable()) return null;
  const light = paletteInput(module, 'light');
  const dark = paletteInput(module, 'dark');
  if (!light || !dark) return null;
  return {
    id: MATERIAL_YOU_SCHEME_ID,
    name: 'System',
    light: mapPaletteFromHex(light),
    dark: mapPaletteFromHex(dark),
  };
}

/** Test seam: the module memoizes the native handle, and a test that swaps it needs it dropped. */
export function resetMaterialYouNativeCache(): void {
  cachedNative = undefined;
}
