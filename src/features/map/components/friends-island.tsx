import { SymbolView } from 'expo-symbols';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { CryptidTheme } from '@/constants/cryptid-theme';
import { Spacing } from '@/constants/theme';
import { CryptidAvatar } from '@/features/account/components/cryptid-avatar';

/** One roster row's worth of friend, already resolved from live presence. */
export interface MapRosterFriend {
  readonly id: string;
  readonly handle: string;
  readonly sigil: string;
  readonly cryptidName?: string;
  /** The friend's chosen signal color — their one honest color everywhere. */
  readonly color: string;
  /** Metres from you, or null when either side has no fix yet. */
  readonly distanceM: number | null;
  /** Uppercase status line, e.g. `UPDATED 4 MIN AGO`. */
  readonly status: string;
  /** Live presence — offline rows dim rather than disappear. */
  readonly online: boolean;
  /**
   * Reachable AND close enough to be worth the word (`isPresenceNearby`). This is what the header
   * counts; `online` alone counted a friend on another continent as NEARBY.
   */
  readonly nearby: boolean;
  /** Whether we have a location to fly the map to. */
  readonly locatable: boolean;
}

interface FriendsIslandProps {
  readonly friends: readonly MapRosterFriend[];
  /** The bump pairing readout. The island being open is what arms it. */
  readonly pairing?: ReactNode;
  readonly theme: CryptidTheme;
  onSelect(friendId: string): void;
  onOpenProfile(friendId: string): void;
}

/**
 * The drawer's FRIENDS body (`renders/social-roster-*`): the same panel swapped from "where you
 * are" to "who is out there", without ever leaving the map.
 *
 * Hairline dividers, not cards. One signal color per friend. Offline rows dim instead of
 * vanishing, so the roster's shape is stable. There is deliberately no "shared ground" bar here —
 * the mock showed one, but the app has no overlap metric yet and a fabricated number would break
 * the one-honest-signal rule.
 *
 * The list is no longer height-capped. It used to stop at 268px and scroll inside a fixed island;
 * now the drawer it sits in is the thing that grows, so capping here would put a second scroll
 * region inside a surface whose whole job is to get taller.
 *
 * The card surface and the FRIENDS label both belong to `MapDrawer`, so the header leads with the
 * one fact the tab cannot carry: how many are near you.
 */
export function FriendsIsland({
  friends,
  pairing,
  theme,
  onSelect,
  onOpenProfile,
}: FriendsIslandProps) {
  const { chrome } = theme;
  const nearby = friends.filter((friend) => friend.nearby).length;

  return (
    <View style={styles.body}>
      <View
        accessible
        accessibilityRole="summary"
        accessibilityLabel={
          friends.length === 0
            ? 'No friends in your atlas yet.'
            : `${friends.length} friend${friends.length === 1 ? '' : 's'}, ${nearby} nearby.`
        }
        style={styles.header}
      >
        <View style={[styles.pip, { backgroundColor: nearby > 0 ? chrome.green : chrome.seg }]} />
        <Text style={[styles.title, { color: chrome.ink }]}>{nearby} NEARBY</Text>
      </View>

      {pairing}

      {friends.length === 0 ? (
        <Text style={[styles.empty, { color: chrome.steel }]}>
          No cryptids in your atlas yet. Touch two phones together while both are on this tab.
        </Text>
      ) : (
        <View style={styles.list}>
          {friends.map((friend, index) => (
            <FriendRow
              divider={index > 0}
              friend={friend}
              key={friend.id}
              onOpenProfile={onOpenProfile}
              onSelect={onSelect}
              theme={theme}
            />
          ))}
        </View>
      )}
    </View>
  );
}

function FriendRow({
  divider,
  friend,
  onOpenProfile,
  onSelect,
  theme,
}: {
  readonly divider: boolean;
  readonly friend: MapRosterFriend;
  readonly theme: CryptidTheme;
  onOpenProfile(friendId: string): void;
  onSelect(friendId: string): void;
}) {
  const { chrome } = theme;
  const distance = compactDistance(friend.distanceM);
  const trailing = friend.online ? (distance ?? 'NO FIX') : 'OFFLINE';

  return (
    <View
      style={[
        styles.row,
        divider && {
          borderTopColor: chrome.islandBorder,
          borderTopWidth: StyleSheet.hairlineWidth,
        },
      ]}
    >
      <Pressable
        accessibilityHint={
          friend.locatable ? 'Centers the map on them and shows their trail' : undefined
        }
        accessibilityLabel={`${friend.handle}. ${trailing.toLowerCase()}. ${friend.status.toLowerCase()}.`}
        accessibilityRole="button"
        accessibilityState={{ disabled: !friend.locatable }}
        disabled={!friend.locatable}
        onPress={() => onSelect(friend.id)}
        style={({ pressed }) => [
          styles.rowMain,
          { opacity: !friend.locatable ? 0.55 : pressed ? 0.58 : 1 },
        ]}
      >
        <CryptidAvatar
          art={friend.sigil || 'unknown'}
          color={friend.color}
          muted={!friend.online}
          name={friend.cryptidName ?? 'Unknown form'}
          style={styles.avatar}
        />
        <View style={styles.copy}>
          <Text numberOfLines={1} style={[styles.handle, { color: friend.color }]}>
            {friend.handle}
          </Text>
          <Text numberOfLines={1} style={[styles.status, { color: chrome.steel }]}>
            {friend.status}
          </Text>
        </View>
        <Text style={[styles.trailing, { color: friend.online ? chrome.ink : chrome.steel }]}>
          {trailing}
        </Text>
      </Pressable>
      {/* Two targets, two questions: the row asks "where are they", this one
          asks "who are they, and what do I want to do about it".

          It is a filled target with a "more" glyph rather than a hairline
          chevron because everything destructive or consequential lives behind
          it — sharing, the retained trail, and removing the friend entirely.
          As a faint chevron it read as decoration, and people concluded the app
          had no way to remove anyone. */}
      <Pressable
        accessibilityHint="Profile, location sharing, trail and remove"
        accessibilityLabel={`Manage ${friend.handle}`}
        accessibilityRole="button"
        hitSlop={8}
        onPress={() => onOpenProfile(friend.id)}
        style={({ pressed }) => [
          styles.manage,
          { backgroundColor: chrome.seg, opacity: pressed ? 0.55 : 1 },
        ]}
      >
        <SymbolView
          name={{ ios: 'ellipsis', android: 'more_horiz', web: 'more_horiz' }}
          size={18}
          tintColor={chrome.ink}
        />
      </Pressable>
    </View>
  );
}

/**
 * Distance for a roster row: short, uppercase, and rounded to a precision the
 * fix actually supports — never a false-precision metre count.
 */
export function compactDistance(distanceM: number | null): string | null {
  if (distanceM === null || !Number.isFinite(distanceM)) return null;
  if (distanceM < 950) return `${Math.max(0, Math.round(distanceM / 10) * 10)} M`;
  const km = distanceM / 1000;
  return `${km.toFixed(km < 10 ? 1 : 0)} KM`;
}

const styles = StyleSheet.create({
  body: {
    paddingBottom: Spacing.one,
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.three,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: Spacing.two,
    minHeight: 32,
  },
  title: {
    fontFamily: 'Rajdhani_700Bold',
    fontSize: 24,
    letterSpacing: 3,
    lineHeight: 28,
  },
  pip: {
    borderRadius: 5,
    height: 10,
    width: 10,
  },
  empty: {
    fontFamily: 'IBMPlexMono_400Regular',
    fontSize: 12,
    lineHeight: 18,
    paddingBottom: Spacing.two,
    paddingTop: Spacing.two,
  },
  list: {
    paddingBottom: Spacing.one,
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
  },
  rowMain: {
    alignItems: 'center',
    flex: 1,
    flexDirection: 'row',
    gap: Spacing.three,
    minHeight: 64,
    minWidth: 0,
    paddingVertical: Spacing.two,
  },
  manage: {
    alignItems: 'center',
    borderRadius: 17,
    height: 34,
    justifyContent: 'center',
    marginLeft: Spacing.two,
    width: 34,
  },
  avatar: {
    width: 72,
  },
  copy: {
    flex: 1,
    gap: 2,
    minWidth: 0,
  },
  handle: {
    fontFamily: 'Rajdhani_700Bold',
    fontSize: 22,
    lineHeight: 25,
  },
  status: {
    fontFamily: 'IBMPlexMono_500Medium',
    fontSize: 9,
    letterSpacing: 1,
  },
  trailing: {
    fontFamily: 'Rajdhani_600SemiBold',
    fontSize: 16,
    lineHeight: 19,
  },
});
