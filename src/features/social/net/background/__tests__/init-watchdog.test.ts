import { awaitInitBounded, INIT_WATCHDOG_MS } from '../init-watchdog';

describe('init watchdog', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('reports ready when init finishes inside the bound', async () => {
    const outcome = awaitInitBounded(Promise.resolve(), 1_000);
    await jest.advanceTimersByTimeAsync(1);
    await expect(outcome).resolves.toBe('ready');
  });

  it('reports failed rather than rejecting, so a rejected init is never unhandled', async () => {
    const outcome = awaitInitBounded(Promise.reject(new Error('no node')), 1_000);
    await jest.advanceTimersByTimeAsync(1);
    await expect(outcome).resolves.toBe('failed');
  });

  it('stops waiting on an init that never settles', async () => {
    // The 2026-09-18 case exactly: not a rejection, which the old latch already handled, but a
    // promise that never settles at all. Before the bound this await was permanent.
    const outcome = awaitInitBounded(new Promise<void>(() => {}), 1_000);
    await jest.advanceTimersByTimeAsync(1_000);
    await expect(outcome).resolves.toBe('timeout');
  });

  it('does not fire the watchdog early', async () => {
    let settled: string | null = null;
    void awaitInitBounded(new Promise<void>(() => {}), 1_000).then((o) => (settled = o));
    await jest.advanceTimersByTimeAsync(999);
    expect(settled).toBeNull();
  });

  it('leaves the caller free to keep waiting — a timeout does not cancel the init', async () => {
    let resolveInit: (() => void) | undefined;
    const init = new Promise<void>((res) => {
      resolveInit = res;
    });
    const outcome = awaitInitBounded(init, 1_000);
    await jest.advanceTimersByTimeAsync(1_000);
    await expect(outcome).resolves.toBe('timeout');
    // The underlying promise is untouched and still settles if and when init eventually lands.
    resolveInit?.();
    await expect(init).resolves.toBeUndefined();
  });

  it('degrades to a plain await when given a nonsensical bound', async () => {
    await expect(awaitInitBounded(Promise.resolve(), 0)).resolves.toBe('ready');
    await expect(awaitInitBounded(Promise.resolve(), Number.NaN)).resolves.toBe('ready');
  });

  it('bounds well short of the outage it exists to prevent', () => {
    expect(INIT_WATCHDOG_MS).toBeGreaterThanOrEqual(10_000);
    expect(INIT_WATCHDOG_MS).toBeLessThanOrEqual(60_000);
  });
});
