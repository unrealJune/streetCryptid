import { resetEventLogForTesting, setTelemetryForTesting } from '@/features/dev/telemetry';
import { createTelemetry } from '@/features/dev/telemetry/telemetry';
import {
  getStorageBackend,
  getStorageDegradationCount,
  reportStorageDegraded,
  resetStorageHealthForTesting,
} from '../storage-health';

function spanNames(): string[] {
  const { getEventLog } = require('@/features/dev/telemetry') as {
    getEventLog: () => { action: string; details: any }[];
  };
  return getEventLog().map((entry) => entry.action);
}

function spanAttributes(): Record<string, unknown>[] {
  const { getEventLog } = require('@/features/dev/telemetry') as {
    getEventLog: () => { action: string; details: any }[];
  };
  return getEventLog()
    .filter((entry) => entry.action === 'storage.degraded')
    .map((entry) => entry.details.attributes as Record<string, unknown>);
}

describe('storage degradation reporting', () => {
  beforeEach(() => {
    resetEventLogForTesting();
    resetStorageHealthForTesting();
    setTelemetryForTesting(createTelemetry({ now: () => 1000 }));
  });

  afterEach(() => setTelemetryForTesting(undefined));

  it('starts out believing storage is durable', () => {
    expect(getStorageBackend()).toBe('sqlite');
    expect(getStorageDegradationCount()).toBe(0);
  });

  it('reports a fatal degradation once and flips the backend for the whole process', () => {
    reportStorageDegraded({ scope: 'open', reason: 'open-failed', fatal: true });

    expect(getStorageBackend()).toBe('memory');
    expect(spanNames()).toEqual(['storage.degraded']);
    expect(spanAttributes()[0]).toMatchObject({
      scope: 'open',
      fatal: true,
      'sc.drop_reason': 'storage-open-failed',
    });
  });

  it('does not emit a span per failure — a wedged database fails on every access', () => {
    for (let i = 0; i < 50; i += 1) {
      reportStorageDegraded({ scope: 'kv.get', reason: 'statement-failed' });
    }
    expect(spanNames()).toEqual(['storage.degraded']);
    // The volume is still visible, it just does not cost 50 exports.
    expect(getStorageDegradationCount()).toBe(50);
  });

  it('separates distinct failures so a second kind is not hidden by the first', () => {
    reportStorageDegraded({ scope: 'kv.get', reason: 'statement-failed' });
    reportStorageDegraded({ scope: 'trail.putSelf', reason: 'statement-failed' });
    expect(spanNames()).toHaveLength(2);
  });

  it('keeps a transient statement failure from claiming the whole store is gone', () => {
    reportStorageDegraded({ scope: 'kv.set', reason: 'statement-failed' });
    expect(getStorageBackend()).toBe('sqlite');
  });

  it('records the error message so the cause survives to the collector', () => {
    reportStorageDegraded({
      scope: 'open',
      reason: 'module-missing',
      fatal: true,
      error: new Error('ExpoSQLite native module unavailable'),
    });
    expect(spanAttributes()[0]['exception.message']).toBe('ExpoSQLite native module unavailable');
  });
});
