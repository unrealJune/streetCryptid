import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, useColorScheme, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { resolveSignalColor, signalColorInk } from '@/constants/signal-colors';
import { CryptidThemes, Spacing } from '@/constants/theme';
import { CryptidAvatar } from '@/features/account/components/cryptid-avatar';
import { useTheme } from '@/hooks/use-theme';
import { buildDeliverySummary } from '../core/delivery-summary';
import { fixTransportBadge, fixTransportDescription } from '../core/fix-transport';
import { formatDistance, formatPresenceAge, type FriendPresence } from '../core/presence';

interface FriendProfileSheetProps {
  presence: FriendPresence | null;
  visible: boolean;
  sharing: boolean;
  /** Whether we have an outstanding live request out to this friend (ARCHITECTURE §9c). */
  watching: boolean;
  /** When this friend's live window on US ends (ms since epoch), or null if they are not watching. */
  watchedUntil: number | null;
  onClose(): void;
  onToggleShare(on: boolean): Promise<void>;
  /** Ask this friend to switch to the real-time cadence, or withdraw the ask. */
  onToggleWatch(on: boolean): Promise<void>;
  /** End this friend's live window on us immediately. */
  onStopWatcher(): Promise<void>;
  onViewMap(): void;
  onRemove(): Promise<void>;
}

/**
 * " for another 12 min" — or "" once the window has effectively lapsed, so the sheet never claims a
 * negative or zero remaining time while the next poll catches up.
 */
function formatLiveRemaining(untilMs: number, now: number = Date.now()): string {
  const minutes = Math.round((untilMs - now) / 60_000);
  return minutes >= 1 ? ` for another ${minutes} min` : '';
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
  watching,
  watchedUntil,
  onClose,
  onToggleShare,
  onToggleWatch,
  onStopWatcher,
  onViewMap,
  onRemove,
}: FriendProfileSheetProps) {
  const theme = useTheme();
  const scheme = useColorScheme();
  const insets = useSafeAreaInsets();
  const [showingSignalPath, setShowingSignalPath] = useState(false);
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

  function closeSheet(): void {
    setShowingSignalPath(false);
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
            <DetailRow
              accessibilityLabel={`${fixTransportDescription(presence.via)}. Double tap for delivery detail.`}
              label="SIGNAL PATH"
              value={fixTransportBadge(presence.via)}
              // Tap as well as long-press: a long-press with no affordance is undiscoverable, and
              // the dotted underline below is the only hint the row does anything.
              onPress={() => setShowingSignalPath(true)}
              underlineValue
            />
          ) : null}
          <DetailRow label="CONNECTION" value={pairingLabel(presence.friend.pairingMethod)} />
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

        {/* Live mode (ARCHITECTURE §9c). Asking is one tap and needs no permission from them beyond
            the sharing they already granted — but it is NOT instant: they pick it up on their next
            poll, so the copy promises "shortly", never "now". */}
        <Pressable
          accessibilityRole="button"
          onPress={() => void onToggleWatch(!watching)}
          style={({ pressed }) => [
            styles.secondaryAction,
            { borderColor: theme.backgroundSelected, opacity: pressed ? 0.58 : 1 },
          ]}
        >
          <ThemedText type="smallBold">
            {watching ? 'Stop asking for live location' : 'Ask to see live location'}
          </ThemedText>
        </Pressable>
        {watching ? (
          <ThemedText type="small" themeColor="textSecondary" style={styles.liveHint}>
            {presence.friend.handle} will start sharing in real time shortly, for a short window.
          </ThemedText>
        ) : null}

        {watchedUntil !== null ? (
          <View accessibilityLiveRegion="polite" style={styles.liveWatcher}>
            <ThemedText type="small" themeColor="textSecondary">
              {presence.friend.handle} is seeing your location in real time
              {formatLiveRemaining(watchedUntil)}.
            </ThemedText>
            <Pressable
              accessibilityRole="button"
              onPress={() => void onStopWatcher()}
              style={({ pressed }) => [
                styles.secondaryAction,
                { borderColor: theme.backgroundSelected, opacity: pressed ? 0.58 : 1 },
              ]}
            >
              <ThemedText type="smallBold">Stop live location</ThemedText>
            </Pressable>
          </View>
        ) : null}

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
      {showingSignalPath ? (
        <SignalPathDetail presence={presence} onClose={() => setShowingSignalPath(false)} />
      ) : null}
    </Modal>
  );
}

function DetailRow({
  accessibilityLabel,
  label,
  value,
  onPress,
  underlineValue,
}: {
  accessibilityLabel?: string;
  label: string;
  value: string;
  /** Makes the row interactive. Bound to both tap and long-press — see the call site. */
  onPress?: () => void;
  /** Dotted underline marking the value as openable; the row's only affordance. */
  underlineValue?: boolean;
}) {
  const valueText = (
    <ThemedText
      type="smallBold"
      style={[styles.detailValue, underlineValue ? styles.detailValueOpenable : null]}
    >
      {value}
    </ThemedText>
  );
  const labelText = (
    <ThemedText type="code" themeColor="textSecondary">
      {label}
    </ThemedText>
  );

  if (onPress) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={
          accessibilityLabel === undefined ? undefined : `${label}: ${accessibilityLabel}`
        }
        onPress={onPress}
        onLongPress={onPress}
        style={({ pressed }) => [styles.detailRow, { opacity: pressed ? 0.6 : 1 }]}
      >
        {labelText}
        {valueText}
      </Pressable>
    );
  }

  return (
    <View
      accessible={accessibilityLabel !== undefined}
      accessibilityLabel={
        accessibilityLabel === undefined ? undefined : `${label}: ${accessibilityLabel}`
      }
      style={styles.detailRow}
    >
      {labelText}
      {valueText}
    </View>
  );
}

/**
 * What the one-word badge hides: which peer handed this fix over, and what paths were open to it.
 *
 * Deliberately ends on {@link DeliverySummary.note}. Everything above it describes ONE HOP, and a
 * list of addresses under a heading like "signal path" invites reading it as a traceroute — which
 * it is not, and which the protocol cannot supply.
 */
function SignalPathDetail({
  presence,
  onClose,
}: {
  presence: FriendPresence;
  onClose: () => void;
}) {
  const theme = useTheme();
  const summary = buildDeliverySummary(presence.via, presence.delivery, (id) =>
    id === presence.friend.endpointId ? presence.friend.handle : undefined
  );

  return (
    <Modal animationType="fade" transparent visible onRequestClose={onClose}>
      <Pressable style={styles.tooltipBackdrop} onPress={onClose}>
        {/* Swallows taps so pressing inside the card does not dismiss it. */}
        <Pressable
          style={[
            styles.tooltipCard,
            { backgroundColor: theme.background, borderColor: theme.backgroundSelected },
          ]}
          onPress={() => {}}
        >
          <View style={styles.tooltipHeader}>
            <ThemedText type="code" themeColor="textSecondary">
              SIGNAL PATH
            </ThemedText>
            <ThemedText type="smallBold">{summary.badge}</ThemedText>
          </View>
          <ThemedText type="small" themeColor="textSecondary">
            {summary.description}
          </ThemedText>

          {summary.rows.map((row) => (
            <View key={row.label} style={styles.tooltipRow}>
              <ThemedText type="code" themeColor="textSecondary">
                {row.label}
              </ThemedText>
              <ThemedText type="small" style={styles.detailValue}>
                {row.value}
              </ThemedText>
            </View>
          ))}

          {summary.paths.length > 0 ? (
            <View style={styles.tooltipPaths}>
              <ThemedText type="code" themeColor="textSecondary">
                PATHS OPEN
              </ThemedText>
              {summary.paths.map((path) => (
                <View key={`${path.kind}:${path.address}`} style={styles.tooltipRow}>
                  <ThemedText type="code" themeColor={path.active ? 'text' : 'textSecondary'}>
                    {path.active ? `${path.kind} ·` : `${path.kind} (idle) ·`}
                  </ThemedText>
                  <ThemedText type="small" style={styles.detailValue}>
                    {path.address}
                  </ThemedText>
                </View>
              ))}
            </View>
          ) : null}

          <ThemedText type="small" themeColor="textSecondary" style={styles.tooltipNote}>
            {summary.note}
          </ThemedText>
        </Pressable>
      </Pressable>
    </Modal>
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
  detailValueOpenable: {
    textDecorationLine: 'underline',
    textDecorationStyle: 'dotted',
  },
  tooltipBackdrop: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    padding: Spacing.four,
  },
  tooltipCard: {
    width: '100%',
    maxWidth: 420,
    borderWidth: 1,
    borderRadius: Spacing.two,
    padding: Spacing.four,
    gap: Spacing.two,
  },
  tooltipHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  tooltipRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  tooltipPaths: {
    gap: Spacing.one,
  },
  tooltipNote: {
    marginTop: Spacing.one,
  },
  detailValue: {
    flex: 1,
    textAlign: 'right',
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
