import type { BlePeer, PairStateRecord } from 'iroh-location';

import type { Friend } from './types';

export type PairingExperienceStage =
  'idle' | 'seeking' | 'contact' | 'handshaking' | 'joining' | 'discovered';

export interface PairingExperienceInput {
  gestureActive: boolean;
  nearbyPeers: readonly BlePeer[];
  sessions: readonly PairStateRecord[];
  discoveredFriend: Friend | null;
}

export interface PairingHapticCadence {
  delayMs: number;
  strength: 'light' | 'medium' | 'rigid';
}

export function derivePairingExperienceStage(
  input: PairingExperienceInput
): PairingExperienceStage {
  if (input.discoveredFriend) return 'discovered';

  const activeNearby = input.sessions.find(
    (session) => session.nearby && !['complete', 'rejected', 'failed'].includes(session.state)
  );
  if (activeNearby) {
    return ['localAccepted', 'peerAccepted'].includes(activeNearby.state)
      ? 'joining'
      : 'handshaking';
  }

  if (!input.gestureActive) return 'idle';
  const dialablePeers = input.nearbyPeers.filter(
    (peer) => (peer.verifiedEndpointId ?? peer.endpointHint) !== null
  );
  return dialablePeers.length === 1 ? 'contact' : 'seeking';
}

export function pairingHapticCadence(stage: PairingExperienceStage): PairingHapticCadence | null {
  switch (stage) {
    case 'seeking':
      return { delayMs: 760, strength: 'light' };
    case 'contact':
      return { delayMs: 560, strength: 'medium' };
    case 'handshaking':
      return { delayMs: 390, strength: 'medium' };
    case 'joining':
      return { delayMs: 240, strength: 'rigid' };
    case 'idle':
    case 'discovered':
      return null;
  }
}
