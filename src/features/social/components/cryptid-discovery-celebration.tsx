import { useEffect, useState } from 'react';
import { Animated, Easing, Modal, Pressable, StyleSheet, useColorScheme, View } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';

import { ThemedText } from '@/components/themed-text';
import { resolveSignalColor } from '@/constants/signal-colors';
import { CryptidThemes, Spacing } from '@/constants/theme';
import { CryptidAvatar } from '@/features/account/components/cryptid-avatar';
import type { Friend } from '../core/types';

interface CryptidDiscoveryCelebrationProps {
  friend: Friend | null;
  onAcknowledge(): void;
  onReject(): Promise<void>;
}

export function CryptidDiscoveryCelebration({
  friend,
  onAcknowledge,
  onReject,
}: CryptidDiscoveryCelebrationProps) {
  const scheme = useColorScheme();
  const chrome = CryptidThemes[scheme === 'dark' ? 'deepsea' : 'daybreak'].chrome;
  const reducedMotion = useReducedMotion();
  const [entrance] = useState(() => new Animated.Value(0));
  const [dance] = useState(() => new Animated.Value(0));

  useEffect(() => {
    if (!friend) return;
    entrance.setValue(0);
    dance.setValue(0);
    if (reducedMotion) {
      entrance.setValue(1);
      return;
    }
    const animation = Animated.parallel([
      Animated.timing(entrance, {
        toValue: 1,
        duration: 260,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.sequence([
        Animated.delay(420),
        Animated.timing(dance, {
          toValue: 1,
          duration: 180,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(dance, {
          toValue: -0.7,
          duration: 150,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(dance, {
          toValue: 0.45,
          duration: 130,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(dance, {
          toValue: 0,
          duration: 180,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
      ]),
    ]);
    animation.start();
    return () => animation.stop();
  }, [dance, entrance, friend, reducedMotion]);

  if (!friend) return null;
  const color = resolveSignalColor(friend.color, chrome.green);
  const rotate = dance.interpolate({
    inputRange: [-1, 0, 1],
    outputRange: ['-13deg', '0deg', '13deg'],
  });
  const hop = dance.interpolate({
    inputRange: [-1, 0, 1],
    outputRange: [-12, 0, -18],
  });

  return (
    <Modal animationType="fade" onRequestClose={() => undefined} transparent visible>
      <View
        accessibilityViewIsModal
        style={[styles.scrim, { backgroundColor: `${chrome.void}F5` }]}
      >
        <Animated.View
          style={[
            styles.burst,
            {
              borderColor: color,
              opacity: entrance,
              transform: [{ scale: entrance }],
            },
          ]}
        />
        <Animated.View
          style={[
            styles.card,
            {
              borderColor: color,
              opacity: entrance,
              transform: [
                {
                  scale: entrance.interpolate({
                    inputRange: [0, 1],
                    outputRange: [0.55, 1],
                  }),
                },
              ],
            },
          ]}
        >
          <ThemedText type="code" style={[styles.eyebrow, { color }]}>
            FRIEND FOUND
          </ThemedText>
          <ThemedText accessibilityRole="header" style={styles.title}>
            CRYPTID DISCOVERED
          </ThemedText>
          <Animated.View
            style={{
              transform: [{ translateY: hop }, { rotate }, { scale: entrance }],
            }}
          >
            <CryptidAvatar
              art={friend.sigil}
              color={color}
              name={friend.cryptidName ?? 'Unknown form'}
              size="large"
              style={styles.avatar}
            />
          </Animated.View>
          <ThemedText style={[styles.handle, { color }]}>{friend.handle}</ThemedText>
          <ThemedText type="code" themeColor="textSecondary" style={styles.caption}>
            {friend.cryptidName?.toUpperCase() ?? 'UNKNOWN FORM'} · LOCATION SHARING ACTIVE
          </ThemedText>
          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Reject ${friend.handle} and stop sharing`}
              onPress={() => void onReject()}
              style={({ pressed }) => [
                styles.action,
                styles.rejectAction,
                {
                  borderColor: chrome.steel,
                  opacity: pressed ? 0.55 : 1,
                },
              ]}
            >
              <ThemedText type="code" themeColor="textSecondary" style={styles.actionLabel}>
                REJECT
              </ThemedText>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Acknowledge ${friend.handle} as a friend`}
              onPress={onAcknowledge}
              style={({ pressed }) => [
                styles.action,
                {
                  backgroundColor: color,
                  opacity: pressed ? 0.72 : 1,
                },
              ]}
            >
              <ThemedText type="code" style={[styles.actionLabel, styles.onGreen]}>
                ACKNOWLEDGE
              </ThemedText>
            </Pressable>
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
    overflow: 'hidden',
    padding: Spacing.four,
  },
  burst: {
    borderRadius: 280,
    borderWidth: 2,
    height: 560,
    position: 'absolute',
    width: 560,
  },
  card: {
    alignItems: 'center',
    borderRadius: Spacing.three,
    borderWidth: 1,
    gap: Spacing.three,
    maxWidth: 520,
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.five,
    width: '100%',
  },
  eyebrow: {
    fontWeight: '700',
    letterSpacing: 2,
  },
  title: {
    fontFamily: 'Rajdhani_700Bold',
    fontSize: 37,
    fontWeight: '700',
    letterSpacing: 3,
    lineHeight: 42,
    textAlign: 'center',
  },
  avatar: {
    minHeight: 190,
    minWidth: 240,
  },
  handle: {
    fontFamily: 'Rajdhani_700Bold',
    fontSize: 34,
    fontWeight: '700',
    // Rajdhani's ascenders overflow the default line box, clipping the top of
    // the glyphs (the '@' loses its upper half). Every other Rajdhani style
    // sets this explicitly; 38 at size 34 matches the coverage island's hero.
    lineHeight: 38,
  },
  caption: {
    letterSpacing: 1.3,
    textAlign: 'center',
  },
  actions: {
    flexDirection: 'row',
    gap: Spacing.two,
    marginTop: Spacing.two,
    width: '100%',
  },
  action: {
    alignItems: 'center',
    borderRadius: Spacing.two,
    flex: 1,
    justifyContent: 'center',
    minHeight: 48,
    paddingHorizontal: Spacing.two,
  },
  rejectAction: {
    borderWidth: StyleSheet.hairlineWidth,
  },
  actionLabel: {
    fontWeight: '700',
    letterSpacing: 0.8,
  },
  onGreen: {
    color: '#07131f',
  },
});
