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
  BackgroundTaskResult: { Success: 1, Failed: 2 },
}));

// `createPersistentKV()` hands back a fresh in-memory store per call outside a real app, so the
// stamp cannot be observed by reading it back. The call itself is the contract under test.
jest.mock('../watermarks', () => ({ stampWatermark: jest.fn(async () => {}) }));

const defineTask = TaskManager.defineTask as jest.Mock;
const isTaskRegisteredAsync = TaskManager.isTaskRegisteredAsync as jest.Mock;
const registerTaskAsync = BackgroundTask.registerTaskAsync as jest.Mock;
const unregisterTaskAsync = BackgroundTask.unregisterTaskAsync as jest.Mock;
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
});
