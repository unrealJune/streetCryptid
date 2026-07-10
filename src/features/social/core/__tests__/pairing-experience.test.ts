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
  it('progresses from seeking to contact to handshake to joining', () => {
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
        sessions: [session('peerAccepted')],
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
    const joining = pairingHapticCadence('joining');
    expect(seeking?.delayMs).toBeGreaterThan(handshake?.delayMs ?? 0);
    expect(handshake?.delayMs).toBeGreaterThan(joining?.delayMs ?? 0);
    expect(pairingHapticCadence('idle')).toBeNull();
  });
});
