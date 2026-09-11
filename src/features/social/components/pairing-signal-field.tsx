import { Canvas, Circle, Rect, Shader, Skia, useClock } from '@shopify/react-native-skia';
import { useEffect, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import {
  Easing,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { hexToRgb } from '@/features/map/core/color';

import { PAIRING_SIGNAL_SKSL } from './pairing-signal-sksl';

export type PairingFieldMode =
  'pulse' | 'sweep' | 'countdown' | 'inward' | 'converge' | 'scatter' | 'fracture';

interface PairingSignalFieldProps {
  readonly accent: string;
  readonly base: string;
  readonly mode: PairingFieldMode;
  readonly progress?: number;
  readonly size: number;
}

const DESIGN_SIZE = 708;
const STEP = 20;
const FIELD_RADIUS = 330;
/** How long one motion takes to become another. Long enough to read as a morph, not a cut. */
const MODE_CROSSFADE_MS = 520;
/**
 * The countdown clock ticks once a second; stepping the ring by 1/120th each tick reads as a
 * stutter. Easing each step across its own second makes the ring drain continuously instead.
 */
const PROGRESS_STEP_MS = 1000;
const MODE_VALUE: Record<PairingFieldMode, number> = {
  pulse: 0,
  sweep: 1,
  countdown: 2,
  inward: 3,
  converge: 4,
  scatter: 5,
  fracture: 6,
};

const FALLBACK_DOTS = Array.from({ length: Math.floor(DESIGN_SIZE / STEP) ** 2 }, (_, index) => {
  const columns = Math.floor(DESIGN_SIZE / STEP);
  const x = ((index % columns) + 1) * STEP;
  const y = (Math.floor(index / columns) + 1) * STEP;
  return { x, y };
}).filter(({ x, y }) => Math.hypot(x - DESIGN_SIZE / 2, y - DESIGN_SIZE / 2) <= FIELD_RADIUS);

export function PairingSignalField({
  accent,
  base,
  mode,
  progress = 1,
  size,
}: PairingSignalFieldProps) {
  const reducedMotion = useReducedMotion();
  const clock = useClock();
  const effect = useMemo(() => {
    const compiled = Skia.RuntimeEffect.Make(PAIRING_SIGNAL_SKSL);
    if (!compiled) console.warn('[pairing] signal field shader unavailable');
    return compiled;
  }, []);
  const accentRgb = useMemo(() => {
    const [r, g, b] = hexToRgb(accent, [76, 255, 171]);
    return [r / 255, g / 255, b / 255];
  }, [accent]);
  const baseRgb = useMemo(() => {
    const [r, g, b] = hexToRgb(base, [104, 210, 206]);
    return [r / 255, g / 255, b / 255];
  }, [base]);
  const modeValue = MODE_VALUE[mode];
  const clampedProgress = Math.max(0, Math.min(1, progress));

  // The outgoing motion and colour are held on the UI thread so the crossfade keeps running
  // even while JS is busy doing whatever caused the state change in the first place.
  const modeFrom = useSharedValue(modeValue);
  const modeTo = useSharedValue(modeValue);
  const modeMix = useSharedValue(1);
  const accentFrom = useSharedValue(accentRgb);
  const accentTo = useSharedValue(accentRgb);
  const smoothProgress = useSharedValue(clampedProgress);

  useEffect(() => {
    if (modeTo.value === modeValue) return;
    // `uModeFrom`/`uModeTo` select a motion; they are not a continuous axis, so an interrupted
    // crossfade restarts from the incoming motion rather than lerping between two selectors.
    modeFrom.value = modeTo.value;
    modeTo.value = modeValue;
    modeMix.value = 0;
    modeMix.value = withTiming(1, {
      duration: reducedMotion ? 0 : MODE_CROSSFADE_MS,
      easing: Easing.inOut(Easing.cubic),
    });
  }, [modeFrom, modeMix, modeTo, modeValue, reducedMotion]);

  useEffect(() => {
    accentFrom.value = accentTo.value;
    accentTo.value = accentRgb;
  }, [accentFrom, accentRgb, accentTo]);

  useEffect(() => {
    // A jump (a new link, a reset) should land immediately; a tick should glide.
    const isTick = Math.abs(smoothProgress.value - clampedProgress) < 0.05;
    smoothProgress.value =
      isTick && !reducedMotion
        ? withTiming(clampedProgress, { duration: PROGRESS_STEP_MS, easing: Easing.linear })
        : clampedProgress;
  }, [clampedProgress, reducedMotion, smoothProgress]);

  const uniforms = useDerivedValue(() => {
    const mix = modeMix.value;
    const from = accentFrom.value;
    const to = accentTo.value;
    return {
      uSize: [size, size],
      uTime: reducedMotion ? 0 : clock.value / 1000,
      uModeFrom: modeFrom.value,
      uModeTo: modeTo.value,
      uModeMix: mix,
      uProgress: smoothProgress.value,
      uAccent: [
        from[0] + (to[0] - from[0]) * mix,
        from[1] + (to[1] - from[1]) * mix,
        from[2] + (to[2] - from[2]) * mix,
      ],
      uBase: baseRgb,
    };
  }, [baseRgb, reducedMotion, size]);
  const fallbackScale = size / DESIGN_SIZE;

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={{ height: size, width: size }}
    >
      <Canvas style={StyleSheet.absoluteFill}>
        {effect ? (
          <Rect x={0} y={0} width={size} height={size}>
            <Shader source={effect} uniforms={uniforms} />
          </Rect>
        ) : (
          FALLBACK_DOTS.map((dot) => (
            <Circle
              key={`${dot.x}-${dot.y}`}
              cx={dot.x * fallbackScale}
              cy={dot.y * fallbackScale}
              r={2.6 * fallbackScale}
              color={base}
              opacity={0.14}
            />
          ))
        )}
      </Canvas>
    </View>
  );
}
