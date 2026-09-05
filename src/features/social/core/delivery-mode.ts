/**
 * How a sealed location envelope is allowed to travel from this phone to a friend's.
 *
 * Two routes, chosen as one exclusive setting rather than a switch, because they are genuinely
 * alternatives: mutual relay trades the fact of your friendships to your own pool for
 * resilience, and the stash adds a blind server on top of that for reach.
 *
 * There is deliberately no "direct only" route. Confining delivery to the intended recipient is
 * not a setting this app can express: a friend subscribes to your gossip topic, so a live
 * envelope reaches the swarm whether or not you pushed your namespace at them. Offering the
 * choice would have meant showing people a narrower picture of where their location goes than
 * what actually happens.
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
 * which both modes here use. Naming this one `relay` too would put two unrelated meanings on
 * the same word in the same feature. The label a person reads is still "Mutual relay".
 */
export const DELIVERY_MODES = ['mutual', 'stash'] as const;

export type DeliveryMode = (typeof DELIVERY_MODES)[number];

/**
 * `mutual`, because that is what the app already does.
 *
 * Every publish live-syncs the author's namespace to every pool member (`durablePeerTickets`),
 * and every pool member bootstraps every other member's topic, so any friend with the app open
 * holds your entries as they are written and can hand them on once you go dark. That is peer
 * relay, it is the only behaviour that ships, and it is gated by two deterministic Rust tests
 * plus `scripts/e2e/relay-e2e.sh` on three devices. See `scripts/e2e/PEER-RELAY-STATUS.md`.
 */
export const DEFAULT_DELIVERY_MODE: DeliveryMode = 'mutual';

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
  mutual: {
    id: 'mutual',
    title: 'Mutual relay',
    segment: 'RELAY',
    body: 'Friends you have in common carry sealed updates for you. If your phone drops off and comes back, you can catch up from any of them. They cannot read what they carry — they hold a read ticket, not a key.',
    note: 'Friends in a shared pool can tell that you are all friends. Nobody outside it can.',
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
export type DeliveryModeUnavailableReason = 'no-stash-deployed';

export interface DeliveryModeOption extends DeliveryModeCopy {
  readonly available: boolean;
  readonly unavailableReason: DeliveryModeUnavailableReason | null;
}

/**
 * Narrow an arbitrary stored string to a mode. Anything unrecognised — a value written by a
 * newer build the user has since rolled back from, a corrupted row, or the short-lived
 * `direct` this picker briefly offered — reads as the default rather than as an error,
 * because there is no useful way for a settings screen to fail here.
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
  // `mutual` is the floor, never unavailable: there is no configuration of this app in which
  // pool members cannot serve for each other. Only the stash can be absent.
  return mode === 'stash' ? availability.stashConfigured : true;
}

function unavailableReason(
  mode: DeliveryMode,
  availability: DeliveryAvailability
): DeliveryModeUnavailableReason | null {
  return isDeliveryModeAvailable(mode, availability) ? null : 'no-stash-deployed';
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
 * The distinction between chosen and effective is the point, and it points one way that
 * matters more than the other: a picker must never UNDERSTATE where your location goes. A
 * build with no stash deployed must not behave as though `stash` had been honoured. Falling
 * back to `mutual` is the safe direction — it is what the app is actually doing. The stored
 * preference is kept as given and resolved on every read, because the same install can gain a
 * stash on a later build and should come back to what was asked for.
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
 * additive on top of a path that was always on. That path was never `direct`: it pushed to the
 * whole pool. So the boolean maps onto `stash` and `mutual`, and an install that had it off
 * migrates to `mutual` because that is what it was already doing.
 */
export function deliveryModeFromLegacyStashOptIn(optedIn: boolean): DeliveryMode {
  return optedIn ? 'stash' : 'mutual';
}
