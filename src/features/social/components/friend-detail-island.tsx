import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { CryptidTheme } from '@/constants/cryptid-theme';
import { resolveSignalColor } from '@/constants/signal-colors';
import { Spacing } from '@/constants/theme';
import { CryptidAvatar } from '@/features/account/components/cryptid-avatar';
import type { DrawerDetent } from '@/features/map/components/map-drawer';

import {
  describeDelivery,
  fixTransportBadge,
  fixTransportDescription,
} from '../core/fix-transport';
import { describePresence, formatAge, formatDistance, type FriendPresence } from '../core/presence';
import type { Friend, RatchetActivity } from '../core/types';

interface FriendDetailIslandProps {
  readonly presence: FriendPresence;
  /**
   * Where the map is looking — which, since selecting a friend flies the camera to them, is where
   * they are. The hero of this pane. Null while the tiles are still resolving a name.
   */
  readonly placeName: string | null;
  /** How far open the drawer is. Everything past the summary is disclosed by pulling it up. */
  readonly detent: DrawerDetent;
  readonly sharing: boolean;
  readonly ratchetActivity?: RatchetActivity;
  /**
   * The pool, so a fix forwarded by a mutual can be named. Anyone absent from it stays unnamed —
   * the author's swarm is not this device's address book, and a stranger's endpoint id is shown as
   * an id rather than dressed up as an identity.
   */
  readonly peers?: readonly Friend[];
  /** The trail stash's endpoint id, when known, so a stashed hop reads as the stash. */
  readonly stashEndpointId?: string | null;
  readonly theme: CryptidTheme;
  onBack(): void;
  onToggleShare(on: boolean): Promise<void>;
  onRemove(): Promise<void>;
}

function pairingLabel(method: FriendPresence['friend']['pairingMethod']): string {
  switch (method) {
    case 'nearby':
      return 'Paired nearby';
    case 'invite':
      return 'Paired by link';
    case 'code':
      return 'Paired by code';
    case 'legacy':
    case undefined:
      return 'Friend';
  }
}

/**
 * A friend, in the drawer — what used to be a full-screen modal.
 *
 * The modal covered the map, which meant the answer to "where are they" was delivered on a screen
 * that could not show where they are. Everything it carried is still here; it is staged by detent
 * instead of stacked on one page.
 *
 * There is no "centre map" button. The tap that opens this pane is the tap that flies the camera,
 * so a control offering to do it again is a control that does nothing. There is no close X either:
 * the back control and a downward swipe are two ways out, and a third was decoration.
 *
 * PEEK is one question — where are they — answered by a hero. Distance and last-signal ride the
 * sub line under it, which is why there is no LOCATION row and no LAST SIGNAL row further down;
 * they would be the same facts a second time.
 */
export function FriendDetailIsland({
  presence,
  placeName,
  detent,
  sharing,
  ratchetActivity,
  peers,
  stashEndpointId,
  theme,
  onBack,
  onToggleShare,
  onRemove,
}: FriendDetailIslandProps) {
  const { chrome } = theme;
  const [pathExpanded, setPathExpanded] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [sharingBusy, setSharingBusy] = useState(false);

  const signalColor = resolveSignalColor(presence.friend.color, chrome.green);
  const endpointId = presence.friend.endpointId;
  const distance = formatDistance(presence.distanceM);
  const expanded = detent !== 'peek';
  const full = detent === 'full';
  // Lower-cased keys: endpoint ids reach us from native hex, storage and tickets, and a case
  // difference between two spellings of the same device would read as two devices.
  const friendHandles = new Map(
    (peers ?? []).map((peer) => [peer.endpointId.trim().toLowerCase(), peer.handle])
  );
  const delivery = describeDelivery({
    via: presence.via,
    viaPeer: presence.viaPeer,
    author: endpointId,
    authorHandle: presence.friend.handle,
    friendHandles,
    stashEndpointId,
  });
  const subLine = [
    describePresence(presence).toUpperCase(),
    distance?.replace(' away', '').toUpperCase(),
  ]
    .filter(Boolean)
    .join(' · ');

  async function handleRemove(): Promise<void> {
    setRemoving(true);
    setRemoveError(null);
    try {
      await onRemove();
    } catch {
      setRemoveError('Could not remove this friend. Try again.');
    } finally {
      setRemoving(false);
    }
  }

  async function handleShare(): Promise<void> {
    if (sharingBusy) return;
    setSharingBusy(true);
    try {
      await onToggleShare(!sharing);
    } catch {
      // The provider owns the actionable error; the control re-renders from `sharing`.
    } finally {
      setSharingBusy(false);
    }
  }

  return (
    <View style={styles.body}>
      <Pressable
        accessibilityLabel="Back to friends"
        accessibilityRole="button"
        hitSlop={8}
        onPress={onBack}
        style={({ pressed }) => [styles.back, { opacity: pressed ? 0.55 : 1 }]}
      >
        <SymbolView
          name={{ ios: 'chevron.left', android: 'chevron_left', web: 'chevron_left' }}
          size={20}
          tintColor={chrome.steel}
        />
        <Text style={[styles.backLabel, { color: chrome.steel }]}>FRIENDS</Text>
      </Pressable>

      {full ? (
        <View
          accessible
          accessibilityRole="summary"
          accessibilityLabel={`${presence.friend.handle}. ${placeName ?? 'Location unnamed'}. ${subLine.toLowerCase()}.`}
          style={styles.heroFull}
        >
          <CryptidAvatar
            art={presence.friend.sigil || 'unknown'}
            color={signalColor}
            name={presence.friend.cryptidName ?? 'Unknown form'}
            size="large"
          />
          <Text style={[styles.handleFull, { color: signalColor }]} numberOfLines={1}>
            {presence.friend.handle}
          </Text>
          <Text style={[styles.placeFull, { color: chrome.ink }]} numberOfLines={1}>
            {placeName ?? '—'}
          </Text>
          <Text style={[styles.sub, { color: chrome.steel }]} numberOfLines={1}>
            {subLine}
          </Text>
        </View>
      ) : (
        <View
          accessible
          accessibilityRole="summary"
          accessibilityLabel={`${presence.friend.handle}. ${placeName ?? 'Location unnamed'}. ${subLine.toLowerCase()}.`}
          style={styles.hero}
        >
          <CryptidAvatar
            art={presence.friend.sigil || 'unknown'}
            color={signalColor}
            name={presence.friend.cryptidName ?? 'Unknown form'}
            style={styles.avatar}
          />
          <View style={styles.heroCopy}>
            <Text style={[styles.handle, { color: signalColor }]} numberOfLines={1}>
              {presence.friend.handle}
            </Text>
            <Text style={[styles.place, { color: chrome.ink }]} numberOfLines={1}>
              {placeName ?? '—'}
            </Text>
            <Text style={[styles.sub, { color: chrome.steel }]} numberOfLines={1}>
              {subLine}
            </Text>
          </View>
        </View>
      )}

      {expanded ? (
        <View style={styles.details}>
          {/*
            The two clocks, side by side, and only when they disagree. While someone is moving they
            are the same number and a second row would be noise; the moment they diverge, the gap
            IS the answer to "is she parked or is her phone dead". Omitted entirely for a sender
            that predates the envelope stamps — that would be a fallback, not a measurement.
          */}
          {presence.contactKnown &&
          presence.contactAgeMs !== null &&
          presence.positionAgeMs !== null &&
          presence.positionAgeMs - presence.contactAgeMs > 60_000 ? (
            <DetailRow
              label="LAST CONTACT"
              value={`${formatAge(presence.contactAgeMs)} ago`}
              theme={theme}
            />
          ) : null}
          {presence.fix ? (
            <SignalPathRow
              delivery={delivery}
              expanded={pathExpanded}
              onToggle={() => setPathExpanded((open) => !open)}
              theme={theme}
              via={presence.via}
            />
          ) : null}
          <DetailRow
            label="CONNECTION"
            value={pairingLabel(presence.friend.pairingMethod)}
            theme={theme}
          />
          {full ? (
            <>
              <DetailRow
                label="LAST FIX ACK"
                value={formatAckAge(ratchetActivity?.fix)}
                theme={theme}
              />
              <DetailRow
                label="LAST NULL ACK"
                value={formatAckAge(ratchetActivity?.null)}
                theme={theme}
              />
            </>
          ) : null}

          {/* States what it is rather than what pressing it would do: "PAUSE SHARING" made you
              read an action backwards to learn whether you were sharing at all. */}
          <Pressable
            accessibilityLabel="Sharing your location with them"
            accessibilityRole="switch"
            accessibilityState={{ checked: sharing, busy: sharingBusy }}
            disabled={sharingBusy}
            onPress={() => void handleShare()}
            style={({ pressed }) => [
              styles.sharing,
              {
                borderColor: chrome.islandBorder,
                opacity: sharingBusy ? 0.45 : pressed ? 0.62 : 1,
              },
            ]}
          >
            <Text style={[styles.sharingLabel, { color: chrome.steel }]}>SHARING WITH THEM</Text>
            <View style={styles.sharingState}>
              <Text style={[styles.sharingValue, { color: sharing ? chrome.green : chrome.steel }]}>
                {sharing ? 'ON' : 'OFF'}
              </Text>
              <View
                style={[
                  styles.track,
                  {
                    backgroundColor: sharing ? chrome.green : chrome.seg,
                    justifyContent: sharing ? 'flex-end' : 'flex-start',
                  },
                ]}
              >
                <View style={[styles.knob, { backgroundColor: chrome.panel }]} />
              </View>
            </View>
          </Pressable>

          {full ? (
            <View style={[styles.removeSection, { borderTopColor: chrome.islandBorder }]}>
              {confirmingRemove ? (
                <View accessibilityLiveRegion="polite" style={styles.removeConfirm}>
                  <Text style={[styles.confirmTitle, { color: chrome.ink }]}>
                    Remove {presence.friend.handle}?
                  </Text>
                  <Text style={[styles.confirmCopy, { color: chrome.steel }]}>
                    This removes them from this device and stops sharing your location with them.
                    You can pair again later.
                  </Text>
                  {removeError ? (
                    <Text
                      accessibilityRole="alert"
                      style={[styles.confirmCopy, { color: chrome.ink }]}
                    >
                      {removeError}
                    </Text>
                  ) : null}
                  <View style={styles.removeActions}>
                    <Pressable
                      accessibilityRole="button"
                      disabled={removing}
                      onPress={() => {
                        setConfirmingRemove(false);
                        setRemoveError(null);
                      }}
                      style={({ pressed }) => [
                        styles.removeChoice,
                        {
                          borderColor: chrome.islandBorder,
                          opacity: removing ? 0.45 : pressed ? 0.58 : 1,
                        },
                      ]}
                    >
                      <Text style={[styles.removeChoiceLabel, { color: chrome.ink }]}>
                        KEEP FRIEND
                      </Text>
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityState={{ busy: removing, disabled: removing }}
                      disabled={removing}
                      onPress={() => void handleRemove()}
                      style={({ pressed }) => [
                        styles.removeChoice,
                        { borderColor: chrome.ink, opacity: removing ? 0.45 : pressed ? 0.58 : 1 },
                      ]}
                    >
                      <Text style={[styles.removeChoiceLabel, { color: chrome.ink }]}>
                        {removing ? 'REMOVING…' : 'REMOVE'}
                      </Text>
                    </Pressable>
                  </View>
                </View>
              ) : (
                <Pressable
                  accessibilityHint="Stops sharing and removes this friend from your atlas"
                  accessibilityRole="button"
                  onPress={() => setConfirmingRemove(true)}
                  style={({ pressed }) => [styles.remove, { opacity: pressed ? 0.58 : 1 }]}
                >
                  <Text style={[styles.removeLabel, { color: chrome.steel }]}>REMOVE FRIEND</Text>
                </Pressable>
              )}
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function formatAckAge(ack: RatchetActivity['fix'] | undefined): string {
  if (!ack) return 'Never';
  const ageMs = Math.max(0, Date.now() - ack.receivedAt);
  const path = ack.source === 'live' ? 'live' : 'sync';
  if (ageMs < 60_000) return `Now · ${path}`;
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 60) return `${minutes} min ago · ${path}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago · ${path}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago · ${path}`;
}

/**
 * SIGNAL PATH, which answers two different questions and so is one row that opens.
 *
 * The badge says HOW the last hop happened; pressing says WHO performed it. It stays folded away
 * by default because the honest answer is often "a device you haven't paired with" — true, and not
 * what a glance at a friend is for.
 */
function SignalPathRow({
  delivery,
  expanded,
  onToggle,
  theme,
  via,
}: {
  delivery: ReturnType<typeof describeDelivery>;
  expanded: boolean;
  onToggle(): void;
  theme: CryptidTheme;
  via: FriendPresence['via'];
}) {
  const { chrome } = theme;

  return (
    <View>
      <Pressable
        accessibilityHint={
          expanded
            ? 'Hides which device delivered this fix'
            : 'Shows which device delivered this fix'
        }
        accessibilityLabel={`SIGNAL PATH: ${fixTransportDescription(via)}`}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={onToggle}
        style={({ pressed }) => [
          styles.row,
          { borderTopColor: chrome.islandBorder, opacity: pressed ? 0.58 : 1 },
        ]}
      >
        <Text style={[styles.rowLabel, { color: chrome.steel }]}>SIGNAL PATH</Text>
        <View style={styles.rowValueGroup}>
          <Text style={[styles.rowValue, { color: chrome.ink }]}>{fixTransportBadge(via)}</Text>
          <SymbolView
            name={
              expanded
                ? {
                    ios: 'chevron.down',
                    android: 'keyboard_arrow_down',
                    web: 'keyboard_arrow_down',
                  }
                : { ios: 'chevron.right', android: 'chevron_right', web: 'chevron_right' }
            }
            size={14}
            tintColor={chrome.steel}
          />
        </View>
      </Pressable>
      {expanded ? (
        <View
          accessibilityLiveRegion="polite"
          style={[styles.pathDetail, { borderLeftColor: chrome.islandBorder }]}
        >
          <Text style={[styles.pathHeadline, { color: chrome.ink }]}>{delivery.headline}</Text>
          {delivery.peerId ? (
            <Text style={[styles.pathId, { color: chrome.steel }]}>{delivery.peerId}</Text>
          ) : null}
          <Text style={[styles.pathCopy, { color: chrome.steel }]}>{delivery.detail}</Text>
        </View>
      ) : null}
    </View>
  );
}

function DetailRow({ label, value, theme }: { label: string; value: string; theme: CryptidTheme }) {
  const { chrome } = theme;

  return (
    <View
      accessible
      accessibilityLabel={`${label}: ${value}`}
      style={[styles.row, { borderTopColor: chrome.islandBorder }]}
    >
      <Text style={[styles.rowLabel, { color: chrome.steel }]}>{label}</Text>
      <Text style={[styles.rowValue, { color: chrome.ink }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  body: {
    paddingBottom: Spacing.two,
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.one,
  },
  back: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: Spacing.one,
    minHeight: 32,
  },
  backLabel: {
    fontFamily: 'IBMPlexMono_500Medium',
    fontSize: 10,
    letterSpacing: 1.2,
  },
  hero: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: Spacing.three,
    paddingBottom: Spacing.two,
    paddingTop: Spacing.one,
  },
  heroFull: {
    alignItems: 'center',
    gap: Spacing.one,
    paddingBottom: Spacing.three,
    paddingTop: Spacing.two,
  },
  avatar: {
    width: 72,
  },
  heroCopy: {
    flex: 1,
    minWidth: 0,
  },
  handle: {
    fontFamily: 'Rajdhani_700Bold',
    fontSize: 22,
    lineHeight: 25,
  },
  handleFull: {
    fontFamily: 'Rajdhani_700Bold',
    fontSize: 26,
    lineHeight: 29,
  },
  place: {
    fontFamily: 'Rajdhani_700Bold',
    fontSize: 30,
    lineHeight: 34,
  },
  placeFull: {
    fontFamily: 'Rajdhani_700Bold',
    fontSize: 34,
    lineHeight: 38,
  },
  sub: {
    fontFamily: 'IBMPlexMono_500Medium',
    fontSize: 9,
    letterSpacing: 1,
    paddingTop: 2,
  },
  details: {
    paddingTop: Spacing.two,
  },
  row: {
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: Spacing.three,
    justifyContent: 'space-between',
    minHeight: 40,
  },
  rowLabel: {
    fontFamily: 'IBMPlexMono_500Medium',
    fontSize: 10,
    letterSpacing: 1.2,
  },
  rowValueGroup: {
    alignItems: 'center',
    flexDirection: 'row',
    flexShrink: 1,
    gap: Spacing.two,
  },
  rowValue: {
    flexShrink: 1,
    fontFamily: 'Rajdhani_600SemiBold',
    fontSize: 16,
    lineHeight: 19,
    textAlign: 'right',
  },
  pathDetail: {
    borderLeftWidth: 2,
    gap: 2,
    marginBottom: Spacing.two,
    paddingLeft: Spacing.three,
  },
  pathHeadline: {
    fontFamily: 'Rajdhani_600SemiBold',
    fontSize: 15,
    lineHeight: 18,
  },
  pathId: {
    fontFamily: 'IBMPlexMono_400Regular',
    fontSize: 10,
  },
  pathCopy: {
    fontFamily: 'IBMPlexMono_400Regular',
    fontSize: 11,
    lineHeight: 15,
  },
  sharing: {
    alignItems: 'center',
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: Spacing.three,
    justifyContent: 'space-between',
    marginTop: Spacing.three,
    minHeight: 48,
    paddingHorizontal: Spacing.three,
  },
  sharingLabel: {
    fontFamily: 'IBMPlexMono_500Medium',
    fontSize: 10,
    letterSpacing: 1.2,
  },
  sharingState: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: Spacing.two,
  },
  sharingValue: {
    fontFamily: 'Rajdhani_700Bold',
    fontSize: 15,
    letterSpacing: 1,
  },
  track: {
    borderRadius: 10,
    flexDirection: 'row',
    height: 20,
    padding: 3,
    width: 34,
  },
  knob: {
    borderRadius: 7,
    height: 14,
    width: 14,
  },
  removeSection: {
    borderTopWidth: StyleSheet.hairlineWidth,
    marginTop: Spacing.three,
    paddingTop: Spacing.two,
  },
  remove: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
  },
  removeLabel: {
    fontFamily: 'Rajdhani_600SemiBold',
    fontSize: 15,
    letterSpacing: 1,
  },
  removeConfirm: {
    gap: Spacing.two,
    paddingBottom: Spacing.two,
  },
  confirmTitle: {
    fontFamily: 'Rajdhani_700Bold',
    fontSize: 18,
    lineHeight: 21,
  },
  confirmCopy: {
    fontFamily: 'IBMPlexMono_400Regular',
    fontSize: 11,
    lineHeight: 15,
  },
  removeActions: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  removeChoice: {
    alignItems: 'center',
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    flex: 1,
    justifyContent: 'center',
    minHeight: 44,
  },
  removeChoiceLabel: {
    fontFamily: 'Rajdhani_600SemiBold',
    fontSize: 14,
    letterSpacing: 1,
  },
});
