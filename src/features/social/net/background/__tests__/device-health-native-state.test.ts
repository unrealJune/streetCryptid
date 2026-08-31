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

const mockNativeHolder: { state: (() => Record<string, unknown>) | undefined } = {
  state: undefined,
};

jest.mock('iroh-location', () => ({
  ...jest.requireActual('iroh-location'),
  tryGetIrohLocation: () => ({
    nativeBackgroundRunning: () => true,
    nativeBackgroundState: mockNativeHolder.state,
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
