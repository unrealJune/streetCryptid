import { GlassView, isGlassEffectAPIAvailable, isLiquidGlassAvailable } from 'expo-glass-effect';
import { useEffect, useState, type ReactNode } from 'react';
import {
  AccessibilityInfo,
  Platform,
  Pressable,
  StyleSheet,
  type PressableProps,
  type StyleProp,
  type ViewProps,
  type ViewStyle,
} from 'react-native';

import type { CryptidTheme } from '@/constants/cryptid-theme';

/**
 * Liquid glass for the map's floating chrome, with the app's own surface as the fallback.
 *
 * The islands and FABs have always been translucent — `chrome.island` is an rgba white at .9 over
 * a map — so on iOS 26 they are asking for the real material rather than an approximation of it.
 * Everywhere else (iOS 25 and earlier, Android, web, the store-shot pipeline) this renders exactly
 * what it rendered before, which is why there is no second design to maintain.
 *
 * Nothing here may ever set `opacity: 0` on a `GlassView` or an ancestor of one: that is the
 * documented way to make the effect silently not render at all.
 */

/**
 * FOUR things have to agree before a single pixel of glass is drawn, and each of them says no for
 * a different reason. They are kept apart rather than collapsed into one boolean because the
 * failure is silent by construction — a surface that has handed its background to a material that
 * never renders is not a wrong colour, it is an invisible island — and "glass is off" is not a
 * diagnosis anyone can act on. {@link glassDiagnosis} is what the Debug screen reads.
 *
 * - `isLiquidGlassAvailable()` covers the build and the OS: it is false unless the binary was
 *   compiled with Xcode 26 AND the device runs iOS 26 AND the app has not opted out via
 *   `UIDesignRequiresCompatibility`. Off iOS the package resolves to a stub that returns false.
 * - `isGlassEffectAPIAvailable()` covers the case the first one misses: some iOS 26 builds ship
 *   without the `UIGlassEffect` class, and `GlassView.swift` guards EVERY one of its methods on
 *   that check — so the view mounts, renders nothing, and takes the surface's background with it.
 *   Missing this was a real hole: the fallback has to be chosen in JS, because by the time the
 *   native view has decided not to draw, the island is already transparent.
 * - Reduce Transparency is the user asking for exactly this fallback. `isLiquidGlassAvailable()`
 *   stays true through it — it reports component availability, not what UIKit will draw.
 *
 * The try/catch is for environments with no native module at all: jest, web, and any bundle whose
 * JS is ahead of the binary it is running on.
 */
const NATIVE_GLASS = ((): { liquid: boolean; api: boolean } => {
  try {
    return { liquid: isLiquidGlassAvailable(), api: isGlassEffectAPIAvailable() };
  } catch {
    return { liquid: false, api: false };
  }
})();

const BUILD_SUPPORTS_GLASS = NATIVE_GLASS.liquid && NATIVE_GLASS.api;

function useReduceTransparency(): boolean {
  const [reduceTransparency, setReduceTransparency] = useState(false);

  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    let live = true;
    void AccessibilityInfo.isReduceTransparencyEnabled()
      .then((enabled) => {
        if (live) setReduceTransparency(enabled);
      })
      .catch(() => {
        // An unanswerable accessibility query is not a reason to drop the material.
      });
    const subscription = AccessibilityInfo.addEventListener(
      'reduceTransparencyChanged',
      setReduceTransparency
    );
    return () => {
      live = false;
      subscription.remove();
    };
  }, []);

  return reduceTransparency;
}

export function useGlassAvailable(): boolean {
  // Called unconditionally, then combined. `BUILD_SUPPORTS_GLASS && !useReduceTransparency()`
  // reads the same and short-circuits the hook away on every non-iOS-26 device, which is a
  // different hook order on the majority platform.
  const reduceTransparency = useReduceTransparency();
  return BUILD_SUPPORTS_GLASS && !reduceTransparency;
}

export interface GlassDiagnosis {
  readonly available: boolean;
  readonly platform: string;
  readonly osVersion: string;
  /** `isLiquidGlassAvailable()`: Xcode 26 build + iOS 26 device + not opted out. */
  readonly liquidGlass: boolean;
  /** `isGlassEffectAPIAvailable()`: the `UIGlassEffect` class is actually present. */
  readonly glassEffectApi: boolean;
  readonly reduceTransparency: boolean;
  /** The first thing that said no, in the order the checks are applied. */
  readonly reason: string;
}

/**
 * Why the app is or is not drawing glass, as something a phone can be asked.
 *
 * Every input here is invisible from the outside — an iPhone on iOS 25, an iPhone with Reduce
 * Transparency on, and an iPhone running a binary compiled by an older Xcode all look identical:
 * the island renders the way it always did. This is the only place that difference is legible.
 */
export function useGlassDiagnosis(): GlassDiagnosis {
  const reduceTransparency = useReduceTransparency();
  const available = BUILD_SUPPORTS_GLASS && !reduceTransparency;

  const reason =
    Platform.OS !== 'ios'
      ? 'Not iOS — glass is an iOS 26 material'
      : !NATIVE_GLASS.liquid
        ? 'Needs iOS 26 on the phone and an Xcode 26 build'
        : !NATIVE_GLASS.api
          ? 'This iOS build has no UIGlassEffect class'
          : reduceTransparency
            ? 'Reduce Transparency is on'
            : 'On';

  return {
    available,
    platform: Platform.OS,
    osVersion: String(Platform.Version),
    liquidGlass: NATIVE_GLASS.liquid,
    glassEffectApi: NATIVE_GLASS.api,
    reduceTransparency,
    reason,
  };
}

interface GlassFillProps {
  /** Corner radius, in points. Must match the clipping parent's, or the highlight sits wrong. */
  readonly radius: number;
  /** The app's resolved scheme, not the OS's — see below. */
  readonly scheme: 'light' | 'dark';
  readonly interactive?: boolean;
  readonly tintColor?: string;
  /** `'none'` where the fill sits under a gesture surface that must win every touch. */
  readonly pointerEvents?: ViewProps['pointerEvents'];
}

/**
 * The material itself, as a background layer. Render it as the FIRST child of the surface it
 * fills; later siblings paint over it.
 *
 * Two things are less obvious than they look:
 *
 * - `borderRadius` is a NATIVE PROP, not a style. `GlassEffectModule.swift` reads
 *   `Prop("borderRadius")` and builds the effect's `UICornerRadius` corner configuration from it;
 *   a radius that exists only in `style` leaves a square `UIVisualEffectView` inside a rounded
 *   parent, which reads as a bright box behind the island's corners. It is absent from
 *   `GlassViewProps` — which is `{…} & ViewProps` — so the cast is here, once, and nowhere else.
 * - `colorScheme` is passed explicitly because the app has its own light/dark override
 *   (`use-color-scheme.ts`). Left on `'auto'`, someone running the app dark on a light phone would
 *   get a light material under dark chrome.
 */
export function GlassFill({
  radius,
  scheme,
  interactive = false,
  tintColor,
  pointerEvents,
}: GlassFillProps) {
  return (
    <GlassView
      {...({ borderRadius: radius } as object)}
      colorScheme={scheme}
      pointerEvents={pointerEvents}
      // 'regular', never 'clear': Rajdhani at 13pt over a dot field needs the material that has
      // some opacity to it.
      glassEffectStyle="regular"
      isInteractive={interactive}
      style={StyleSheet.absoluteFill}
      tintColor={tintColor}
    />
  );
}

interface IslandPressableProps extends Omit<PressableProps, 'style' | 'children'> {
  readonly children: ReactNode;
  readonly radius: number;
  readonly theme: CryptidTheme;
  readonly style?: StyleProp<ViewStyle>;
  /** Border colour, when the control wants to say something with it (the lit layers FAB). */
  readonly borderColor?: string;
  /** Tints the material. Only reaches the glass path; the fallback says it with `borderColor`. */
  readonly tintColor?: string;
}

/**
 * A pressable island surface: the rounded, hairline-bordered, translucent panel that every floating
 * control on the map is made of.
 *
 * This exists because `SettingsControl`, `LocateMeControl`, `MapLayersControl`'s FAB and its layer
 * rows had each declared the same 48pt circle and the same
 * `backgroundColor: chrome.island` / `borderColor: chrome.islandBorder` / `opacity: pressed ? .68`
 * triple, so the glass decision would otherwise have been made four times. The press feedback is
 * owned here too, and deliberately only applies off the glass path — `isInteractive` gives the
 * material its own response, and dimming it as well reads as a double-press.
 */
export function IslandPressable({
  children,
  radius,
  theme,
  style,
  borderColor,
  tintColor,
  ...pressable
}: IslandPressableProps) {
  const glass = useGlassAvailable();
  const { chrome } = theme;

  return (
    <Pressable
      {...pressable}
      style={({ pressed }) => [
        styles.surface,
        {
          borderRadius: radius,
          borderColor: borderColor ?? chrome.islandBorder,
        },
        style,
        {
          backgroundColor: glass ? 'transparent' : chrome.island,
          opacity: pressed && !glass ? 0.68 : 1,
        },
      ]}
    >
      {glass ? (
        <GlassFill interactive radius={radius} scheme={theme.scheme} tintColor={tintColor} />
      ) : null}
      {children}
    </Pressable>
  );
}

/** Every floating map control is this size and this radius, so they read as one family. */
export const FAB_RADIUS = 24;

export const islandStyles = StyleSheet.create({
  fab: {
    height: 48,
    width: 48,
  },
});

const styles = StyleSheet.create({
  surface: {
    alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    justifyContent: 'center',
    // Clips the material to the same rounded shape the border draws.
    overflow: 'hidden',
  },
});
