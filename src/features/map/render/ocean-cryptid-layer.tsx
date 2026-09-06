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
/**
 * Ceiling on the layer's own opacity. Decoration, but decoration nobody notices
 * is not decoration — at 0.55 over a full-strength water field these read as
 * smudges rather than creatures.
 */
const MAX_OPACITY = 1;
/**
 * Halo radius (px) behind every glyph, painted in the canvas background.
 *
 * This is what actually makes them pop, and it is the same trick the name chips
 * use — they sit on an island-coloured plate for exactly this reason. A stippled
 * dot field is the worst possible ground for thin ASCII: the strokes and the
 * dots are the same width, so the outline dissolves into the water no matter how
 * dark the ink. Clearing a little background behind each glyph separates the
 * figure from the sea without a hard chip edge around a piece of art.
 *
 * It also inverts correctly for free: in a dark scheme the halo is dark and the
 * ink is light, so the same rule pops in both.
 */
const HALO_RADIUS = 4;
/** Waves sit behind the creature, so they stay a fraction of its weight. */
const WAVE_OPACITY_FACTOR = 0.7;
/** Wave drift, counter to the figure's — the relative motion is what swims. */
const WAVE_DRIFT_X = -9;

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
  const [hr, hg, hb] = palette.bg;
  const halo = `rgb(${hr}, ${hg}, ${hb})`;

  return (
    <>
      {cryptids.map((cryptid) => {
        const [x, y] = worldToScreen(anchor, viewport, cryptid.world);
        return (
          <DriftingCryptid
            art={cryptid.art}
            color={color}
            halo={halo}
            key={cryptid.id}
            opacity={opacity}
            phase={cryptid.phase}
            reducedMotion={reducedMotion}
            scale={scale}
            translateX={translateX}
            translateY={translateY}
            waves={cryptid.waves}
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
  halo,
  opacity,
  phase,
  reducedMotion,
  scale,
  translateX,
  translateY,
  waves,
  x,
  y,
}: {
  readonly art: string;
  readonly color: string;
  readonly halo: string;
  readonly opacity: number;
  readonly phase: number;
  readonly reducedMotion: boolean;
  readonly scale: SharedValue<number>;
  readonly translateX: SharedValue<number>;
  readonly translateY: SharedValue<number>;
  readonly waves: string;
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
  // The waves ride the same driver but slide the other way, so the creature
  // reads as moving THROUGH water rather than the whole glyph sliding around.
  const waveStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: Math.sin(drift.value * Math.PI * 2) * WAVE_DRIFT_X }],
  }));

  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={[styles.figure, positionStyle]}
    >
      <Text allowFontScaling={false} style={[styles.art, haloStyle(halo), { color, opacity }]}>
        {art}
      </Text>
      <Animated.View style={waveStyle}>
        <Text
          allowFontScaling={false}
          style={[styles.art, haloStyle(halo), { color, opacity: opacity * WAVE_OPACITY_FACTOR }]}
        >
          {waves}
        </Text>
      </Animated.View>
    </Animated.View>
  );
}

/** The background-coloured glow that lifts a glyph off the dot field. */
function haloStyle(halo: string) {
  return {
    textShadowColor: halo,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: HALO_RADIUS,
  } as const;
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
    // The heaviest mono face the app loads (see `app/_layout.tsx`). At 500 these
    // dissolved into the water dots; the extra weight is what makes an ASCII
    // outline hold together over a stippled field.
    fontFamily: 'IBMPlexMono_600SemiBold',
    fontSize: 15,
    includeFontPadding: false,
    lineHeight: 16,
  },
});
