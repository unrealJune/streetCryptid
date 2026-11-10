import type { FixTransport } from './types';

/**
 * Display strings for {@link FixTransport} — how a stored fix reached this device.
 *
 * Every friend fix is replicated through iroh-docs, so the label never names a link or a path: it
 * says whether a serving peer was recorded (`docs`) or the entry was simply read back out of this
 * phone's replica (`sync`). WHO served it is a separate, exact fact recorded beside the label, and
 * {@link describeDelivery} is the only place that interprets it.
 */

/** Terse uppercase badge for the history rows (matches the sheet's `type="code"` treatment). */
export function fixTransportBadge(via: FixTransport | undefined): string {
  switch (via) {
    case 'docs':
      return 'TRAIL';
    case 'sync':
      return 'SYNCED';
    case undefined:
      return '—';
  }
}

/** Spoken form for accessibility labels. */
export function fixTransportDescription(via: FixTransport | undefined): string {
  switch (via) {
    case 'docs':
      return "replicated from a peer's copy of their trail";
    case 'sync':
      return "read from this phone's copy of their trail";
    case undefined:
      return 'delivery not recorded';
  }
}

/** Who served the entry, once the raw endpoint has been matched against what we know. */
export type DeliveryPeerKind =
  /** The author's own device served it — no other device was involved. */
  | 'author'
  /** A friend in this device's pool. Named. */
  | 'friend'
  /** The configured trail stash. */
  | 'stash'
  /** A device we have never paired with — another holder of the author's namespace. */
  | 'stranger'
  /** Nobody was recorded serving it (read back from the replica), or the binary predates this. */
  | 'unknown';

export interface DeliveryProvenance {
  readonly kind: DeliveryPeerKind;
  /** One line naming the server, e.g. `Served by @owlbear`. */
  readonly headline: string;
  /** One sentence saying what that means for this fix. */
  readonly detail: string;
  /** Short endpoint id, present only for a `stranger` — the one case with no name to show. */
  readonly peerId?: string;
}

export interface DeliveryProvenanceInput {
  /** Raw endpoint id of the serving device, as recorded with the fix. */
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

/** Endpoint ids are 64 hex chars; six is enough to tell two peers apart at a glance. */
export function shortEndpoint(endpointId: string): string {
  return `${endpointId.slice(0, 6)}…`;
}

function normalise(endpointId: string): string {
  return endpointId.trim().toLowerCase();
}

/**
 * Turn the stored serving peer into the line the SIGNAL PATH row expands to.
 *
 * The server is usually NOT the author: reconciliation is served by whichever device holds the
 * entry, and every friend of the author holds their namespace. That set is the author's, not ours —
 * so a server we have not paired with is an ordinary case, not an anomaly, and gets a short endpoint
 * id rather than a name we do not have.
 *
 * Pure and total: every state, including "we don't know", has a sentence. Nothing here may claim a
 * delivery that was not observed — an absent peer says so plainly rather than falling back to the
 * friendlier-sounding "straight from her phone".
 */
export function describeDelivery(input: DeliveryProvenanceInput): DeliveryProvenance {
  const { authorHandle } = input;
  const peer = input.viaPeer ? normalise(input.viaPeer) : null;

  if (!peer) {
    return {
      kind: 'unknown',
      headline: 'Server not recorded',
      detail: `This fix was read back out of this phone's replica, so no peer was recorded serving ${authorHandle}'s entry.`,
    };
  }

  const stash = input.stashEndpointId ? normalise(input.stashEndpointId) : null;
  if (stash && peer === stash) {
    return {
      kind: 'stash',
      headline: 'Served by the trail stash',
      detail: `The stash held ${authorHandle}'s sealed fix until this device asked for it. It could not read it.`,
    };
  }

  if (peer === normalise(input.author)) {
    return {
      kind: 'author',
      headline: `Straight from ${authorHandle}'s phone`,
      detail: 'No other device carried this one — it came from the phone that made it.',
    };
  }

  const handle = input.friendHandles.get(peer);
  if (handle) {
    return {
      kind: 'friend',
      headline: `Served by ${handle}`,
      detail: `Replicated from ${handle}'s copy of ${authorHandle}'s trail. Sealed the whole way — ${handle} could not read it.`,
    };
  }

  return {
    kind: 'stranger',
    headline: "Served by a device you haven't paired with",
    detail: `Another of ${authorHandle}'s friends served this from their copy. Sealed the whole way — they could not read it.`,
    peerId: shortEndpoint(peer),
  };
}
