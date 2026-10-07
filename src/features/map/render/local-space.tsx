import { Group } from '@shopify/react-native-skia';
import type { ReactNode } from 'react';
import { useDerivedValue, type SharedValue } from 'react-native-reanimated';

import type { ViewTransform } from '../core/camera';
import type { RevealRect } from './reveal-mask';

/** Cancel session-sized offsets in doubles BEFORE Skia converts the matrix to float32. */
export function localTransform(t: ViewTransform, x: number, y: number) {
  'worklet';
  return [{ translateX: x * t.k + t.tx }, { translateY: y * t.k + t.ty }, { scale: t.k }];
}

export function LocalMapGroup({
  origin,
  camera,
  children,
}: {
  origin: { x: number; y: number };
  camera: SharedValue<ViewTransform>;
  children: ReactNode;
}) {
  const { x, y } = origin;
  const transform = useDerivedValue(() => localTransform(camera.value, x, y));
  return <Group transform={transform}>{children}</Group>;
}

/** Only overlapping coverage matters; a previous city must not become a huge shader uniform. */
export function localCoverage(current: RevealRect, previous: RevealRect | null): RevealRect | null {
  if (!previous) return null;
  const x = Math.max(0, previous.x - current.x);
  const y = Math.max(0, previous.y - current.y);
  const right = Math.min(current.width, previous.x - current.x + previous.width);
  const bottom = Math.min(current.height, previous.y - current.y + previous.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}
