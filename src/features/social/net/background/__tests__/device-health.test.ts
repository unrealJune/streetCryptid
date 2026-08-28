import {
  getEventLog,
  resetEventLogForTesting,
  setTelemetryForTesting,
} from '@/features/dev/telemetry';
import { createTelemetry } from '@/features/dev/telemetry/telemetry';
import { recordDeviceHealth } from '../device-health';

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
