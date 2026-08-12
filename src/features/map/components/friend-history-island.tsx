import { SymbolView } from 'expo-symbols';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { CryptidTheme } from '@/constants/cryptid-theme';
import { Spacing } from '@/constants/theme';
import { CryptidAvatar } from '@/features/account/components/cryptid-avatar';
import type { MapFriendLocation } from '../render/map-view';

interface FriendHistoryIslandProps {
  readonly friend: MapFriendLocation;
  readonly self?: boolean;
  /** Retained points in YOUR trail. Omitted for friends — their history is not retained. */
  readonly signalCount?: number;
  readonly theme: CryptidTheme;
  onClose(): void;
}

/**
 * Selected-location readout. A drill-down inside the island: the segmented bar stays live below
 * it, so either tab dismisses it, and the close button returns to whichever tab you came from.
 *
 * Asymmetric by design. Your own selection is a *trail* — the retained breadcrumb the map draws
 * behind you. A friend's selection is a single point, because we no longer receive or keep
 * anyone else's history; showing a signal count or a trail motif for them would imply a
 * back-catalogue that does not exist.
 */
export function FriendHistoryIsland({
  friend,
  self = false,
  signalCount = 0,
  theme,
  onClose,
}: FriendHistoryIslandProps) {
  const { chrome } = theme;
  const signalLabel = `${signalCount} signal${signalCount === 1 ? '' : 's'}`;
  const summary = self
    ? `Your location history. ${signalLabel} retained. The latest retained location is shown.`
    : `${friend.handle}'s last known location${friend.stale ? ', signal stale' : ''}.`;
  const meta = self
    ? `${signalLabel.toUpperCase()} · YOUR TRAIL`
    : friend.stale
      ? 'LAST KNOWN · SIGNAL STALE'
      : 'LAST KNOWN POSITION';

  return (
    <View style={styles.body}>
      <CryptidAvatar
        art={friend.sigil || '?'}
        color={friend.color}
        muted={friend.stale}
        name={friend.cryptidName ?? 'Unknown form'}
        style={styles.avatar}
      />
      <View accessible accessibilityRole="summary" accessibilityLabel={summary} style={styles.copy}>
        <Text numberOfLines={1} style={[styles.handle, { color: friend.color }]}>
          {friend.handle}
        </Text>
        <Text numberOfLines={1} style={[styles.meta, { color: chrome.steel }]}>
          {meta}
        </Text>
        {self ? (
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
        ) : null}
      </View>
      <Pressable
        accessibilityLabel={`Close ${self ? 'your location history' : `${friend.handle}'s location`}`}
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
  body: {
    alignItems: 'center',
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
