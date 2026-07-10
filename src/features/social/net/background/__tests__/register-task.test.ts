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
  it('defines the Expo location task as soon as the module loads', () => {
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- module-load side effect under test
      require('../register-task');
    });

    expect(mockDefineBackgroundLocationTask).toHaveBeenCalledTimes(1);
  });
});
