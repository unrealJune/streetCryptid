import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { CryptidTheme } from '@/constants/cryptid-theme';
import { Spacing } from '@/constants/theme';

import type { BumpSensorState } from '../hooks/use-bump-to-pair';
import type { PairingSnapshot } from '../net/location-sharing';

interface BumpPairingStripProps {
  readonly pairing: PairingSnapshot | null;
  readonly sensor: BumpSensorState;
  /** Why the last arm attempt did not take, if it did not. */
  readonly error?: string | null;
  readonly theme: CryptidTheme;
  onArm(): Promise<void>;
  onCommit(): Promise<void>;
}

interface StripCopy {
  readonly status: string;
  readonly detail: string;
  readonly action: 'arm' | 'bump' | 'retry' | null;
  readonly listening: boolean;
}

function secondsRemaining(expiresAt: number | null): number {
  return expiresAt ? Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)) : 0;
}

const ACTION_LABEL = { arm: 'ARM BUMP', bump: 'BUMP NOW', retry: 'TRY AGAIN' } as const;
const ACTION_HINT = {
  arm: 'Arm bump to meet a nearby friend',
  bump: 'Pair with the phone touching this one',
  retry: 'Try bump again',
} as const;

/**
 * Reads out the pairing radio inside the island's FRIENDS tab.
 *
 * Arming is a deliberate tap, not a consequence of opening the tab: it asks for
 * Bluetooth permission and can fail honestly, so it needs a control the user can
 * press again. The strip is a status line first and a control exactly when there
 * is something to do — arm it, bump it by hand if motion detection cannot close
 * the deal, or try once more after a miss.
 */
export function BumpPairingStrip({
  pairing,
  sensor,
  error = null,
  theme,
  onArm,
  onCommit,
}: BumpPairingStripProps) {
  const { chrome } = theme;
  const [working, setWorking] = useState(false);
  const [, setTick] = useState(0);
  const stage = pairing?.bump.stage ?? 'idle';
  const remaining = secondsRemaining(pairing?.bump.expiresAt ?? null);

  useEffect(() => {
    if (!pairing?.bump.expiresAt) return;
    const timer = setInterval(() => setTick((value) => value + 1), 500);
    return () => clearInterval(timer);
  }, [pairing?.bump.expiresAt]);

  const copy = stripCopy(pairing, sensor, stage, error);

  const run = async (action: () => Promise<void>): Promise<void> => {
    if (working) return;
    setWorking(true);
    try {
      await action();
    } catch {
      // The provider owns the actionable error; the strip re-renders from the stage.
    } finally {
      setWorking(false);
    }
  };

  return (
    <View
      accessibilityLiveRegion="polite"
      style={[styles.strip, { borderBottomColor: chrome.islandBorder }]}
    >
      <View style={styles.copy}>
        <View style={styles.statusRow}>
          {/* No second pip: the roster header already owns the one live dot.
              The status ink carries "listening" instead. */}
          <Text
            numberOfLines={1}
            style={[styles.status, { color: copy.listening ? chrome.green : chrome.steel }]}
          >
            {copy.status}
          </Text>
          {stage === 'armed' && remaining > 0 ? (
            <Text style={[styles.clock, { color: chrome.steel }]}>{remaining}s</Text>
          ) : null}
        </View>
        <Text style={[styles.detail, { color: chrome.steel }]}>{copy.detail}</Text>
      </View>

      {copy.action ? (
        <Pressable
          accessibilityLabel={ACTION_HINT[copy.action]}
          accessibilityRole="button"
          disabled={working}
          onPress={() => void run(copy.action === 'bump' ? onCommit : onArm)}
          style={({ pressed }) => [
            styles.action,
            { borderColor: chrome.green, opacity: working ? 0.4 : pressed ? 0.62 : 1 },
          ]}
        >
          <Text style={[styles.actionLabel, { color: chrome.green }]}>
            {working ? 'WORKING' : ACTION_LABEL[copy.action]}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function stripCopy(
  pairing: PairingSnapshot | null,
  sensor: BumpSensorState,
  stage: string,
  error: string | null
): StripCopy {
  if (!pairing?.available) {
    return {
      status: 'PAIRING NEEDS AN INSTALLED BUILD',
      detail: 'Bump uses Bluetooth, which Expo Go cannot reach.',
      action: null,
      listening: false,
    };
  }
  if (pairing.capabilities === null) {
    return {
      status: 'CHECKING BLUETOOTH',
      detail: 'Getting the radio ready.',
      action: null,
      listening: false,
    };
  }
  if (!pairing.capabilities.available) {
    return {
      status: 'BLUETOOTH OFFLINE',
      detail: 'Turn Bluetooth on to meet someone in person.',
      action: null,
      listening: false,
    };
  }
  switch (stage) {
    case 'armed':
      return {
        status: 'READY FOR IMPACT',
        detail:
          sensor.status === 'ready'
            ? 'Touch the top edges of both phones together.'
            : 'Tap BUMP NOW on both phones while they are touching.',
        action: 'bump',
        listening: true,
      };
    case 'searching':
      return {
        status: `READING ${pairing.bump.peerCount || '—'} SIGNALS`,
        detail: 'Ranking the nearest phone and verifying it.',
        action: null,
        listening: true,
      };
    case 'contact':
      return {
        status: 'SIGNAL FOUND',
        detail: 'Starting the encrypted visual check.',
        action: null,
        listening: true,
      };
    case 'failed':
      return {
        status: 'BUMP MISSED',
        detail: pairing.bump.error ?? 'Keep both phones on the FRIENDS tab and try once more.',
        action: 'retry',
        listening: false,
      };
    default:
      // Idle is a real, recoverable resting state, not a spinner: an arm attempt
      // that fails leaves the stage here, and so does a window that simply ran
      // out. Either way there has to be something to press.
      return {
        status: error ? 'BUMP DID NOT START' : 'BUMP IS OFF',
        detail: error ?? 'Arm both phones, then touch their top edges together.',
        action: error ? 'retry' : 'arm',
        listening: false,
      };
  }
}

const styles = StyleSheet.create({
  strip: {
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: Spacing.three,
    paddingBottom: Spacing.three,
    paddingTop: Spacing.two,
  },
  copy: {
    flex: 1,
    gap: 3,
    minWidth: 0,
  },
  statusRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: Spacing.two,
  },
  status: {
    flexShrink: 1,
    fontFamily: 'IBMPlexMono_600SemiBold',
    fontSize: 10,
    letterSpacing: 1.2,
  },
  clock: {
    fontFamily: 'IBMPlexMono_500Medium',
    fontSize: 10,
    letterSpacing: 1,
  },
  detail: {
    fontFamily: 'IBMPlexMono_400Regular',
    fontSize: 11,
    lineHeight: 15,
  },
  action: {
    alignItems: 'center',
    borderRadius: 18,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 36,
    paddingHorizontal: Spacing.three,
  },
  actionLabel: {
    fontFamily: 'IBMPlexMono_600SemiBold',
    fontSize: 10,
    letterSpacing: 1.2,
  },
});
