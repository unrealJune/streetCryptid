import {
  ServiceSupervisor,
  type DiscardNotice,
  type StallNotice,
  type SupervisedService,
} from '../service-supervisor';

const WATCHDOG = 30_000;

/** A service whose init the test settles by hand. */
class FakeService implements SupervisedService {
  static built: FakeService[] = [];
  shutdowns = 0;
  initStartedAt: number | null = null;
  phase: string | null = 'pairing';
  private settle: { resolve: () => void; reject: (e: Error) => void } | null = null;

  constructor(private readonly clock: { now: number }) {
    FakeService.built.push(this);
  }

  init(): Promise<void> {
    this.initStartedAt = this.clock.now;
    return new Promise<void>((resolve, reject) => {
      this.settle = { resolve, reject };
    });
  }

  land(): void {
    this.settle?.resolve();
  }

  fail(message = 'claim refused'): void {
    this.settle?.reject(new Error(message));
  }

  shutdown(): void {
    this.shutdowns += 1;
  }

  currentInitPhase(): string | null {
    return this.phase;
  }

  initElapsedMs(): number {
    return this.initStartedAt === null ? 0 : this.clock.now - this.initStartedAt;
  }
}

function rig() {
  FakeService.built = [];
  const clock = { now: 1_000_000 };
  const stalls: StallNotice[] = [];
  const discards: DiscardNotice[] = [];
  const supervisor = new ServiceSupervisor({
    create: () => new FakeService(clock),
    watchdogMs: WATCHDOG,
    now: () => clock.now,
    onStall: (notice) => stalls.push(notice),
  });
  supervisor.onDiscard((notice) => discards.push(notice));
  const start = () => supervisor.attempt((service) => service.init());
  return { supervisor, clock, stalls, discards, start };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('service supervisor', () => {
  beforeEach(() => jest.useFakeTimers({ doNotFake: ['setImmediate'] }));
  afterEach(() => jest.useRealTimers());

  it('runs one attempt per process, whatever joins it', async () => {
    const { supervisor, start } = rig();
    const first = start();
    const second = start();
    await flush();
    FakeService.built[0].land();
    await expect(first).resolves.toEqual({ outcome: 'ready' });
    await expect(second).resolves.toEqual({ outcome: 'ready' });
    expect(FakeService.built).toHaveLength(1);
    expect(supervisor.lifecycle.phase).toBe('ready');
    await expect(start()).resolves.toEqual({ outcome: 'ready' });
  });

  /** The 2026-10-13 Pixel: back 11 minutes into an init whose 30 s timer never ran. */
  it('retries an overdue attempt exactly once on a foreground, and reports it once', async () => {
    const { supervisor, clock, stalls, discards, start } = rig();
    const waiting = start();
    await flush();
    clock.now += 689_519;
    expect(supervisor.foreground()).toBe(true);
    expect(supervisor.foreground()).toBe(false);
    expect(stalls).toEqual([
      { attempt: 1, trigger: 'foreground', initPhase: 'pairing', elapsedMs: 689_519 },
    ]);
    expect(discards).toEqual([
      { attempt: 1, trigger: 'foreground', reason: 'init-timeout', initPhase: 'pairing' },
    ]);
    expect(FakeService.built[0].shutdowns).toBe(1);
    // The frozen timer finally fires: no second report.
    jest.advanceTimersByTime(WATCHDOG);
    await expect(waiting).resolves.toMatchObject({ outcome: 'timeout' });
    expect(stalls).toHaveLength(1);
  });

  it('leaves an attempt inside its watchdog alone on a foreground', async () => {
    const { supervisor, clock, discards, start } = rig();
    void start();
    await flush();
    clock.now += WATCHDOG - 1;
    expect(supervisor.foreground()).toBe(false);
    expect(discards).toEqual([]);
  });

  it('reports a timer-detected stall once and retries it on the next foreground', async () => {
    const { supervisor, stalls, discards, start } = rig();
    const waiting = start();
    await flush();
    jest.advanceTimersByTime(WATCHDOG);
    await expect(waiting).resolves.toMatchObject({ outcome: 'timeout' });
    expect(stalls.map((s) => s.trigger)).toEqual(['watchdog']);
    expect(supervisor.foreground()).toBe(true);
    expect(stalls).toHaveLength(1);
    expect(discards.map((d) => d.trigger)).toEqual(['foreground']);
  });

  it('ignores the discarded attempt landing late, and builds the next on a fresh service', async () => {
    const { supervisor, clock, start } = rig();
    void start();
    await flush();
    clock.now += WATCHDOG;
    supervisor.foreground();
    const old = FakeService.built[0];
    old.land();
    await flush();
    expect(supervisor.lifecycle.phase).toBe('idle');

    const next = start();
    await flush();
    expect(FakeService.built).toHaveLength(2);
    expect(supervisor.service).toBe(FakeService.built[1]);
    expect(supervisor.lifecycle.attempt).toBe(2);
    FakeService.built[1].land();
    await expect(next).resolves.toEqual({ outcome: 'ready' });
  });

  it('marks a stalled attempt that lands as the current one ready', async () => {
    const { supervisor, start } = rig();
    const waiting = start();
    await flush();
    jest.advanceTimersByTime(WATCHDOG);
    const result = await waiting;
    if (result.outcome !== 'timeout') throw new Error(result.outcome);
    FakeService.built[0].land();
    await expect(result.landed).resolves.toBe(true);
    expect(supervisor.lifecycle.phase).toBe('ready');
  });

  it('retries a failed init on the next foreground', async () => {
    const { supervisor, discards, start } = rig();
    const waiting = start();
    await flush();
    FakeService.built[0].fail('AlreadyOpen');
    await expect(waiting).resolves.toMatchObject({ outcome: 'failed' });
    expect(supervisor.lifecycle).toMatchObject({ phase: 'failed', error: 'AlreadyOpen' });
    expect(supervisor.foreground()).toBe(true);
    expect(discards).toEqual([
      { attempt: 1, trigger: 'foreground', reason: 'init-failed', initPhase: 'pairing' },
    ]);
  });

  it('retries on request only when there is something to retry', async () => {
    const { supervisor, start } = rig();
    void start();
    await flush();
    expect(supervisor.retry()).toBe(false);
    FakeService.built[0].land();
    await flush();
    expect(supervisor.retry()).toBe(false);
  });

  it('lets a later caller begin a fresh attempt after a rejection', async () => {
    const { supervisor, start } = rig();
    const first = start();
    await flush();
    FakeService.built[0].fail();
    await first;
    const second = start();
    await flush();
    expect(supervisor.lifecycle).toMatchObject({ phase: 'initializing', attempt: 2 });
    FakeService.built[0].land();
    await expect(second).resolves.toEqual({ outcome: 'ready' });
  });
});
