import { Platform } from 'react-native';

import { rgbToHex } from '../../core/color';
import {
  isMaterialYouAvailable,
  MATERIAL_YOU_SCHEME_ID,
  readMaterialYouScheme,
  resetMaterialYouNativeCache,
} from '../material-you';

// `jest.mock` is hoisted above these imports by babel, so the mocks below are in place before any
// of them resolves.
const mockMaterial3 = {
  dynamic: jest.fn<string | null, [string, string]>(),
  static: jest.fn<string | null, [string, string]>(),
};

// Only `ExpoRouter` is intercepted. Replacing the whole of expo-modules-core takes expo's winter
// runtime down with it — `globalThis.fetch` is installed through `requireNativeModule`.
jest.mock('expo-modules-core', () => {
  const actual = jest.requireActual('expo-modules-core');
  return {
    ...actual,
    requireNativeModule: (name: string) =>
      name === 'ExpoRouter'
        ? {
            Material3DynamicColor: (role: string, scheme: string) =>
              mockMaterial3.dynamic(role, scheme),
            Material3Color: (role: string, scheme: string) => mockMaterial3.static(role, scheme),
          }
        : actual.requireNativeModule(name),
  };
});

// A mutable Platform, so the Android-version and off-Android cases are reachable from one suite.
// Through a Proxy rather than a spread: react-native's barrel is a wall of lazy getters, and
// spreading it instantiates every one of them — including the dev-menu TurboModule, which is not
// there to instantiate.
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  const platform = { OS: 'android', Version: 34 };
  return new Proxy(actual, {
    get: (target, prop) => (prop === 'Platform' ? platform : Reflect.get(target, prop)),
  });
});

/**
 * A stand-in for the OS's tonal system: a light scheme whose roles get darker as they get more
 * emphatic, and a dark one where they get lighter. The real thing is generated from a wallpaper;
 * what matters to us is only that the ramps run in opposite directions between schemes, because
 * that is the property one role list relies on to serve both.
 */
const TONES: Record<string, [light: number, dark: number]> = {
  surface: [246, 18],
  surfaceContainerHighest: [228, 56],
  outlineVariant: [200, 74],
  outline: [122, 150],
  onSurface: [26, 230],
  onSurfaceVariant: [70, 200],
  primary: [96, 200],
  secondaryContainer: [222, 62],
  secondary: [110, 190],
  onSecondaryContainer: [30, 234],
  tertiaryContainer: [232, 66],
  tertiary: [118, 186],
  onTertiaryContainer: [34, 238],
  error: [140, 170],
};

/** Give each role family a distinct hue so the palette is not accidentally monochrome. */
const HUE: Record<string, [number, number, number]> = {
  surface: [1, 0.98, 1],
  surfaceContainerHighest: [1, 0.98, 1],
  outlineVariant: [1, 0.98, 1],
  outline: [1, 0.98, 1],
  onSurface: [1, 0.98, 1],
  onSurfaceVariant: [1, 0.98, 1],
  primary: [1, 0.6, 0.2],
  secondaryContainer: [0.4, 0.6, 1],
  secondary: [0.4, 0.6, 1],
  onSecondaryContainer: [0.4, 0.6, 1],
  tertiaryContainer: [0.4, 1, 0.5],
  tertiary: [0.4, 1, 0.5],
  onTertiaryContainer: [0.4, 1, 0.5],
  error: [1, 0.3, 0.3],
};

function wallpaperColor(role: string, scheme: string): string | null {
  const tone = TONES[role];
  if (!tone) return null;
  const value = scheme === 'dark' ? tone[1] : tone[0];
  const tint = HUE[role] ?? [1, 1, 1];
  return rgbToHex([value * tint[0], value * tint[1], value * tint[2]]);
}

/** Google's baseline purple, which is what a phone without dynamic colours hands back. */
const BASELINE_PRIMARY = '#6750a4';

beforeEach(() => {
  resetMaterialYouNativeCache();
  mockMaterial3.dynamic.mockReset();
  mockMaterial3.static.mockReset();
  mockMaterial3.dynamic.mockImplementation(wallpaperColor);
  mockMaterial3.static.mockImplementation((role, scheme) =>
    role === 'primary' ? BASELINE_PRIMARY : wallpaperColor(role, scheme)
  );
  (Platform as { OS: string }).OS = 'android';
  (Platform as { Version: number }).Version = 34;
});

describe('isMaterialYouAvailable', () => {
  it('is true on an Android 12+ phone whose roles have left the baseline', () => {
    expect(isMaterialYouAvailable()).toBe(true);
  });

  it('is false when the dynamic roles ARE the static baseline', () => {
    // Below API 31, and on OEM builds that do not apply wallpaper colours, the dynamic-colours
    // theme silently resolves to Google's default purple. Version alone would not catch that, and
    // offering it as "System" would be offering a theme the phone has nothing to do with.
    mockMaterial3.dynamic.mockImplementation((role, scheme) =>
      role === 'primary' ? BASELINE_PRIMARY : wallpaperColor(role, scheme)
    );
    expect(isMaterialYouAvailable()).toBe(false);
    expect(readMaterialYouScheme()).toBeNull();
  });

  it('is false below Android 12 even if the roles resolve', () => {
    (Platform as { Version: number }).Version = 30;
    expect(isMaterialYouAvailable()).toBe(false);
  });

  it('is false off Android', () => {
    (Platform as { OS: string }).OS = 'ios';
    resetMaterialYouNativeCache();
    expect(isMaterialYouAvailable()).toBe(false);
    expect(readMaterialYouScheme()).toBeNull();
  });

  it('survives a native module that is older than the JS bundle', () => {
    // A phone can be running a binary that predates these exports; the module is checked function
    // by function rather than assumed complete because it resolved.
    mockMaterial3.dynamic.mockImplementation(() => {
      throw new Error('no such function');
    });
    expect(isMaterialYouAvailable()).toBe(false);
  });
});

describe('readMaterialYouScheme', () => {
  it('builds a scheme in the same shape as a built-in one', () => {
    const scheme = readMaterialYouScheme()!;
    expect(scheme.id).toBe(MATERIAL_YOU_SCHEME_ID);
    expect(scheme.name).toBe('System');
    expect(scheme.light.terr).toHaveLength(4);
    expect(scheme.light.water).toHaveLength(3);
    expect(scheme.light.park).toHaveLength(3);
    // Numeric triples, not hex: this is what the Skia canvas consumes.
    expect(scheme.light.bg).toEqual([246, 241, 246]);
  });

  it('reads both schemes explicitly rather than whichever one the system is in', () => {
    readMaterialYouScheme();
    const asked = new Set(mockMaterial3.dynamic.mock.calls.map(([, scheme]) => scheme));
    expect(asked).toEqual(new Set(['light', 'dark']));
  });

  it('runs its ramps light-to-dark in light mode and dark-to-light in dark', () => {
    // One role list serves both because M3's tonal roles already flip between schemes. If that
    // ever stops holding, the map's most-emphatic roads would come out the same tone as its
    // quietest ones.
    const scheme = readMaterialYouScheme()!;
    const brightness = (rgb: readonly number[]) => rgb[0] + rgb[1] + rgb[2];
    for (const ramp of [scheme.light.terr, scheme.light.water, scheme.light.park]) {
      expect(brightness(ramp[0].rgb)).toBeGreaterThan(brightness(ramp[ramp.length - 1].rgb));
    }
    for (const ramp of [scheme.dark.terr, scheme.dark.water, scheme.dark.park]) {
      expect(brightness(ramp[0].rgb)).toBeLessThan(brightness(ramp[ramp.length - 1].rgb));
    }
  });

  it('refuses a palette with a hole in it', () => {
    // A missing role would otherwise render black, which is worse than not offering the scheme.
    mockMaterial3.dynamic.mockImplementation((role, scheme) =>
      role === 'outline' ? null : wallpaperColor(role, scheme)
    );
    expect(readMaterialYouScheme()).toBeNull();
  });

  it('refuses anything that is not a six-digit hex', () => {
    mockMaterial3.dynamic.mockImplementation((role, scheme) =>
      role === 'surface' ? 'rebeccapurple' : wallpaperColor(role, scheme)
    );
    expect(readMaterialYouScheme()).toBeNull();
  });
});
