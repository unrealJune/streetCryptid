import type { FixTransport } from './types';

/**
 * Display strings for {@link FixTransport} — how a stored fix reached this device.
 *
 * The wording deliberately describes the LAST HOP into this device, never a link between the two
 * friends: gossip is epidemic, so a live fix may have been forwarded by any neighbour in the swarm,
 * and a stashed fix was served by the mirror rather than by the friend.
 *
 * For the four live-gossip transports the label is the CLOSEST open path to that neighbour, not a
 * measurement of the packet's route — iroh holds every usable path open at once (a hole-punched
 * direct path never retires the relay fallback) and exposes only the set, never the carrier. See
 * `delivery_label` in `modules/iroh-location/rust/src/lib.rs` for the ranking and why picking the
 * first active path instead made two phones disagree about the same link. `docs` / `stash` / `sync`
 * describe replica sync; its recorded entry provider may differ from the content supplier.
 *
 * This legacy display is not the measured connection statistics. {@link describeDelivery}
 * interprets its recorded forwarder / entry provider without claiming a packet route.
 */

/** Terse uppercase badge for the history rows (matches the sheet's `type="code"` treatment). */
export function fixTransportBadge(via: FixTransport | undefined): string {
  switch (via) {
    case 'relay':
      return 'INTERNET RELAY';
    case 'direct':
      return 'DIRECT IP';
    case 'lan':
      return 'LOCAL IP';
    case 'ble':
      return 'BLUETOOTH';
    case 'live':
      return 'BROADCAST';
    case 'docs':
      return 'REPLICA';
    case 'stash':
      return 'STASH';
    case 'sync':
      return 'SYNCED';
    case undefined:
      return '—';
  }
}

/** Spoken form for accessibility labels, e.g. "received over a relay". */
export function fixTransportDescription(via: FixTransport | undefined): string {
  switch (via) {
    case 'relay':
      return 'received by live broadcast, nearest open path an internet relay';
    case 'direct':
      return 'received by live broadcast, nearest open path direct IP';
    case 'lan':
      return 'received by live broadcast, nearest open path private or link-local IP';
    case 'ble':
      return 'received by live broadcast, nearest open path Bluetooth';
    case 'live':
      return 'received by live broadcast';
    case 'docs':
      return 'recovered by replica sync';
    case 'stash':
      return 'replica entry received from the stash server';
    case 'sync':
      return 'recovered from the durable trail';
    case undefined:
      return 'transport unknown';
  }
}

/** Who performed the last hop, once the raw endpoint has been matched against what we know. */
export type DeliveryPeerKind =
  /** The author's own device handed it over — no forwarding happened. */
  | 'author'
  /** A friend in this device's pool. Named. */
  | 'friend'
  /** The configured trail stash. */
  | 'stash'
  /** A device we have never paired with — another recipient in the author's swarm. */
  | 'stranger'
  /** Nobody delivered it on this path (read back from the replica), or the binary predates this. */
  | 'unknown';

export interface DeliveryProvenance {
  readonly kind: DeliveryPeerKind;
  /** One line naming the deliverer, e.g. `Forwarded by @owlbear`. */
  readonly headline: string;
  /** One sentence saying what that means for this fix. */
  readonly detail: string;
  /** Short endpoint id, present only for a `stranger` — the one case with no name to show. */
  readonly peerId?: string;
}

export interface DeliveryProvenanceInput {
  readonly via: FixTransport | undefined;
  /** Raw endpoint id of the delivering device, as recorded with {@link via}. */
  readonly viaPeer: string | undefined;
  /** The fix's author — the friend whose profile this is. */
  readonly author: string;
  /** That friend's handle, for the sentences that name them. */
  readonly authorHandle: string;
  /** Endpoint id → handle for every friend in the pool. */
  readonly friendHandles: ReadonlyMap<string, string>;
  /** Endpoint id of the configured trail stash, when it is known. */
  readonly stashEndpointId?: string | null;
}

/** Endpoint ids are 64 hex chars; six is enough to tell two neighbours apart at a glance. */
export function shortEndpoint(endpointId: string): string {
  return `${endpointId.slice(0, 6)}…`;
}

function normalise(endpointId: string): string {
  return endpointId.trim().toLowerCase();
}

/**
 * Whether {@link via} describes a durable-replica recovery rather than a live receipt. The two
 * need different sentences: one peer *forwarded* a broadcast, the other *served* a stored entry.
 */
function isRecovered(via: FixTransport | undefined): boolean {
  return via === 'docs' || via === 'stash' || via === 'sync';
}

/**
 * Turn the stored `(via, viaPeer)` pair into the line the SIGNAL PATH row expands to.
 *
 * The whole point is that the deliverer is usually NOT the author: gossip is epidemic, so a fix
 * can reach this phone through any device subscribed to the author's topic, and reconciliation is
 * served by whichever peer holds the entry. That neighbourhood is the author's, not ours — so a
 * deliverer we have not paired with is an ordinary case, not an anomaly, and gets a short endpoint
 * id rather than a name we do not have.
 *
 * Pure and total: every state, including "we don't know", has a sentence. Nothing here may claim
 * a delivery that was not observed — an absent peer says so plainly rather than falling back to
 * the friendlier-sounding "straight from her phone".
 */
export function describeDelivery(input: DeliveryProvenanceInput): DeliveryProvenance {
  const { via, authorHandle } = input;
  const recovered = isRecovered(via);
  const peer = input.viaPeer ? normalise(input.viaPeer) : null;

  if (!peer) {
    return {
      kind: 'unknown',
      headline: 'Deliverer not recorded',
      detail: recovered
        ? `This fix was read back out of the durable replica, so no peer handed it over on this pass.`
        : `This device did not record which neighbour carried ${authorHandle}'s fix here.`,
    };
  }

  const stash = input.stashEndpointId ? normalise(input.stashEndpointId) : null;
  if (stash && peer === stash) {
    return {
      kind: 'stash',
      headline: 'Replica entry from the stash server',
      detail: `The stash held ${authorHandle}'s encrypted replica entry. The content may have downloaded from another device.`,
    };
  }

  if (peer === normalise(input.author)) {
    return {
      kind: 'author',
      headline: recovered
        ? `Replica entry from ${authorHandle}'s phone`
        : `Straight from ${authorHandle}'s phone`,
      detail: recovered
        ? 'The signed entry came from their phone. Its encrypted content may have downloaded from another device.'
        : 'Their phone delivered this broadcast. Its connection may still have used an internet relay.',
    };
  }

  const handle = input.friendHandles.get(peer);
  if (handle) {
    return {
      kind: 'friend',
      headline: recovered ? `Replica entry from ${handle}` : `Forwarded by ${handle}`,
      detail: recovered
        ? `Entry from ${handle}'s replica of ${authorHandle}'s trail. Its encrypted content may have downloaded from another device.`
        : `${handle} carried ${authorHandle}'s sealed fix to this phone. They could not read it.`,
    };
  }

  return {
    kind: 'stranger',
    headline: recovered
      ? 'Replica entry from another device'
      : "Forwarded by a device you haven't paired with",
    detail: recovered
      ? `Another device supplied the signed entry for ${authorHandle}'s update. Its encrypted content may have downloaded from a different device.`
      : `Another of ${authorHandle}'s friends carried it here. Sealed the whole way — they could not read it.`,
    peerId: shortEndpoint(peer),
  };
}
