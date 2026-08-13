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
 * come off the backfill path and are exact.
 */

/** Terse uppercase badge for the history rows (matches the sheet's `type="code"` treatment). */
export function fixTransportBadge(via: FixTransport | undefined): string {
  switch (via) {
    case 'relay':
      return 'RELAY';
    case 'direct':
      return 'DIRECT';
    case 'lan':
      return 'LAN';
    case 'ble':
      return 'BLE';
    case 'live':
      return 'LIVE';
    case 'docs':
      return 'TRAIL';
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
      return 'received live, nearest open path a relay';
    case 'direct':
      return 'received live, nearest open path a direct connection';
    case 'lan':
      return 'received live, nearest open path the local network';
    case 'ble':
      return 'received live, nearest open path Bluetooth';
    case 'live':
      return 'received live';
    case 'docs':
      return "recovered from a friend's durable trail";
    case 'stash':
      return 'recovered from the trail stash';
    case 'sync':
      return 'recovered from the durable trail';
    case undefined:
      return 'transport unknown';
  }
}
