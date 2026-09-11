import { useCallback, useEffect, useRef, useState } from 'react';
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
 * Owns the nearby-listening lifecycle for the active pairing screen.
 *
 * Entering the screen is the deliberate user gesture that opens Bluetooth and motion
 * permissions. A timed-out or transiently interrupted window re-arms itself while the
 * screen remains visible; a physical miss stays parked for an explicit retry. Leaving
 * or backgrounding the screen always closes the radio.
 */
export function useArmedBump(active: boolean): ArmedBump {
  const { pairing, armBump, commitBump, cancelBump, refreshPairing } = useLocationSharing();
  const [appState, setAppState] = useState<AppStateStatus>(AppState.currentState);
  const [error, setError] = useState<string | null>(null);
  const [arming, setArming] = useState(false);
  const armingRef = useRef(false);
  const retryCountRef = useRef(0);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', setAppState);
    return () => subscription.remove();
  }, []);

  const live = active && appState === 'active';
  const stage = pairing?.bump.stage ?? 'idle';

  const arm = useCallback(async () => {
    if (armingRef.current) return;
    armingRef.current = true;
    setArming(true);
    setError(null);
    try {
      await armBump();
      retryCountRef.current = 0;
    } catch (armError: unknown) {
      setError(armError instanceof Error ? armError.message : 'Bump could not start.');
      throw armError;
    } finally {
      armingRef.current = false;
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

  const hasActiveSession =
    (pairing?.verifications.length ?? 0) > 0 ||
    (pairing?.pendingRequests.length ?? 0) > 0 ||
    (pairing?.sessions.some(
      (session) => !['complete', 'rejected', 'failed'].includes(session.state)
    ) ??
      false) ||
    Boolean(pairing?.discoveredFriend);

  useEffect(() => {
    if (!live || hasActiveSession || stage !== 'idle' || armingRef.current) return;
    let cancelled = false;
    const delay =
      retryCountRef.current === 0 ? 0 : Math.min(8000, 1000 * 2 ** retryCountRef.current);
    const timer = setTimeout(() => {
      void arm().catch(() => {
        if (!cancelled) retryCountRef.current += 1;
      });
    }, delay);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [arm, hasActiveSession, live, stage]);

  const visibleError = stage === 'idle' && live ? error : null;

  useEffect(() => {
    if (live || stage === 'idle') return;
    void cancelBump();
  }, [cancelBump, live, stage]);

  const sensor = useBumpToPair(live && stage === 'armed' && !hasActiveSession, commitBump);
  usePairingHaptics(pairing, live);

  return { pairing, sensor, live, error: visibleError, arming, arm, commit: commitBump };
}
