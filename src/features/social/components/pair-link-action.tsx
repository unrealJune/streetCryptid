import { useState } from 'react';
import { Pressable, Share, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import type { PairingSnapshot } from '../net/location-sharing';

interface PairLinkActionProps {
  pairing: PairingSnapshot;
  accent: string;
  onCreateInvite(): Promise<string | undefined>;
  onRespond(sessionId: string, accept: boolean): Promise<void>;
}

export function PairLinkAction({
  pairing,
  accent,
  onCreateInvite,
  onRespond,
}: PairLinkActionProps) {
  const theme = useTheme();
  const [working, setWorking] = useState(false);
  const remoteRequests = pairing.pendingRequests.filter((request) => !request.nearby);

  const shareInvite = async (): Promise<void> => {
    if (working) return;
    setWorking(true);
    try {
      const link = await onCreateInvite();
      if (link) {
        await Share.share({
          message: `Find me on streetCryptid:\n${link}`,
          url: link,
        });
      }
    } finally {
      setWorking(false);
    }
  };

  return (
    <View style={[styles.container, { borderColor: theme.backgroundSelected }]}>
      {remoteRequests.map((request) => (
        <View
          key={request.sessionId}
          style={[styles.request, { borderBottomColor: theme.backgroundSelected }]}
        >
          <View style={styles.requestCopy}>
            <ThemedText type="smallBold">Pair request</ThemedText>
            <ThemedText type="small" themeColor="textSecondary">
              A shared link was opened on another phone.
            </ThemedText>
          </View>
          <View style={styles.requestActions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Decline pair request"
              onPress={() => void onRespond(request.sessionId, false)}
              style={({ pressed }) => [
                styles.smallButton,
                { borderColor: theme.backgroundSelected, opacity: pressed ? 0.55 : 1 },
              ]}
            >
              <ThemedText type="code" themeColor="textSecondary">
                DECLINE
              </ThemedText>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Accept pair request"
              onPress={() => void onRespond(request.sessionId, true)}
              style={({ pressed }) => [
                styles.smallButton,
                { backgroundColor: accent, opacity: pressed ? 0.72 : 1 },
              ]}
            >
              <ThemedText type="code" style={styles.onAccent}>
                ACCEPT
              </ThemedText>
            </Pressable>
          </View>
        </View>
      ))}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Share a one-time pairing link"
        disabled={!pairing.available || working}
        onPress={() => void shareInvite()}
        style={({ pressed }) => [
          styles.shareRow,
          {
            opacity: !pairing.available || working ? 0.38 : pressed ? 0.62 : 1,
          },
        ]}
      >
        <View style={styles.shareCopy}>
          <ThemedText type="smallBold">Share a pairing link</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            One-time link for a friend who is not nearby
          </ThemedText>
        </View>
        <ThemedText type="code" style={{ color: accent }}>
          SHARE
        </ThemedText>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  request: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: Spacing.two,
    paddingVertical: Spacing.three,
  },
  requestCopy: {
    gap: Spacing.one,
  },
  requestActions: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  smallButton: {
    alignItems: 'center',
    borderRadius: Spacing.two,
    borderWidth: StyleSheet.hairlineWidth,
    flex: 1,
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: Spacing.two,
  },
  onAccent: {
    color: '#07131f',
    fontWeight: '700',
  },
  shareRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: Spacing.three,
    justifyContent: 'space-between',
    minHeight: 64,
    paddingVertical: Spacing.two,
  },
  shareCopy: {
    flex: 1,
    gap: Spacing.one,
  },
});
