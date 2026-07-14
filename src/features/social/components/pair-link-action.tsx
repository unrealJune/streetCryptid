import { useState } from 'react';
import { Pressable, Share, StyleSheet, TextInput, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import type { PairingSnapshot } from '../net/location-sharing';

interface PairLinkActionProps {
  pairing: PairingSnapshot;
  accent: string;
  errorAccent: string;
  onCreateInvite(): Promise<string | undefined>;
  onPairInput(input: string): Promise<void>;
  onReject(sessionId: string): Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function PairLinkAction({
  pairing,
  accent,
  errorAccent,
  onCreateInvite,
  onPairInput,
  onReject,
}: PairLinkActionProps) {
  const theme = useTheme();
  const [sharing, setSharing] = useState(false);
  const [pairingInput, setPairingInput] = useState('');
  const [pairingInputError, setPairingInputError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const remoteRequests = pairing.pendingRequests.filter((request) => !request.nearby);

  const shareInvite = async (): Promise<void> => {
    if (sharing) return;
    setSharing(true);
    try {
      const link = await onCreateInvite();
      if (link) {
        await Share.share({
          message: `Find me on streetCryptid:\n${link}`,
          url: link,
        });
      }
    } finally {
      setSharing(false);
    }
  };

  const submitPairInput = async (): Promise<void> => {
    const value = pairingInput.trim();
    if (!value) {
      setPairingInputError('Paste a streetCryptid sharing link or enter a pairing code.');
      return;
    }
    setSubmitting(true);
    setPairingInputError(null);
    try {
      await onPairInput(value);
      setPairingInput('');
    } catch (error) {
      setPairingInputError(errorMessage(error));
    } finally {
      setSubmitting(false);
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
            <ThemedText type="smallBold">Preparing a visual check</ThemedText>
            <ThemedText type="small" themeColor="textSecondary">
              Keep both phones open. Pairing cannot finish until you compare an ASCII figure.
            </ThemedText>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Cancel pair request"
            onPress={() => void onReject(request.sessionId)}
            style={({ pressed }) => [
              styles.smallButton,
              { borderColor: theme.backgroundSelected, opacity: pressed ? 0.55 : 1 },
            ]}
          >
            <ThemedText type="code" themeColor="textSecondary">
              CANCEL
            </ThemedText>
          </Pressable>
        </View>
      ))}

      <View style={[styles.inputSection, { borderBottomColor: theme.backgroundSelected }]}>
        <View style={styles.inputCopy}>
          <ThemedText type="smallBold">Pairing link or code</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            Paste a shared link, raw token, or 16-character code.
          </ThemedText>
        </View>
        <View style={styles.inputRow}>
          <TextInput
            accessibilityLabel="Pairing link or code"
            autoCapitalize="none"
            autoCorrect={false}
            editable={pairing.available && !submitting}
            onChangeText={(value) => {
              setPairingInput(value);
              if (pairingInputError) setPairingInputError(null);
            }}
            onSubmitEditing={() => void submitPairInput()}
            placeholder="streetcryptid:///social?token=…"
            placeholderTextColor={theme.textSecondary}
            selectionColor={accent}
            style={[
              styles.input,
              {
                borderColor: pairingInputError ? errorAccent : theme.backgroundSelected,
                color: theme.text,
              },
            ]}
            value={pairingInput}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Pair using this link or code"
            disabled={!pairing.available || submitting}
            onPress={() => void submitPairInput()}
            style={({ pressed }) => [
              styles.inputButton,
              {
                borderColor: accent,
                opacity: !pairing.available || submitting ? 0.38 : pressed ? 0.62 : 1,
              },
            ]}
          >
            <ThemedText type="code" style={{ color: accent }}>
              {submitting ? 'PAIRING' : 'PAIR'}
            </ThemedText>
          </Pressable>
        </View>
        {pairingInputError ? (
          <ThemedText accessibilityLiveRegion="polite" type="small" style={{ color: errorAccent }}>
            {pairingInputError}
          </ThemedText>
        ) : null}
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Share a one-time pairing link"
        disabled={!pairing.available || sharing}
        onPress={() => void shareInvite()}
        style={({ pressed }) => [
          styles.shareRow,
          {
            opacity: !pairing.available || sharing ? 0.38 : pressed ? 0.62 : 1,
          },
        ]}
      >
        <View style={styles.shareCopy}>
          <ThemedText type="smallBold">Share a pairing link</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            Compare its ASCII figure over a trusted call
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
  inputSection: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: Spacing.two,
    paddingVertical: Spacing.three,
  },
  inputCopy: {
    gap: Spacing.one,
  },
  inputRow: {
    alignItems: 'stretch',
    flexDirection: 'row',
    gap: Spacing.two,
  },
  input: {
    borderRadius: Spacing.two,
    borderWidth: StyleSheet.hairlineWidth,
    flex: 1,
    fontFamily: 'IBMPlexMono_400Regular',
    fontSize: 14,
    minHeight: 48,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
  },
  inputButton: {
    alignItems: 'center',
    borderRadius: Spacing.two,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 48,
    minWidth: 72,
    paddingHorizontal: Spacing.three,
  },
  smallButton: {
    alignItems: 'center',
    borderRadius: Spacing.two,
    borderWidth: StyleSheet.hairlineWidth,
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: Spacing.two,
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
