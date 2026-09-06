import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';

export interface FriendClusterPuckItem {
  readonly id: string;
  readonly color: string;
  readonly self?: boolean;
}

interface FriendClusterPuckProps {
  readonly x: number;
  readonly y: number;
  readonly scale: SharedValue<number>;
  readonly translateX: SharedValue<number>;
  readonly translateY: SharedValue<number>;
  readonly members: readonly FriendClusterPuckItem[];
  readonly panelColor: string;
  /** Theme ink for the count — the island surface is a translucent rgba(), so
      it carries no luminance to derive contrast from. */
  readonly inkColor: string;
  /** Fired on tap — the map zooms until the group separates. */
  onPress(): void;
}

const SIZE = 44;
const RADIUS = SIZE / 2;
/** Members whose colors make it into the ring before it stops being readable. */
const MAX_RING_SEGMENTS = 6;

/**
 * A group of friends too large to draw as a stack, collapsed to one puck.
 *
 * `FriendLocatorStack` shows every avatar and a tappable name row each, which is
 * exactly right for two or three people and unreadable for a dozen — at country
 * zoom it becomes a wall of ASCII panels taller than the viewport. Past
 * `CLUSTER_STACK_MAX` this replaces it: the count, a ring split into the members'
 * signal colors so the group still reads as *who* at a glance, and a core dot in
 * your own color when you are one of them. Tapping zooms in until the cluster
 * breaks apart back into stacks and individual pins.
 */
export function FriendClusterPuck({
  x,
  y,
  scale,
  translateX,
  translateY,
  members,
  panelColor,
  inkColor,
  onPress,
}: FriendClusterPuckProps) {
  const includesSelf = members.some((member) => member.self);
  const others = members.filter((member) => !member.self);
  const selfColor = members.find((member) => member.self)?.color;
  const segments = others.slice(0, MAX_RING_SEGMENTS);
  const count = others.length;

  const positionStyle = useAnimatedStyle(
    () => ({
      transform: [
        { translateX: x * scale.value + translateX.value - RADIUS },
        { translateY: y * scale.value + translateY.value - RADIUS },
      ],
    }),
    [x, y]
  );

  return (
    <Animated.View pointerEvents="box-none" style={[styles.anchor, positionStyle]}>
      <Pressable
        accessibilityHint="Zooms in until the group separates"
        accessibilityLabel={
          includesSelf
            ? `${count} ${count === 1 ? 'friend' : 'friends'} and you in this area`
            : `${count} friends in this area`
        }
        accessibilityRole="button"
        hitSlop={6}
        onPress={onPress}
        style={({ pressed }) => [
          styles.puck,
          { backgroundColor: panelColor, opacity: pressed ? 0.72 : 1 },
        ]}
      >
        {/* One arc per member, laid out around the rim: a top border on a
            rotated square reads as a ring segment without any SVG. */}
        {segments.map((member, index) => (
          <View
            key={member.id}
            style={[
              styles.segment,
              {
                borderTopColor: member.color,
                transform: [{ rotate: `${(360 / segments.length) * index}deg` }],
              },
            ]}
          />
        ))}
        <Text allowFontScaling={false} style={[styles.count, { color: inkColor }]}>
          {count}
        </Text>
        {includesSelf && selfColor ? (
          <View style={[styles.selfDot, { backgroundColor: selfColor }]} />
        ) : null}
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  anchor: {
    height: SIZE,
    left: 0,
    position: 'absolute',
    top: 0,
    width: SIZE,
    zIndex: 3,
  },
  puck: {
    alignItems: 'center',
    borderRadius: RADIUS,
    height: SIZE,
    justifyContent: 'center',
    width: SIZE,
  },
  segment: {
    borderRadius: RADIUS,
    borderTopWidth: 2.5,
    borderColor: 'transparent',
    height: SIZE,
    left: 0,
    position: 'absolute',
    top: 0,
    width: SIZE,
  },
  count: {
    fontFamily: 'Rajdhani_700Bold',
    fontSize: 17,
    fontWeight: '700',
    lineHeight: 20,
  },
  selfDot: {
    borderRadius: 2.5,
    bottom: 8,
    height: 5,
    position: 'absolute',
    width: 5,
  },
});
