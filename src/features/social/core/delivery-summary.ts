import { fixTransportBadge, fixTransportDescription } from './fix-transport';
import type { DeliveryDetail, FixTransport } from './types';

/**
 * Turns a {@link DeliveryDetail} into the rows the signal-path tooltip shows.
 *
 * Kept separate from the sheet so the wording is testable without rendering, and so the one claim
 * that matters stays in one place: this describes a SINGLE HOP. `from` is the neighbour that handed
 * the envelope over, which with epidemic gossip is frequently neither the fix's author nor a
 * friend. Nothing here is a route, and the UI must never imply one.
 */

export interface DeliveryRow {
  label: string;
  value: string;
}

export interface DeliveryPathRow {
  /** `RELAY` | `DIRECT` | `LAN` | `BLE`. */
  kind: string;
  address: string;
  active: boolean;
}

export interface DeliverySummary {
  /** Badge for the tooltip heading — matches the row the user long-pressed. */
  badge: string;
  /** Spoken/plain description of the transport. */
  description: string;
  rows: DeliveryRow[];
  /** Every path known to the delivering peer at the time. Empty on the backfill path. */
  paths: DeliveryPathRow[];
  /** The one-hop caveat, shown as a footnote so the tooltip never reads as a traceroute. */
  note: string;
}

const LIVE_NOTE =
  'Gossip is epidemic, so this is the peer that handed the fix over — not necessarily who recorded it. The route before that hop is not carried in the envelope.';
const BACKFILL_NOTE =
  'Recovered from the durable trail rather than a live broadcast, so there is no gossip neighbour or path set to report.';
const UNKNOWN_NOTE = 'This build of the native core did not report delivery detail.';

/** `7f3a91c2…b41d` — enough to compare against a peer id by eye without filling the sheet. */
export function shortEndpointId(id: string): string {
  return id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

/** Never claims a name it was not given: an unknown peer shows its id, not "Unknown friend". */
function peerName(id: string, handleFor?: (endpointId: string) => string | undefined): string {
  if (!id) return 'Not reported';
  const handle = handleFor?.(id);
  return handle ? `${handle} · ${shortEndpointId(id)}` : shortEndpointId(id);
}

export function buildDeliverySummary(
  via: FixTransport | undefined,
  delivery: DeliveryDetail | undefined,
  handleFor?: (endpointId: string) => string | undefined
): DeliverySummary {
  const badge = fixTransportBadge(via);
  const description = fixTransportDescription(via);

  if (!delivery) {
    return { badge, description, rows: [], paths: [], note: UNKNOWN_NOTE };
  }

  const rows: DeliveryRow[] = [];
  const backfill = delivery.paths.length === 0;

  if (delivery.fromStash) {
    rows.push({ label: 'SERVED BY', value: `Trail stash · ${shortEndpointId(delivery.from)}` });
  } else {
    rows.push({
      label: backfill ? 'SERVED BY' : 'HANDED OVER BY',
      value: peerName(delivery.from, handleFor),
    });
  }

  const active = delivery.paths.find((path) => path.active);
  if (active) rows.push({ label: 'OVER', value: active.address });

  return {
    badge,
    description,
    rows,
    paths: delivery.paths.map((path) => ({
      kind: path.kind.toUpperCase(),
      address: path.address,
      active: path.active,
    })),
    note: backfill ? BACKFILL_NOTE : LIVE_NOTE,
  };
}
