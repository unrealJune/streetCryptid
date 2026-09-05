import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, useColorScheme, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { resolveSignalColor, signalColorInk } from '@/constants/signal-colors';
import { CryptidThemes, Spacing } from '@/constants/theme';
import { CryptidAvatar } from '@/features/account/components/cryptid-avatar';
import { useTheme } from '@/hooks/use-theme';
import {
  describeDelivery,
  fixTransportBadge,
  fixTransportDescription,
  type DeliveryProvenance,
} from '../core/fix-transport';
import { formatDistance, formatPresenceAge, type FriendPresence } from '../core/presence';
import type { Friend, RatchetActivity } from '../core/types';

interface FriendProfileSheetProps {
  presence: FriendPresence | null;
  visible: boolean;
  sharing: boolean;
  ratchetActivity?: RatchetActivity;
  /**
   * The pool, so a fix forwarded by a mutual can be named. Anyone absent from it stays unnamed —
   * the author's swarm is not this device's address book, and a stranger's endpoint id is shown
   * as an id rather than dressed up as an identity.
   */
  peers?: readonly Friend[];
  /** The trail stash's endpoint id, when known, so a stashed hop reads as the stash. */
  stashEndpointId?: string | null;
  onClose(): void;
  onToggleShare(on: boolean): Promise<void>;
  onViewMap(): void;
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

export function FriendProfileSheet({
  presence,
  visible,
  sharing,
  ratchetActivity,
  peers,
  stashEndpointId,
  onClose,
  onToggleShare,
  onViewMap,
  onRemove,
}: FriendProfileSheetProps) {
  const theme = useTheme();
  const scheme = useColorScheme();
  const insets = useSafeAreaInsets();
  const [pathExpanded, setPathExpanded] = useState(false);
  const [confirmingEndpoint, setConfirmingEndpoint] = useState<string | null>(null);
  const [removingEndpoint, setRemovingEndpoint] = useState<string | null>(null);
  const [removeFailure, setRemoveFailure] = useState<{
    endpointId: string;
    message: string;
  } | null>(null);
  const fallback = CryptidThemes[scheme === 'dark' ? 'deepsea' : 'daybreak'].chrome.green;

  if (!presence) return null;

  const signalColor = resolveSignalColor(presence.friend.color, fallback);
  const endpointId = presence.friend.endpointId;
  const confirmingRemove = confirmingEndpoint === endpointId;
  const removing = removingEndpoint === endpointId;
  const removeError = removeFailure?.endpointId === endpointId ? removeFailure.message : null;
  const distance = formatDistance(presence.distanceM);
  const locationLine = distance ?? (presence.fix ? 'Location received' : 'Waiting for location');
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

  function closeSheet(): void {
    setPathExpanded(false);
    setConfirmingEndpoint(null);
    setRemovingEndpoint(null);
    setRemoveFailure(null);
    onClose();
  }

  async function handleRemove(): Promise<void> {
    setRemovingEndpoint(endpointId);
    setRemoveFailure(null);
    try {
      await onRemove();
      closeSheet();
    } catch {
      setRemoveFailure({
        endpointId,
        message: 'Could not remove this friend. Try again.',
      });
    } finally {
      setRemovingEndpoint(null);
    }
  }

  return (
    <Modal
      animationType="slide"
      onRequestClose={closeSheet}
      presentationStyle="pageSheet"
      visible={visible}
    >
      <ScrollView
        style={{ backgroundColor: theme.background }}
        contentContainerStyle={[
          styles.content,
          { paddingTop: insets.top + Spacing.three, paddingBottom: insets.bottom + Spacing.five },
        ]}
      >
        <View style={styles.topBar}>
          <ThemedText type="code" themeColor="textSecondary">
            CRYPTID PROFILE
          </ThemedText>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close friend profile"
            hitSlop={10}
            onPress={closeSheet}
            style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
          >
            <ThemedText type="code">CLOSE</ThemedText>
          </Pressable>
        </View>

        <CryptidAvatar
          art={presence.friend.sigil || 'unknown'}
          color={signalColor}
          name={presence.friend.cryptidName ?? 'Unknown form'}
          size="large"
          style={styles.heroArt}
        />

        <View style={styles.identity}>
          <ThemedText style={[styles.handle, { color: signalColor }]}>
            {presence.friend.handle}
          </ThemedText>
          <ThemedText type="code" themeColor="textSecondary">
            {(presence.friend.cryptidName ?? 'Unknown form').toUpperCase()}
          </ThemedText>
        </View>

        <View style={[styles.details, { borderColor: theme.backgroundSelected }]}>
          <DetailRow label="LOCATION" value={locationLine} />
          <DetailRow label="LAST SIGNAL" value={formatPresenceAge(presence.ageMs)} />
          {presence.fix ? (
            <SignalPathRow
              delivery={delivery}
              expanded={pathExpanded}
              onToggle={() => setPathExpanded((open) => !open)}
              theme={theme}
              via={presence.via}
            />
          ) : null}
          <DetailRow label="CONNECTION" value={pairingLabel(presence.friend.pairingMethod)} />
          <DetailRow label="LAST FIX ACK" value={formatAckAge(ratchetActivity?.fix)} />
          <DetailRow label="LAST NULL ACK" value={formatAckAge(ratchetActivity?.null)} />
          <DetailRow label="YOUR LOCATION" value={sharing ? 'Shared' : 'Paused'} />
        </View>

        {presence.fix ? (
          <Pressable
            accessibilityRole="button"
            onPress={onViewMap}
            style={({ pressed }) => [
              styles.primaryAction,
              { backgroundColor: signalColor, opacity: pressed ? 0.72 : 1 },
            ]}
          >
            <ThemedText type="smallBold" style={{ color: signalColorInk(signalColor) }}>
              View on map
            </ThemedText>
          </Pressable>
        ) : null}

        <Pressable
          accessibilityRole="button"
          onPress={() => void onToggleShare(!sharing)}
          style={({ pressed }) => [
            styles.secondaryAction,
            { borderColor: theme.backgroundSelected, opacity: pressed ? 0.58 : 1 },
          ]}
        >
          <ThemedText type="smallBold">
            {sharing ? 'Pause sharing my location' : 'Share my location'}
          </ThemedText>
        </Pressable>

        <View style={[styles.removeSection, { borderTopColor: theme.backgroundSelected }]}>
          {confirmingRemove ? (
            <View accessibilityLiveRegion="polite" style={styles.removeConfirm}>
              <ThemedText type="smallBold">Remove {presence.friend.handle}?</ThemedText>
              <ThemedText type="small" themeColor="textSecondary">
                This removes them from this device and stops sharing your location with them. You
                can pair again later.
              </ThemedText>
              {removeError ? (
                <ThemedText type="small" accessibilityRole="alert">
                  {removeError}
                </ThemedText>
              ) : null}
              <View style={styles.removeActions}>
                <Pressable
                  accessibilityRole="button"
                  disabled={removing}
                  onPress={() => {
                    setConfirmingEndpoint(null);
                    setRemoveFailure(null);
                  }}
                  style={({ pressed }) => [
                    styles.removeChoice,
                    {
                      borderColor: theme.backgroundSelected,
                      opacity: removing ? 0.45 : pressed ? 0.58 : 1,
                    },
                  ]}
                >
                  <ThemedText type="smallBold">Keep friend</ThemedText>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ busy: removing, disabled: removing }}
                  disabled={removing}
                  onPress={() => void handleRemove()}
                  style={({ pressed }) => [
                    styles.removeChoice,
                    {
                      borderColor: theme.text,
                      opacity: removing ? 0.45 : pressed ? 0.58 : 1,
                    },
                  ]}
                >
                  <ThemedText type="smallBold">{removing ? 'Removing…' : 'Remove'}</ThemedText>
                </Pressable>
              </View>
            </View>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityHint="Stops sharing and removes this friend from your atlas"
              onPress={() => setConfirmingEndpoint(endpointId)}
              style={({ pressed }) => [styles.removeAction, { opacity: pressed ? 0.58 : 1 }]}
            >
              <ThemedText type="smallBold" themeColor="textSecondary">
                Remove friend
              </ThemedText>
            </Pressable>
          )}
        </View>
      </ScrollView>
    </Modal>
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
 * The badge says HOW the last hop happened; pressing says WHO performed it. The second question
 * only became askable when the delivering endpoint started being recorded, and it stays folded
 * away by default because the honest answer is often "a device you haven't paired with" — true,
 * and not what a glance at a friend's profile is for.
 */
function SignalPathRow({
  delivery,
  expanded,
  onToggle,
  theme,
  via,
}: {
  delivery: DeliveryProvenance;
  expanded: boolean;
  onToggle(): void;
  theme: ReturnType<typeof useTheme>;
  via: FriendPresence['via'];
}) {
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`SIGNAL PATH: ${fixTransportDescription(via)}`}
        accessibilityHint={
          expanded
            ? 'Hides which device delivered this fix'
            : 'Shows which device delivered this fix'
        }
        onPress={onToggle}
        style={({ pressed }) => [styles.detailRow, { opacity: pressed ? 0.58 : 1 }]}
      >
        <ThemedText type="code" themeColor="textSecondary">
          SIGNAL PATH
        </ThemedText>
        <View style={styles.pathValue}>
          <ThemedText type="smallBold">{fixTransportBadge(via)}</ThemedText>
          <ThemedText type="code" themeColor="textSecondary">
            {expanded ? '⌄' : '›'}
          </ThemedText>
        </View>
      </Pressable>
      {expanded ? (
        <View
          accessibilityLiveRegion="polite"
          style={[styles.pathDetail, { borderLeftColor: theme.backgroundSelected }]}
        >
          <ThemedText type="smallBold">{delivery.headline}</ThemedText>
          {delivery.peerId ? (
            <ThemedText type="code" themeColor="textSecondary">
              {delivery.peerId}
            </ThemedText>
          ) : null}
          <ThemedText type="small" themeColor="textSecondary">
            {delivery.detail}
          </ThemedText>
        </View>
      ) : null}
    </View>
  );
}

function DetailRow({
  accessibilityLabel,
  label,
  value,
}: {
  accessibilityLabel?: string;
  label: string;
  value: string;
}) {
  return (
    <View
      accessible={accessibilityLabel !== undefined}
      accessibilityLabel={
        accessibilityLabel === undefined ? undefined : `${label}: ${accessibilityLabel}`
      }
      style={styles.detailRow}
    >
      <ThemedText type="code" themeColor="textSecondary">
        {label}
      </ThemedText>
      <ThemedText type="smallBold" style={styles.detailValue}>
        {value}
      </ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: Spacing.four,
  },
  topBar: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  heroArt: {
    minHeight: 190,
    marginTop: Spacing.four,
  },
  identity: {
    alignItems: 'center',
    gap: Spacing.one,
    marginBottom: Spacing.four,
  },
  handle: {
    fontFamily: 'Rajdhani_700Bold',
    fontSize: 34,
    fontWeight: '700',
    // Without this Rajdhani's ascenders clip — same fix as the discovery popup.
    lineHeight: 38,
  },
  details: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderTopWidth: StyleSheet.hairlineWidth,
    marginBottom: Spacing.four,
  },
  detailRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: Spacing.three,
    justifyContent: 'space-between',
    minHeight: 52,
  },
  detailValue: {
    flex: 1,
    textAlign: 'right',
  },
  pathValue: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: Spacing.two,
  },
  pathDetail: {
    borderLeftWidth: StyleSheet.hairlineWidth,
    gap: Spacing.one,
    marginBottom: Spacing.three,
    paddingLeft: Spacing.three,
  },
  primaryAction: {
    alignItems: 'center',
    borderRadius: Spacing.two,
    justifyContent: 'center',
    minHeight: 50,
    paddingHorizontal: Spacing.three,
  },
  liveHint: {
    marginTop: Spacing.one,
    paddingHorizontal: Spacing.one,
  },
  liveWatcher: {
    gap: Spacing.one,
    marginTop: Spacing.two,
  },
  secondaryAction: {
    alignItems: 'center',
    borderRadius: Spacing.two,
    borderWidth: StyleSheet.hairlineWidth,
    justifyContent: 'center',
    marginTop: Spacing.two,
    minHeight: 50,
    paddingHorizontal: Spacing.three,
  },
  removeSection: {
    borderTopWidth: StyleSheet.hairlineWidth,
    marginTop: Spacing.four,
    paddingTop: Spacing.three,
  },
  removeAction: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
  },
  removeConfirm: {
    gap: Spacing.two,
  },
  removeActions: {
    flexDirection: 'row',
    gap: Spacing.two,
    marginTop: Spacing.one,
  },
  removeChoice: {
    alignItems: 'center',
    borderRadius: Spacing.two,
    borderWidth: StyleSheet.hairlineWidth,
    flex: 1,
    justifyContent: 'center',
    minHeight: 48,
    paddingHorizontal: Spacing.two,
  },
});
