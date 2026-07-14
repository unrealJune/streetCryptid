import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import type { BumpSensorState } from '../hooks/use-bump-to-pair';
import type { PairingSnapshot } from '../net/location-sharing';

interface BumpPairingPanelProps {
  accent: string;
  pairing: PairingSnapshot | null;
  sensor: BumpSensorState;
  onArm(): Promise<void>;
  onCommit(): Promise<void>;
  onCancel(): Promise<void>;
}

function secondsRemaining(expiresAt: number | null): number {
  return expiresAt ? Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)) : 0;
}

export function BumpPairingPanel({
  accent,
  pairing,
  sensor,
  onArm,
  onCommit,
  onCancel,
}: BumpPairingPanelProps) {
  const theme = useTheme();
  const stage = pairing?.bump.stage ?? 'idle';
  const [working, setWorking] = useState(false);
  const [, setClockTick] = useState(0);
  const remaining = secondsRemaining(pairing?.bump.expiresAt ?? null);

  useEffect(() => {
    if (!pairing?.bump.expiresAt) return;
    const timer = setInterval(() => {
      setClockTick((tick) => tick + 1);
    }, 250);
    return () => clearInterval(timer);
  }, [pairing?.bump.expiresAt]);

  const active = stage !== 'idle';
  const pairingInProgress =
    pairing?.pendingRequests.length ||
    pairing?.verifications.length ||
    pairing?.sessions.some(
      (session) => !['complete', 'rejected', 'failed'].includes(session.state)
    );
  const disabled =
    !pairing?.available ||
    Boolean(pairing.discoveredFriend) ||
    Boolean(pairingInProgress) ||
    working ||
    stage === 'searching' ||
    stage === 'contact';
  const title =
    stage === 'armed'
      ? 'Ready for impact'
      : stage === 'searching'
        ? 'Reading the nearest signal'
        : stage === 'contact'
          ? 'Signal found'
          : stage === 'failed'
            ? 'Bump needs another try'
            : 'Bump phones';
  const detail =
    stage === 'armed'
      ? sensor.status === 'ready'
        ? 'Tap the top edges together. If motion misses, tap BUMP NOW on both phones.'
        : 'Tap BUMP NOW on both phones while they are touching.'
      : stage === 'searching'
        ? 'Fresh Bluetooth signals are being ranked and verified.'
        : stage === 'contact'
          ? 'Starting the encrypted visual check.'
          : stage === 'failed'
            ? (pairing?.bump.error ?? 'Keep both Friends screens open and retry.')
            : 'Open Friends on both phones, arm Bump, then tap their top edges together.';
  const actionLabel =
    stage === 'armed'
      ? 'BUMP NOW'
      : stage === 'failed'
        ? 'TRY AGAIN'
        : stage === 'searching'
          ? 'SEARCHING'
          : stage === 'contact'
            ? 'CONNECTING'
            : 'ARM BUMP';

  const runPrimary = async (): Promise<void> => {
    if (disabled) return;
    setWorking(true);
    try {
      if (stage === 'idle') await onArm();
      else await onCommit();
    } catch {
      // The provider owns the actionable error banner.
    } finally {
      setWorking(false);
    }
  };

  return (
    <View
      accessibilityLiveRegion="polite"
      style={[styles.container, { borderColor: theme.backgroundSelected }]}
    >
      <View style={styles.headingRow}>
        <View style={styles.copy}>
          <ThemedText type="smallBold">{title}</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            {detail}
          </ThemedText>
        </View>
        {active ? (
          <ThemedText type="code" style={{ color: accent }}>
            {remaining}s
          </ThemedText>
        ) : null}
      </View>

      <View style={styles.signalRow}>
        <View
          style={[
            styles.signalDot,
            {
              backgroundColor:
                pairing?.capabilities?.available && pairing.ready ? accent : theme.textSecondary,
            },
          ]}
        />
        <ThemedText type="code" themeColor="textSecondary">
          {!pairing?.available
            ? 'INSTALLED BUILD REQUIRED'
            : pairing.capabilities === null
              ? 'CHECKING BLUETOOTH'
              : !pairing.capabilities.available
                ? 'BLUETOOTH OFFLINE'
                : stage === 'searching'
                  ? `${pairing.bump.peerCount || '—'} SIGNALS`
                  : sensor.status === 'ready' && stage === 'armed'
                    ? 'IMPACT SENSOR READY'
                    : 'BLUETOOTH READY'}
        </ThemedText>
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={
          stage === 'idle' ? 'Arm Bump pairing' : 'Find the phone touching this phone'
        }
        disabled={disabled}
        onPress={() => void runPrimary()}
        style={({ pressed }) => [
          styles.primary,
          {
            borderColor: accent,
            backgroundColor: stage === 'armed' ? theme.backgroundSelected : 'transparent',
            opacity: disabled ? 0.4 : pressed ? 0.62 : 1,
          },
        ]}
      >
        <ThemedText type="smallBold" style={{ color: accent }}>
          {working ? 'STARTING' : actionLabel}
        </ThemedText>
      </Pressable>

      {active ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Cancel Bump pairing"
          onPress={() => void onCancel()}
          style={({ pressed }) => [styles.cancel, { opacity: pressed ? 0.55 : 1 }]}
        >
          <ThemedText type="code" themeColor="textSecondary">
            CANCEL
          </ThemedText>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: Spacing.three,
    paddingVertical: Spacing.three,
  },
  headingRow: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: Spacing.three,
    justifyContent: 'space-between',
  },
  copy: {
    flex: 1,
    gap: Spacing.one,
  },
  signalRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: Spacing.two,
  },
  signalDot: {
    borderRadius: 4,
    height: 8,
    width: 8,
  },
  primary: {
    alignItems: 'center',
    borderRadius: Spacing.three,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 64,
    paddingHorizontal: Spacing.four,
  },
  cancel: {
    alignItems: 'center',
    alignSelf: 'center',
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: Spacing.three,
  },
});
