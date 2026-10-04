/**
 * The bridge half of the node's lifecycle, against a native module that refuses, hangs, throws or
 * lacks an export on demand. `native-start-bound.test.ts` checks the same rules through a whole
 * `LocationSharingService.init`; these pin them where they live.
 */

import { setTelemetryForTesting, type Telemetry } from '@/features/dev/telemetry';

import {
  handOverNativeBackground,
  hasNodeHost,
  isClaimRefusal,
  NATIVE_HANDOVER_TIMEOUT_MS,
  NATIVE_START_TIMEOUT_MS,
  releaseNativeBackground,
  startNativeBounded,
} from '../native-node';

const spans: { name: string; attributes: Record<string, unknown>; error?: unknown }[] = [];
const logs: string[] = [];

function recordingTelemetry(): Telemetry {
  return {
    enabled: true,
    startSpan: (name: string, options?: { attributes?: Record<string, unknown> }) => {
      const record: (typeof spans)[number] = { name, attributes: { ...options?.attributes } };
      spans.push(record);
      return {
        context: { traceId: '0'.repeat(32), spanId: '0'.repeat(16) },
        setAttribute: (key: string, value: unknown) => {
          record.attributes[key] = value;
        },
        setAttributes: (values: Record<string, unknown>) =>
          Object.assign(record.attributes, values),
        addEvent: () => {},
        recordError: (error: unknown) => {
          record.error = error;
        },
        setStatus: () => {},
        end: () => {},
      };
    },
    withSpan: async (_name: string, _options: unknown, fn: (span: never) => unknown) =>
      fn(undefined as never),
    log: (_level: string, message: string) => {
      logs.push(message);
    },
    setResourceAttributes: () => {},
    flush: async () => {},
  } as unknown as Telemetry;
}

const CONFIG = { relay: true, ip: true, ble: false };

function refusal(): Error {
  return new Error(
    "Call to function 'IrohLocation.start' has been rejected: session store is already open: AlreadyOpen"
  );
}

interface FakeModule {
  start: jest.Mock;
  stopNativeBackground: jest.Mock;
  releaseNativeBackground?: jest.Mock;
  handOverNativeBackground?: jest.Mock;
}

function fakeModule(overrides: Partial<Record<keyof FakeModule, jest.Mock | undefined>> = {}) {
  return {
    start: jest.fn(async () => {}),
    releaseNativeBackground: jest.fn(),
    stopNativeBackground: jest.fn(),
    ...overrides,
  } as FakeModule;
}

function deps() {
  return { flush: jest.fn(async () => {}), handOver: jest.fn(async () => {}) };
}

beforeEach(() => {
  spans.length = 0;
  logs.length = 0;
  setTelemetryForTesting(recordingTelemetry());
});

afterEach(() => {
  jest.useRealTimers();
});

afterAll(() => setTelemetryForTesting(undefined));

describe('hasNodeHost', () => {
  it('is the restartNode export, which ships exactly with the host', () => {
    expect(hasNodeHost({ restartNode: async () => {} })).toBe(true);
    expect(hasNodeHost({})).toBe(false);
  });
});

describe('isClaimRefusal', () => {
  it.each([
    'session store is already open: AlreadyOpen',
    'seq store already claimed',
    'writer claim held by another node',
  ])('recognises %p', (message) => {
    expect(isClaimRefusal(new Error(message))).toBe(true);
  });

  it('does not mistake another failure for a refused claim', () => {
    expect(isClaimRefusal(new Error('relay unreachable'))).toBe(false);
    expect(isClaimRefusal('native start did not return')).toBe(false);
  });
});

describe('startNativeBounded', () => {
  it('starts with the given settings and nothing else', async () => {
    const mod = fakeModule();
    const d = deps();
    await startNativeBounded(mod as never, CONFIG, d);
    expect(mod.start).toHaveBeenCalledWith(CONFIG);
    expect(d.handOver).not.toHaveBeenCalled();
    expect(spans).toEqual([]);
  });

  it('hands over and retries ONCE on a refused claim', async () => {
    const mod = fakeModule({
      start: jest.fn().mockRejectedValueOnce(refusal()).mockResolvedValueOnce(undefined),
    });
    const d = deps();
    await startNativeBounded(mod as never, CONFIG, d);
    expect(mod.start).toHaveBeenCalledTimes(2);
    expect(d.handOver).toHaveBeenCalledTimes(1);
    expect(spans.map((s) => s.name)).toEqual(['node.start.claim_refused']);
  });

  it('gives up after the one retry rather than looping', async () => {
    const mod = fakeModule({ start: jest.fn(async () => Promise.reject(refusal())) });
    const d = deps();
    await expect(startNativeBounded(mod as never, CONFIG, d)).rejects.toThrow(/AlreadyOpen/);
    expect(mod.start).toHaveBeenCalledTimes(2);
    expect(d.handOver).toHaveBeenCalledTimes(1);
  });

  it('does not retry a failure that is not a refused claim', async () => {
    const mod = fakeModule({
      start: jest.fn(async () => Promise.reject(new Error('bind failed'))),
    });
    const d = deps();
    await expect(startNativeBounded(mod as never, CONFIG, d)).rejects.toThrow('bind failed');
    expect(mod.start).toHaveBeenCalledTimes(1);
    expect(d.handOver).not.toHaveBeenCalled();
  });

  it('fails a start that never returns, at the deadline and not before, and flushes the span', async () => {
    jest.useFakeTimers();
    const mod = fakeModule({ start: jest.fn(() => new Promise<void>(() => {})) });
    const d = deps();
    const start = startNativeBounded(mod as never, CONFIG, d);
    const settled = jest.fn();
    void start.then(settled, settled);

    await jest.advanceTimersByTimeAsync(NATIVE_START_TIMEOUT_MS - 1);
    expect(settled).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(2);
    await expect(start).rejects.toThrow(/did not return/);
    expect(spans.map((s) => s.name)).toEqual(['node.start_timeout']);
    expect(spans[0].attributes['sc.drop_reason']).toBe('native-start-timeout');
    expect(d.flush).toHaveBeenCalledTimes(1);
  });
});

describe('handOverNativeBackground', () => {
  it('records a completed handover', async () => {
    const mod = fakeModule({ handOverNativeBackground: jest.fn(async () => true) });
    await handOverNativeBackground(mod as never);
    expect(mod.handOverNativeBackground).toHaveBeenCalledWith(NATIVE_HANDOVER_TIMEOUT_MS);
    expect(spans[0]).toMatchObject({ name: 'node.handover', attributes: { completed: true } });
  });

  it('says so when the native side gave up inside its own bound', async () => {
    const mod = fakeModule({ handOverNativeBackground: jest.fn(async () => false) });
    await handOverNativeBackground(mod as never);
    expect(spans[0].attributes).toMatchObject({
      completed: false,
      'sc.drop_reason': 'handover-timeout',
    });
  });

  it('bounds a native handover that never settles, and never throws', async () => {
    jest.useFakeTimers();
    const mod = fakeModule({
      handOverNativeBackground: jest.fn(() => new Promise<boolean>(() => {})),
    });
    const handover = handOverNativeBackground(mod as never);
    await jest.advanceTimersByTimeAsync(NATIVE_HANDOVER_TIMEOUT_MS * 2 + 1);
    await expect(handover).resolves.toBeUndefined();
    expect(spans[0].attributes).toMatchObject({ completed: false });
  });

  it('records a handover that threw, and still lets the launch go on', async () => {
    const mod = fakeModule({
      handOverNativeBackground: jest.fn(async () => Promise.reject(new Error('boom'))),
    });
    await expect(handOverNativeBackground(mod as never)).resolves.toBeUndefined();
    expect(spans[0].error).toBeInstanceOf(Error);
  });

  it('falls back to releasing the sink on a binary without the export — every host binary', async () => {
    const mod = fakeModule();
    await handOverNativeBackground(mod as never);
    expect(mod.releaseNativeBackground).toHaveBeenCalledTimes(1);
    expect(spans).toEqual([]);
  });

  it('tolerates having no module at all', async () => {
    await expect(handOverNativeBackground(null)).resolves.toBeUndefined();
  });
});

describe('releaseNativeBackground', () => {
  it('releases without disarming when the binary can', () => {
    const mod = fakeModule();
    releaseNativeBackground(mod as never);
    expect(mod.releaseNativeBackground).toHaveBeenCalledTimes(1);
    expect(mod.stopNativeBackground).not.toHaveBeenCalled();
  });

  it('falls back to the full stop on a binary from before the release export', () => {
    const mod = fakeModule({ releaseNativeBackground: undefined });
    releaseNativeBackground(mod as never);
    expect(mod.stopNativeBackground).toHaveBeenCalledTimes(1);
  });

  it('logs rather than throws when the native call fails', () => {
    const mod = fakeModule({
      releaseNativeBackground: jest.fn(() => {
        throw new Error('module gone');
      }),
    });
    expect(() => releaseNativeBackground(mod as never)).not.toThrow();
    expect(logs).toContain('native background release failed');
  });
});
