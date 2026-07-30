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

/** One beat of the pairing pulse: when the next one lands, and how it should feel. */
export interface PairingPulse {
  delayMs: number;
  /** 0–1, drives haptic strength and the ring's opacity/scale. */
  intensity: number;
  /** 0–1, Core Haptics "sharpness"; higher reads as a crisper, more clicky edge. */
  sharpness: number;
}

/**
 * A stage's pulse band. The stage picks the band (a predictable spine, so the feel never seems
 * random); proximity moves within it (so the feel carries real information about how close the
 * phones are). `far` is the weakest, slowest end; `near` the strongest, fastest.
 */
interface PulseBand {
  farDelayMs: number;
  nearDelayMs: number;
  farIntensity: number;
  nearIntensity: number;
  sharpness: number;
  /** When false, proximity is ignored and the band sits at its `far` end. See `verifying`. */
  proximityDriven: boolean;
}

const PULSE_BANDS: Record<PairingExperienceStage, PulseBand | null> = {
  // Hunting. Soft and slow when nothing is close, tightening as a peer comes into range.
  // Bands deliberately do NOT overlap with the next stage's slow end (see the monotonic-ladder
  // test): if seeking-at-its-fastest beat contact-at-its-slowest, crossing into contact would feel
  // like a slow-down, which is the "random" reading the stage spine exists to prevent.
  seeking: {
    farDelayMs: 760,
    nearDelayMs: 580,
    farIntensity: 0.3,
    nearIntensity: 0.62,
    sharpness: 0.35,
    proximityDriven: true,
  },
  // A peer is ranked and closing. Firmer, and noticeably quicker.
  contact: {
    farDelayMs: 560,
    nearDelayMs: 400,
    farIntensity: 0.55,
    nearIntensity: 0.82,
    sharpness: 0.6,
    proximityDriven: true,
  },
  // Touching, keys moving. The fastest honest heartbeat before the security step.
  handshaking: {
    farDelayMs: 390,
    nearDelayMs: 250,
    farIntensity: 0.7,
    nearIntensity: 0.92,
    sharpness: 0.75,
    proximityDriven: true,
  },
  // DELIBERATELY CALM AND FIXED. This is the SAS comparison — the one moment the user has to stop
  // and actually think. An accelerating pulse here would be manufacturing urgency around a security
  // decision, so proximity is ignored and the beat stays slow and quiet.
  verifying: {
    farDelayMs: 1000,
    nearDelayMs: 1000,
    farIntensity: 0.28,
    nearIntensity: 0.28,
    sharpness: 0.22,
    proximityDriven: false,
  },
  // Committed. Insistent, and the sharpest thing short of the payoff itself.
  joining: {
    farDelayMs: 240,
    nearDelayMs: 170,
    farIntensity: 0.85,
    nearIntensity: 1,
    sharpness: 0.9,
    proximityDriven: true,
  },
  idle: null,
  discovered: null,
};

/** Weakest and strongest BLE RSSI we map across, in dBm. Beyond either end we clamp. */
const RSSI_FLOOR_DBM = -95;
const RSSI_CEILING_DBM = -40;

/**
 * Normalise a BLE RSSI reading to 0 (far) … 1 (touching).
 *
 * A missing reading resolves to the middle of the band rather than either extreme: absent RSSI
 * means "we cannot tell", and both a dead-feeling pulse and a maxed-out one would be a lie about
 * proximity we do not actually have.
 */
export function proximityFromRssi(rssi: number | null | undefined): number {
  if (rssi === null || rssi === undefined || !Number.isFinite(rssi)) return 0.5;
  const span = RSSI_CEILING_DBM - RSSI_FLOOR_DBM;
  return Math.min(1, Math.max(0, (rssi - RSSI_FLOOR_DBM) / span));
}

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

/**
 * The next pulse for `stage` at the given signal strength — the hybrid the pairing feel is built
 * on. Returns null for stages that should stay silent.
 */
export function pairingPulse(
  stage: PairingExperienceStage,
  rssi: number | null | undefined
): PairingPulse | null {
  const band = PULSE_BANDS[stage];
  if (!band) return null;
  const t = band.proximityDriven ? proximityFromRssi(rssi) : 0;
  return {
    delayMs: Math.round(lerp(band.farDelayMs, band.nearDelayMs, t)),
    intensity: lerp(band.farIntensity, band.nearIntensity, t),
    sharpness: band.sharpness,
  };
}
