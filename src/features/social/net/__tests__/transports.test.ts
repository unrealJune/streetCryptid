import type { BleCapabilities } from 'iroh-location';

import { buildTransportReport, type TransportInputs, type TransportRow } from '../transports';

const BLE_ON: BleCapabilities = {
  available: true,
  activeScanToggle: false,
  rssi: false,
  discoveryRefresh: false,
  pairingReady: false,
};

function baseInputs(overrides: Partial<TransportInputs> = {}): TransportInputs {
  return {
    nativeAvailable: true,
    platformOS: 'android',
    nodeReady: true,
    relayConfigured: true,
    relayCount: 2,
    ble: BLE_ON,
    blePeerCount: 0,
    nearby: null,
    stash: { available: false, optedIn: false },
    relayOnly: { enabled: false, enforced: false },
    ...overrides,
  };
}

function row(rows: TransportRow[], id: string): TransportRow {
  const found = rows.find((r) => r.id === id);
  if (!found) throw new Error(`no transport row "${id}"`);
  return found;
}

describe('buildTransportReport', () => {
  it('reports the full stack on a ready native node', () => {
    const { rows } = buildTransportReport(baseInputs());
    expect(row(rows, 'relay').status).toBe('active');
    expect(row(rows, 'relay').detail).toContain('2 relays');
    expect(row(rows, 'direct').status).toBe('available');
    expect(row(rows, 'lan').status).toBe('available');
    expect(row(rows, 'ble').status).toBe('available');
    expect(row(rows, 'nearby').status).toBe('planned');
    expect(row(rows, 'stash').status).toBe('unavailable');
  });

  it('marks a BLE transport with live peers active', () => {
    const { rows } = buildTransportReport(baseInputs({ blePeerCount: 3 }));
    const ble = row(rows, 'ble');
    expect(ble.status).toBe('active');
    expect(ble.detail).toContain('3 nearby peers');
  });

  it('disables every radio + direct/LAN when relay-only is on', () => {
    const { rows } = buildTransportReport(
      baseInputs({ blePeerCount: 3, relayOnly: { enabled: true, enforced: true } })
    );
    // Relay stays active; everything local goes inactive.
    expect(row(rows, 'relay').status).toBe('active');
    for (const id of ['direct', 'lan', 'ble']) {
      expect(row(rows, id).status).toBe('inactive');
      expect(row(rows, id).detail).toMatch(/relay-only/i);
    }
  });

  it('degrades radios/direct to n-a on web, keeping relay + stash', () => {
    const { rows } = buildTransportReport(
      baseInputs({ platformOS: 'web', nativeAvailable: false })
    );
    for (const id of ['direct', 'lan', 'ble', 'nearby']) {
      expect(row(rows, id).status).toBe('n/a');
    }
    expect(row(rows, 'relay').status).toBe('active');
  });

  it('reports BLE unavailable when the native module is absent', () => {
    const { rows } = buildTransportReport(
      baseInputs({ platformOS: 'android', nativeAvailable: false, ble: null })
    );
    expect(row(rows, 'ble').status).toBe('unavailable');
    expect(row(rows, 'direct').status).toBe('unavailable');
  });

  it('flags a missing relay configuration', () => {
    const { rows } = buildTransportReport(baseInputs({ relayConfigured: false, relayCount: 0 }));
    const relay = row(rows, 'relay');
    expect(relay.status).toBe('unavailable');
    expect(relay.detail).toMatch(/EXPO_PUBLIC_IROH_RELAY_URLS/);
  });

  it('surfaces stash state from opt-in', () => {
    const on = buildTransportReport(baseInputs({ stash: { available: true, optedIn: true } }));
    expect(row(on.rows, 'stash').status).toBe('active');
    const off = buildTransportReport(baseInputs({ stash: { available: true, optedIn: false } }));
    expect(row(off.rows, 'stash').status).toBe('inactive');
  });

  it('activates the nearby row once real capabilities arrive', () => {
    const { rows } = buildTransportReport(
      baseInputs({ nearby: { available: true, peerCount: 1 } })
    );
    const nearby = row(rows, 'nearby');
    expect(nearby.status).toBe('active');
    expect(nearby.detail).toContain('1 nearby peer');
  });

  it('downgrades active transports to inactive/available before the node is ready', () => {
    const { rows } = buildTransportReport(baseInputs({ nodeReady: false }));
    expect(row(rows, 'relay').status).toBe('available');
    expect(row(rows, 'ble').status).toBe('inactive');
    expect(row(rows, 'direct').status).toBe('inactive');
  });
});
