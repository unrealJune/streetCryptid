import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';

import { setTelemetryForTesting, type Telemetry } from '@/features/dev/telemetry';

import type { LocationFix } from '../../../core/types';
import {
  armReviveFence,
  defineReviveTask,
  REVIVE_FENCE_MIN_REARM_MS,
  REVIVE_FENCE_REGION_ID,
  REVIVE_FENCE_TASK,
} from '../revive-task';

// Hoisted above the imports by babel-plugin-jest-hoist, so the modules resolve to these mocks.
jest.mock('expo-task-manager', () => ({
  defineTask: jest.fn(),
  isTaskDefined: jest.fn(() => true),
  isTaskRegisteredAsync: jest.fn(async () => true),
}));

jest.mock('expo-location', () => ({
  startGeofencingAsync: jest.fn(async () => {}),
  stopGeofencingAsync: jest.fn(async () => {}),
  GeofencingEventType: { Enter: 1, Exit: 2 },
}));

jest.mock('../../persistence', () => {
  const values = new Map<string, string>();
  return {
    __values: values,
    createPersistentKV: () => ({
      get: async (key: string) => values.get(key) ?? null,
      set: async (key: string, value: string) => {
        values.set(key, value);
      },
      remove: async (key: string) => {
        values.delete(key);
      },
    }),
  };
});

const defineTask = TaskManager.defineTask as jest.Mock;
const startGeofencingAsync = Location.startGeofencingAsync as jest.Mock;
const kvValues = (jest.requireMock('../../persistence') as { __values: Map<string, string> })
  .__values;

const FIX: LocationFix = { lat: 47.6381, lon: -122.3529, accuracyM: 5, headingDeg: 0, ts: 1_000 };

function fakeTelemetry() {
  const span = {
    context: { traceId: '0'.repeat(32), spanId: '0'.repeat(16) },
    setAttribute: jest.fn(),
    setAttributes: jest.fn(),
    addEvent: jest.fn(),
    recordError: jest.fn(),
    setStatus: jest.fn(),
    end: jest.fn(),
  };
  const flush = jest.fn(async () => {});
  const instance = {
    enabled: true,
    startSpan: jest.fn(() => span),
    withSpan: jest.fn(),
    log: jest.fn(),
    setResourceAttributes: jest.fn(),
    flush,
  } as unknown as Telemetry;
  return { instance, span, flush };
}

/** Register the task and hand back the executor TaskManager would invoke. */
function registerHandler(run: jest.Mock): (body: unknown) => Promise<void> {
  defineReviveTask(run as unknown as Parameters<typeof defineReviveTask>[0]);
  return defineTask.mock.calls.at(-1)?.[1] as (body: unknown) => Promise<void>;
}

describe('revive-task', () => {
  beforeEach(() => {
    kvValues.clear();
  });

  afterEach(() => {
    jest.clearAllMocks();
    setTelemetryForTesting(undefined);
  });

  describe('event gating', () => {
    // The regression test for the runaway loop. Every `startGeofencingAsync` makes expo-location's
    // iOS consumer reset the region's cached state and call `requestStateForRegion`, whose
    // `didDetermineState:` callback fires the task with an ENTER event regardless of
    // `notifyOnEnter: false`. Acting on that event re-armed the fence, which fired it again — 60-125
    // wakes/second, persisted across launches by expo-task-manager and cleared only by an uninstall.
    it('ignores the synthetic enter delivered by every arm, instead of reviving', async () => {
      const { instance } = fakeTelemetry();
      setTelemetryForTesting(instance);
      const run = jest.fn(async () => {});
      const execute = registerHandler(run);

      await execute({ data: { eventType: Location.GeofencingEventType.Enter }, error: null });

      expect(run).not.toHaveBeenCalled();
    });

    it('ignores a delivery with no event type at all', async () => {
      const { instance } = fakeTelemetry();
      setTelemetryForTesting(instance);
      const run = jest.fn(async () => {});
      const execute = registerHandler(run);

      await execute({ data: null, error: null });

      expect(run).not.toHaveBeenCalled();
    });

    it('revives on a genuine exit', async () => {
      const { instance, flush } = fakeTelemetry();
      setTelemetryForTesting(instance);
      const run = jest.fn(async () => {});
      const execute = registerHandler(run);

      await execute({ data: { eventType: Location.GeofencingEventType.Exit }, error: null });

      expect(run).toHaveBeenCalledTimes(1);
      // Headless contexts are frozen by the OS with unexported batches unless we flush.
      expect(flush).toHaveBeenCalled();
    });

    it('does not revive on a geofence error', async () => {
      const { instance } = fakeTelemetry();
      setTelemetryForTesting(instance);
      const run = jest.fn(async () => {});
      const execute = registerHandler(run);

      await execute({ data: null, error: new Error('kCLErrorDomain 0') });

      expect(run).not.toHaveBeenCalled();
    });
  });

  describe('re-arm throttle', () => {
    it('arms the fence on the given fix', async () => {
      const { instance } = fakeTelemetry();
      setTelemetryForTesting(instance);

      await expect(armReviveFence(FIX, { now: () => 0 })).resolves.toBe(true);

      expect(startGeofencingAsync).toHaveBeenCalledWith(REVIVE_FENCE_TASK, [
        expect.objectContaining({
          identifier: REVIVE_FENCE_REGION_ID,
          latitude: FIX.lat,
          longitude: FIX.lon,
          notifyOnEnter: false,
          notifyOnExit: true,
        }),
      ]);
    });

    // Backstop for the case the event gate cannot catch: a fence we keep re-centering on a position
    // we are genuinely outside of re-fires a real EXIT on every arm.
    it('refuses a second arm that lands in the same place inside the floor', async () => {
      const { instance } = fakeTelemetry();
      setTelemetryForTesting(instance);

      await armReviveFence(FIX, { now: () => 0 });
      startGeofencingAsync.mockClear();

      await expect(armReviveFence(FIX, { now: () => REVIVE_FENCE_MIN_REARM_MS - 1 })).resolves.toBe(
        false
      );
      expect(startGeofencingAsync).not.toHaveBeenCalled();
    });

    // The floor must not strand the tripwire behind a moving user: at 30 mph a 200 m radius is
    // crossed in ~15 s, well inside the floor, and refusing that re-centre would leave the fence
    // where the drive started.
    it('allows an arm inside the floor once the centre has moved clear of the fence', async () => {
      const { instance } = fakeTelemetry();
      setTelemetryForTesting(instance);

      await armReviveFence(FIX, { now: () => 0 });
      startGeofencingAsync.mockClear();

      // ~1 km north — comfortably outside the 200 m fence just armed.
      const moved: LocationFix = { ...FIX, lat: FIX.lat + 0.009 };
      await expect(
        armReviveFence(moved, { now: () => REVIVE_FENCE_MIN_REARM_MS - 1 })
      ).resolves.toBe(true);
      expect(startGeofencingAsync).toHaveBeenCalledWith(REVIVE_FENCE_TASK, [
        expect.objectContaining({ latitude: moved.lat }),
      ]);
    });

    it('still refuses a jitter-sized move inside the floor', async () => {
      const { instance } = fakeTelemetry();
      setTelemetryForTesting(instance);

      await armReviveFence(FIX, { now: () => 0 });
      startGeofencingAsync.mockClear();

      // ~11 m — GPS noise, not a crossing. This is the shape the runaway had.
      const jitter: LocationFix = { ...FIX, lat: FIX.lat + 0.0001 };
      await expect(
        armReviveFence(jitter, { now: () => REVIVE_FENCE_MIN_REARM_MS - 1 })
      ).resolves.toBe(false);
      expect(startGeofencingAsync).not.toHaveBeenCalled();
    });

    it('allows the next arm once the floor has elapsed', async () => {
      const { instance } = fakeTelemetry();
      setTelemetryForTesting(instance);

      await armReviveFence(FIX, { now: () => 0 });
      startGeofencingAsync.mockClear();

      await expect(armReviveFence(FIX, { now: () => REVIVE_FENCE_MIN_REARM_MS })).resolves.toBe(
        true
      );
      expect(startGeofencingAsync).toHaveBeenCalledTimes(1);
    });

    it('lets startBackground force an arm, so sharing never starts fenceless', async () => {
      const { instance } = fakeTelemetry();
      setTelemetryForTesting(instance);

      await armReviveFence(FIX, { now: () => 0 });
      startGeofencingAsync.mockClear();

      await expect(armReviveFence(FIX, { force: true, now: () => 1 })).resolves.toBe(true);
      expect(startGeofencingAsync).toHaveBeenCalledTimes(1);
    });

    it('does not let a failed arm consume the floor', async () => {
      const { instance } = fakeTelemetry();
      setTelemetryForTesting(instance);
      startGeofencingAsync.mockRejectedValueOnce(new Error('no Always authorization'));

      await expect(armReviveFence(FIX, { now: () => 0 })).resolves.toBe(false);
      await expect(armReviveFence(FIX, { now: () => 1 })).resolves.toBe(true);
    });
  });
});
