import * as Haptics from 'expo-haptics';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Fonts, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { isPairingFigureIndex, pairingFigure, type PairingFigure } from '../core/pairing-figures';
import type { PairingVerification } from '../net/location-sharing';

interface PairingVerificationPanelProps {
  accent: string;
  verifications: readonly PairingVerification[];
  onChoose(sessionId: string, figureIndex: number): Promise<void>;
  onConfirm(sessionId: string, matched: boolean): Promise<void>;
  onCancel(sessionId: string): Promise<void>;
}

function secondsRemaining(deadlineMs: number, nowMs: number): number {
  return Math.max(0, Math.ceil((deadlineMs - nowMs) / 1000));
}

function formatRemaining(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

function isValidPickerChallenge(verification: PairingVerification): boolean {
  return (
    verification.optionIndices.length === 4 &&
    new Set(verification.optionIndices).size === 4 &&
    verification.optionIndices.includes(verification.targetIndex) &&
    verification.optionIndices.every(isPairingFigureIndex)
  );
}

async function selectionHaptic(): Promise<void> {
  try {
    await Haptics.selectionAsync();
  } catch {
    // The visual verification remains authoritative when haptics are unavailable.
  }
}

export function PairingVerificationPanel({
  accent,
  verifications,
  onChoose,
  onConfirm,
  onCancel,
}: PairingVerificationPanelProps) {
  const theme = useTheme();
  const verification = useMemo(
    () => [...verifications].sort((a, b) => a.deadlineMs - b.deadlineMs)[0] ?? null,
    [verifications]
  );
  const verificationSessionId = verification?.sessionId ?? null;
  const [nowMs, setNowMs] = useState(0);
  const [workingSessionId, setWorkingSessionId] = useState<string | null>(null);

  useEffect(() => {
    if (!verificationSessionId) return;
    const updateClock = () => setNowMs(Date.now());
    const initial = setTimeout(updateClock, 0);
    const timer = setInterval(updateClock, 1000);
    return () => {
      clearTimeout(initial);
      clearInterval(timer);
    };
  }, [verificationSessionId]);

  if (!verification) return null;

  const remaining = nowMs === 0 ? null : secondsRemaining(verification.deadlineMs, nowMs);
  const working = workingSessionId === verification.sessionId;
  const expired = remaining === 0;
  const targetValid = isPairingFigureIndex(verification.targetIndex);
  const pickerValid = verification.role !== 'picker' || isValidPickerChallenge(verification);
  const challengeValid = targetValid && pickerValid;
  const target = targetValid ? pairingFigure(verification.targetIndex) : null;
  const options = pickerValid
    ? verification.optionIndices.map((index) => pairingFigure(index))
    : [];
  const disabled = working || expired || verification.localConfirmed;

  const run = async (action: () => Promise<void>): Promise<void> => {
    if (disabled) return;
    setWorkingSessionId(verification.sessionId);
    await selectionHaptic();
    try {
      await action();
    } finally {
      setWorkingSessionId((current) => (current === verification.sessionId ? null : current));
    }
  };

  return (
    <View
      accessibilityLabel="Pairing identity verification"
      style={[
        styles.container,
        {
          backgroundColor: theme.backgroundElement,
          borderColor: challengeValid ? accent : theme.textSecondary,
        },
      ]}
    >
      <View style={styles.headingRow}>
        <View style={styles.headingCopy}>
          <ThemedText type="smallBold">
            {verification.localConfirmed
              ? 'Waiting for the other phone'
              : verification.role === 'picker'
                ? 'Which figure is on their phone?'
                : 'Show them this figure'}
          </ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            {verification.localConfirmed
              ? 'Keep both phones nearby. Pairing completes only after both people confirm.'
              : verification.nearby
                ? 'Compare the screens together before either person confirms.'
                : 'Compare over a trusted voice or video call before confirming.'}
          </ThemedText>
        </View>
        <ThemedText
          accessibilityLabel={
            remaining === null
              ? 'Verification time remaining is loading'
              : `Verification expires in ${remaining} seconds`
          }
          type="code"
          style={{ color: expired ? theme.textSecondary : accent }}
        >
          {expired ? 'EXPIRED' : remaining === null ? '--:--' : formatRemaining(remaining)}
        </ThemedText>
      </View>

      {!challengeValid ? (
        <View style={styles.invalid}>
          <ThemedText type="smallBold">This verification signal is invalid.</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            Stop this attempt and start a fresh pairing. Friendship and location access were not
            granted.
          </ThemedText>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Stop invalid pairing attempt"
            disabled={working}
            onPress={() => void run(() => onCancel(verification.sessionId))}
            style={({ pressed }) => [
              styles.outlineAction,
              { borderColor: theme.textSecondary, opacity: working || pressed ? 0.55 : 1 },
            ]}
          >
            <ThemedText type="code" themeColor="textSecondary">
              STOP PAIRING
            </ThemedText>
          </Pressable>
        </View>
      ) : verification.localConfirmed ? (
        target ? (
          <PairingFigureView accent={accent} figure={target} large />
        ) : null
      ) : verification.role === 'picker' ? (
        <View accessibilityRole="radiogroup" style={styles.options}>
          {options.map((figure) => (
            <Pressable
              key={figure.index}
              accessibilityRole="radio"
              accessibilityLabel={`Pairing figure: ${figure.name}`}
              accessibilityState={{ checked: false, disabled }}
              disabled={disabled}
              onPress={() => void run(() => onChoose(verification.sessionId, figure.index))}
              style={({ pressed }) => [
                styles.option,
                {
                  borderColor: theme.backgroundSelected,
                  opacity: disabled ? 0.42 : pressed ? 0.62 : 1,
                },
              ]}
            >
              <PairingFigureView accent={accent} figure={figure} />
            </Pressable>
          ))}
        </View>
      ) : (
        <>
          {target ? <PairingFigureView accent={accent} figure={target} large /> : null}
          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="The other person picked a different figure"
              disabled={disabled}
              onPress={() => void run(() => onConfirm(verification.sessionId, false))}
              style={({ pressed }) => [
                styles.action,
                styles.outlineAction,
                {
                  borderColor: theme.textSecondary,
                  opacity: disabled ? 0.42 : pressed ? 0.55 : 1,
                },
              ]}
            >
              <ThemedText type="code" themeColor="textSecondary" style={styles.actionLabel}>
                DIFFERENT
              </ThemedText>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="The other person picked this figure"
              disabled={disabled}
              onPress={() => void run(() => onConfirm(verification.sessionId, true))}
              style={({ pressed }) => [
                styles.action,
                {
                  backgroundColor: accent,
                  opacity: disabled ? 0.42 : pressed ? 0.72 : 1,
                },
              ]}
            >
              <ThemedText type="code" style={[styles.actionLabel, styles.onAccent]}>
                THEY MATCHED
              </ThemedText>
            </Pressable>
          </View>
        </>
      )}

      {verifications.length > 1 ? (
        <ThemedText type="code" themeColor="textSecondary" style={styles.queue}>
          {verifications.length - 1} MORE SIGNAL{verifications.length === 2 ? '' : 'S'} WAITING
        </ThemedText>
      ) : null}
    </View>
  );
}

function PairingFigureView({
  accent,
  figure,
  large = false,
}: {
  accent: string;
  figure: PairingFigure;
  large?: boolean;
}) {
  return (
    <View
      accessible={large}
      accessibilityLabel={large ? `${figure.name} ASCII pairing figure` : undefined}
      accessibilityRole={large ? 'text' : undefined}
      style={styles.figure}
    >
      <Text
        accessible={false}
        allowFontScaling={false}
        style={[styles.art, large ? styles.artLarge : styles.artSmall, { color: accent }]}
      >
        {figure.art}
      </Text>
      <ThemedText
        accessible={false}
        type="code"
        themeColor="textSecondary"
        style={styles.figureName}
      >
        {figure.name.toUpperCase()}
      </ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignSelf: 'stretch',
    borderRadius: Spacing.three,
    borderWidth: StyleSheet.hairlineWidth,
    gap: Spacing.three,
    maxWidth: '100%',
    minWidth: 0,
    padding: Spacing.three,
    width: '100%',
  },
  headingRow: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: Spacing.three,
    justifyContent: 'space-between',
  },
  headingCopy: {
    flex: 1,
    gap: Spacing.one,
  },
  options: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
    minWidth: 0,
  },
  option: {
    alignItems: 'stretch',
    borderRadius: Spacing.two,
    borderWidth: StyleSheet.hairlineWidth,
    flexBasis: 132,
    flexGrow: 1,
    justifyContent: 'center',
    minHeight: 132,
    minWidth: 132,
    padding: Spacing.two,
  },
  figure: {
    alignItems: 'center',
    gap: Spacing.two,
    justifyContent: 'center',
  },
  art: {
    fontFamily: Fonts.mono,
    includeFontPadding: false,
    textAlign: 'left',
  },
  artSmall: {
    fontSize: 14,
    lineHeight: 17,
  },
  artLarge: {
    fontSize: 22,
    lineHeight: 26,
  },
  figureName: {
    letterSpacing: 0.6,
    textAlign: 'center',
  },
  actions: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  action: {
    alignItems: 'center',
    borderRadius: Spacing.two,
    flex: 1,
    justifyContent: 'center',
    minHeight: 48,
    paddingHorizontal: Spacing.two,
  },
  outlineAction: {
    alignItems: 'center',
    borderRadius: Spacing.two,
    borderWidth: StyleSheet.hairlineWidth,
    justifyContent: 'center',
    minHeight: 48,
    paddingHorizontal: Spacing.two,
  },
  actionLabel: {
    fontWeight: '700',
    letterSpacing: 0.6,
    textAlign: 'center',
  },
  onAccent: {
    color: '#07131f',
  },
  invalid: {
    gap: Spacing.two,
  },
  queue: {
    textAlign: 'center',
  },
});
