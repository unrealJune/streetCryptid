import { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

import type { Rgb } from '../core/types';

interface YouLocatorProps {
  readonly x: number;
  readonly y: number;
  readonly scale: SharedValue<number>;
  readonly translateX: SharedValue<number>;
  readonly translateY: SharedValue<number>;
  readonly accent: Rgb;
  readonly panelColor: string;
}

/** The amber YOU locator stays legible at every map zoom. */
export function YouLocator({
  x,
  y,
  scale,
  translateX,
  translateY,
  accent,
  panelColor,
}: YouLocatorProps) {
  const reducedMotion = useReducedMotion();
  const pulse = useSharedValue(0);
  const color = `rgb(${accent[0]}, ${accent[1]}, ${accent[2]})`;
  const rgba = (alpha: number) => `rgba(${accent[0]}, ${accent[1]}, ${accent[2]}, ${alpha})`;
  const positionStyle = useAnimatedStyle(
    () => ({
      transform: [
        { translateX: x * scale.value + translateX.value - 30 },
        { translateY: y * scale.value + translateY.value - 30 },
      ],
    }),
    [x, y]
  );
  const pulseStyle = useAnimatedStyle(() => ({
    opacity: 0.24 * (1 - pulse.value),
    transform: [{ scale: 1 + pulse.value * 0.35 }],
  }));

  useEffect(() => {
    if (reducedMotion) {
      pulse.value = 0;
      return;
    }
    pulse.value = withRepeat(
      withTiming(1, { duration: 2400, easing: Easing.out(Easing.quad) }),
      -1,
      false
    );
    return () => cancelAnimation(pulse);
  }, [pulse, reducedMotion]);

  return (
    <Animated.View pointerEvents="none" style={[styles.anchor, positionStyle]}>
      <View style={styles.marker}>
        {!reducedMotion ? (
          <Animated.View style={[styles.pulse, { borderColor: color }, pulseStyle]} />
        ) : null}
        <View style={[styles.outerRing, { borderColor: rgba(0.4) }]} />
        <View style={[styles.innerRing, { borderColor: rgba(0.72) }]} />
        <View style={[styles.core, { backgroundColor: color }]}>
          <View style={[styles.coreDot, { backgroundColor: panelColor }]} />
        </View>
        <View style={[styles.label, { backgroundColor: panelColor }]}>
          <Text allowFontScaling={false} style={[styles.labelText, { color }]}>
            YOU
          </Text>
        </View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  anchor: {
    height: 64,
    left: 0,
    position: 'absolute',
    top: 0,
    width: 92,
    zIndex: 3,
  },
  marker: {
    height: 64,
    position: 'absolute',
    width: 92,
  },
  pulse: {
    borderRadius: 28,
    borderWidth: 1.2,
    height: 56,
    left: 2,
    position: 'absolute',
    top: 2,
    width: 56,
  },
  outerRing: {
    borderRadius: 22,
    borderWidth: 1.2,
    height: 44,
    left: 8,
    position: 'absolute',
    top: 8,
    width: 44,
  },
  innerRing: {
    borderRadius: 12,
    borderWidth: 1.4,
    height: 24,
    left: 18,
    position: 'absolute',
    top: 18,
    width: 24,
  },
  core: {
    alignItems: 'center',
    borderRadius: 6,
    height: 12,
    justifyContent: 'center',
    left: 24,
    position: 'absolute',
    top: 24,
    width: 12,
  },
  coreDot: {
    borderRadius: 2,
    height: 4,
    width: 4,
  },
  label: {
    borderRadius: 4,
    left: 42,
    paddingHorizontal: 6,
    paddingVertical: 3,
    position: 'absolute',
    top: 19,
  },
  labelText: {
    fontFamily: 'Rajdhani_700Bold',
    fontSize: 13,
    fontWeight: '700',
    lineHeight: 16,
  },
});
