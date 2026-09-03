/**
 * `device.health` reporting what the native location runtime is actually doing.
 *
 * `task.location_running` alone is necessary and nowhere near sufficient. On 2026-08-30 it was
 * `true` on a phone that had published nothing for 88 minutes, and no other span could tell that
 * apart from a phone whose owner simply had not moved — a parked iPhone emits nothing by
 * construction. `location.state` is which of the two it is, `location.wake_reason` is what last ran
 * it, and `location.fence_registered` is whether the thing meant to resurrect it exists at all.
 */

import {
  getEventLog,
  resetEventLogForTesting,
  setTelemetryForTesting,
} from '@/features/dev/telemetry';
import { createTelemetry } from '@/features/dev/telemetry/telemetry';

const mockNativeHolder: {
  state: (() => Record<string, unknown>) | undefined;
  watermarks:
    | (() => Promise<{
        lastAcceptedAt: number | null;
        lastPublishedAt: number | null;
        lastPushedAt: number | null;
      }>)
    | undefined;
  sharingRecipients: (() => Promise<string[]>) | undefined;
} = {
  state: undefined,
  watermarks: undefined,
  sharingRecipients: undefined,
};

jest.mock('iroh-location', () => ({
  ...jest.requireActual('iroh-location'),
  tryGetIrohLocation: () => ({
    nativeBackgroundRunning: () => true,
    nativeBackgroundState: mockNativeHolder.state,
    publishWatermarks: mockNativeHolder.watermarks,
    sharingRecipients: mockNativeHolder.sharingRecipients,
  }),
}));

// eslint-disable-next-line import/first
import { recordDeviceHealth } from '../device-health';

function attributes(): Record<string, unknown> {
  const entry = getEventLog().find((e) => e.action === 'device.health');
  return (entry?.details as { attributes: Record<string, unknown> })?.attributes ?? {};
}

describe('device.health — native runtime state', () => {
  beforeEach(() => {
    resetEventLogForTesting();
    setTelemetryForTesting(createTelemetry({ now: () => 1_000 }));
    mockNativeHolder.state = undefined;
    mockNativeHolder.watermarks = undefined;
    mockNativeHolder.sharingRecipients = undefined;
  });

  afterEach(() => setTelemetryForTesting(undefined));

  it('flattens the runtime snapshot under location.*', async () => {
    mockNativeHolder.state = () => ({
      running: true,
      state: 'stopped',
      wake_reason: 'geofence_exit',
      auth_status: 'always',
      fence_registered: true,
      anchor_age_ms: 4_200,
    });

    await recordDeviceHealth('refresh');

    expect(attributes()).toMatchObject({
      'location.state': 'stopped',
      'location.wake_reason': 'geofence_exit',
      'location.auth_status': 'always',
      'location.fence_registered': true,
      'location.anchor_age_ms': 4_200,
    });
  });

  it('distinguishes a parked phone from one that has stopped waking', async () => {
    // The pair of records this exists to make different. Both publish nothing; only one is healthy.
    mockNativeHolder.state = () => ({ state: 'stopped', fence_registered: true });
    await recordDeviceHealth('refresh');
    expect(attributes()['location.state']).toBe('stopped');
    expect(attributes()['location.fence_registered']).toBe(true);

    resetEventLogForTesting();
    mockNativeHolder.state = () => ({ state: 'moving', fence_registered: false });
    await recordDeviceHealth('refresh');
    expect(attributes()['location.state']).toBe('moving');
    expect(attributes()['location.fence_registered']).toBe(false);
  });

  it('omits non-scalar fields rather than stringifying them to [object Object]', async () => {
    mockNativeHolder.state = () => ({ state: 'moving', anchor: { lat: 1, lon: 2 } });
    await recordDeviceHealth('refresh');
    expect(attributes()['location.state']).toBe('moving');
    expect(attributes()['location.anchor']).toBeUndefined();
  });

  it('stays silent on a binary that predates the export', async () => {
    // Guarded rather than assumed: a phone can be running an older binary than the JS bundle.
    mockNativeHolder.state = undefined;
    await expect(recordDeviceHealth('refresh')).resolves.not.toThrow();
    expect(attributes()['location.state']).toBeUndefined();
    // ...and the record it does emit is otherwise intact.
    expect(attributes()['task.location_running']).toBe(true);
  });

  it('omits the section rather than failing the record when the read throws', async () => {
    mockNativeHolder.state = () => {
      throw new Error('runtime has never started');
    };
    await expect(recordDeviceHealth('refresh')).resolves.not.toThrow();
    expect(attributes()['location.state']).toBeUndefined();
  });
});

describe('device.health — publish watermarks come from native', () => {
  // The drain moved into Rust and nothing took over stamping the JS row, so the row kept whatever
  // it last held and this record reported it as fact. On 2026-08-31 an iPhone showed a publish age
  // of 672 minutes through an afternoon in which it published 37 envelopes.
  beforeEach(() => {
    resetEventLogForTesting();
    setTelemetryForTesting(createTelemetry({ now: () => 1_000 }));
    mockNativeHolder.state = undefined;
    mockNativeHolder.watermarks = undefined;
    mockNativeHolder.sharingRecipients = undefined;
  });

  afterEach(() => setTelemetryForTesting(undefined));

  it('reports ages from the native stamps', async () => {
    const now = Date.now();
    mockNativeHolder.watermarks = async () => ({
      lastAcceptedAt: now - 1_000,
      lastPublishedAt: now - 2_000,
      lastPushedAt: now - 3_000,
    });

    await recordDeviceHealth('refresh');

    const attrs = attributes();
    expect(attrs['last_fix_age_ms']).toBeGreaterThanOrEqual(1_000);
    expect(attrs['last_publish_age_ms']).toBeGreaterThanOrEqual(2_000);
    expect(attrs['last_push_age_ms']).toBeGreaterThanOrEqual(3_000);
  });

  it('omits a step that has never happened rather than sending a sentinel', async () => {
    // "Never pushed" and "pushed a long time ago" are different diagnoses; a 0 or -1 collapses them.
    mockNativeHolder.watermarks = async () => ({
      lastAcceptedAt: Date.now(),
      lastPublishedAt: null,
      lastPushedAt: null,
    });

    await recordDeviceHealth('refresh');

    const attrs = attributes();
    expect(attrs).toHaveProperty('last_fix_age_ms');
    expect(attrs).not.toHaveProperty('last_publish_age_ms');
    expect(attrs).not.toHaveProperty('last_push_age_ms');
  });

  it('falls through to the JS row on a binary without the export', async () => {
    mockNativeHolder.watermarks = undefined;

    await expect(recordDeviceHealth('refresh')).resolves.not.toThrow();
  });

  it('survives a node that has never started', async () => {
    mockNativeHolder.watermarks = async () => {
      throw new Error('no gate state; the node has never started');
    };

    await expect(recordDeviceHealth('refresh')).resolves.not.toThrow();
  });
});

/**
 * The count that actually seals.
 *
 * `sharing.recipients` is the JS pool in AsyncStorage; the native drain path reads none of it and
 * keeps its own durable list. On 2026-09-03 the two disagreed for a full day — pool of one, native
 * list empty, 91 envelopes sealed for nobody — and every health record reported the healthy number,
 * because it only ever asked one of them. Reporting both is what turns that into one query.
 */
describe('device.health — the native sharing set', () => {
  beforeEach(() => {
    resetEventLogForTesting();
    setTelemetryForTesting(createTelemetry({ now: () => 1_000 }));
    mockNativeHolder.sharingRecipients = undefined;
  });

  afterEach(() => setTelemetryForTesting(undefined));

  it('reports how many recipients native holds', async () => {
    mockNativeHolder.sharingRecipients = async () => ['bb22', 'cc33'];

    await recordDeviceHealth('refresh');

    expect(attributes()['sharing.native_recipients']).toBe(2);
  });

  /**
   * Zero is the interesting value, so it has to be a real one. An empty native list beside a
   * non-empty pool is the exact 2026-09-03 signature, and a reporter that dropped the key when the
   * answer was zero would hide precisely the case it exists for.
   */
  it('reports zero as zero, because an empty native list is the failure it looks for', async () => {
    mockNativeHolder.sharingRecipients = async () => [];

    await recordDeviceHealth('refresh');

    expect(attributes()['sharing.native_recipients']).toBe(0);
  });

  it('omits it on a binary that predates the getter, rather than reporting zero', async () => {
    mockNativeHolder.sharingRecipients = undefined;

    await recordDeviceHealth('refresh');

    expect(attributes()['sharing.native_recipients']).toBeUndefined();
  });

  /** No node to ask is not the same answer as nobody to seal for. See `outbox.pending`. */
  it('omits it when there is no node, rather than turning the refusal into a zero', async () => {
    mockNativeHolder.sharingRecipients = async () => {
      throw new Error('call createNode first');
    };

    await recordDeviceHealth('refresh');

    expect(attributes()['sharing.native_recipients']).toBeUndefined();
  });
});
