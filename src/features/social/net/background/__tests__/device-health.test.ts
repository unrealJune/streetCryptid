import {
  getEventLog,
  resetEventLogForTesting,
  setTelemetryForTesting,
} from '@/features/dev/telemetry';
import { createTelemetry } from '@/features/dev/telemetry/telemetry';
import { mutedSharingReason, recordDeviceHealth } from '../device-health';

function healthRecords(): { attributes: Record<string, unknown> }[] {
  return getEventLog()
    .filter((entry) => entry.action === 'device.health')
    .map((entry) => (entry.details as { attributes: Record<string, unknown> }) ?? {});
}

describe('device.health', () => {
  beforeEach(() => {
    resetEventLogForTesting();
    setTelemetryForTesting(createTelemetry({ now: () => 1_000 }));
  });

  afterEach(() => setTelemetryForTesting(undefined));

  it('emits a record and never throws, even where every native module is missing', async () => {
    // This is the contract that matters most: it runs inside a headless background task, from a
    // `finally`, and a health record that could reject would turn a diagnostic into an outage.
    await expect(recordDeviceHealth('manual')).resolves.not.toThrow();
    expect(healthRecords()).toHaveLength(1);
  });

  it('records what prompted it, so scheduled and opportunistic records are separable', async () => {
    await recordDeviceHealth('manual');
    expect(healthRecords()[0].attributes).toMatchObject({ trigger: 'manual' });
  });

  it('always carries the platform and the storage backend', async () => {
    await recordDeviceHealth('refresh');
    const attributes = healthRecords()[0].attributes;
    expect(attributes.platform).toBeDefined();
    // `storage.backend` says whether anything this device persists will survive a restart, so a
    // record without it would be misleading rather than merely thin.
    //
    // It reads 'memory' here, and that is the assertion: jest has no `expo-sqlite`, so
    // `persistence.ts` is genuinely running on its in-memory fallback — and the reporter noticing
    // that unprompted is the whole behaviour under test. On a device it reads 'sqlite'; if it ever
    // reads 'memory' there, the outbox and the sharing intent are being lost on every restart.
    expect(attributes['storage.backend']).toBe('memory');
  });

  it('degrades to fewer attributes rather than failing when a module is unavailable', async () => {
    await recordDeviceHealth('refresh');
    const attributes = healthRecords()[0].attributes;
    // Whatever could not be read is simply absent; nothing is guessed and nothing is a sentinel.
    expect(attributes['sc.drop_reason']).toBeUndefined();
  });
});

describe('sharing.muted', () => {
  // The attribute that would have answered "why has she been out of contact since the bar?" in one
  // query. On 2026-09-17 an iPhone reinstalled the app — which on iOS resets location authorization
  // to "While Using" — paired at 04:04 UTC, delivered exactly one introduction fix while the app
  // was open, and went silent. Its `device.health` already said `sharing.enabled=true` and
  // `perm.background=denied` in the same record; nothing named the combination.
  const sharing = {
    'sharing.enabled': true,
    'perm.foreground': 'granted',
    'perm.background': 'granted',
    'task.location_running': true,
    'sharing.native_recipients': 2,
  };

  it('is absent when a sharing phone can actually share', () => {
    expect(mutedSharingReason(sharing)).toEqual({});
  });

  it('is absent when sharing is off, because nothing is being promised', () => {
    expect(
      mutedSharingReason({ ...sharing, 'sharing.enabled': false, 'perm.background': 'denied' })
    ).toEqual({});
  });

  it('names a reinstall that reset background authorization', () => {
    expect(mutedSharingReason({ ...sharing, 'perm.background': 'denied' })).toEqual({
      'sharing.muted': 'background-permission',
    });
  });

  it('reports the most fundamental cause first', () => {
    // Without foreground permission the background answer is not even meaningful, so a phone
    // missing both is reported as the one that has to be fixed first.
    expect(
      mutedSharingReason({
        ...sharing,
        'perm.foreground': 'denied',
        'perm.background': 'denied',
        'task.location_running': false,
      })
    ).toEqual({ 'sharing.muted': 'foreground-permission' });
  });

  it('names a stopped location task and an empty native recipient list', () => {
    expect(mutedSharingReason({ ...sharing, 'task.location_running': false })).toEqual({
      'sharing.muted': 'location-task-stopped',
    });
    expect(mutedSharingReason({ ...sharing, 'sharing.native_recipients': 0 })).toEqual({
      'sharing.muted': 'no-recipients',
    });
  });
});
