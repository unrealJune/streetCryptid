import { Canvas, Circle, Group, Path, Rect, Shader, Skia } from '@shopify/react-native-skia';
import { useMemo } from 'react';
import { StyleSheet } from 'react-native';
import { type SharedValue, useDerivedValue } from 'react-native-reanimated';

import { hexToRgb } from '@/features/map/core/color';

import {
  introProgress,
  SIGIL_VIEWBOX,
  SPLASH_MAX_PINGS,
  SPLASH_TIMELINE,
  type SplashRect,
} from '../core/splash-layout';
import { SPLASH_FIELD_SKSL } from './splash-field-sksl';
import { SIGIL_CENTER_X, SIGIL_EYES, SIGIL_ROWS, SIGIL_STROKE } from './splash-sigil-paths';

/**
 * The splash's Skia half: the signal lattice and the sigil flipping in over it, both driven by
 * the intro clock the screen owns. Loaded through `splash-canvas-loader` so the web build waits
 * for CanvasKit — a fresh install reaches this before the map has initialized it.
 */
export interface SplashGeometry {
  readonly sigil: SplashRect;
  readonly clear: { x: number; y: number; rx: number; ry: number };
  readonly pings: readonly { x: number; y: number; start: number; reach: number }[];
  readonly speed: number;
  readonly youSpeed: number;
  readonly youReach: number;
}

export interface SplashCanvasProps {
  readonly width: number;
  readonly height: number;
  readonly geometry: SplashGeometry;
  readonly logoWidth: number;
  readonly time: SharedValue<number>;
  readonly still: SharedValue<number>;
  readonly colors: {
    readonly base: string;
    readonly signal: string;
    readonly amber: string;
    readonly ground: string;
    readonly ink: string;
    readonly baseAlpha: number;
  };
}

export function SplashCanvas({
  width,
  height,
  geometry,
  logoWidth,
  time,
  still,
  colors,
}: SplashCanvasProps) {
  const effect = useMemo(() => {
    const compiled = Skia.RuntimeEffect.Make(SPLASH_FIELD_SKSL);
    if (!compiled) console.warn('[onboarding] splash field shader unavailable');
    return compiled;
  }, []);

  const statics = useMemo(() => {
    const rgb = (hex: string, fallback: [number, number, number]) =>
      hexToRgb(hex, fallback).map((c) => c / 255);
    const slots = Array.from({ length: SPLASH_MAX_PINGS }, (_, i) => {
      const p = geometry.pings[i];
      return p ? [p.x, p.y, p.start, p.reach] : [0, 0, 0, 0];
    });
    const { sigil, clear } = geometry;
    return {
      uSize: [width, height],
      uF0: slots[0],
      uF1: slots[1],
      uF2: slots[2],
      uF3: slots[3],
      uSpeed: geometry.speed,
      uYou: [sigil.x + sigil.width / 2, sigil.y + sigil.height / 2],
      uYouSpeed: geometry.youSpeed,
      uYouReach: geometry.youReach,
      uStarts: [SPLASH_TIMELINE.you, SPLASH_TIMELINE.clear],
      uClear: [clear.x, clear.y, clear.rx, clear.ry],
      uBase: rgb(colors.base, [26, 132, 142]),
      uSignal: rgb(colors.signal, [47, 158, 106]),
      uAmber: rgb(colors.amber, [198, 121, 26]),
      uGround: rgb(colors.ground, [238, 242, 245]),
      uBaseA: colors.baseAlpha,
    };
  }, [colors, geometry, height, width]);

  const uniforms = useDerivedValue(
    () => ({ ...statics, uTime: time.value, uStill: still.value }),
    [statics]
  );

  const scale = logoWidth / SIGIL_VIEWBOX.width;
  const placement = [
    { translateX: geometry.sigil.x },
    { translateY: geometry.sigil.y },
    { scale },
    { translateX: -SIGIL_VIEWBOX.x },
    { translateY: -SIGIL_VIEWBOX.y },
  ];

  return (
    <Canvas pointerEvents="none" style={StyleSheet.absoluteFill}>
      {effect ? (
        <Rect x={0} y={0} width={width} height={height}>
          <Shader source={effect} uniforms={uniforms} />
        </Rect>
      ) : null}
      <Group transform={placement}>
        {SIGIL_ROWS.map((row, index) => (
          <SigilRow
            key={index}
            index={index}
            row={row}
            ink={colors.ink}
            time={time}
            still={still}
          />
        ))}
        {SIGIL_EYES.map((eye, index) => (
          <SigilEye
            key={index}
            index={index}
            eye={eye}
            color={colors.amber}
            time={time}
            still={still}
          />
        ))}
      </Group>
    </Canvas>
  );
}

/** A row of the sigil flipping open about its own centre line, like a flip-dot. */
function SigilRow({
  index,
  row,
  ink,
  time,
  still,
}: {
  index: number;
  row: (typeof SIGIL_ROWS)[number];
  ink: string;
  time: SharedValue<number>;
  still: SharedValue<number>;
}) {
  const path = useMemo(() => Skia.Path.MakeFromSVGString(row.strokes), [row.strokes]);
  const progress = useDerivedValue(() =>
    still.value > 0.5
      ? 1
      : introProgress(
          time.value,
          SPLASH_TIMELINE.rows + index * SPLASH_TIMELINE.rowStagger,
          SPLASH_TIMELINE.rowDuration
        )
  );
  const transform = useDerivedValue(() => [{ scaleY: 0.06 + 0.94 * progress.value }]);
  return (
    <Group origin={{ x: SIGIL_CENTER_X, y: row.centerY }} transform={transform} opacity={progress}>
      {path ? (
        <Path
          path={path}
          style="stroke"
          strokeWidth={SIGIL_STROKE}
          strokeCap="round"
          strokeJoin="round"
          color={ink}
        />
      ) : null}
      {row.dots.map((dot) => (
        <Circle key={dot.cx} cx={dot.cx} cy={dot.cy} r={dot.r} color={ink} />
      ))}
    </Group>
  );
}

function SigilEye({
  index,
  eye,
  color,
  time,
  still,
}: {
  index: number;
  eye: (typeof SIGIL_EYES)[number];
  color: string;
  time: SharedValue<number>;
  still: SharedValue<number>;
}) {
  const progress = useDerivedValue(() =>
    still.value > 0.5
      ? 1
      : introProgress(
          time.value,
          SPLASH_TIMELINE.eyes + index * SPLASH_TIMELINE.eyeStagger,
          SPLASH_TIMELINE.eyeDuration
        )
  );
  const transform = useDerivedValue(() => [{ scale: progress.value }]);
  return (
    <Group origin={{ x: eye.cx, y: eye.cy }} transform={transform} opacity={progress}>
      <Circle cx={eye.cx} cy={eye.cy} r={eye.r} color={color} />
    </Group>
  );
}
