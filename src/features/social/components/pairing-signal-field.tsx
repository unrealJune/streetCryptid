import { useEffect, useMemo, useState } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';

export type PairingFieldMode = 'pulse' | 'sweep' | 'countdown' | 'inward' | 'converge' | 'scatter';

interface PairingSignalFieldProps {
  readonly accent: string;
  readonly base: string;
  readonly mode: PairingFieldMode;
  readonly progress?: number;
  readonly size: number;
}

interface Dot {
  readonly x: number;
  readonly y: number;
  readonly band: number;
  readonly phase: number;
}

const FIELD_SIZE = 320;
const STEP = 16;
const RADIUS = 150;
const BAND_COUNT = 10;

function buildDots(mode: PairingFieldMode): Dot[] {
  const dots: Dot[] = [];
  for (let y = STEP; y < FIELD_SIZE; y += STEP) {
    for (let x = STEP; x < FIELD_SIZE; x += STEP) {
      const dx = x - FIELD_SIZE / 2;
      const dy = y - FIELD_SIZE / 2;
      const distance = Math.hypot(dx, dy);
      if (distance > RADIUS) continue;
      const angle = (Math.atan2(dy, dx) + Math.PI * 2) % (Math.PI * 2);
      const radialBand = Math.min(BAND_COUNT - 1, Math.floor((distance / RADIUS) * BAND_COUNT));
      const angularBand = Math.min(
        BAND_COUNT - 1,
        Math.floor((angle / (Math.PI * 2)) * BAND_COUNT)
      );
      dots.push({
        x,
        y,
        band: mode === 'sweep' || mode === 'scatter' ? angularBand : radialBand,
        phase: angle / (Math.PI * 2),
      });
    }
  }
  return dots;
}

function durationForMode(mode: PairingFieldMode): number {
  switch (mode) {
    case 'sweep':
      return 2100;
    case 'converge':
      return 1500;
    case 'inward':
      return 1900;
    case 'scatter':
      return 2600;
    case 'countdown':
      return 3000;
    case 'pulse':
      return 2400;
  }
}

export function PairingSignalField({
  accent,
  base,
  mode,
  progress = 1,
  size,
}: PairingSignalFieldProps) {
  const reducedMotion = useReducedMotion();
  const [animation] = useState(() => new Animated.Value(0));
  const dots = useMemo(() => buildDots(mode), [mode]);
  const bands = useMemo(
    () => Array.from({ length: BAND_COUNT }, (_, band) => dots.filter((dot) => dot.band === band)),
    [dots]
  );

  useEffect(() => {
    animation.stopAnimation();
    animation.setValue(reducedMotion ? 0.5 : 0);
    if (reducedMotion || mode === 'countdown') return;
    const loop = Animated.loop(
      Animated.timing(animation, {
        toValue: 1,
        duration: durationForMode(mode),
        easing: Easing.linear,
        useNativeDriver: true,
      })
    );
    loop.start();
    return () => loop.stop();
  }, [animation, mode, reducedMotion]);

  const scale = size / FIELD_SIZE;

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={{ height: size, width: size }}
    >
      <View style={[styles.field, { transform: [{ scale }] }]}>
        {bands.map((bandDots, index) => {
          const center = (index + 0.5) / BAND_COUNT;
          const start = Math.max(0, center - 0.14);
          const end = Math.min(1, center + 0.14);
          const inputRange =
            start === 0
              ? [0, center, end]
              : end === 1
                ? [start, center, 1]
                : [0, start, center, end, 1];
          const outputRange =
            start === 0 || end === 1 ? [0.16, 0.95, 0.16] : [0.12, 0.12, 0.95, 0.12, 0.12];
          const opacity =
            mode === 'countdown'
              ? index / BAND_COUNT <= progress
                ? 0.92
                : 0.12
              : animation.interpolate({ inputRange, outputRange });
          const reverseIndex = BAND_COUNT - 1 - index;
          const transform =
            mode === 'converge'
              ? [
                  {
                    scale: animation.interpolate({
                      inputRange: [0, 0.5, 1],
                      outputRange: [0.88, 1.04, 0.88],
                    }),
                  },
                ]
              : mode === 'inward'
                ? [
                    {
                      scale: animation.interpolate({
                        inputRange: [0, 1],
                        outputRange: [1 + reverseIndex * 0.006, 0.94 + reverseIndex * 0.003],
                      }),
                    },
                  ]
                : undefined;

          return (
            <Animated.View
              key={`${mode}-${index}`}
              style={[StyleSheet.absoluteFill, { opacity, transform }]}
            >
              {bandDots.map((dot) => {
                const active =
                  mode !== 'countdown' || dot.phase <= Math.max(0, Math.min(1, progress));
                return (
                  <View
                    key={`${dot.x}-${dot.y}`}
                    style={[
                      styles.dot,
                      {
                        backgroundColor: active ? accent : base,
                        left: dot.x - 2.5,
                        top: dot.y - 2.5,
                      },
                    ]}
                  />
                );
              })}
            </Animated.View>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  field: {
    height: FIELD_SIZE,
    left: '50%',
    marginLeft: -FIELD_SIZE / 2,
    marginTop: -FIELD_SIZE / 2,
    position: 'absolute',
    top: '50%',
    width: FIELD_SIZE,
  },
  dot: {
    borderRadius: 3,
    height: 5,
    position: 'absolute',
    width: 5,
  },
});
