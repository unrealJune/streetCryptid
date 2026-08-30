import type { LocationFix } from '../../../core/types';
import type { SpanContext } from '@/features/dev/telemetry';
import {
  createBackgroundFixDispatcher,
  type ActiveBackgroundFixHandler,
} from '../background-dispatch';

const fix = (ts: number): LocationFix => ({
  lat: 47.62,
  lon: -122.32,
  accuracyM: 5,
  headingDeg: 0,
  ts,
});

/**
 * Records what the headless path was handed.
 *
 * There is no fake outbox any more: the durable queue moved to Rust (`outbox.rs`) so an OS callback
 * can fill and drain it with no JS context alive. The dispatcher's whole job is now the routing
 * decision — mounted runtime, or a short-lived headless one — and that is what these assert.
 */
function recorder(): {
  ingestHeadless: (fixes: readonly LocationFix[], parent?: SpanContext) => Promise<void>;
  calls: { ts: number[]; parent?: SpanContext }[];
} {
  const calls: { ts: number[]; parent?: SpanContext }[] = [];
  return {
    calls,
    ingestHeadless: async (fixes, parent) => {
      calls.push({ ts: fixes.map((f) => f.ts), parent });
    },
  };
}

describe('background fix dispatcher', () => {
  it('delivers an OS batch directly to the mounted runtime', async () => {
    const headless = recorder();
    const received: number[] = [];
    const dispatcher = createBackgroundFixDispatcher({ ingestHeadless: headless.ingestHeadless });
    dispatcher.registerActiveHandler(async (item) => {
      received.push(item.ts);
    });

    await dispatcher.dispatch([fix(1), fix(2)]);

    expect(received).toEqual([1, 2]);
    expect(headless.calls).toHaveLength(0);
  });

  it('hands a headless batch straight down, with no JS queue in between', async () => {
    const headless = recorder();
    const dispatcher = createBackgroundFixDispatcher({ ingestHeadless: headless.ingestHeadless });

    await dispatcher.dispatch([fix(3), fix(4)]);

    expect(headless.calls.map((c) => c.ts)).toEqual([[3, 4]]);
  });

  it('falls back without losing a fix when the live publisher rejects it', async () => {
    const headless = recorder();
    const activeError = jest.fn();
    const dispatcher = createBackgroundFixDispatcher({
      ingestHeadless: headless.ingestHeadless,
      onActiveError: activeError,
    });
    const handler: ActiveBackgroundFixHandler = async (item) => {
      if (item.ts === 6) throw new Error('node disconnected');
    };
    dispatcher.registerActiveHandler(handler);

    await dispatcher.dispatch([fix(5), fix(6), fix(7)]);

    expect(activeError).toHaveBeenCalledTimes(1);
    // A mounted runtime owns the process-wide native stores, so the rejected fix waits for ITS next
    // heartbeat rather than racing a second runtime against the same author/seq space — the
    // directory claim in `durable.rs` would refuse that second one anyway.
    expect(headless.calls).toHaveLength(0);
  });

  it('stops routing to a handler after its cleanup runs', async () => {
    const headless = recorder();
    const dispatcher = createBackgroundFixDispatcher({ ingestHeadless: headless.ingestHeadless });
    const handler = jest.fn(async () => {});
    const unregister = dispatcher.registerActiveHandler(handler);
    unregister();

    await dispatcher.dispatch([fix(8)]);

    expect(handler).not.toHaveBeenCalled();
    expect(headless.calls.map((c) => c.ts)).toEqual([[8]]);
  });

  it('carries the wake context through active and headless dispatch', async () => {
    const parent: SpanContext = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) };
    const activeHandler = jest.fn(async () => {});
    const active = createBackgroundFixDispatcher({ ingestHeadless: recorder().ingestHeadless });
    active.registerActiveHandler(activeHandler);

    await active.dispatch([fix(9)], parent);

    expect(activeHandler).toHaveBeenCalledWith(expect.objectContaining({ ts: 9 }), parent);

    const headless = recorder();
    const dispatcher = createBackgroundFixDispatcher({ ingestHeadless: headless.ingestHeadless });

    await dispatcher.dispatch([fix(10)], parent);

    expect(headless.calls).toEqual([{ ts: [10], parent }]);
  });
});
