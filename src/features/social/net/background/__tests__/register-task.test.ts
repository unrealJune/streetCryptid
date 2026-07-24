import type { SpanContext } from '@/features/dev/telemetry';
import type { LocationFix } from '../../../core/types';

const mockDefineBackgroundLocationTask = jest.fn();

jest.mock('../background-task', () => ({
  defineBackgroundLocationTask: mockDefineBackgroundLocationTask,
  isBackgroundLocationAvailable: () => true,
}));

jest.mock('../../persistence', () => {
  const values = new Map<string, string>();
  return {
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

describe('background task registration', () => {
  beforeEach(() => {
    mockDefineBackgroundLocationTask.mockClear();
  });

  it('defines the Expo location task as soon as the module loads', () => {
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- module-load side effect under test
      require('../register-task');
    });

    expect(mockDefineBackgroundLocationTask).toHaveBeenCalledTimes(1);
  });

  it('forwards the wake span context to the active fix handler', async () => {
    let registerActiveHandler:
      typeof import('../register-task').registerActiveBackgroundFixHandler | undefined;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- module-load side effect under test
      const registerTask = require('../register-task') as typeof import('../register-task');
      registerActiveHandler = registerTask.registerActiveBackgroundFixHandler;
    });
    if (!registerActiveHandler) throw new Error('register-task module did not load');
    const handler = jest.fn(async () => {});
    registerActiveHandler(handler);
    const makeSink = mockDefineBackgroundLocationTask.mock.calls[0][0] as () => {
      onBackgroundFixes(fixes: readonly LocationFix[], parent?: SpanContext): Promise<void>;
    };
    const fix: LocationFix = { lat: 1, lon: 2, accuracyM: 3, headingDeg: 4, ts: 5 };
    const parent: SpanContext = { traceId: '1'.repeat(32), spanId: '2'.repeat(16) };

    await makeSink().onBackgroundFixes([fix], parent);

    expect(handler).toHaveBeenCalledWith(fix, parent);
  });
});
