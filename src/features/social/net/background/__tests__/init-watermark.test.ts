import { InMemoryKV } from '../persistent-kv';
import {
  clearInitWatermark,
  loadInitWatermark,
  saveInitWatermark,
  type InitPhase,
} from '../../persistence';
import { reportStrandedInit } from '../init-watermark';

const ended: { name: string; attributes: Record<string, unknown> }[] = [];

jest.mock('@/features/dev/telemetry', () => ({
  getTelemetry: () => ({
    startSpan: (name: string, opts?: { attributes?: Record<string, unknown> }) => ({
      end: () => ended.push({ name, attributes: opts?.attributes ?? {} }),
    }),
  }),
}));

beforeEach(() => {
  ended.length = 0;
});

describe('init watermark', () => {
  it('round-trips the phase that was in flight', async () => {
    const kv = new InMemoryKV();
    await saveInitWatermark(kv, 'native-start', 1_000, true);
    expect(await loadInitWatermark(kv)).toEqual({
      startedAt: 1_000,
      phase: 'native-start',
      interactive: true,
    });
  });

  it('keeps the attempt start time across phase changes, so stranded_ms measures the whole init', async () => {
    // The watermark answers "how long has this init been stuck", not "how long has this phase
    // been stuck" — the phase names WHERE, `startedAt` measures the outage.
    const kv = new InMemoryKV();
    const startedAt = 5_000;
    for (const phase of ['create-node', 'mirror-secrets', 'native-start'] as InitPhase[]) {
      await saveInitWatermark(kv, phase, startedAt, true);
    }
    expect(await loadInitWatermark(kv)).toEqual({
      startedAt,
      phase: 'native-start',
      interactive: true,
    });
  });

  it('reads a never-written store as "no init has stalled"', async () => {
    expect(await loadInitWatermark(new InMemoryKV())).toBeNull();
    expect(await reportStrandedInit(new InMemoryKV(), 'mounted')).toBeNull();
    expect(ended).toHaveLength(0);
  });

  it('reads a cleared watermark as nothing to report', async () => {
    const kv = new InMemoryKV();
    await saveInitWatermark(kv, 'tickets', 1_000, true);
    await clearInitWatermark(kv);
    expect(await loadInitWatermark(kv)).toBeNull();
  });

  it('reports a stalled init as a span naming the phase, then clears it', async () => {
    const kv = new InMemoryKV();
    const startedAt = Date.now() - 60_000;
    await saveInitWatermark(kv, 'create-node', startedAt, true);

    const strandedMs = await reportStrandedInit(kv, 'mounted');

    expect(strandedMs).toBeGreaterThanOrEqual(60_000);
    expect(ended).toHaveLength(1);
    expect(ended[0].name).toBe('app.init.stranded');
    expect(ended[0].attributes).toMatchObject({
      'init.phase': 'create-node',
      'init.interactive': true,
      reported_from: 'mounted',
      'sc.drop_reason': 'init-stranded',
    });
    // Exactly once: a second launch must not re-report an outage already on the wire.
    expect(await reportStrandedInit(kv, 'mounted')).toBeNull();
    expect(ended).toHaveLength(1);
  });

  it('survives a corrupt row rather than reporting a phantom stall on every launch', async () => {
    const kv = new InMemoryKV();
    await kv.set('sc.social.initPhase', '{not json');
    expect(await loadInitWatermark(kv)).toBeNull();
    expect(await reportStrandedInit(kv, 'headless')).toBeNull();
    expect(ended).toHaveLength(0);
  });

  it('never rejects when the store is broken — reporting must not fail a launch', async () => {
    const broken = {
      get: async () => {
        throw new Error('db gone');
      },
      set: async () => {
        throw new Error('db gone');
      },
      remove: async () => {
        throw new Error('db gone');
      },
    };
    await expect(reportStrandedInit(broken, 'mounted')).resolves.toBeNull();
  });
});
