import { recordEventLog, resetEventLogForTesting, unshippedCount } from '../event-log';
import { createShipper } from '../shipper';
import { createTelemetry } from '../telemetry';
import type { Attributes } from '../types';

interface Capture {
  url: string;
  body: any;
}

function harness(
  options: {
    fail?: () => boolean;
    resource?: Attributes;
    batchSize?: number;
    maxBatches?: number;
    nowStart?: number;
  } = {}
) {
  const sent: Capture[] = [];
  let nowMs = options.nowStart ?? 1_000_000;
  const shipper = createShipper({
    endpoint: 'http://collector:4318',
    resource: () => options.resource ?? { 'service.name': 'streetcryptid-app' },
    now: () => nowMs,
    batchSize: options.batchSize ?? 250,
    maxBatches: options.maxBatches ?? 3,
    transport: async (url, body) => {
      if (options.fail?.()) throw new Error('collector unreachable');
      sent.push({ url, body: JSON.parse(body) });
    },
  });
  return { shipper, sent, tick: (ms: number) => (nowMs += ms) };
}

function spansOf(capture: Capture): any[] {
  return capture.body.resourceSpans[0].scopeSpans[0].spans;
}

function logsOf(capture: Capture): any[] {
  return capture.body.resourceLogs[0].scopeLogs[0].logRecords;
}

describe('journal shipper', () => {
  beforeEach(() => resetEventLogForTesting());

  it('ships nothing when the journal is empty', async () => {
    const { shipper, sent } = harness();
    await shipper.drain();
    expect(sent).toEqual([]);
  });

  it('keeps entries queued when the collector rejects them, and re-sends later', async () => {
    let down = true;
    const { shipper, sent, tick } = harness({ fail: () => down });
    const telemetry = createTelemetry({ now: () => 5_000 });
    telemetry.startSpan('bg.wake', { attributes: { fixes: 2 } }).end();

    await shipper.drain();
    expect(sent).toEqual([]);
    // The whole point: a failed POST must not consume the entry.
    expect(await unshippedCount()).toBe(1);

    down = false;
    // The breaker holds the next attempt back, so an immediate retry is a no-op...
    await shipper.drain();
    expect(sent).toEqual([]);
    expect(shipper.isBackingOff()).toBe(true);

    // ...and it goes out once the backoff has elapsed.
    tick(60_000);
    expect(shipper.isBackingOff()).toBe(false);
    await shipper.drain();
    expect(spansOf(sent[0])).toHaveLength(1);
    expect(await unshippedCount()).toBe(0);
  });

  it('does not re-send an entry the collector already accepted', async () => {
    const { shipper, sent } = harness();
    const telemetry = createTelemetry({ now: () => 5_000 });
    telemetry.startSpan('publish.fix').end();

    await shipper.drain();
    await shipper.drain();
    expect(sent).toHaveLength(1);
  });

  it('replays a span with its original timestamps, trace context and events', async () => {
    const { shipper, sent } = harness();
    let nowMs = 1_700_000_000_000;
    const telemetry = createTelemetry({ now: () => nowMs });
    const parent = telemetry.startSpan('bg.wake');
    const span = telemetry.startSpan('outbox.drain', {
      parent: parent.context,
      attributes: { 'sc.author': 'ab12cd34ef' },
    });
    span.addEvent('publish.failed', { reason: 'node not ready' });
    nowMs += 250;
    span.setAttribute('published', 3);
    span.setStatus('ok');
    span.end();

    // Drain long after the fact — the replayed span must still describe when it HAPPENED, not
    // when it was finally delivered. That is what makes a recovered backlog readable.
    nowMs += 6 * 60 * 60_000;
    await shipper.drain();

    const exported = spansOf(sent[0]).find((s) => s.name === 'outbox.drain');
    expect(exported.startTimeUnixNano).toBe('1700000000000000000');
    expect(exported.endTimeUnixNano).toBe('1700000000250000000');
    expect(exported.traceId).toBe(parent.context.traceId);
    expect(exported.parentSpanId).toBe(parent.context.spanId);
    expect(exported.status).toEqual({ code: 1 });
    expect(exported.attributes).toEqual(
      expect.arrayContaining([
        { key: 'sc.author', value: { stringValue: 'ab12cd34ef' } },
        { key: 'published', value: { intValue: '3' } },
      ])
    );
    expect(exported.events[0].name).toBe('publish.failed');
  });

  it('ships journal entries that never went through the tracer', async () => {
    const { shipper, sent } = harness();
    // `recordEventLog` callers (ratchet, transport, generator) were local-only before the shipper.
    recordEventLog({
      category: 'ratchet',
      action: 'ratchet.ack.fix',
      summary: 'ratchet response received',
      level: 'warn',
      details: { attributes: { 'sc.peer': 'ff00' } },
    });

    await shipper.drain();
    const record = logsOf(sent[0])[0];
    expect(record.severityText).toBe('WARN');
    expect(record.body).toEqual({ stringValue: 'ratchet response received' });
    expect(record.attributes).toEqual(
      expect.arrayContaining([
        { key: 'event.action', value: { stringValue: 'ratchet.ack.fix' } },
        { key: 'sc.peer', value: { stringValue: 'ff00' } },
      ])
    );
  });

  it('stops at the batch budget so a headless wake is not spent on telemetry', async () => {
    const { shipper, sent } = harness({ batchSize: 2, maxBatches: 2 });
    const telemetry = createTelemetry({ now: () => 5_000 });
    for (let i = 0; i < 10; i += 1) telemetry.startSpan(`span.${i}`).end();

    await shipper.drain();
    // Two batches of two, and the rest waits for the next opportunity rather than blowing the
    // background time budget.
    expect(sent).toHaveLength(2);
    expect(await unshippedCount()).toBe(6);
  });

  it('stamps resource attributes read at send time, not at record time', async () => {
    const resource: Attributes = { 'service.name': 'streetcryptid-app' };
    const { shipper, sent } = harness({ resource });
    const telemetry = createTelemetry({ now: () => 5_000 });
    telemetry.startSpan('bg.wake').end();

    // `device.id` resolves asynchronously and lands after the span was recorded; the batch must
    // still carry it, which is the whole reason the resource is a getter.
    resource['device.id'] = 'a1b2c3d4e5f6';
    await shipper.drain();

    expect(sent[0].body.resourceSpans[0].resource.attributes).toEqual(
      expect.arrayContaining([{ key: 'device.id', value: { stringValue: 'a1b2c3d4e5f6' } }])
    );
  });
});

describe('journal shipper — failure containment', () => {
  beforeEach(() => resetEventLogForTesting());

  it('never rejects, so a reporting failure cannot fail the task it was reporting on', async () => {
    // `Telemetry.flush()` is awaited in the `finally` of every headless background task. A
    // rejection escaping from here would land in the task that was only trying to describe
    // itself — and in a headless context, with nothing above it, as an unhandled rejection.
    const shipper = createShipper({
      endpoint: 'http://collector:4318',
      resource: () => {
        throw new Error('resource assembly exploded');
      },
      now: () => 1_000,
    });
    const telemetry = createTelemetry({ now: () => 1_000 });
    telemetry.startSpan('bg.wake').end();

    await expect(shipper.drain()).resolves.toBeUndefined();
    // And the entry survives, because nothing confirmed it was delivered.
    expect(await unshippedCount()).toBe(1);
  });
});
