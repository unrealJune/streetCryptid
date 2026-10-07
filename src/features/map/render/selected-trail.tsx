import { Circle, Path, Skia } from '@shopify/react-native-skia';
import { useDerivedValue, type SharedValue } from 'react-native-reanimated';

import type { ViewTransform } from '../core/camera';
import type { ScreenPoint, Viewport } from '../core/types';

export interface TrailScreenPoint {
  readonly id: string;
  readonly screen: ScreenPoint;
}

/** Clip in doubles: even a single segment can cross continents, so a trail-wide origin is unsafe. */
export function clipTrailSegment(a: ScreenPoint, b: ScreenPoint, viewport: Viewport) {
  'worklet';
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  let lo = 0;
  let hi = 1;
  const p = [-dx, dx, -dy, dy];
  const q = [a[0] + 4, viewport.width + 4 - a[0], a[1] + 4, viewport.height + 4 - a[1]];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return null;
    } else {
      const u = q[i] / p[i];
      if (p[i] < 0) lo = Math.max(lo, u);
      else hi = Math.min(hi, u);
      if (lo > hi) return null;
    }
  }
  return [a[0] + lo * dx, a[1] + lo * dy, a[0] + hi * dx, a[1] + hi * dy];
}

function TrailDot({
  point,
  camera,
  viewport,
  color,
  opacity,
}: {
  point: ScreenPoint;
  camera: SharedValue<ViewTransform>;
  viewport: Viewport;
  color: string;
  opacity: number;
}) {
  const position = useDerivedValue(() => {
    const t = camera.value;
    const x = point[0] * t.k + t.tx;
    const y = point[1] * t.k + t.ty;
    return x < -4 || y < -4 || x > viewport.width + 4 || y > viewport.height + 4
      ? [-10, -10]
      : [x, y];
  });
  const x = useDerivedValue(() => position.value[0]);
  const y = useDerivedValue(() => position.value[1]);
  return <Circle cx={x} cy={y} r={2.8} color={color} opacity={opacity} />;
}

export function SelectedTrail({
  points,
  camera,
  viewport,
  color,
}: {
  points: readonly TrailScreenPoint[];
  camera: SharedValue<ViewTransform>;
  viewport: Viewport;
  color: string;
}) {
  const path = useDerivedValue(() => {
    const result = Skia.Path.Make();
    const t = camera.value;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1].screen;
      const b = points[i].screen;
      const segment = clipTrailSegment(
        [a[0] * t.k + t.tx, a[1] * t.k + t.ty],
        [b[0] * t.k + t.tx, b[1] * t.k + t.ty],
        viewport
      );
      if (segment) {
        result.moveTo(segment[0], segment[1]);
        result.lineTo(segment[2], segment[3]);
      }
    }
    return result;
  });
  return (
    <>
      <Path
        path={path}
        color={color}
        opacity={0.72}
        style="stroke"
        strokeWidth={2.5}
        strokeCap="round"
        strokeJoin="round"
      />
      {points.map(({ id, screen }, index) => (
        <TrailDot
          key={id}
          point={screen}
          camera={camera}
          viewport={viewport}
          color={color}
          opacity={0.34 + (0.5 * (index + 1)) / points.length}
        />
      ))}
    </>
  );
}
