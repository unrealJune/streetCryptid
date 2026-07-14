import type { BleCapabilities } from 'iroh-location';

/**
 * Honest transport-diagnostic model. The report is assembled by a pure function from signals we
 * can actually observe (native module present, BLE capability report, nearby-peer counts, stash
 * opt-in, relay config, relay-only mode) — it never fabricates a "connected" state we can't see.
 * All environment / platform reads happen at the call site and are injected here so the builder
 * stays trivially unit-testable. See docs/social/ARCHITECTURE.md §2.
 */

/** Coarse, honest status for a single transport row. */
export type TransportStatus =
  /** Wired in and carrying (or actively able to carry) traffic right now. */
  | 'active'
  /** Wired in and usable, but nothing is flowing over it at the moment. */
  | 'available'
  /** Present but deliberately turned off (e.g. disabled by relay-only, or opt-in that's off). */
  | 'inactive'
  /** Not usable here (no radio, misconfigured, or wrong platform). */
  | 'unavailable'
  /** Not applicable on this platform (e.g. radios on web). */
  | 'n/a'
  /** Designed but not yet built into this build. */
  | 'planned';

/** A single transport as surfaced in the Settings diagnostic. */
export interface TransportRow {
  /** Stable key for lists. */
  id: string;
  /** Human label, e.g. "BLE mesh". */
  label: string;
  status: TransportStatus;
  /** Short, honest one-liner about why it's in this state. */
  detail: string;
}

export interface TransportReport {
  rows: TransportRow[];
}

/** Nearby (Wi-Fi Aware / Multipeer) capability report — mirrors the native `nearby_capabilities`. */
export interface NearbyCapabilities {
  available: boolean;
  peerCount: number;
}

/** Everything the pure builder needs; all reads are done by the caller and injected. */
export interface TransportInputs {
  /** The native `IrohLocation` module is present (false on web / Expo Go). */
  nativeAvailable: boolean;
  /** `Platform.OS`. */
  platformOS: string;
  /** Whether the node has finished starting (transports only carry traffic once ready). */
  nodeReady: boolean;
  /** Whether at least one relay URL is configured. */
  relayConfigured: boolean;
  /** How many relay URLs are configured. */
  relayCount: number;
  /** BLE capability report from the snapshot, or null when not yet polled / unavailable. */
  ble: BleCapabilities | null;
  /** Count of nearby BLE peers currently surfaced by the transport. */
  blePeerCount: number;
  /** Nearby (Wi-Fi Aware / Multipeer) capabilities, or null until Phase 3 lands. */
  nearby: NearbyCapabilities | null;
  /** Offline-delivery trail stash: deployed + opted in. */
  stash: { available: boolean; optedIn: boolean };
  /** User forced relay-only, and whether that's actually enforced natively yet. */
  relayOnly: { enabled: boolean; enforced: boolean };
}

const RADIO_OFF_BY_RELAY_ONLY = 'Disabled while relay-only is on.';

/** Radio-transport status shared by BLE + nearby: unavailable / off-by-relay-only / active / available. */
function radioStatus(
  available: boolean,
  peerCount: number,
  relayOnly: boolean,
  nodeReady: boolean
): TransportStatus {
  if (!available) return 'unavailable';
  if (relayOnly) return 'inactive';
  if (peerCount > 0) return 'active';
  return nodeReady ? 'available' : 'inactive';
}

/**
 * Build the transport diagnostic from observable signals. Pure: no env, Platform, or module reads.
 */
export function buildTransportReport(input: TransportInputs): TransportReport {
  const web = input.platformOS === 'web';
  const native = input.nativeAvailable && !web;
  const relayOnly = input.relayOnly.enabled;

  const rows: TransportRow[] = [];

  // Relay — the authenticated always-on internet path. It's the one transport relay-only keeps.
  rows.push({
    id: 'relay',
    label: 'Relay',
    status: input.relayConfigured ? (input.nodeReady ? 'active' : 'available') : 'unavailable',
    detail: input.relayConfigured
      ? `${input.relayCount} relay${input.relayCount === 1 ? '' : 's'} configured.`
      : 'No relay URLs configured (EXPO_PUBLIC_IROH_RELAY_URLS).',
  });

  // Direct / IP — hole-punched peer-to-peer over the internet.
  rows.push({
    id: 'direct',
    label: 'Direct (IP)',
    status: web
      ? 'n/a'
      : !native
        ? 'unavailable'
        : relayOnly
          ? 'inactive'
          : input.nodeReady
            ? 'available'
            : 'inactive',
    detail: web
      ? 'Not available in the browser build.'
      : relayOnly
        ? RADIO_OFF_BY_RELAY_ONLY
        : 'Hole-punched peer-to-peer over the internet.',
  });

  // LAN (mDNS) — same-Wi-Fi direct discovery.
  rows.push({
    id: 'lan',
    label: 'LAN (mDNS)',
    status: web
      ? 'n/a'
      : !native
        ? 'unavailable'
        : relayOnly
          ? 'inactive'
          : input.nodeReady
            ? 'available'
            : 'inactive',
    detail: web
      ? 'Not available in the browser build.'
      : relayOnly
        ? RADIO_OFF_BY_RELAY_ONLY
        : 'Finds friends on the same Wi-Fi (best-effort; needs OS multicast).',
  });

  // BLE mesh — nearby, no internet.
  const bleAvailable = native && (input.ble?.available ?? false);
  rows.push({
    id: 'ble',
    label: 'BLE mesh',
    status: web ? 'n/a' : radioStatus(bleAvailable, input.blePeerCount, relayOnly, input.nodeReady),
    detail: web
      ? 'Not available in the browser build.'
      : !bleAvailable
        ? 'No BLE transport on this device/build.'
        : relayOnly
          ? RADIO_OFF_BY_RELAY_ONLY
          : input.blePeerCount > 0
            ? `${input.blePeerCount} nearby peer${input.blePeerCount === 1 ? '' : 's'}.`
            : 'Scanning for nearby cryptids over Bluetooth.',
  });

  // Wi-Fi Aware / Multipeer — high-bandwidth nearby (Phase 3).
  const nearbyAvailable = native && (input.nearby?.available ?? false);
  rows.push({
    id: 'nearby',
    label: 'Wi-Fi Aware / Multipeer',
    status: web
      ? 'n/a'
      : input.nearby === null
        ? 'planned'
        : radioStatus(nearbyAvailable, input.nearby.peerCount, relayOnly, input.nodeReady),
    detail: web
      ? 'Not available in the browser build.'
      : input.nearby === null
        ? 'Coming soon: high-bandwidth local transport, no internet.'
        : !nearbyAvailable
          ? 'Not supported on this device/build.'
          : relayOnly
            ? RADIO_OFF_BY_RELAY_ONLY
            : input.nearby.peerCount > 0
              ? `${input.nearby.peerCount} nearby peer${input.nearby.peerCount === 1 ? '' : 's'}.`
              : 'Discovering nearby cryptids over local Wi-Fi.',
  });

  // Trail stash — ciphertext-blind offline delivery relay.
  rows.push({
    id: 'stash',
    label: 'Offline delivery (stash)',
    status: !input.stash.available ? 'unavailable' : input.stash.optedIn ? 'active' : 'inactive',
    detail: !input.stash.available
      ? 'No trail stash deployed for this app.'
      : input.stash.optedIn
        ? 'A blind relay holds your sealed trail so offline friends still receive it.'
        : 'Off — turn on Offline delivery to use it.',
  });

  return { rows };
}
