import { useCallback, useEffect, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import { useBumpToPair, type BumpSensorState } from './use-bump-to-pair';
import { useLocationSharing } from './use-location-sharing';
import { usePairingHaptics } from './use-pairing-haptics';
import type { PairingSnapshot } from '../net/location-sharing';

export interface ArmedBump {
  readonly pairing: PairingSnapshot | null;
  readonly sensor: BumpSensorState;
  /** True while this surface is allowed to hold the radio open. */
  readonly live: boolean;
  /** Why the last arm attempt did not take, if it did not. */
  readonly error: string | null;
  /** True while an arm attempt is in flight. */
  readonly arming: boolean;
  arm(): Promise<void>;
  commit(): Promise<void>;
}

/**
 * Owns the Bump window for whichever surface is showing the roster.
 *
 * Arming is an explicit tap, not a side effect of opening the tab. Arming has to
 * ask for Bluetooth permission and can fail for half a dozen honest reasons
 * (no native module, radio off, another pairing already running), and the
 * service leaves the stage on `idle` when it does — so a silent auto-arm could
 * fail once and then sit there looking armed forever, with nothing to press.
 * A button makes the failure visible and recoverable, and puts the OS permission
 * prompt behind a deliberate gesture.
 *
 * Disarming stays automatic: leaving the tab, drilling into a friend's trace, or
 * backgrounding the app cancels the window, so the radio is never quietly left
 * listening.
 */
export function useArmedBump(active: boolean): ArmedBump {
  const { pairing, armBump, commitBump, cancelBump, refreshPairing } = useLocationSharing();
  const [appState, setAppState] = useState<AppStateStatus>(AppState.currentState);
  const [error, setError] = useState<string | null>(null);
  const [arming, setArming] = useState(false);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', setAppState);
    return () => subscription.remove();
  }, []);

  const live = active && appState === 'active';
  const stage = pairing?.bump.stage ?? 'idle';

  const arm = useCallback(async () => {
    setArming(true);
    setError(null);
    try {
      await armBump();
    } catch (armError: unknown) {
      setError(armError instanceof Error ? armError.message : 'Bump could not start.');
    } finally {
      setArming(false);
    }
  }, [armBump]);

  // Re-read pairing (and with it the Bluetooth radio state) whenever this surface comes alive —
  // including on the way back from the Bluetooth settings the strip can send you to, so the copy
  // catches up with a radio that was just switched on without waiting for the next poll tick.
  useEffect(() => {
    if (!live) return;
    void refreshPairing();
  }, [live, refreshPairing]);

  // Derived, not stored-and-cleared: a failure only describes the attempt that
  // produced it, so it is simply not shown once the radio is open or you have
  // walked away from the roster.
  const visibleError = stage === 'idle' && live ? error : null;

  useEffect(() => {
    if (live || stage === 'idle') return;
    void cancelBump();
  }, [cancelBump, live, stage]);

  const sensor = useBumpToPair(live && stage === 'armed' && !pairing?.discoveredFriend, commitBump);
  usePairingHaptics(pairing, live);

  return { pairing, sensor, live, error: visibleError, arming, arm, commit: commitBump };
}
