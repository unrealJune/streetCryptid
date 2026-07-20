import type {
  BleCapabilities,
  BlePeer,
  TransportAddressDiagnostic,
  TransportDiagnostics,
} from 'iroh-location';

import { buildTransportReport, type TransportInputs, type TransportRow } from '../transports';

const BLE_ON: BleCapabilities = {
  available: true,
  activeScanToggle: false,
  rssi: false,
  discoveryRefresh: false,
  pairingReady: false,
};

const CONNECTED_BLE_PEER: BlePeer = {
  deviceId: 'device-1',
  phase: 'connected',
  verifiedEndpointId: 'aa'.repeat(32),
  endpointHint: 'aa'.repeat(32),
  consecutiveFailures: 0,
  connectPath: 'ble',
};

function address(
  kind: TransportAddressDiagnostic['kind'],
  value: string,
  active: boolean
): TransportAddressDiagnostic {
  return { kind, address: `${kind}:${value}`, active };
}

function diagnostics(
  addresses: TransportAddressDiagnostic[],
  localAddresses: TransportAddressDiagnostic[] = []
): TransportDiagnostics {
  return {
    localAddresses,
    peers: [{ endpointId: 'aa'.repeat(32), known: true, addresses }],
  };
}

function baseInputs(overrides: Partial<TransportInputs> = {}): TransportInputs {
  return {
    nativeAvailable: true,
    platformOS: 'android',
    platformVersion: '36',
    nodeReady: true,
    nodeStatus: 'ready',
    selfEndpointId: 'bb'.repeat(32),
    relayUrls: ['https://relay-1.example', 'https://relay-2.example'],
    diagnostics: diagnostics([]),
    diagnosticsUpdatedAt: 1_700_000_000_000,
    diagnosticsError: null,
    ble: BLE_ON,
    blePeers: [],
    pairingSessions: [],
    nearby: null,
    stash: { available: false, optedIn: false },
    relayOnly: { enabled: false, enforced: false },
    friends: [{ endpointId: 'aa'.repeat(32), handle: 'moth', pairingMethod: 'nearby' }],
    background: { sharing: true, access: 'full' },
    ...overrides,
  };
}

function row(rows: TransportRow[], id: string): TransportRow {
  const found = rows.find((value) => value.id === id);
  if (!found) throw new Error(`no transport row "${id}"`);
  return found;
}

describe('buildTransportReport', () => {
  it('does not claim traffic is active without an observed active path', () => {
    const report = buildTransportReport(baseInputs());
    expect(row(report.rows, 'relay').status).toBe('available');
    expect(row(report.rows, 'direct').status).toBe('available');
    expect(row(report.rows, 'lan').status).toBe('available');
    expect(row(report.rows, 'ble').status).toBe('available');
    expect(row(report.rows, 'nearby').status).toBe('planned');
    expect(row(report.rows, 'stash').status).toBe('unavailable');
    expect(report.updatedAt).toBe(1_700_000_000_000);
  });

  it.each([
    ['relay', address('relay', 'https://relay.example', true)],
    ['direct', address('ip', '203.0.113.4:443', true)],
    ['lan', address('ip', '192.168.1.20:443', true)],
    ['ble', address('custom', 'ble:device-1', true)],
  ] as const)('marks %s active only from an active native path', (id, activePath) => {
    const report = buildTransportReport(baseInputs({ diagnostics: diagnostics([activePath]) }));
    expect(row(report.rows, id).status).toBe('active');
    expect(row(report.rows, id).detail).toMatch(/1 active/i);
  });

  it('surfaces detailed BLE peer state', () => {
    const { rows } = buildTransportReport(baseInputs({ blePeers: [CONNECTED_BLE_PEER] }));
    const ble = row(rows, 'ble');
    expect(ble.status).toBe('active');
    expect(ble.groups.find((group) => group.label === 'BLE PEERS')?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: 'device-1 · connected' }),
        expect.objectContaining({ label: 'Consecutive failures', value: '0' }),
      ])
    );
  });

  it('disables radio and direct paths when relay-only is on', () => {
    const report = buildTransportReport(
      baseInputs({
        diagnostics: diagnostics([
          address('relay', 'https://relay.example', true),
          address('ip', '203.0.113.4:443', true),
          address('ip', '192.168.1.20:443', true),
          address('custom', 'ble:device-1', true),
        ]),
        relayOnly: { enabled: true, enforced: true },
      })
    );
    expect(row(report.rows, 'relay').status).toBe('active');
    for (const id of ['direct', 'lan', 'ble']) {
      expect(row(report.rows, id).status).toBe('inactive');
      expect(row(report.rows, id).detail).toMatch(/relay-only/i);
    }
  });

  it('keeps observed paths honest while relay-only enforcement is pending', () => {
    const report = buildTransportReport(
      baseInputs({
        diagnostics: diagnostics([address('ip', '203.0.113.4:443', true)]),
        relayOnly: { enabled: true, enforced: false },
      })
    );
    expect(row(report.rows, 'direct').status).toBe('active');
    expect(row(report.rows, 'direct').detail).toMatch(/not enforced/i);
  });

  it('degrades local transports to n-a on web', () => {
    const { rows } = buildTransportReport(
      baseInputs({ platformOS: 'web', nativeAvailable: false })
    );
    for (const id of ['direct', 'lan', 'ble', 'nearby']) {
      expect(row(rows, id).status).toBe('n/a');
    }
    expect(row(rows, 'relay').status).toBe('available');
  });

  it('reports unavailable native and relay configurations honestly', () => {
    const noNative = buildTransportReport(baseInputs({ nativeAvailable: false, ble: null }));
    expect(row(noNative.rows, 'ble').status).toBe('unavailable');
    expect(row(noNative.rows, 'direct').status).toBe('unavailable');

    const noRelay = buildTransportReport(baseInputs({ relayUrls: [] }));
    expect(row(noRelay.rows, 'relay').status).toBe('unavailable');
    expect(row(noRelay.rows, 'relay').detail).toMatch(/No authenticated relay/i);
  });

  it('surfaces stash and future nearby state', () => {
    const on = buildTransportReport(
      baseInputs({
        stash: { available: true, optedIn: true },
        nearby: { available: true, peerCount: 1 },
      })
    );
    expect(row(on.rows, 'stash').status).toBe('active');
    expect(row(on.rows, 'nearby').status).toBe('active');
  });

  it('shows diagnostics errors in the report', () => {
    const report = buildTransportReport(
      baseInputs({ diagnostics: null, diagnosticsError: 'Native bindings are stale' })
    );
    expect(report.error).toBe('Native bindings are stale');
  });
});
