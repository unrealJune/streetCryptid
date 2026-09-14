import { SymbolView } from 'expo-symbols';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { CryptidTheme } from '@/constants/cryptid-theme';
import { Spacing } from '@/constants/theme';
import { CryptidAvatar } from '@/features/account/components/cryptid-avatar';
import { formatDistanceValue, type DistanceUnit } from '@/features/settings/core/distance-units';
import { useDisplayPreferences } from '@/features/settings/hooks/use-display-preferences';

import { islandBody } from './island-body';

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
  readonly theme: CryptidTheme;
  /** Collapsed to the count alone; the drawer's grip is what reopens it. */
  readonly minimized: boolean;
  onSelect(friendId: string): void;
  onOpenProfile(friendId: string): void;
  /** Opens the pairing screen. Rendered as the one glyph beside the count. */
  onOpenPairing(): void;
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
 * one fact the tab cannot carry: how many are near you — and, beside it, the only way to add
 * anyone. Adding a friend used to be a full-width strip at the top of the list reading "PAIR WITH
 * SOMEONE / OPEN PAIRING", which said the same thing twice and cost a row of roster to do it. It
 * is a glyph on the header line now, present at every detent including the collapsed one, so the
 * roster starts with friends rather than with an advertisement for the pairing screen.
 *
 * The drawer owns minimizing through its grip; there is no collapse control in here.
 */
export function FriendsIsland({
  friends,
  theme,
  minimized,
  onSelect,
  onOpenProfile,
  onOpenPairing,
}: FriendsIslandProps) {
  const { chrome } = theme;
  const { distanceUnit, ready: displayPreferencesReady } = useDisplayPreferences();
  const nearby = friends.filter((friend) => friend.nearby).length;

  return (
    <View style={minimized ? islandBody.minimized : islandBody.expanded}>
      <View style={islandBody.header}>
        <View
          accessible
          accessibilityRole="summary"
          accessibilityLabel={
            friends.length === 0
              ? 'No cryptids yet!'
              : `${friends.length} friend${friends.length === 1 ? '' : 's'}, ${nearby} nearby.`
          }
          style={islandBody.summary}
        >
          <Text style={[styles.title, { color: chrome.ink }]}>{nearby} NEARBY</Text>
        </View>
        {/* The pairing screen's only entrance. Kept on the header line at every
            detent: it is the answer to an empty roster, and the roster is at its
            emptiest exactly when the panel is smallest. */}
        <Pressable
          accessibilityHint="Opens the active pairing screen and starts nearby listening"
          accessibilityLabel="Open pairing"
          accessibilityRole="button"
          hitSlop={8}
          onPress={onOpenPairing}
          style={({ pressed }) => [
            styles.add,
            { backgroundColor: chrome.seg, opacity: pressed ? 0.55 : 1 },
          ]}
        >
          <SymbolView
            name={{ ios: 'person.badge.plus', android: 'person_add', web: 'person_add' }}
            size={18}
            tintColor={chrome.green}
          />
        </Pressable>
      </View>

      {minimized ? null : (
        <>
          {friends.length === 0 ? (
            <Text style={[styles.empty, { color: chrome.steel }]}>No cryptids yet!</Text>
          ) : (
            <View style={styles.list}>
              {friends.map((friend, index) => (
                <FriendRow
                  distanceUnit={displayPreferencesReady ? distanceUnit : null}
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
        </>
      )}
    </View>
  );
}

function FriendRow({
  distanceUnit,
  divider,
  friend,
  onOpenProfile,
  onSelect,
  theme,
}: {
  readonly distanceUnit: DistanceUnit | null;
  readonly divider: boolean;
  readonly friend: MapRosterFriend;
  readonly theme: CryptidTheme;
  onOpenProfile(friendId: string): void;
  onSelect(friendId: string): void;
}) {
  const { chrome } = theme;
  const distance = distanceUnit === null ? null : compactDistance(friend.distanceM, distanceUnit);
  const trailing = !friend.online
    ? 'OFFLINE'
    : distanceUnit === null
      ? null
      : (distance ?? 'NO FIX');

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
        accessibilityLabel={`${friend.handle}. ${trailing ? `${trailing.toLowerCase()}. ` : ''}${friend.status.toLowerCase()}.`}
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
        {trailing ? (
          <Text style={[styles.trailing, { color: friend.online ? chrome.ink : chrome.steel }]}>
            {trailing}
          </Text>
        ) : null}
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
export function compactDistance(
  distanceM: number | null,
  unit: DistanceUnit = 'km'
): string | null {
  return formatDistanceValue(distanceM, unit)?.toUpperCase() ?? null;
}

const styles = StyleSheet.create({
  title: {
    fontFamily: 'Rajdhani_700Bold',
    fontSize: 22,
    letterSpacing: 3,
    lineHeight: 26,
  },
  add: {
    alignItems: 'center',
    borderRadius: 15,
    height: 30,
    justifyContent: 'center',
    width: 30,
  },
  empty: {
    fontFamily: 'IBMPlexMono_400Regular',
    fontSize: 12,
    lineHeight: 18,
    paddingBottom: Spacing.two,
    paddingTop: Spacing.one,
  },
  list: {
    paddingBottom: Spacing.half,
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
    // The sigil is what sets a row's height — four lines of art plus its caption
    // clears 56 on its own — so the padding here is a separator, not a floor.
    // At Spacing.two the roster read as a list of cards with air between them.
    minHeight: 52,
    minWidth: 0,
    paddingVertical: Spacing.half,
  },
  manage: {
    alignItems: 'center',
    borderRadius: 15,
    height: 30,
    justifyContent: 'center',
    marginLeft: Spacing.two,
    width: 30,
  },
  avatar: {
    // Do NOT narrow this to shorten rows. `CryptidAvatar` only scales the art
    // down once `onTextLayout` has measured it, and where that never fires —
    // react-native-web, which is what the screenshot harness renders — the art
    // WRAPS instead, which mangles it and makes the row taller, not shorter.
    width: 72,
  },
  copy: {
    flex: 1,
    gap: 2,
    minWidth: 0,
  },
  handle: {
    fontFamily: 'Rajdhani_700Bold',
    fontSize: 20,
    lineHeight: 23,
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
