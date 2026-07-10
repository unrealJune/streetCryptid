import { Modal, Pressable, ScrollView, StyleSheet, useColorScheme, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { CryptidThemes, Spacing } from '@/constants/theme';
import { CryptidAvatar } from '@/features/account/components/cryptid-avatar';
import { useTheme } from '@/hooks/use-theme';
import { formatDistance, formatPresenceAge, type FriendPresence } from '../core/presence';

interface FriendProfileSheetProps {
  presence: FriendPresence | null;
  visible: boolean;
  sharing: boolean;
  onClose(): void;
  onToggleShare(on: boolean): Promise<void>;
  onViewMap(): void;
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
  onClose,
  onToggleShare,
  onViewMap,
}: FriendProfileSheetProps) {
  const theme = useTheme();
  const scheme = useColorScheme();
  const insets = useSafeAreaInsets();
  const green = CryptidThemes[scheme === 'dark' ? 'deepsea' : 'daybreak'].chrome.green;
  if (!presence) return null;

  const distance = formatDistance(presence.distanceM);
  const locationLine = distance ?? (presence.fix ? 'Location received' : 'Waiting for location');

  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
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
            onPress={onClose}
            style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
          >
            <ThemedText type="code" style={{ color: green }}>
              CLOSE
            </ThemedText>
          </Pressable>
        </View>

        <CryptidAvatar
          art={presence.friend.sigil || 'unknown'}
          color={green}
          name={presence.friend.cryptidName ?? 'Unknown form'}
          size="large"
          style={styles.heroArt}
        />

        <View style={styles.identity}>
          <ThemedText style={[styles.handle, { color: green }]}>
            {presence.friend.handle}
          </ThemedText>
          <ThemedText type="code" themeColor="textSecondary">
            {(presence.friend.cryptidName ?? 'Unknown form').toUpperCase()}
          </ThemedText>
        </View>

        <View style={[styles.details, { borderColor: theme.backgroundSelected }]}>
          <DetailRow label="LOCATION" value={locationLine} />
          <DetailRow label="LAST SIGNAL" value={formatPresenceAge(presence.ageMs)} />
          <DetailRow label="CONNECTION" value={pairingLabel(presence.friend.pairingMethod)} />
          <DetailRow label="YOUR LOCATION" value={sharing ? 'Shared' : 'Paused'} />
        </View>

        {presence.fix ? (
          <Pressable
            accessibilityRole="button"
            onPress={onViewMap}
            style={({ pressed }) => [
              styles.primaryAction,
              { backgroundColor: green, opacity: pressed ? 0.72 : 1 },
            ]}
          >
            <ThemedText type="smallBold" style={styles.onGreen}>
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
      </ScrollView>
    </Modal>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.detailRow}>
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
  primaryAction: {
    alignItems: 'center',
    borderRadius: Spacing.two,
    justifyContent: 'center',
    minHeight: 50,
    paddingHorizontal: Spacing.three,
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
  onGreen: {
    color: '#ffffff',
  },
});
