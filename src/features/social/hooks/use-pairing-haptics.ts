import { useEffect, useRef } from 'react';

import { patternHaptic, transientHaptic } from '@/features/haptics/haptics';

import {
  CONTACT_STRIKE,
  DISCOVERY_FLOURISH,
  FAILURE_COLLAPSE,
  derivePairingExperienceStage,
  pairingPulse,
  type PairingExperienceStage,
} from '../core/pairing-experience';
import type { PairingSnapshot } from '../net/location-sharing';

/**
 * The felt half of pairing.
 *
 * Three deliberate choices:
 *
 * 1. **Self-scheduling, not `setInterval`.** The gap between beats is recomputed every beat from
 *    live RSSI, so there is no fixed interval to set — and `setInterval` would drift against the
 *    ring animation anyway, which is exactly the mushiness we are trying to remove.
 * 2. **Proximity is read from a ref.** RSSI updates constantly; keying the effect on it would tear
 *    down and restart the loop several times a second, so the loop reads the latest value instead
 *    of restarting. The effect restarts only when the *stage* changes.
 * 3. **Driven by the whole snapshot, not by the Bump path.** This used to hang off the armed-bump
 *    hook, which the pairing screen only arms for nearby pairing — so a link or QR pair, which is
 *    most of them, ran completely silent: no pulse, no contact strike, not even the discovery
 *    flourish. Nothing about how pairing feels is specific to how it started.
 */

export function usePairingHaptics(pairing: PairingSnapshot | null, enabled: boolean): void {
  const poppedDiscoveryRef = useRef<string | null>(null);
  const struckContactRef = useRef(false);
  const collapsedFailureRef = useRef<string | null>(null);
  const rssiRef = useRef<number | null>(null);

  const stage: PairingExperienceStage = pairing
    ? derivePairingExperienceStage({
        bumpStage: pairing.bump.stage,
        sessions: pairing.sessions,
        discoveredFriend: pairing.discoveredFriend,
        failed: Boolean(pairing.failure),
      })
    : 'idle';

  // Declared BEFORE the pulse loop on purpose: effects run in declaration order, so the ref holds
  // the current reading before the loop's first beat reads it.
  useEffect(() => {
    rssiRef.current = pairing?.bump.rssi ?? null;
  }, [pairing?.bump.rssi]);

  // The pulse loop. Restarts only on stage change; proximity rides in through the ref.
  useEffect(() => {
    if (!enabled || stage === 'idle' || stage === 'discovered') return;
    if (!pairingPulse(stage, rssiRef.current)) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const beat = (): void => {
      if (cancelled) return;
      const pulse = pairingPulse(stage, rssiRef.current);
      if (!pulse) return;
      void transientHaptic(pulse.intensity, pulse.sharpness);
      timer = setTimeout(beat, pulse.delayMs);
    };

    beat();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [enabled, stage]);

  // Contact is a one-shot event, not a beat: fire once on entry and re-arm when we leave.
  useEffect(() => {
    if (!enabled) return;
    if (stage !== 'contact') {
      struckContactRef.current = false;
      return;
    }
    if (struckContactRef.current) return;
    struckContactRef.current = true;
    void patternHaptic(CONTACT_STRIKE);
  }, [enabled, stage]);

  // Failure, likewise one-shot — and keyed by session so two consecutive failures each land.
  useEffect(() => {
    const failure = pairing?.failure;
    if (!enabled || !failure) return;
    const failureId = `${failure.sessionId}:${failure.at}`;
    if (collapsedFailureRef.current === failureId) return;
    collapsedFailureRef.current = failureId;
    void patternHaptic(FAILURE_COLLAPSE);
  }, [enabled, pairing?.failure]);

  useEffect(() => {
    const friend = pairing?.discoveredFriend;
    if (!enabled || !friend) return;
    // Keyed so re-pairing the same friend later still celebrates, but a re-render does not.
    const discoveryId = `${friend.endpointId}:${friend.pairedAt ?? 0}`;
    if (poppedDiscoveryRef.current === discoveryId) return;
    poppedDiscoveryRef.current = discoveryId;
    void patternHaptic(DISCOVERY_FLOURISH);
  }, [enabled, pairing?.discoveredFriend]);
}
