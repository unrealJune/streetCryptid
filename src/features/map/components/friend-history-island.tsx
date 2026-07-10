import { SymbolView } from 'expo-symbols';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { CryptidTheme } from '@/constants/cryptid-theme';
import { Spacing } from '@/constants/theme';
import { CryptidAvatar } from '@/features/account/components/cryptid-avatar';
import type { MapFriendLocation } from '../render/map-view';

interface FriendHistoryIslandProps {
  readonly friend: MapFriendLocation;
  readonly theme: CryptidTheme;
  onClose(): void;
}

/** Selected-friend readout shown while their retained breadcrumb is on the map. */
export function FriendHistoryIsland({ friend, theme, onClose }: FriendHistoryIslandProps) {
  const { chrome } = theme;
  const signalLabel = `${friend.historyCount} signal${friend.historyCount === 1 ? '' : 's'}`;

  return (
    <View
      style={[
        styles.island,
        {
          backgroundColor: chrome.island,
          borderColor: chrome.islandBorder,
        },
      ]}
    >
      <CryptidAvatar
        art={friend.sigil || '?'}
        color={friend.color}
        muted={friend.stale}
        name={friend.cryptidName ?? 'Unknown form'}
        style={styles.avatar}
      />
      <View
        accessible
        accessibilityRole="summary"
        accessibilityLabel={`${friend.handle}. ${signalLabel} in the retained 48 hour location history. The latest retained location is shown.`}
        style={styles.copy}
      >
        <Text numberOfLines={1} style={[styles.handle, { color: friend.color }]}>
          {friend.handle}
        </Text>
        <Text numberOfLines={1} style={[styles.meta, { color: chrome.steel }]}>
          {signalLabel.toUpperCase()} · RETAINED 48H
        </Text>
        <View accessibilityElementsHidden style={styles.trail}>
          {Array.from({ length: 7 }, (_, index) => (
            <View
              key={index}
              style={[
                index === 6 ? styles.trailHead : styles.trailDot,
                { backgroundColor: friend.color, opacity: 0.28 + index * 0.11 },
              ]}
            />
          ))}
        </View>
      </View>
      <Pressable
        accessibilityLabel={`Close ${friend.handle}'s location history`}
        accessibilityRole="button"
        hitSlop={6}
        onPress={onClose}
        style={({ pressed }) => [
          styles.close,
          {
            borderColor: chrome.islandBorder,
            opacity: pressed ? 0.55 : 1,
          },
        ]}
      >
        <SymbolView
          name={{ ios: 'xmark', android: 'close', web: 'close' }}
          size={17}
          tintColor={chrome.ink}
        />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  island: {
    alignItems: 'center',
    borderRadius: 26,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: Spacing.three,
    minHeight: 108,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.three,
  },
  avatar: {
    maxHeight: 74,
    overflow: 'hidden',
    width: 78,
  },
  copy: {
    flex: 1,
    gap: Spacing.one,
    minWidth: 0,
  },
  handle: {
    fontFamily: 'Rajdhani_700Bold',
    fontSize: 27,
    fontWeight: '700',
    lineHeight: 30,
  },
  meta: {
    fontFamily: 'IBMPlexMono_500Medium',
    fontSize: 9,
    letterSpacing: 1,
  },
  trail: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 5,
    height: 10,
    marginTop: Spacing.one,
  },
  trailDot: {
    borderRadius: 2,
    height: 4,
    width: 4,
  },
  trailHead: {
    borderRadius: 4,
    height: 8,
    width: 8,
  },
  close: {
    alignItems: 'center',
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
});
