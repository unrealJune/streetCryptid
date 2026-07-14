import type { PairStateRecord } from 'iroh-location';

import { derivePairingExperienceStage, pairingHapticCadence } from '../pairing-experience';
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
