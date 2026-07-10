import type { LocationFix } from '../../../core/types';
import {
  createBackgroundFixDispatcher,
  type ActiveBackgroundFixHandler,
} from '../background-dispatch';
import type { FixOutbox } from '../fix-outbox';

const fix = (ts: number): LocationFix => ({
  lat: 47.62,
  lon: -122.32,
  accuracyM: 5,
  headingDeg: 0,
  ts,
});

function fakeOutbox(): FixOutbox & { items: LocationFix[] } {
  const items: LocationFix[] = [];
  return {
    items,
    async enqueue(item) {
      items.push(item);
    },
    async drain(publish) {
      let count = 0;
      while (items.length > 0) {
        await publish(items[0]);
        items.shift();
        count += 1;
      }
      return count;
    },
    async pending() {
      return items.length;
    },
    async clear() {
      items.length = 0;
    },
  };
}

describe('background fix dispatcher', () => {
  it('delivers an OS batch directly to the mounted runtime', async () => {
    const outbox = fakeOutbox();
    const flushHeadless = jest.fn(async () => {});
    const received: number[] = [];
    const dispatcher = createBackgroundFixDispatcher({ outbox, flushHeadless });
    dispatcher.registerActiveHandler(async (item) => {
      received.push(item.ts);
    });

    await dispatcher.dispatch([fix(1), fix(2)]);

    expect(received).toEqual([1, 2]);
    expect(outbox.items).toHaveLength(0);
    expect(flushHeadless).not.toHaveBeenCalled();
  });

  it('persists a headless batch before asking the restored runtime to flush', async () => {
    const outbox = fakeOutbox();
    const seenAtFlush: number[][] = [];
    const dispatcher = createBackgroundFixDispatcher({
      outbox,
      flushHeadless: async () => {
        seenAtFlush.push(outbox.items.map((item) => item.ts));
      },
    });

    await dispatcher.dispatch([fix(3), fix(4)]);

    expect(seenAtFlush).toEqual([[3, 4]]);
  });

  it('falls back without losing a fix when the live publisher rejects it', async () => {
    const outbox = fakeOutbox();
    const activeError = jest.fn();
    const flushHeadless = jest.fn(async () => {});
    const dispatcher = createBackgroundFixDispatcher({
      outbox,
      flushHeadless,
      onActiveError: activeError,
    });
    const handler: ActiveBackgroundFixHandler = async (item) => {
      if (item.ts === 6) throw new Error('node disconnected');
    };
    dispatcher.registerActiveHandler(handler);

    await dispatcher.dispatch([fix(5), fix(6), fix(7)]);

    expect(outbox.items.map((item) => item.ts)).toEqual([6]);
    expect(activeError).toHaveBeenCalledTimes(1);
    expect(flushHeadless).not.toHaveBeenCalled();
  });

  it('stops routing to a handler after its cleanup runs', async () => {
    const outbox = fakeOutbox();
    const dispatcher = createBackgroundFixDispatcher({
      outbox,
      flushHeadless: async () => {},
    });
    const handler = jest.fn(async () => {});
    const unregister = dispatcher.registerActiveHandler(handler);
    unregister();

    await dispatcher.dispatch([fix(8)]);

    expect(handler).not.toHaveBeenCalled();
    expect(outbox.items.map((item) => item.ts)).toEqual([8]);
  });
});
