import { useEffect } from 'react';
import { StyleSheet, Text } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

import { worldToScreen } from '../core/camera';
import { oceanCryptidOpacity, type PlacedCryptid } from '../core/ocean-cryptids';
import type { CameraState, MapPalette, Viewport } from '../core/types';

interface OceanCryptidLayerProps {
  readonly cryptids: readonly PlacedCryptid[];
  /** Fixed session anchor camera — every overlay shares its screen space. */
  readonly anchor: CameraState;
  readonly viewport: Viewport;
  readonly scale: SharedValue<number>;
  readonly translateX: SharedValue<number>;
  readonly translateY: SharedValue<number>;
  readonly palette: MapPalette;
  /** Committed camera zoom — drives the layer's fade band. */
  readonly zoom: number;
  readonly reducedMotion: boolean;
}

/** Seconds for one full drift cycle; staggered per figure by its phase. */
const DRIFT_MS = 9000;
/** Drift amplitude in screen px — a slow swim, not a bounce. */
const DRIFT_X = 14;
const DRIFT_Y = 7;
/** Ceiling on the layer's own opacity, so cryptids never compete with the map. */
const MAX_OPACITY = 0.55;

/**
 * Sea cryptids drifting through the oceans and the polar void at far-out zooms.
 *
 * Rides the live transform exactly like `MapLabelLayer` and the locators do —
 * positioned in anchor space, then only *translated* by the UI-thread shared
 * values — so a pinch moves them with the water while the ASCII itself stays a
 * constant, legible size.
 *
 * Purely decorative: the island is the canvas's accessible text model
 * (PRODUCT.md P0), so this is hidden from screen readers and never takes a touch
 * away from the map's pan/pinch. Which figures appear at all is decided in
 * `core/ocean-cryptids.ts`.
 */
export function OceanCryptidLayer({
  cryptids,
  anchor,
  viewport,
  scale,
  translateX,
  translateY,
  palette,
  zoom,
  reducedMotion,
}: OceanCryptidLayerProps) {
  const opacity = oceanCryptidOpacity(zoom) * MAX_OPACITY;
  if (cryptids.length === 0 || opacity <= 0) return null;

  // The lattice ink, not a step of the water ramp. These sit on TWO very
  // different grounds — deep water inside the world, and the bare canvas in the
  // letterbox void past the poles — so an ink drawn from the water ramp
  // disappears into the sea in one and into the background in the other.
  // `streetLabel` is the palette's quiet line work and is built to read against
  // the canvas in both schemes, which is exactly the job here.
  const [r, g, b] = palette.streetLabel;
  const color = `rgb(${r}, ${g}, ${b})`;

  return (
    <>
      {cryptids.map((cryptid) => {
        const [x, y] = worldToScreen(anchor, viewport, cryptid.world);
        return (
          <DriftingCryptid
            art={cryptid.art}
            color={color}
            key={cryptid.id}
            opacity={opacity}
            phase={cryptid.phase}
            reducedMotion={reducedMotion}
            scale={scale}
            translateX={translateX}
            translateY={translateY}
            x={x}
            y={y}
          />
        );
      })}
    </>
  );
}

function DriftingCryptid({
  art,
  color,
  opacity,
  phase,
  reducedMotion,
  scale,
  translateX,
  translateY,
  x,
  y,
}: {
  readonly art: string;
  readonly color: string;
  readonly opacity: number;
  readonly phase: number;
  readonly reducedMotion: boolean;
  readonly scale: SharedValue<number>;
  readonly translateX: SharedValue<number>;
  readonly translateY: SharedValue<number>;
  readonly x: number;
  readonly y: number;
}) {
  // One 0→1 driver per figure; the drift is derived from it, so the whole
  // animation lives on the UI thread and costs nothing on the JS side.
  const drift = useSharedValue(phase);
  useEffect(() => {
    if (reducedMotion) {
      drift.value = phase;
      return;
    }
    drift.value = phase;
    drift.value = withRepeat(
      withTiming(phase + 1, { duration: DRIFT_MS, easing: Easing.inOut(Easing.sin) }),
      -1,
      true
    );
    return () => {
      cancelAnimation(drift);
    };
  }, [drift, phase, reducedMotion]);

  const offset = useDerivedValue(() => {
    const t = drift.value * Math.PI * 2;
    return { dx: Math.sin(t) * DRIFT_X, dy: Math.cos(t * 0.6) * DRIFT_Y };
  });

  const positionStyle = useAnimatedStyle(
    () => ({
      transform: [
        { translateX: x * scale.value + translateX.value + offset.value.dx },
        { translateY: y * scale.value + translateY.value + offset.value.dy },
      ],
    }),
    [x, y]
  );

  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={[styles.figure, positionStyle]}
    >
      <Text allowFontScaling={false} style={[styles.art, { color, opacity }]}>
        {art}
      </Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  figure: {
    left: 0,
    position: 'absolute',
    top: 0,
    // Below the name chips (zIndex 1) and the locators (2–3): decoration loses
    // to anything the user can actually read or tap.
    zIndex: 0,
  },
  art: {
    fontFamily: 'IBMPlexMono_500Medium',
    fontSize: 11,
    includeFontPadding: false,
    lineHeight: 12,
  },
});
