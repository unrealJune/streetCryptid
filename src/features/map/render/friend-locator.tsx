import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';

import { signalColorInk } from '@/constants/signal-colors';
import { normalizeAsciiArt } from '@/features/account/core/profile';

interface FriendLocatorProps {
  x: number;
  y: number;
  scale: SharedValue<number>;
  translateX: SharedValue<number>;
  translateY: SharedValue<number>;
  handle: string;
  sigil: string;
  color: string;
  panelColor: string;
  selected?: boolean;
  stale?: boolean;
  onPress(): void;
}

export interface SigilMetrics {
  fontSize: number;
  height: number;
  lineHeight: number;
  width: number;
}

export function sigilMetrics(sigil: string): SigilMetrics {
  const lines = sigil.replace(/\r\n?/g, '\n').split('\n');
  const columns = Math.max(1, ...lines.map((line) => line.replace(/\t/g, '    ').length));
  const fontSize = Math.max(
    3,
    Math.min(7, 52 / (columns * 0.62), 38 / (Math.max(1, lines.length) * 1.12))
  );
  const lineHeight = fontSize * 1.12;
  return {
    fontSize,
    lineHeight,
    width: Math.ceil(columns * fontSize * 0.62 + 10),
    height: Math.ceil(lines.length * lineHeight + 8),
  };
}

/** A screen-space friend marker: map position moves, visual size never zooms. */
export function FriendLocator({
  x,
  y,
  scale,
  translateX,
  translateY,
  handle,
  sigil,
  color,
  panelColor,
  selected = false,
  stale = false,
  onPress,
}: FriendLocatorProps) {
  const art = normalizeAsciiArt(sigil || '?');
  const metrics = sigilMetrics(art);
  const handleWidth = Math.min(126, Math.max(58, handle.length * 7.2 + 18));
  const pinTop = metrics.height + 7;
  const anchorX = 16;
  const anchorY = pinTop + 16;
  const markerWidth = Math.max(metrics.width, 36 + handleWidth);
  const markerHeight = anchorY + 22;
  const positionStyle = useAnimatedStyle(
    () => ({
      transform: [
        { translateX: x * scale.value + translateX.value - anchorX },
        { translateY: y * scale.value + translateY.value - anchorY },
      ],
    }),
    [anchorX, anchorY, x, y]
  );

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[
        styles.anchor,
        {
          height: markerHeight,
          width: markerWidth,
          zIndex: selected ? 2 : 1,
        },
        positionStyle,
      ]}
    >
      <Pressable
        accessibilityHint="Shows this friend's retained location trail"
        accessibilityLabel={`Open ${handle}'s location history`}
        accessibilityRole="button"
        hitSlop={6}
        onPress={onPress}
        style={({ pressed }) => [
          styles.marker,
          {
            height: markerHeight,
            opacity: stale ? 0.58 : pressed ? 0.72 : 1,
            width: markerWidth,
          },
        ]}
      >
        <View
          style={[
            styles.artPanel,
            {
              backgroundColor: panelColor,
              borderColor: color,
              height: metrics.height,
              width: metrics.width,
            },
          ]}
        >
          <Text
            accessibilityElementsHidden
            allowFontScaling={false}
            style={[
              styles.art,
              {
                color,
                fontSize: metrics.fontSize,
                lineHeight: metrics.lineHeight,
              },
            ]}
          >
            {art}
          </Text>
        </View>

        <View
          accessibilityElementsHidden
          style={[
            styles.outerRing,
            {
              borderColor: color,
              borderWidth: selected ? 2 : 1.2,
              top: pinTop + 1,
            },
          ]}
        />
        <View
          accessibilityElementsHidden
          style={[styles.innerRing, { borderColor: color, top: pinTop + 8 }]}
        />
        <View
          accessibilityElementsHidden
          style={[styles.core, { backgroundColor: color, top: pinTop + 12 }]}
        >
          <View style={[styles.coreDot, { backgroundColor: panelColor }]} />
        </View>

        <View
          style={[
            styles.handleChip,
            {
              backgroundColor: color,
              left: 35,
              maxWidth: handleWidth,
              top: pinTop + 5,
            },
          ]}
        >
          <Text
            allowFontScaling={false}
            numberOfLines={1}
            style={[styles.handle, { color: signalColorInk(color) }]}
          >
            {handle}
          </Text>
        </View>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  anchor: {
    left: 0,
    position: 'absolute',
    top: 0,
  },
  marker: {
    position: 'absolute',
  },
  artPanel: {
    alignItems: 'center',
    borderRadius: 5,
    borderWidth: StyleSheet.hairlineWidth,
    justifyContent: 'center',
    left: 0,
    overflow: 'hidden',
    position: 'absolute',
    top: 0,
  },
  art: {
    fontFamily: 'IBMPlexMono_500Medium',
    includeFontPadding: false,
    textAlign: 'left',
  },
  outerRing: {
    borderRadius: 15,
    height: 30,
    left: 1,
    position: 'absolute',
    width: 30,
  },
  innerRing: {
    borderRadius: 8,
    borderWidth: 1.2,
    height: 16,
    left: 8,
    position: 'absolute',
    width: 16,
  },
  core: {
    alignItems: 'center',
    borderRadius: 4,
    height: 8,
    justifyContent: 'center',
    left: 12,
    position: 'absolute',
    width: 8,
  },
  coreDot: {
    borderRadius: 1.5,
    height: 3,
    width: 3,
  },
  handleChip: {
    borderRadius: 5,
    minHeight: 22,
    paddingHorizontal: 7,
    paddingVertical: 3,
    position: 'absolute',
  },
  handle: {
    fontFamily: 'Rajdhani_700Bold',
    fontSize: 13,
    fontWeight: '700',
    lineHeight: 16,
  },
});
