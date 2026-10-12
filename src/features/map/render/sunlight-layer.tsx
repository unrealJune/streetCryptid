'use no memo';

import { Rect, Shader, Skia } from '@shopify/react-native-skia';
import { useEffect, useMemo, useState } from 'react';
import {
  runOnJS,
  useAnimatedReaction,
  useDerivedValue,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';

import { useIsAppActive } from '@/hooks/use-is-app-active';
import { scaleFor } from '../core/camera';
import { sunDirection, sunlightOpacity } from '../core/sunlight';
import type { CameraState, Viewport } from '../core/types';
import { SUNLIGHT_SKSL } from './sunlight-shader';

export function SunlightLayer({
  anchor,
  viewport,
  scale,
  translateX,
  translateY,
}: {
  anchor: CameraState;
  viewport: Viewport;
  scale: SharedValue<number>;
  translateX: SharedValue<number>;
  translateY: SharedValue<number>;
}) {
  const appActive = useIsAppActive();
  const [visible, setVisible] = useState(
    () => sunlightOpacity(anchor.zoom + Math.log2(scale.value)) > 0
  );
  const [initialSun] = useState(() => sunDirection(Date.now()));
  const sun = useSharedValue(initialSun);
  const effect = useMemo(() => Skia.RuntimeEffect.Make(SUNLIGHT_SKSL), []);
  const anchorScale = scaleFor(anchor.zoom);

  useAnimatedReaction(
    () => sunlightOpacity(anchor.zoom + Math.log2(scale.value)) > 0,
    (next, previous) => {
      if (next !== previous) runOnJS(setVisible)(next);
    },
    [anchor.zoom]
  );

  useEffect(() => {
    if (!appActive || !visible) return;
    const update = () => {
      sun.value = sunDirection(Date.now());
    };
    update();
    // No animation loop: one minute moves the sun only a quarter of a degree.
    const timer = setInterval(update, 60_000);
    return () => clearInterval(timer);
  }, [appActive, visible, sun]);

  const uniforms = useDerivedValue(() => ({
    uWorldOrigin: [
      anchor.center[0] - (translateX.value / scale.value + viewport.width / 2) / anchorScale,
      anchor.center[1] - (translateY.value / scale.value + viewport.height / 2) / anchorScale,
    ],
    uWorldPerPixel: 1 / (anchorScale * scale.value),
    uSun: sun.value,
    uOpacity: sunlightOpacity(anchor.zoom + Math.log2(scale.value)),
  }));

  if (!effect || !appActive || !visible) return null;
  return (
    <Rect x={0} y={0} width={viewport.width} height={viewport.height}>
      <Shader source={effect} uniforms={uniforms} />
    </Rect>
  );
}
