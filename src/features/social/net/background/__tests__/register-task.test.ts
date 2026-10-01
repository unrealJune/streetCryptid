/**
 * Which platforms still wake a JS context in the background, and which no longer need to.
 *
 * iOS does not. `BackgroundLocationRuntime` captures, gates, seals, sends AND pulls with no JS in
 * the loop, and monitors significant location changes — the only mechanism that relaunches a
 * TERMINATED app, which the 200 m revive fence only ever approximated. Leaving the tasks defined
 * there would mean iOS launching the app specifically to run JavaScript with nothing left to do,
 * and with React deferred on background launches, servicing one means booting the whole bundle.
 *
 * Android must keep both, and that is the half worth guarding. The geofence is the documented
 * exemption to the Android 12+ ban on starting a foreground service from the background — the only
 * legal window `ensureSharingArmedHeadless` has — and the periodic refresh is how a phone whose
 * `LocationTaskService` was killed gets itself back.
 */

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

const mockDefineRefresh = jest.fn();
const mockDefineRevive = jest.fn();

jest.mock('../refresh-task', () => ({
  ...jest.requireActual('../refresh-task'),
  defineBackgroundRefreshTask: (...args: unknown[]) => mockDefineRefresh(...args),
  isBackgroundRefreshAvailable: () => true,
}));

jest.mock('../revive-task', () => ({
  ...jest.requireActual('../revive-task'),
  defineReviveTask: (...args: unknown[]) => mockDefineRevive(...args),
  isReviveFenceAvailable: () => true,
}));

function loadOn(os: 'ios' | 'android'): void {
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- platform is read at load
    const { Platform } = require('react-native');
    Platform.OS = os;
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- module-load side effect under test
    require('../register-task');
  });
}

describe('background task registration', () => {
  const originalOs = jest.requireActual('react-native').Platform.OS;

  beforeEach(() => {
    mockDefineRefresh.mockClear();
    mockDefineRevive.mockClear();
  });

  afterAll(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- restore for other suites
    require('react-native').Platform.OS = originalOs;
  });

  it('registers nothing on iOS, where the native runtime covers it', () => {
    loadOn('ios');
    expect(mockDefineRefresh).not.toHaveBeenCalled();
    expect(mockDefineRevive).not.toHaveBeenCalled();
  });

  it('still registers both on Android', () => {
    loadOn('android');
    expect(mockDefineRefresh).toHaveBeenCalledTimes(1);
    expect(mockDefineRevive).toHaveBeenCalledTimes(1);
  });

  it('is side-effect-free to import', () => {
    expect(() => loadOn('android')).not.toThrow();
  });
});
