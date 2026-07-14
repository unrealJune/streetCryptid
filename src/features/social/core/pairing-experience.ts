import type { PairStateRecord } from 'iroh-location';

import type { Friend } from './types';

export type PairingExperienceStage =
  'idle' | 'seeking' | 'contact' | 'handshaking' | 'verifying' | 'joining' | 'discovered';

export interface PairingExperienceInput {
  bumpStage: 'idle' | 'armed' | 'searching' | 'contact' | 'failed';
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
  const verificationSessions = input.sessions.filter((session) =>
    ['verifying', 'localAccepted', 'peerAccepted'].includes(session.state)
  );
  if (verificationSessions.length > 0) return 'verifying';

  const activeNearby = input.sessions.find(
    (session) => session.nearby && !['complete', 'rejected', 'failed'].includes(session.state)
  );
  if (activeNearby) return 'handshaking';

  if (input.bumpStage === 'contact') return 'contact';
  if (input.bumpStage === 'searching') return 'seeking';
  return 'idle';
}

export function pairingHapticCadence(stage: PairingExperienceStage): PairingHapticCadence | null {
  switch (stage) {
    case 'seeking':
      return { delayMs: 760, strength: 'light' };
    case 'contact':
      return { delayMs: 560, strength: 'medium' };
    case 'handshaking':
      return { delayMs: 390, strength: 'medium' };
    case 'verifying':
      return { delayMs: 1000, strength: 'light' };
    case 'joining':
      return { delayMs: 240, strength: 'rigid' };
    case 'idle':
    case 'discovered':
      return null;
  }
}
