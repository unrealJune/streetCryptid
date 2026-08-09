import {
  awaitNativeRuntimeIdle,
  claimNativeRuntime,
  isNativeRuntimeClaimed,
  releaseNativeRuntime,
  resetNativeRuntimeOwnerForTesting,
  withNativeRuntimeSession,
} from '../native-runtime-owner';

describe('native-runtime-owner', () => {
  beforeEach(() => {
    resetNativeRuntimeOwnerForTesting();
  });

  describe('the mounted claim', () => {
    it('starts unclaimed, so a genuine headless launch is free to build a node', () => {
      expect(isNativeRuntimeClaimed()).toBe(false);
    });

    it('reports the claim while a mounted runtime holds it, and drops it on release', () => {
      claimNativeRuntime();
      expect(isNativeRuntimeClaimed()).toBe(true);
      releaseNativeRuntime();
      expect(isNativeRuntimeClaimed()).toBe(false);
    });
  });

  describe('session serialization', () => {
    it('never overlaps two sessions, even when the first is slow', async () => {
      const order: string[] = [];
      let releaseFirst: (() => void) | undefined;
      const first = withNativeRuntimeSession(async () => {
        order.push('first:start');
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        order.push('first:end');
      });
      const second = withNativeRuntimeSession(async () => {
        order.push('second:start');
      });

      // The second must not have touched the runtime while the first still holds it.
      await Promise.resolve();
      expect(order).toEqual(['first:start']);

      releaseFirst?.();
      await Promise.all([first, second]);
      expect(order).toEqual(['first:start', 'first:end', 'second:start']);
    });

    // A session that throws must not wedge the chain — the next OS wake still has to work.
    it('keeps running later sessions after one rejects', async () => {
      const failing = withNativeRuntimeSession(async () => {
        throw new Error('node build failed');
      });
      await expect(failing).rejects.toThrow('node build failed');

      await expect(withNativeRuntimeSession(async () => 'ok')).resolves.toBe('ok');
    });

    it('passes the session result back to the caller', async () => {
      await expect(withNativeRuntimeSession(async () => 42)).resolves.toBe(42);
    });
  });

  describe('awaitNativeRuntimeIdle', () => {
    // This is what stops a mounted `createNode` landing in the middle of a headless session and
    // getting its brand-new node nil'd by that session's `shutdown`.
    it('resolves only once the in-flight session has finished', async () => {
      const seen: string[] = [];
      let releaseSession: (() => void) | undefined;
      const session = withNativeRuntimeSession(async () => {
        await new Promise<void>((resolve) => {
          releaseSession = resolve;
        });
        seen.push('session:end');
      });

      const idle = awaitNativeRuntimeIdle().then(() => seen.push('idle'));
      await Promise.resolve();
      expect(seen).toEqual([]);

      releaseSession?.();
      await Promise.all([session, idle]);
      expect(seen).toEqual(['session:end', 'idle']);
    });

    it('resolves immediately when nothing is running', async () => {
      await expect(awaitNativeRuntimeIdle()).resolves.toBeUndefined();
    });
  });
});
