import { useEffect, useMemo, useState } from 'react';
import { type LayoutChangeEvent, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useFrameCallback,
  useReducedMotion,
  useSharedValue,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { BrandFonts, CryptidThemes, Spacing } from '@/constants/theme';
import { PageFooter } from '@/features/settings/components/settings-page';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useIsAppActive } from '@/hooks/use-is-app-active';
import { useSystemRail } from '@/hooks/use-system-rail';

import {
  introProgress,
  SPLASH_TIMELINE,
  splashHero,
  splashLayout,
  splashPings,
  type SplashRect,
} from '../core/splash-layout';
import { SplashCanvas } from './splash-canvas-loader';

const COPY =
  'Share your location with your friends and track where you’ve been. We promise to never save, sell, or snoop on your trail.';

/** Intro clock frames are clamped so a hitch (or a debugger pause) never skips the animation. */
const MAX_FRAME_S = 0.05;

/**
 * The first screen a new install sees: friends ping in from the edges of an empty lattice, their
 * rings meet at the sigil, you answer in amber (YOU before there is a profile to colour you), and
 * the mark flips in over a cleared patch of field. One line of what the app is and one action.
 *
 * Beside a system rail (iPhone Duo) the action moves into the rail like every other onboarding
 * step's, and the island keeps only the words.
 */
export function OnboardingSplash({ onContinue }: { onContinue: () => void }) {
  const scheme = useColorScheme();
  const chrome = CryptidThemes[scheme === 'dark' ? 'deepsea' : 'daybreak'].chrome;
  const insets = useSafeAreaInsets();
  const railWidth = useSystemRail();
  const reducedMotion = useReducedMotion();
  const appActive = useIsAppActive();

  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [hero, setHero] = useState<SplashRect | null>(null);
  const [island, setIsland] = useState<SplashRect | null>(null);

  const layoutWidth = size ? size.width - railWidth : 390;
  const layoutHeight = size?.height ?? 844;
  const layout = useMemo(
    () => splashLayout(layoutWidth, layoutHeight),
    [layoutWidth, layoutHeight]
  );
  const ready = size !== null && hero !== null && island !== null;

  const geometry = useMemo(() => {
    if (!size || !hero) return null;
    const { sigil, clear } = splashHero(hero, layout);
    const pings = splashPings({
      width: size.width,
      height: size.height,
      sigil,
      island,
      trailingInset: railWidth,
    });
    return { sigil, clear, ...pings };
  }, [size, hero, island, railWidth, layout]);

  const time = useSharedValue(0);
  const still = useSharedValue(reducedMotion ? 1 : 0);
  const frame = useFrameCallback((info) => {
    time.value += Math.min(MAX_FRAME_S, (info.timeSincePreviousFrame ?? 16) / 1000);
  }, false);
  useEffect(() => {
    still.set(reducedMotion ? 1 : 0);
    if (reducedMotion) time.set(SPLASH_TIMELINE.settled);
    // Off screen is the same answer as reduced motion: stop moving. See `useIsAppActive`.
    frame.setActive(ready && !reducedMotion && appActive);
  }, [appActive, frame, ready, reducedMotion, still, time]);

  const wordStyle = useAnimatedStyle(() => {
    const v =
      still.value > 0.5
        ? 1
        : introProgress(time.value, SPLASH_TIMELINE.word, SPLASH_TIMELINE.wordDuration);
    return { opacity: v, transform: [{ translateY: (1 - v) * 10 }] };
  });
  const islandStyle = useAnimatedStyle(() => {
    const v =
      still.value > 0.5
        ? 1
        : introProgress(time.value, SPLASH_TIMELINE.island, SPLASH_TIMELINE.islandDuration);
    return { opacity: v, transform: [{ translateY: (1 - v) * 28 }] };
  });

  const measure = (set: (rect: SplashRect) => void) => (event: LayoutChangeEvent) => {
    const { x, y, width, height } = event.nativeEvent.layout;
    set({ x, y, width, height });
  };

  const railed = railWidth > 0;

  return (
    <View
      testID="onboarding-splash"
      style={[styles.screen, { backgroundColor: chrome.bg }]}
      onLayout={(event) => {
        const { width, height } = event.nativeEvent.layout;
        setSize({ width, height });
      }}
    >
      {size && geometry ? (
        <SplashCanvas
          width={size.width}
          height={size.height}
          geometry={geometry}
          logoWidth={layout.logoWidth}
          time={time}
          still={still}
          colors={{
            base: chrome.dot,
            signal: chrome.green,
            amber: chrome.amber,
            ground: chrome.bg,
            ink: chrome.ink,
            baseAlpha: scheme === 'dark' ? 0.13 : 0.15,
          }}
        />
      ) : null}

      <View
        pointerEvents="box-none"
        style={[
          styles.content,
          {
            flexDirection: layout.landscape ? 'row' : 'column',
            gap: layout.landscape ? 56 : 0,
            paddingTop: insets.top + Spacing.three,
            paddingBottom: insets.bottom + Spacing.three,
            paddingLeft: insets.left + (layout.landscape ? 64 : Spacing.three),
            paddingRight: railed
              ? railWidth + Spacing.three
              : insets.right + (layout.landscape ? 64 : Spacing.three),
          },
        ]}
      >
        <View pointerEvents="none" style={styles.hero} onLayout={measure(setHero)}>
          {/* The sigil itself is drawn on the canvas, flipping in with the field; this holds its place. */}
          <View style={{ width: layout.logoWidth, height: layout.logoHeight }} />
          <Animated.View style={wordStyle}>
            <Text
              accessibilityRole="header"
              style={[
                styles.word,
                {
                  color: chrome.ink,
                  fontSize: layout.wordSize,
                  lineHeight: layout.wordSize * 1.05,
                  marginTop: layout.wordGap,
                },
              ]}
            >
              <Text style={styles.wordStreet}>street</Text>Cryptid
            </Text>
          </Animated.View>
        </View>

        <Animated.View
          onLayout={measure(setIsland)}
          style={[
            styles.island,
            islandStyle,
            {
              backgroundColor: chrome.panel,
              borderColor: chrome.hairline,
              width: layout.landscape ? 400 : '100%',
              padding: layout.headingSize < 26 ? 20 : 22,
              paddingTop: layout.headingSize < 26 ? 20 : Spacing.four,
            },
          ]}
        >
          <Text style={[styles.heading, { color: chrome.ink, fontSize: layout.headingSize }]}>
            Find your people out in the city.
          </Text>
          <ThemedText type="small" style={[styles.body, { color: chrome.steel }]}>
            {COPY}
          </ThemedText>
          {railed ? null : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Get started"
              onPress={onContinue}
              testID="onboarding-splash-continue"
              style={({ pressed }) => [
                styles.button,
                { backgroundColor: chrome.ink, opacity: pressed ? 0.65 : 1 },
              ]}
            >
              <Text style={[styles.buttonLabel, { color: chrome.bg }]}>Get started</Text>
            </Pressable>
          )}
        </Animated.View>
      </View>

      {railed ? (
        <PageFooter
          rail={{
            primary: {
              label: 'Get started',
              railLabel: 'Start',
              icon: { ios: 'arrow.right', android: 'arrow_forward', web: 'arrow_forward' },
              testID: 'onboarding-splash-continue',
              onPress: onContinue,
            },
          }}
        >
          {null}
        </PageFooter>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: {
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  hero: {
    alignItems: 'center',
    alignSelf: 'stretch',
    flex: 1,
    justifyContent: 'center',
    minHeight: 0,
  },
  word: {
    fontFamily: BrandFonts.display,
    fontWeight: '700',
    letterSpacing: -0.4,
  },
  wordStreet: {
    fontFamily: BrandFonts.displayMedium,
    fontWeight: '600',
  },
  island: {
    borderRadius: 26,
    borderWidth: 1,
    gap: 12,
    maxWidth: 420,
  },
  heading: {
    fontFamily: BrandFonts.displayMedium,
    fontWeight: '600',
    lineHeight: 28,
  },
  body: {
    lineHeight: 21,
  },
  button: {
    alignItems: 'center',
    borderRadius: 16,
    height: 52,
    justifyContent: 'center',
    marginTop: Spacing.two,
  },
  buttonLabel: {
    fontFamily: BrandFonts.display,
    fontSize: 18,
    fontWeight: '700',
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },
});
