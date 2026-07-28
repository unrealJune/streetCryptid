import { StyleSheet, Text } from 'react-native';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';

import { worldToScreen } from '../core/camera';
import {
  labelWidthPx,
  LABEL_FONT_SIZE,
  LABEL_HEIGHT_PX,
  LABEL_LETTER_SPACING,
  type MapLabel,
} from '../core/map-labels';
import type { CameraState, MapPalette, Viewport } from '../core/types';

interface MapLabelLayerProps {
  readonly labels: readonly MapLabel[];
  /** Fixed session anchor camera — every overlay shares its screen space. */
  readonly anchor: CameraState;
  readonly viewport: Viewport;
  readonly scale: SharedValue<number>;
  readonly translateX: SharedValue<number>;
  readonly translateY: SharedValue<number>;
  readonly palette: MapPalette;
  /** Chip backing (the theme's island surface), so chips read over any ground. */
  readonly chipColor: string;
}

/**
 * Street and park name chips over the dot field.
 *
 * They ride the live transform exactly like the locators do — positioned in
 * anchor space and only *translated* by the UI-thread transform — so a pinch
 * moves them with the map while the type itself stays a constant, legible size.
 * Which names appear at all is decided per region build in `core/map-labels.ts`.
 *
 * Purely decorative: the island is the canvas's accessible text model
 * (PRODUCT.md P0), so this layer is hidden from screen readers and never takes
 * a touch away from the map's pan/pinch.
 */
export function MapLabelLayer({
  labels,
  anchor,
  viewport,
  scale,
  translateX,
  translateY,
  palette,
  chipColor,
}: MapLabelLayerProps) {
  if (labels.length === 0) return null;

  return (
    <>
      {labels.map((label) => {
        const [x, y] = worldToScreen(anchor, viewport, label.world);
        const rgb = label.kind === 'area' ? palette.parkLabel : palette.streetLabel;
        return (
          <MapLabelChip
            angle={label.angle}
            chipColor={chipColor}
            color={`rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`}
            key={label.id}
            scale={scale}
            text={label.text}
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

function MapLabelChip({
  angle,
  chipColor,
  color,
  scale,
  text,
  translateX,
  translateY,
  x,
  y,
}: {
  readonly angle: number;
  readonly chipColor: string;
  readonly color: string;
  readonly scale: SharedValue<number>;
  readonly text: string;
  readonly translateX: SharedValue<number>;
  readonly translateY: SharedValue<number>;
  readonly x: number;
  readonly y: number;
}) {
  // The chip's width is computed, not measured, so what collides in
  // `core/map-labels.ts` is exactly what renders here.
  const width = labelWidthPx(text);
  // Translate the box so its CENTER lands on the anchor point, then rotate —
  // React Native rotates about the view's own center, so the chip pivots on the
  // road rather than swinging away from it.
  const positionStyle = useAnimatedStyle(
    () => ({
      transform: [
        { translateX: x * scale.value + translateX.value - width / 2 },
        { translateY: y * scale.value + translateY.value - LABEL_HEIGHT_PX / 2 },
        { rotate: `${angle}rad` },
      ],
    }),
    [x, y, width, angle]
  );

  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={[styles.chip, { backgroundColor: chipColor, width }, positionStyle]}
    >
      <Text allowFontScaling={false} numberOfLines={1} style={[styles.text, { color }]}>
        {text}
      </Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  chip: {
    alignItems: 'center',
    borderRadius: 3,
    height: LABEL_HEIGHT_PX,
    justifyContent: 'center',
    left: 0,
    position: 'absolute',
    top: 0,
    // Under the locators (zIndex 3): a friend or the YOU marker always wins.
    zIndex: 1,
  },
  text: {
    fontFamily: 'IBMPlexMono_500Medium',
    fontSize: LABEL_FONT_SIZE,
    letterSpacing: LABEL_LETTER_SPACING,
    lineHeight: LABEL_HEIGHT_PX,
    textAlign: 'center',
  },
});
