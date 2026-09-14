import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import { useEffect, useState, type ReactNode } from 'react';
import {
  AccessibilityInfo,
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
 * Whether the build AND the device AND the user's accessibility settings all say glass.
 *
 * `isLiquidGlassAvailable()` is only the first of those. It reports component availability — it
 * stays true when the user has turned Reduce Transparency on, at which point UIKit flattens the
 * material and an app that kept treating it as a background would be drawing text onto nothing.
 * The try/catch is for the environments with no native module at all (jest, and any bundle where
 * the JS is ahead of the binary).
 */
const LIQUID_GLASS = ((): boolean => {
  try {
    return isLiquidGlassAvailable();
  } catch {
    return false;
  }
})();

export function useGlassAvailable(): boolean {
  const [reduceTransparency, setReduceTransparency] = useState(false);

  useEffect(() => {
    if (!LIQUID_GLASS) return;
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

  return LIQUID_GLASS && !reduceTransparency;
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
