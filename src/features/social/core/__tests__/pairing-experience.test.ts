import type { BlePeer, PairStateRecord } from 'iroh-location';

import { derivePairingExperienceStage, pairingHapticCadence } from '../pairing-experience';
import type { Friend } from '../types';

const peer: BlePeer = {
  deviceId: 'ble-1',
  phase: 'discovered',
  verifiedEndpointId: null,
  endpointHint: 'peer',
  consecutiveFailures: 0,
  connectPath: 'Gatt',
};

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
        gestureActive: true,
        nearbyPeers: [],
        sessions: [],
        discoveredFriend: null,
      })
    ).toBe('seeking');
    expect(
      derivePairingExperienceStage({
        gestureActive: true,
        nearbyPeers: [peer],
        sessions: [],
        discoveredFriend: null,
      })
    ).toBe('contact');
    expect(
      derivePairingExperienceStage({
        gestureActive: true,
        nearbyPeers: [peer],
        sessions: [session('handshaking')],
        discoveredFriend: null,
      })
    ).toBe('handshaking');
    expect(
      derivePairingExperienceStage({
        gestureActive: true,
        nearbyPeers: [peer],
        sessions: [session('verifying')],
        discoveredFriend: null,
      })
    ).toBe('verifying');
    expect(
      derivePairingExperienceStage({
        gestureActive: true,
        nearbyPeers: [peer],
        sessions: [session('peerAccepted')],
        discoveredFriend: null,
      })
    ).toBe('verifying');
    expect(
      derivePairingExperienceStage({
        gestureActive: true,
        nearbyPeers: [peer],
        sessions: [session('complete')],
        discoveredFriend: null,
      })
    ).toBe('joining');
  });

  it('prioritizes the completed discovery reveal', () => {
    expect(
      derivePairingExperienceStage({
        gestureActive: false,
        nearbyPeers: [],
        sessions: [],
        discoveredFriend: friend,
      })
    ).toBe('discovered');
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
