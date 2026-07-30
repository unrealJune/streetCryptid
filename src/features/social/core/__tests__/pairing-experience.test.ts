import type { PairStateRecord } from 'iroh-location';

import {
  derivePairingExperienceStage,
  pairingHapticCadence,
  pairingPulse,
  proximityFromRssi,
} from '../pairing-experience';
import type { Friend } from '../types';

function session(state: PairStateRecord['state']): PairStateRecord {
  return {
    sessionId: 'session',
    peerEndpointId: 'peer',
    state,
    localAccepted: state === 'localAccepted',
    peerAccepted: state === 'peerAccepted',
    initiator: true,
    nearby: true,
    sasVerified: ['verifying', 'localAccepted', 'peerAccepted', 'complete'].includes(state),
    localSasConfirmed: ['localAccepted', 'complete'].includes(state),
  };
}

const friend: Friend = {
  endpointId: 'peer',
  handle: '@peer',
  sigil: '(o.o)',
  recvPublic: 'recv',
  ticket: 'ticket',
};

describe('pairing experience', () => {
  it('stays calm through mutual verification, then joins', () => {
    expect(
      derivePairingExperienceStage({
        bumpStage: 'armed',
        sessions: [],
        discoveredFriend: null,
      })
    ).toBe('idle');
    expect(
      derivePairingExperienceStage({
        bumpStage: 'searching',
        sessions: [],
        discoveredFriend: null,
      })
    ).toBe('seeking');
    expect(
      derivePairingExperienceStage({
        bumpStage: 'contact',
        sessions: [],
        discoveredFriend: null,
      })
    ).toBe('contact');
    expect(
      derivePairingExperienceStage({
        bumpStage: 'contact',
        sessions: [session('handshaking')],
        discoveredFriend: null,
      })
    ).toBe('handshaking');
    expect(
      derivePairingExperienceStage({
        bumpStage: 'contact',
        sessions: [session('verifying')],
        discoveredFriend: null,
      })
    ).toBe('verifying');
    expect(
      derivePairingExperienceStage({
        bumpStage: 'contact',
        sessions: [session('peerAccepted')],
        discoveredFriend: null,
      })
    ).toBe('verifying');
    expect(
      derivePairingExperienceStage({
        bumpStage: 'contact',
        sessions: [session('complete')],
        discoveredFriend: null,
      })
    ).toBe('contact');
  });

  it('prioritizes the completed discovery reveal', () => {
    expect(
      derivePairingExperienceStage({
        bumpStage: 'idle',
        sessions: [],
        discoveredFriend: friend,
      })
    ).toBe('discovered');
  });

  it('keeps an authenticated nearby session visible after the Bump window ends', () => {
    expect(
      derivePairingExperienceStage({
        bumpStage: 'idle',
        sessions: [session('handshaking')],
        discoveredFriend: null,
      })
    ).toBe('handshaking');
    expect(
      derivePairingExperienceStage({
        bumpStage: 'idle',
        sessions: [session('verifying')],
        discoveredFriend: null,
      })
    ).toBe('verifying');
  });

  it('keeps invite verification independent of the motion window', () => {
    expect(
      derivePairingExperienceStage({
        bumpStage: 'idle',
        sessions: [{ ...session('verifying'), nearby: false }],
        discoveredFriend: null,
      })
    ).toBe('verifying');
  });

  it('accelerates haptic cadence as pairing advances', () => {
    const seeking = pairingHapticCadence('seeking');
    const handshake = pairingHapticCadence('handshaking');
    const verifying = pairingHapticCadence('verifying');
    const joining = pairingHapticCadence('joining');
    expect(seeking?.delayMs).toBeGreaterThan(handshake?.delayMs ?? 0);
    expect(verifying?.delayMs).toBeGreaterThan(handshake?.delayMs ?? 0);
    expect(handshake?.delayMs).toBeGreaterThan(joining?.delayMs ?? 0);
    expect(pairingHapticCadence('idle')).toBeNull();
  });
});

describe('pairing pulse (hybrid stage ladder + proximity)', () => {
  it('maps RSSI onto 0..1 and clamps beyond the usable band', () => {
    expect(proximityFromRssi(-95)).toBeCloseTo(0, 5);
    expect(proximityFromRssi(-40)).toBeCloseTo(1, 5);
    expect(proximityFromRssi(-120)).toBe(0);
    expect(proximityFromRssi(-10)).toBe(1);
  });

  // Absent RSSI must not fake either extreme — "we cannot tell" sits in the middle.
  it('falls back to mid-band when there is no reading', () => {
    expect(proximityFromRssi(null)).toBe(0.5);
    expect(proximityFromRssi(undefined)).toBe(0.5);
    expect(proximityFromRssi(Number.NaN)).toBe(0.5);
  });

  it('speeds up and firms up as a peer closes, within one stage', () => {
    const far = pairingPulse('seeking', -95);
    const near = pairingPulse('seeking', -40);
    if (!far || !near) throw new Error('seeking should pulse');

    expect(near.delayMs).toBeLessThan(far.delayMs);
    expect(near.intensity).toBeGreaterThan(far.intensity);
  });

  // The spine: even at its most eager, a stage never overtakes the next one's calmest beat.
  it('keeps the stage ladder monotonic so the feel never reads as random', () => {
    const fastest = (stage: Parameters<typeof pairingPulse>[0]) =>
      pairingPulse(stage, -40)!.delayMs;
    const slowest = (stage: Parameters<typeof pairingPulse>[0]) =>
      pairingPulse(stage, -95)!.delayMs;

    expect(fastest('seeking')).toBeGreaterThanOrEqual(slowest('contact'));
    expect(fastest('contact')).toBeGreaterThanOrEqual(slowest('handshaking'));
    expect(fastest('handshaking')).toBeGreaterThanOrEqual(slowest('joining'));
  });

  // Manufacturing urgency around a security decision is the one thing this must not do.
  it('holds verifying calm and fixed regardless of proximity', () => {
    const far = pairingPulse('verifying', -95);
    const near = pairingPulse('verifying', -40);

    expect(near).toEqual(far);
    expect(near?.delayMs).toBe(1000);
    expect(near?.intensity).toBeLessThan(0.4);
  });

  it('stays silent where there is nothing to say', () => {
    expect(pairingPulse('idle', -40)).toBeNull();
    expect(pairingPulse('discovered', -40)).toBeNull();
  });

  it('never emits an out-of-range intensity or sharpness', () => {
    const stages = ['seeking', 'contact', 'handshaking', 'verifying', 'joining'] as const;
    for (const stage of stages) {
      for (const rssi of [-200, -95, -70, -40, 0, null]) {
        const pulse = pairingPulse(stage, rssi);
        if (!pulse) continue;
        expect(pulse.intensity).toBeGreaterThanOrEqual(0);
        expect(pulse.intensity).toBeLessThanOrEqual(1);
        expect(pulse.sharpness).toBeGreaterThanOrEqual(0);
        expect(pulse.sharpness).toBeLessThanOrEqual(1);
        expect(pulse.delayMs).toBeGreaterThan(0);
      }
    }
  });
});
