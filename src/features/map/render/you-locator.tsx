import { Circle, Group } from '@shopify/react-native-skia';
import { useEffect } from 'react';
import {
  Easing,
  useDerivedValue,
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
  readonly accent: Rgb;
}

/**
 * The single live element of the map: concentric amber rings + core dot (the
 * mock's locator), with a gentle ease-out breath on the outer ring. Honors
 * reduced-motion by rendering the static rings only.
 */
export function YouLocator({ x, y, accent }: YouLocatorProps) {
  const reducedMotion = useReducedMotion();

  const rgb = `rgb(${accent[0]}, ${accent[1]}, ${accent[2]})`;
  const rgba = (a: number) => `rgba(${accent[0]}, ${accent[1]}, ${accent[2]}, ${a})`;

  return (
    <Group transform={[{ translateX: x }, { translateY: y }]}>
      {!reducedMotion && <PulseRing color={rgb} />}
      <Circle r={22} color={rgba(0.16)} style="stroke" strokeWidth={1.2} />
      <Circle r={12} color={rgba(0.4)} style="stroke" strokeWidth={1.4} />
      <Circle r={6} color={rgb} />
      <Circle r={2.3} color="rgba(255, 251, 244, 1)" />
    </Group>
  );
}

/** The animated breath, isolated so its hooks never mount under reduced motion. */
function PulseRing({ color }: { color: string }) {
  const pulse: SharedValue<number> = useSharedValue(0);

  useEffect(() => {
    pulse.value = withRepeat(
      withTiming(1, { duration: 2400, easing: Easing.out(Easing.quad) }),
      -1,
      false
    );
  }, [pulse]);

  // Skia accepts Reanimated-derived values as props: the pulse never re-renders React.
  const r = useDerivedValue(() => 22 + 8 * pulse.value);
  const opacity = useDerivedValue(() => 0.22 * (1 - pulse.value));

  return <Circle r={r} opacity={opacity} color={color} style="stroke" strokeWidth={1.2} />;
}
