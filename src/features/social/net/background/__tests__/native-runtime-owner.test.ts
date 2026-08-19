import {
  awaitNativeRuntimeIdle,
  claimNativeRuntime,
  isNativeRuntimeClaimed,
  releaseNativeRuntime,
  resetNativeRuntimeOwnerForTesting,
  setNativeRuntimeSessionWatchdogHandler,
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

    // The regression this whole watchdog exists for. A session that never settles used to leave
    // `sessionChain` pending forever: every later wake queued behind it and did nothing, and the
    // next mounted launch hung on `awaitNativeRuntimeIdle`. Only killing the process cleared it.
    it('lets the next session run when one hangs and never settles', async () => {
      jest.useFakeTimers();
      try {
        const ran: string[] = [];
        // Deliberately never resolved — this models a native `shutdown` that does not return.
        void withNativeRuntimeSession(async () => {
          ran.push('hung:start');
          await new Promise<void>(() => {});
        }, 1_000);

        const next = withNativeRuntimeSession(async () => {
          ran.push('next');
          return 'ok';
        }, 1_000);

        await Promise.resolve();
        expect(ran).toEqual(['hung:start']);

        jest.advanceTimersByTime(1_000);
        await expect(next).resolves.toBe('ok');
        expect(ran).toEqual(['hung:start', 'next']);
      } finally {
        jest.useRealTimers();
      }
    });

    it('reports the overrun so a hang is visible instead of silent', async () => {
      jest.useFakeTimers();
      try {
        const trips: number[] = [];
        setNativeRuntimeSessionWatchdogHandler((elapsedMs) => trips.push(elapsedMs));
        void withNativeRuntimeSession(async () => {
          await new Promise<void>(() => {});
        }, 2_000);

        await Promise.resolve();
        expect(trips).toEqual([]);

        jest.advanceTimersByTime(2_000);
        await Promise.resolve();
        expect(trips).toEqual([2_000]);
      } finally {
        jest.useRealTimers();
      }
    });

    it('does not trip the watchdog for a session that finishes in time', async () => {
      jest.useFakeTimers();
      try {
        const trips: number[] = [];
        setNativeRuntimeSessionWatchdogHandler((elapsedMs) => trips.push(elapsedMs));
        await withNativeRuntimeSession(async () => 'quick', 5_000);
        jest.advanceTimersByTime(10_000);
        await Promise.resolve();
        expect(trips).toEqual([]);
      } finally {
        jest.useRealTimers();
      }
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

    // The launch-hang half of the same bug: a mounted `init` awaits this before `createNode`, so a
    // session that never settles used to mean the app never got past the splash screen.
    it('still resolves once the watchdog releases a hung session', async () => {
      jest.useFakeTimers();
      try {
        let idle = false;
        void withNativeRuntimeSession(async () => {
          await new Promise<void>(() => {});
        }, 1_000);
        const waiting = awaitNativeRuntimeIdle().then(() => {
          idle = true;
        });

        await Promise.resolve();
        expect(idle).toBe(false);

        jest.advanceTimersByTime(1_000);
        await waiting;
        expect(idle).toBe(true);
      } finally {
        jest.useRealTimers();
      }
    });
  });
});
