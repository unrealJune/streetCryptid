/**
 * How a sealed location envelope is allowed to travel from this phone to a friend's.
 *
 * Three routes, chosen as one exclusive setting rather than a pile of switches, because they
 * are genuinely alternatives: each one trades a different thing away. Direct trades delivery
 * rate for the smallest possible footprint; relay trades the fact of your friendships to your
 * mutuals for resilience; the stash trades a blind server for convenience.
 *
 * What every mode shares — and what the picker must never imply is negotiable — is that the
 * payload is sealed for its recipients before it leaves. No mode can read a trail it forwards.
 * The difference is only *who holds the ciphertext on its way*.
 *
 * Pure data and pure functions: no storage, no native module, no React. The service persists
 * the choice, the screen renders it, and both agree on what it means through this file.
 */

/**
 * `mutual`, not `relay`. "Relay" is already taken in this codebase and means something else
 * entirely — the authenticated iroh relay servers in `transports.relay` / `relay-config.ts`,
 * which every mode here uses. Naming this one `relay` too would put two unrelated meanings on
 * the same word in the same feature. The label a person reads is still "Mutual relay".
 */
export const DELIVERY_MODES = ['direct', 'mutual', 'stash'] as const;

export type DeliveryMode = (typeof DELIVERY_MODES)[number];

export const DEFAULT_DELIVERY_MODE: DeliveryMode = 'direct';

/**
 * How long the stash holds a sealed envelope before dropping it.
 *
 * MUST match the deployed trail-stash's own retention setting — this is a promise made in the
 * UI about someone else's data, and the countdown on the delivery diagram renders from it. It
 * lives here so the copy and the animation cannot drift apart, not because the client enforces
 * it: the client cannot. Changing the server means changing this.
 */
export const STASH_RETENTION_MS = 30 * 60 * 1000;

/** What the runtime can actually offer right now. Availability is not a preference. */
export interface DeliveryAvailability {
  /** A stash is deployed for this build (`EXPO_PUBLIC_TRAIL_STASH_URL`/`TICKET`). */
  readonly stashConfigured: boolean;
  /**
   * The running native binary can carry sealed envelopes for a mutual friend. Guarded rather
   * than assumed: a phone can be running an older binary than the JS bundle, and this is the
   * newest of the three routes, so it is the one most often absent.
   */
  readonly mutualSupported: boolean;
}

export interface DeliveryModeCopy {
  readonly id: DeliveryMode;
  /** Sentence case, two to four words — the Shoreline rule for every headline and label. */
  readonly title: string;
  /** Uppercase micro-label for the segmented control. */
  readonly segment: string;
  readonly body: string;
  /** A second, quieter line. Present only where the mode has a real caveat to state. */
  readonly note: string | null;
}

export const DELIVERY_MODE_COPY: Readonly<Record<DeliveryMode, DeliveryModeCopy>> = {
  direct: {
    id: 'direct',
    title: 'Direct',
    segment: 'DIRECT',
    body: 'Send locations straight to your friends, phone to phone. Nothing else ever holds the data. Both phones have to be reachable at the same moment, which between two iPhones is rare.',
    note: null,
  },
  mutual: {
    id: 'mutual',
    title: 'Mutual relay',
    segment: 'RELAY',
    body: 'Let friends you have in common carry sealed updates for you. If your phone drops off and comes back, you can catch up from any mutual. They cannot read what they carry.',
    note: 'Mutual friends can tell that you are all friends. Nobody outside that circle can. Works best above about five mutuals.',
  },
  stash: {
    id: 'stash',
    title: 'Stash server',
    segment: 'STASH',
    body: 'Drop a sealed copy for each friend on the stash server. Only the friend it was sealed for can open it — the server never can. The most reliable of the three.',
    note: `Sealed copies are dropped after ${Math.round(STASH_RETENTION_MS / 60_000)} minutes.`,
  },
};

/** Whether a mode can be selected at all on this device, and why not when it cannot. */
export type DeliveryModeUnavailableReason = 'no-stash-deployed' | 'mutual-unsupported';

export interface DeliveryModeOption extends DeliveryModeCopy {
  readonly available: boolean;
  readonly unavailableReason: DeliveryModeUnavailableReason | null;
}

/**
 * Narrow an arbitrary stored string to a mode. Anything unrecognised — a value written by a
 * newer build the user has since rolled back from, a corrupted row — reads as the default
 * rather than as an error, because there is no useful way for a settings screen to fail here.
 */
export function parseDeliveryMode(raw: string | null | undefined): DeliveryMode {
  return DELIVERY_MODES.includes(raw as DeliveryMode)
    ? (raw as DeliveryMode)
    : DEFAULT_DELIVERY_MODE;
}

export function isDeliveryModeAvailable(
  mode: DeliveryMode,
  availability: DeliveryAvailability
): boolean {
  if (mode === 'stash') return availability.stashConfigured;
  if (mode === 'mutual') return availability.mutualSupported;
  return true;
}

function unavailableReason(
  mode: DeliveryMode,
  availability: DeliveryAvailability
): DeliveryModeUnavailableReason | null {
  if (isDeliveryModeAvailable(mode, availability)) return null;
  return mode === 'stash' ? 'no-stash-deployed' : 'mutual-unsupported';
}

/** Every mode, in picker order, each carrying whether this device can actually offer it. */
export function deliveryModeOptions(
  availability: DeliveryAvailability
): readonly DeliveryModeOption[] {
  return DELIVERY_MODES.map((mode) => ({
    ...DELIVERY_MODE_COPY[mode],
    available: isDeliveryModeAvailable(mode, availability),
    unavailableReason: unavailableReason(mode, availability),
  }));
}

/**
 * What the delivery path will *actually* do, given what the user picked and what exists.
 *
 * The distinction between chosen and effective is the point. A build with no stash deployed,
 * or a phone whose native binary predates relay, must not silently behave as though the choice
 * had been honoured — and it must not quietly rewrite the user's choice either, because the
 * same install can gain a stash on the next build and should come back to what they asked for.
 * So the preference is stored as given and resolved on every read.
 */
export function effectiveDeliveryMode(
  chosen: DeliveryMode,
  availability: DeliveryAvailability
): DeliveryMode {
  return isDeliveryModeAvailable(chosen, availability) ? chosen : DEFAULT_DELIVERY_MODE;
}

/** Whether the chosen mode is being silently downgraded, which the screen has to say out loud. */
export function isDeliveryModeDowngraded(
  chosen: DeliveryMode,
  availability: DeliveryAvailability
): boolean {
  return effectiveDeliveryMode(chosen, availability) !== chosen;
}

/**
 * Legacy migration. Delivery used to be one boolean — "offline delivery via the trail stash",
 * additive on top of a direct path that was always on. That maps exactly onto two of the three
 * modes, and nobody who had it switched on was asking for less.
 */
export function deliveryModeFromLegacyStashOptIn(optedIn: boolean): DeliveryMode {
  return optedIn ? 'stash' : 'direct';
}
