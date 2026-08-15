import { useEffect, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import type { CryptidTheme } from '@/constants/cryptid-theme';
import { Spacing } from '@/constants/theme';

import type { BumpSensorState } from '../hooks/use-bump-to-pair';
import { openBluetoothSettings } from '../net/bluetooth-settings';
import type { PairingSnapshot } from '../net/location-sharing';

interface BumpPairingStripProps {
  readonly pairing: PairingSnapshot | null;
  readonly sensor: BumpSensorState;
  /** Why the last arm attempt did not take, if it did not. */
  readonly error?: string | null;
  readonly theme: CryptidTheme;
  onArm(): Promise<void>;
  onCommit(): Promise<void>;
  /** Send the user to the Bluetooth switch. Injectable for tests; opens settings by default. */
  onEnableBluetooth?(): Promise<void>;
}

interface StripCopy {
  readonly status: string;
  readonly detail: string;
  readonly action: 'arm' | 'bump' | 'retry' | 'enable' | null;
  /** Render the control, but greyed and inert — there is nothing this tap could fix. */
  readonly disabled: boolean;
  readonly listening: boolean;
}

function secondsRemaining(expiresAt: number | null): number {
  return expiresAt ? Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)) : 0;
}

const ACTION_LABEL = {
  arm: 'ARM BUMP',
  bump: 'BUMP NOW',
  retry: 'TRY AGAIN',
  enable: 'TURN ON BT',
} as const;
const ACTION_HINT = {
  arm: 'Arm bump to meet a nearby friend',
  bump: 'Pair with the phone touching this one',
  retry: 'Try bump again',
  enable: 'Open Bluetooth settings to turn the radio on',
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
  onEnableBluetooth = openBluetoothSettings,
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

  const copy = stripCopy(pairing, sensor, stage, error, Platform.OS);
  const action = copy.action;

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

      {action ? (
        <Pressable
          accessibilityLabel={ACTION_HINT[action]}
          accessibilityRole="button"
          accessibilityState={{ disabled: copy.disabled || working }}
          disabled={copy.disabled || working}
          onPress={() => void run(actionHandler(action, { onArm, onCommit, onEnableBluetooth }))}
          style={({ pressed }) => [
            styles.action,
            {
              borderColor: copy.disabled ? chrome.steel : chrome.green,
              opacity: copy.disabled ? 0.35 : working ? 0.4 : pressed ? 0.62 : 1,
            },
          ]}
        >
          <Text
            style={[styles.actionLabel, { color: copy.disabled ? chrome.steel : chrome.green }]}
          >
            {working ? 'WORKING' : ACTION_LABEL[action]}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function actionHandler(
  action: NonNullable<StripCopy['action']>,
  handlers: {
    onArm(): Promise<void>;
    onCommit(): Promise<void>;
    onEnableBluetooth(): Promise<void>;
  }
): () => Promise<void> {
  if (action === 'bump') return handlers.onCommit;
  if (action === 'enable') return handlers.onEnableBluetooth;
  return handlers.onArm;
}

function stripCopy(
  pairing: PairingSnapshot | null,
  sensor: BumpSensorState,
  stage: string,
  error: string | null,
  platform: string
): StripCopy {
  if (!pairing?.available) {
    return {
      status: 'PAIRING NEEDS AN INSTALLED BUILD',
      detail: 'Bump uses Bluetooth, which Expo Go cannot reach.',
      action: null,
      disabled: false,
      listening: false,
    };
  }
  if (pairing.capabilities === null) {
    return {
      status: 'CHECKING BLUETOOTH',
      detail: 'Getting the radio ready.',
      action: null,
      disabled: false,
      listening: false,
    };
  }
  // The radio's own state outranks the transport's flat `available`, which cannot tell a phone
  // with Bluetooth switched off from one that was never given permission. Bump used to arm on a
  // dark radio and then simply find nothing, so the switch gets named here.
  if (pairing.radio === 'unsupported') {
    return {
      status: 'NO BLUETOOTH RADIO',
      detail: 'This device has no Bluetooth LE, so Bump cannot run. Share an invite link instead.',
      action: null,
      disabled: false,
      listening: false,
    };
  }
  if (pairing.radio === 'poweredOff') {
    // Android exposes the radio toggle as a public settings intent, so it gets a live button.
    // iOS has no public deep link to it, so the control is shown greyed with the real instruction
    // rather than sending the user somewhere that cannot help.
    return platform === 'android'
      ? {
          status: 'BLUETOOTH IS OFF',
          detail: 'Bump needs the radio on. Turn Bluetooth on, then arm bump.',
          action: 'enable',
          disabled: false,
          listening: false,
        }
      : {
          status: 'BLUETOOTH IS OFF',
          detail: 'Turn Bluetooth on in Control Centre or Settings, then arm bump.',
          action: 'arm',
          disabled: true,
          listening: false,
        };
  }
  if (!pairing.capabilities.available) {
    // Keep the control. The native layer reports one flat "unavailable" for three different
    // causes — permission never granted, radio switched off, no BLE at all — and the first is
    // both the most common and the only one the app can fix. Dropping the button here stranded
    // exactly that case: arming is what asks for Bluetooth, so hiding it meant a phone that had
    // never been asked could never be asked. Arm re-requests permission and rebinds the node, so
    // a tap either fixes it or fails with an honest reason in `error`.
    return {
      status: 'BLUETOOTH UNAVAILABLE',
      detail: 'Allow Bluetooth to meet someone in person. If it is allowed, turn the radio on.',
      action: 'arm',
      disabled: false,
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
        disabled: false,
        listening: true,
      };
    case 'searching':
      return {
        status: `READING ${pairing.bump.peerCount || '—'} SIGNALS`,
        detail: 'Ranking the nearest phone and verifying it.',
        action: null,
        disabled: false,
        listening: true,
      };
    case 'contact':
      return {
        status: 'SIGNAL FOUND',
        detail: 'Starting the encrypted visual check.',
        action: null,
        disabled: false,
        listening: true,
      };
    case 'failed':
      return {
        status: 'BUMP MISSED',
        detail: pairing.bump.error ?? 'Keep both phones on the FRIENDS tab and try once more.',
        action: 'retry',
        disabled: false,
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
        disabled: false,
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
