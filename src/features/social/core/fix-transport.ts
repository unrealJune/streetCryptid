import type { FixTransport } from './types';

/**
 * Display strings for {@link FixTransport} — how a stored fix reached this device.
 *
 * The wording deliberately describes the LAST HOP into this device, never a link between the two
 * friends: gossip is epidemic, so a live fix may have been forwarded by any neighbour in the swarm,
 * and a stashed fix was served by the mirror rather than by the friend.
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
      return 'received live over a relay';
    case 'direct':
      return 'received live over a direct connection';
    case 'lan':
      return 'received live over the local network';
    case 'ble':
      return 'received live over Bluetooth';
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
