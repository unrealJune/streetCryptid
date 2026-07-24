import type {
  BleCapabilities,
  BlePeer,
  PairStateRecord,
  PeerTransportDiagnostic,
  TransportAddressDiagnostic,
  TransportDiagnostics,
} from 'iroh-location';
import type { TransportPreferences } from './persistence';

export type TransportStatus =
  'active' | 'available' | 'inactive' | 'unavailable' | 'n/a' | 'planned';

export interface TransportDetailItem {
  label: string;
  value: string;
  status?: TransportStatus;
}

export interface TransportDetailGroup {
  label: string;
  items: TransportDetailItem[];
}

export interface TransportRow {
  id: string;
  label: string;
  status: TransportStatus;
  detail: string;
  groups: TransportDetailGroup[];
}

export interface TransportReport {
  rows: TransportRow[];
  updatedAt: number | null;
  error: string | null;
}

export interface NearbyCapabilities {
  available: boolean;
  peerCount: number;
}

export interface TransportFriend {
  endpointId: string;
  handle: string;
  pairingMethod?: string;
}

export interface TransportInputs {
  nativeAvailable: boolean;
  platformOS: string;
  platformVersion: string;
  nodeReady: boolean;
  nodeStatus: string;
  selfEndpointId: string | null;
  relayUrls: string[];
  diagnostics: TransportDiagnostics | null;
  diagnosticsUpdatedAt: number | null;
  diagnosticsError: string | null;
  ble: BleCapabilities | null;
  blePeers: BlePeer[];
  pairingSessions: PairStateRecord[];
  nearby: NearbyCapabilities | null;
  stash: { available: boolean; optedIn: boolean };
  transportEnabled: TransportPreferences;
  friends: TransportFriend[];
  background: { sharing: boolean; access: string };
}

const TRANSPORT_DISABLED = 'Disabled by the transport debug controls.';

function yesNo(value: boolean): string {
  return value ? 'Yes' : 'No';
}

function shortId(value: string | null): string {
  if (!value) return 'Not available';
  return value.length > 20 ? `${value.slice(0, 10)}…${value.slice(-8)}` : value;
}

function friendName(friend: TransportFriend | undefined, endpointId: string): string {
  return friend?.handle || shortId(endpointId);
}

function addressWithoutKind(address: TransportAddressDiagnostic): string {
  const prefix = `${address.kind}:`;
  return address.address.startsWith(prefix)
    ? address.address.slice(prefix.length)
    : address.address;
}

function isLanIp(address: TransportAddressDiagnostic): boolean {
  if (address.kind !== 'ip') return false;
  const value = addressWithoutKind(address).toLowerCase();
  const host = value.startsWith('[')
    ? value.slice(1, value.indexOf(']'))
    : value.slice(0, value.lastIndexOf(':'));
  if (
    host === '::1' ||
    host.startsWith('fe80:') ||
    host.startsWith('fc') ||
    host.startsWith('fd') ||
    host.startsWith('127.') ||
    host.startsWith('10.') ||
    host.startsWith('169.254.') ||
    host.startsWith('192.168.')
  ) {
    return true;
  }
  const match = /^172\.(\d+)\./.exec(host);
  return match ? Number(match[1]) >= 16 && Number(match[1]) <= 31 : false;
}

function pathStatus(address: TransportAddressDiagnostic): TransportStatus {
  return address.active ? 'active' : 'available';
}

function matchingPaths(
  peers: PeerTransportDiagnostic[],
  predicate: (address: TransportAddressDiagnostic) => boolean
): { peer: PeerTransportDiagnostic; address: TransportAddressDiagnostic }[] {
  return peers.flatMap((peer) =>
    peer.addresses.filter(predicate).map((address) => ({ peer, address }))
  );
}

function pathItems(
  paths: { peer: PeerTransportDiagnostic; address: TransportAddressDiagnostic }[],
  friends: Map<string, TransportFriend>
): TransportDetailItem[] {
  return paths.map(({ peer, address }) => ({
    label: friendName(friends.get(peer.endpointId), peer.endpointId),
    value: `${peer.endpointId} · ${addressWithoutKind(address)} · ${
      address.active ? 'active' : 'inactive'
    }`,
    status: pathStatus(address),
  }));
}

function localAddressItems(
  diagnostics: TransportDiagnostics | null,
  predicate: (address: TransportAddressDiagnostic) => boolean
): TransportDetailItem[] {
  return (diagnostics?.localAddresses ?? []).filter(predicate).map((address, index) => ({
    label: `Address ${index + 1}`,
    value: addressWithoutKind(address),
  }));
}

function nodeItems(input: TransportInputs): TransportDetailItem[] {
  return [
    { label: 'Runtime', value: input.nodeStatus, status: input.nodeReady ? 'active' : 'inactive' },
    { label: 'Native module', value: input.nativeAvailable ? 'Loaded' : 'Unavailable' },
    { label: 'Platform', value: `${input.platformOS} ${input.platformVersion}` },
    { label: 'Endpoint', value: input.selfEndpointId ?? 'Not available' },
    {
      label: 'Background sharing',
      value: `${input.background.sharing ? 'Running' : 'Stopped'} · ${input.background.access}`,
    },
    { label: 'Relay transport', value: input.transportEnabled.relay ? 'Enabled' : 'Disabled' },
    { label: 'IP transport', value: input.transportEnabled.ip ? 'Enabled' : 'Disabled' },
    { label: 'BLE transport', value: input.transportEnabled.ble ? 'Enabled' : 'Disabled' },
  ];
}

function radioStatus(
  available: boolean,
  active: boolean,
  enabled: boolean,
  nodeReady: boolean
): TransportStatus {
  if (!enabled) return 'inactive';
  if (!available) return 'unavailable';
  if (active) return 'active';
  return nodeReady ? 'available' : 'inactive';
}

export function buildTransportReport(input: TransportInputs): TransportReport {
  const web = input.platformOS === 'web';
  const native = input.nativeAvailable && !web;
  const peers = input.diagnostics?.peers ?? [];
  const friends = new Map(input.friends.map((friend) => [friend.endpointId, friend]));

  const relayPaths = matchingPaths(peers, (address) => address.kind === 'relay');
  const directPaths = matchingPaths(peers, (address) => address.kind === 'ip' && !isLanIp(address));
  const lanPaths = matchingPaths(peers, isLanIp);
  const customPaths = matchingPaths(peers, (address) => address.kind === 'custom');
  const relayActive = relayPaths.some(({ address }) => address.active);
  const directActive = directPaths.some(({ address }) => address.active);
  const lanActive = lanPaths.some(({ address }) => address.active);
  const customActive = customPaths.some(({ address }) => address.active);
  const connectedBlePeers = input.blePeers.filter((peer) => peer.phase === 'connected');
  const bleActive = customActive || connectedBlePeers.length > 0;

  const rows: TransportRow[] = [];
  const relayConfigured = input.relayUrls.length > 0;
  rows.push({
    id: 'relay',
    label: 'Relay',
    status: !input.transportEnabled.relay
      ? 'inactive'
      : !relayConfigured
        ? 'unavailable'
        : relayActive
          ? 'active'
          : input.nodeReady
            ? 'available'
            : 'inactive',
    detail: !input.transportEnabled.relay
      ? TRANSPORT_DISABLED
      : !relayConfigured
        ? 'No authenticated relay is configured.'
        : relayActive
          ? `${relayPaths.filter(({ address }) => address.active).length} active peer relay path${relayPaths.filter(({ address }) => address.active).length === 1 ? '' : 's'}.`
          : `${input.relayUrls.length} configured; no active peer relay path observed.`,
    groups: [
      { label: 'NODE', items: nodeItems(input) },
      {
        label: 'CONFIGURED RELAYS',
        items: input.relayUrls.map((url, index) => ({ label: `Relay ${index + 1}`, value: url })),
      },
      {
        label: 'LOCAL RELAY ADDRESSES',
        items: localAddressItems(input.diagnostics, (address) => address.kind === 'relay'),
      },
      {
        label: 'PEER PATHS',
        items: pathItems(relayPaths, friends),
      },
    ],
  });

  rows.push({
    id: 'direct',
    label: 'Direct (IP)',
    status: web
      ? 'n/a'
      : !native
        ? 'unavailable'
        : !input.transportEnabled.ip
          ? 'inactive'
          : directActive
            ? 'active'
            : input.nodeReady
              ? 'available'
              : 'inactive',
    detail: web
      ? 'Not available in the browser build.'
      : !input.transportEnabled.ip
        ? TRANSPORT_DISABLED
        : directActive
          ? `${directPaths.filter(({ address }) => address.active).length} active public IP path${directPaths.filter(({ address }) => address.active).length === 1 ? '' : 's'}.`
          : 'Ready for hole-punched peer-to-peer traffic; no active public IP path observed.',
    groups: [
      { label: 'NODE', items: nodeItems(input) },
      {
        label: 'LOCAL PUBLIC ADDRESSES',
        items: localAddressItems(
          input.diagnostics,
          (address) => address.kind === 'ip' && !isLanIp(address)
        ),
      },
      { label: 'PEER PATHS', items: pathItems(directPaths, friends) },
      {
        label: 'KNOWN PEERS',
        items: peers.map((peer) => ({
          label: friendName(friends.get(peer.endpointId), peer.endpointId),
          value: peer.known
            ? `${peer.endpointId} · ${peer.addresses.length} known address(es)`
            : `${peer.endpointId} · no retained path state`,
        })),
      },
    ],
  });

  rows.push({
    id: 'lan',
    label: 'LAN (mDNS)',
    status: web
      ? 'n/a'
      : !native
        ? 'unavailable'
        : !input.transportEnabled.ip
          ? 'inactive'
          : lanActive
            ? 'active'
            : input.nodeReady
              ? 'available'
              : 'inactive',
    detail: web
      ? 'Not available in the browser build.'
      : !input.transportEnabled.ip
        ? TRANSPORT_DISABLED
        : lanActive
          ? `${lanPaths.filter(({ address }) => address.active).length} active same-network path${lanPaths.filter(({ address }) => address.active).length === 1 ? '' : 's'}.`
          : 'mDNS and ticket-seeded LAN dialing are ready; no active LAN path observed.',
    groups: [
      {
        label: 'OS SUPPORT',
        items: [
          {
            label: 'Local network access',
            value:
              input.platformOS === 'ios'
                ? 'Usage prompt configured'
                : 'Runtime permission requested before node start',
          },
          {
            label: 'Multicast',
            value:
              input.platformOS === 'ios'
                ? 'Managed entitlement declared; signed profile decides availability'
                : 'CHANGE_WIFI_MULTICAST_STATE + process-lifetime MulticastLock',
          },
          { label: 'Discovery', value: 'Custom iroh mDNS address lookup' },
        ],
      },
      { label: 'LOCAL LAN ADDRESSES', items: localAddressItems(input.diagnostics, isLanIp) },
      { label: 'PEER PATHS', items: pathItems(lanPaths, friends) },
    ],
  });

  const bleAvailable = native && (input.ble?.available ?? false);
  rows.push({
    id: 'ble',
    label: 'BLE mesh',
    status: web
      ? 'n/a'
      : radioStatus(bleAvailable, bleActive, input.transportEnabled.ble, input.nodeReady),
    detail: web
      ? 'Not available in the browser build.'
      : !bleAvailable
        ? 'No BLE transport is attached to this endpoint.'
        : !input.transportEnabled.ble
          ? TRANSPORT_DISABLED
          : bleActive
            ? `${Math.max(connectedBlePeers.length, customPaths.filter(({ address }) => address.active).length)} active BLE peer${Math.max(connectedBlePeers.length, customPaths.filter(({ address }) => address.active).length) === 1 ? '' : 's'}.`
            : `Scanning; ${input.blePeers.length} peer${input.blePeers.length === 1 ? '' : 's'} retained.`,
    groups: [
      {
        label: 'CAPABILITIES',
        items: input.ble
          ? [
              { label: 'Transport attached', value: yesNo(input.ble.available) },
              { label: 'Active scan toggle', value: yesNo(input.ble.activeScanToggle) },
              { label: 'RSSI during Bump', value: yesNo(input.ble.rssi) },
              { label: 'Discovery refresh', value: yesNo(input.ble.discoveryRefresh) },
              { label: 'Invite-less pairing armed', value: yesNo(input.ble.pairingReady) },
            ]
          : [{ label: 'Native report', value: 'Not received yet' }],
      },
      {
        label: 'BLE PEERS',
        items: input.blePeers.flatMap((peer, index) => [
          {
            label: `Peer ${index + 1}`,
            value: `${peer.deviceId} · ${peer.phase}`,
            status: peer.phase === 'connected' ? 'active' : 'available',
          },
          { label: 'Verified endpoint', value: peer.verifiedEndpointId ?? 'Not available' },
          { label: 'Endpoint hint', value: peer.endpointHint ?? 'Not available' },
          { label: 'Connect path', value: peer.connectPath ?? 'Unknown' },
          { label: 'Consecutive failures', value: String(peer.consecutiveFailures) },
        ]),
      },
      {
        label: 'LOCAL CUSTOM ADDRESSES',
        items: localAddressItems(input.diagnostics, (address) => address.kind === 'custom'),
      },
      { label: 'IROH CUSTOM PATHS', items: pathItems(customPaths, friends) },
      {
        label: 'PAIRING SESSIONS',
        items: input.pairingSessions.map((session, index) => ({
          label: `Session ${index + 1}`,
          value: `${session.peerEndpointId} · ${session.state} · ${
            session.nearby ? 'nearby' : 'invite'
          }`,
          status: session.state === 'complete' ? 'active' : 'available',
        })),
      },
    ],
  });

  const nearbyAvailable = native && (input.nearby?.available ?? false);
  rows.push({
    id: 'nearby',
    label: 'Wi-Fi Aware / Multipeer',
    status: web
      ? 'n/a'
      : input.nearby === null
        ? 'planned'
        : radioStatus(nearbyAvailable, input.nearby.peerCount > 0, true, input.nodeReady),
    detail: web
      ? 'Not available in the browser build.'
      : input.nearby === null
        ? 'High-bandwidth nearby transport is not implemented yet.'
        : `${input.nearby.peerCount} nearby peer${input.nearby.peerCount === 1 ? '' : 's'}.`,
    groups: [
      {
        label: 'IMPLEMENTATION',
        items: [
          { label: 'Android', value: 'Wi-Fi Aware planned' },
          { label: 'iOS', value: 'Multipeer Connectivity planned' },
          {
            label: 'Native capability report',
            value: input.nearby ? 'Present' : 'Not implemented',
          },
        ],
      },
    ],
  });

  rows.push({
    id: 'stash',
    label: 'Offline delivery (stash)',
    status: !input.stash.available ? 'unavailable' : input.stash.optedIn ? 'active' : 'inactive',
    detail: !input.stash.available
      ? 'No trail stash is configured.'
      : input.stash.optedIn
        ? 'Ciphertext-blind offline replication is enabled.'
        : 'Configured but not opted in.',
    groups: [
      {
        label: 'STATE',
        items: [
          { label: 'Deployment configured', value: yesNo(input.stash.available) },
          { label: 'User opted in', value: yesNo(input.stash.optedIn) },
          {
            label: 'Last native path refresh',
            value: input.diagnosticsUpdatedAt
              ? new Date(input.diagnosticsUpdatedAt).toISOString()
              : 'Never',
          },
        ],
      },
    ],
  });

  return {
    rows,
    updatedAt: input.diagnosticsUpdatedAt,
    error: input.diagnosticsError,
  };
}
