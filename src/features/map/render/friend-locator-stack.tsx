import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';

import { signalColorInk } from '@/constants/signal-colors';
import { normalizeAsciiArt } from '@/features/account/core/profile';

import { sigilMetrics } from './friend-locator';

export interface FriendLocatorStackItem {
  readonly id: string;
  readonly handle: string;
  readonly sigil: string;
  readonly color: string;
  readonly selected: boolean;
  readonly self?: boolean;
  readonly stale?: boolean;
  /** They have stopped and said so. Rendered, never dimmed — see `FriendLocator`. */
  readonly parked?: boolean;
}

interface FriendLocatorStackProps {
  readonly x: number;
  readonly y: number;
  readonly scale: SharedValue<number>;
  readonly translateX: SharedValue<number>;
  readonly translateY: SharedValue<number>;
  readonly friends: readonly FriendLocatorStackItem[];
  readonly panelColor: string;
  onPress(friendId: string): void;
  onPressSelf?(): void;
}

/** Gap between two cryptid cards in the row above the pin. */
const ART_GAP_X = 3;
const LABEL_ROW_HEIGHT = 24;

/** A shared pin with collated ASCII avatars and individually selectable name rows. */
export function FriendLocatorStack({
  x,
  y,
  scale,
  translateX,
  translateY,
  friends,
  panelColor,
  onPress,
  onPressSelf,
}: FriendLocatorStackProps) {
  const ordered = [...friends].sort((a, b) => Number(a.selected) - Number(b.selected));
  const includesSelf = ordered.some((item) => item.self);
  const nonSelfCount = ordered.length - Number(includesSelf);
  // Cryptid cards are laid out ONE PER FRIEND, side by side, in the same order the
  // name rows below read top-to-bottom. They used to be dealt as a 7x4px cascade,
  // which hid ~85% of every card but the front one and — because each card is
  // sized to its own art — left their edges at ragged heights. The names stacked
  // cleanly and the icons did not, so a stack of three friends showed one cryptid
  // and two slivers. A row costs width, which a marker has to spare, rather than
  // legibility, which is the entire point of the drawing.
  let artCursorX = 0;
  const art = ordered
    .filter((friend) => !friend.self)
    .map((friend) => {
      const sigil = normalizeAsciiArt(friend.sigil || '?');
      const metrics = sigilMetrics(sigil);
      const left = artCursorX;
      artCursorX += metrics.width + ART_GAP_X;
      return { friend, sigil, metrics, left };
    });
  const artWidth = Math.max(0, artCursorX - ART_GAP_X);
  const artHeight = Math.max(0, ...art.map(({ metrics }) => metrics.height));
  const handleWidth = Math.max(
    ...ordered.map((friend) => Math.min(126, Math.max(58, friend.handle.length * 7.2 + 18)))
  );
  const pinTop = artHeight + 7;
  const anchorX = 16;
  const anchorY = pinTop + 16;
  const markerWidth = Math.max(artWidth, 36 + handleWidth);
  const markerHeight = anchorY + ordered.length * LABEL_ROW_HEIGHT + 2;
  const pinColor = ordered.find((friend) => friend.selected)?.color ?? ordered[0].color;
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
      accessibilityLabel={
        includesSelf
          ? nonSelfCount === 0
            ? 'You are in this area'
            : `${nonSelfCount} ${nonSelfCount === 1 ? 'friend' : 'friends'} and you in this area`
          : `${ordered.length} friends in this area`
      }
      pointerEvents="box-none"
      style={[styles.anchor, { height: markerHeight, width: markerWidth }, positionStyle]}
    >
      {art.map(({ friend, sigil, metrics, left }) => (
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          key={friend.id}
          style={[
            styles.artPanel,
            {
              backgroundColor: panelColor,
              borderColor: friend.color,
              // Selection reads the same way it does on a lone locator: a heavier
              // edge, not a position in a pile.
              borderWidth: friend.selected ? 1.4 : StyleSheet.hairlineWidth,
              borderStyle: friend.parked ? 'dashed' : 'solid',
              height: metrics.height,
              left,
              opacity: friend.stale ? 0.58 : 1,
              // Cards sit on one baseline just above the pin, whatever their own
              // height, so the row reads as a row.
              top: artHeight - metrics.height,
              width: metrics.width,
            },
          ]}
        >
          <Text
            allowFontScaling={false}
            style={[
              styles.art,
              {
                color: friend.color,
                fontSize: metrics.fontSize,
                lineHeight: metrics.lineHeight,
              },
            ]}
          >
            {sigil}
          </Text>
        </View>
      ))}

      <View style={[styles.outerRing, { borderColor: pinColor, top: pinTop + 1 }]} />
      <View style={[styles.innerRing, { borderColor: pinColor, top: pinTop + 8 }]} />
      <View style={[styles.core, { backgroundColor: pinColor, top: pinTop + 12 }]}>
        <View style={[styles.coreDot, { backgroundColor: panelColor }]} />
      </View>

      {ordered.map((friend, index) => (
        <Pressable
          accessibilityHint={
            friend.self
              ? 'Shows your retained location trail'
              : "Shows this friend's retained location trail"
          }
          accessibilityLabel={
            friend.self ? 'Open your location history' : `Open ${friend.handle}'s location history`
          }
          accessibilityRole="button"
          accessibilityState={{ selected: friend.selected }}
          hitSlop={4}
          key={friend.id}
          onPress={() => (friend.self ? onPressSelf?.() : onPress(friend.id))}
          style={({ pressed }) => [
            styles.handleChip,
            {
              backgroundColor: friend.color,
              left: 35,
              maxWidth: handleWidth,
              opacity: friend.stale ? 0.58 : pressed ? 0.72 : 1,
              top: pinTop + 3 + index * LABEL_ROW_HEIGHT,
            },
          ]}
        >
          <Text
            allowFontScaling={false}
            numberOfLines={1}
            style={[styles.handle, { color: signalColorInk(friend.color) }]}
          >
            {friend.handle}
          </Text>
        </Pressable>
      ))}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  anchor: {
    left: 0,
    position: 'absolute',
    top: 0,
    zIndex: 2,
  },
  artPanel: {
    alignItems: 'center',
    borderRadius: 5,
    borderWidth: StyleSheet.hairlineWidth,
    justifyContent: 'center',
    overflow: 'hidden',
    position: 'absolute',
  },
  art: {
    fontFamily: 'IBMPlexMono_500Medium',
    includeFontPadding: false,
  },
  outerRing: {
    borderRadius: 15,
    borderWidth: 1.2,
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
