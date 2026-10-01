import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';

import { setTelemetryForTesting, type Telemetry } from '@/features/dev/telemetry';
import { stampWatermark } from '../watermarks';

import {
  BACKGROUND_REFRESH_TASK,
  cancelBackgroundRefresh,
  defineBackgroundRefreshTask,
  isBackgroundRefreshAvailable,
  scheduleBackgroundRefresh,
} from '../refresh-task';

// Hoisted above the imports by babel-plugin-jest-hoist, so the modules resolve to these mocks.
jest.mock('expo-task-manager', () => ({
  defineTask: jest.fn(),
  isTaskRegisteredAsync: jest.fn(async () => true),
}));

jest.mock('expo-background-task', () => ({
  registerTaskAsync: jest.fn(async () => {}),
  unregisterTaskAsync: jest.fn(async () => {}),
  addExpirationListener: jest.fn(() => ({ remove: jest.fn() })),
  BackgroundTaskResult: { Success: 1, Failed: 2 },
}));

// `createPersistentKV()` hands back a fresh in-memory store per call outside a real app, so the
// stamp cannot be observed by reading it back. The call itself is the contract under test.
jest.mock('../watermarks', () => ({ stampWatermark: jest.fn(async () => {}) }));

const defineTask = TaskManager.defineTask as jest.Mock;
const isTaskRegisteredAsync = TaskManager.isTaskRegisteredAsync as jest.Mock;
const registerTaskAsync = BackgroundTask.registerTaskAsync as jest.Mock;
const unregisterTaskAsync = BackgroundTask.unregisterTaskAsync as jest.Mock;
const addExpirationListener = BackgroundTask.addExpirationListener as jest.Mock;
const stamp = stampWatermark as jest.Mock;

function fakeTelemetry() {
  const flush = jest.fn(async () => {});
  const span = {
    context: { traceId: '0'.repeat(32), spanId: '0'.repeat(16) },
    setAttribute: jest.fn(),
    setAttributes: jest.fn(),
    addEvent: jest.fn(),
    recordError: jest.fn(),
    setStatus: jest.fn(),
    end: jest.fn(),
  };
  const instance = {
    enabled: true,
    startSpan: jest.fn(() => span),
    withSpan: jest.fn(),
    log: jest.fn(),
    setResourceAttributes: jest.fn(),
    flush,
  } as unknown as Telemetry;
  return { instance, flush, span };
}

describe('refresh-task', () => {
  afterEach(() => {
    jest.clearAllMocks();
    setTelemetryForTesting(undefined);
  });

  it('reports availability when both native modules are present', () => {
    expect(isBackgroundRefreshAvailable()).toBe(true);
  });

  it('schedules with the requested minimum interval', async () => {
    await scheduleBackgroundRefresh(15);
    expect(registerTaskAsync).toHaveBeenCalledWith(BACKGROUND_REFRESH_TASK, {
      minimumInterval: 15,
    });
  });

  it('cancels only when the task is registered', async () => {
    isTaskRegisteredAsync.mockResolvedValueOnce(true);
    await cancelBackgroundRefresh();
    expect(isTaskRegisteredAsync).toHaveBeenCalledWith(BACKGROUND_REFRESH_TASK);
    expect(unregisterTaskAsync).toHaveBeenCalledWith(BACKGROUND_REFRESH_TASK);
  });

  it('skips unregister when the task is not registered', async () => {
    isTaskRegisteredAsync.mockResolvedValueOnce(false);
    await cancelBackgroundRefresh();
    expect(unregisterTaskAsync).not.toHaveBeenCalled();
  });

  it('runs the headless runner, flushes telemetry, and returns Success', async () => {
    const { instance, flush } = fakeTelemetry();
    setTelemetryForTesting(instance);
    const run = jest.fn(async () => {});

    defineBackgroundRefreshTask(run);
    const executor = defineTask.mock.calls[0][1] as () => Promise<number>;
    const result = await executor();

    expect(run).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(result).toBe(1); // BackgroundTaskResult.Success
  });

  it('stamps the refresh watermark when the OS runs the task', async () => {
    const { instance } = fakeTelemetry();
    setTelemetryForTesting(instance);

    defineBackgroundRefreshTask(jest.fn(async () => {}));
    const executor = defineTask.mock.calls[0][1] as () => Promise<number>;
    await executor();

    expect(stamp).toHaveBeenCalledWith(expect.anything(), 'refresh');
  });

  it('stamps the refresh watermark even when the runner throws', async () => {
    // A run that failed still ran. Only stamping on success would leave a phone whose refresh
    // errors every time looking identical to one the OS has stopped scheduling — which is the
    // distinction the stamp exists to make.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { instance } = fakeTelemetry();
    setTelemetryForTesting(instance);

    defineBackgroundRefreshTask(
      jest.fn(async () => {
        throw new Error('boom');
      })
    );
    const executor = defineTask.mock.calls[0][1] as () => Promise<number>;
    await executor();

    expect(stamp).toHaveBeenCalledWith(expect.anything(), 'refresh');
    warn.mockRestore();
  });

  it('returns Failed and still flushes telemetry when the runner throws', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { instance, flush } = fakeTelemetry();
    setTelemetryForTesting(instance);
    const run = jest.fn(async () => {
      throw new Error('boom');
    });

    defineBackgroundRefreshTask(run);
    const executor = defineTask.mock.calls[0][1] as () => Promise<number>;
    const result = await executor();

    expect(result).toBe(2); // BackgroundTaskResult.Failed
    expect(flush).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  /**
   * The OS cutting a refresh short is the one notice iOS gives, and nothing listened to it.
   *
   * Until now a refresh terminated mid-flight was indistinguishable from one that was never
   * scheduled: both leave a `bg.refresh` span that simply never ends and a `last_refresh_age_ms`
   * that climbs. Those want different fixes — one means the work is too big for the window, the
   * other means we are not being given windows at all.
   */
  describe('expiry', () => {
    function expire(): void {
      const listener = addExpirationListener.mock.calls[0][0] as () => void;
      listener();
    }

    it('reports how much of the window the refresh actually got', async () => {
      const { instance, span } = fakeTelemetry();
      setTelemetryForTesting(instance);

      defineBackgroundRefreshTask(jest.fn(async () => {}));
      const executor = defineTask.mock.calls[0][1] as () => Promise<number>;
      // Expire while a refresh is genuinely in flight, which is the only case that matters.
      const running = executor();
      expire();
      await running;

      const expired = (instance.startSpan as jest.Mock).mock.calls.find(
        ([name]) => name === 'bg.refresh.expired'
      );
      expect(expired).toBeDefined();
      expect(expired?.[1].attributes.elapsed_ms).toBeGreaterThanOrEqual(0);
      expect(span.end).toHaveBeenCalled();
    });

    /**
     * The flush is not deferrable here. The OS is about to stop this process, so a span left in
     * the journal unexported dies describing the very thing it exists to describe.
     */
    it('flushes immediately, because the process is about to be stopped', async () => {
      const { instance, flush } = fakeTelemetry();
      setTelemetryForTesting(instance);

      defineBackgroundRefreshTask(jest.fn(async () => {}));
      expire();
      await new Promise((resolve) => setImmediate(resolve));

      expect(flush).toHaveBeenCalled();
    });

    /** An expiry with no refresh in flight is worth seeing, not reporting as zero elapsed. */
    it('marks an expiry that arrived with nothing running', async () => {
      const { instance } = fakeTelemetry();
      setTelemetryForTesting(instance);

      defineBackgroundRefreshTask(jest.fn(async () => {}));
      expire();
      await new Promise((resolve) => setImmediate(resolve));

      const expired = (instance.startSpan as jest.Mock).mock.calls.find(
        ([name]) => name === 'bg.refresh.expired'
      );
      expect(expired?.[1].attributes.elapsed_ms).toBe(-1);
    });

    /**
     * A JS bundle can run against a native module older than itself, so the export can simply not
     * be there. Re-required against a module that lacks it, rather than by blanking the property:
     * a jest module namespace is read-only, so the assignment silently does nothing and the test
     * passes for the wrong reason.
     */
    it('degrades silently on a build without the listener', () => {
      jest.isolateModules(() => {
        jest.doMock('expo-background-task', () => ({
          registerTaskAsync: jest.fn(async () => {}),
          unregisterTaskAsync: jest.fn(async () => {}),
          BackgroundTaskResult: { Success: 1, Failed: 2 },
        }));
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- isolated re-require
        const fresh = require('../refresh-task') as typeof import('../refresh-task');
        expect(() => fresh.defineBackgroundRefreshTask(jest.fn(async () => {}))).not.toThrow();
      });
    });
  });
});
