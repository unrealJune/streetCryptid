import { createTelemetry, parseTraceparent, traceparentFor } from '../telemetry';

interface Capture {
  url: string;
  body: unknown;
}

function makeHarness(nowStart = 1_000_000) {
  const sent: Capture[] = [];
  let nowMs = nowStart;
  const telemetry = createTelemetry({
    endpoint: 'http://collector:4318',
    transport: async (url, body) => {
      sent.push({ url, body: JSON.parse(body) });
    },
    now: () => nowMs,
  });
  return { telemetry, sent, tick: (ms: number) => (nowMs += ms) };
}

/** Dig the spans array out of an OTLP resourceSpans payload. */
function spansOf(capture: Capture): any[] {
  return (capture.body as any).resourceSpans[0].scopeSpans[0].spans;
}

describe('telemetry span export', () => {
  it('exports a finished span with attributes, events, status and nano timestamps', async () => {
    const { telemetry, sent, tick } = makeHarness();
    const span = telemetry.startSpan('outbox.drain', { attributes: { 'sc.author': 'ab12' } });
    span.setAttribute('published', 3);
    span.addEvent('publish.failed', { 'sc.seq': 7, reason: 'node not ready' });
    tick(250);
    span.setStatus('ok');
    span.end();
    await telemetry.flush();

    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe('http://collector:4318/v1/traces');
    const [exported] = spansOf(sent[0]);
    expect(exported.name).toBe('outbox.drain');
    expect(exported.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(exported.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(exported.startTimeUnixNano).toBe('1000000000000');
    expect(exported.endTimeUnixNano).toBe('1000250000000');
    expect(exported.status).toEqual({ code: 1 });
    expect(exported.attributes).toEqual(
      expect.arrayContaining([
        { key: 'sc.author', value: { stringValue: 'ab12' } },
        { key: 'published', value: { intValue: '3' } },
      ])
    );
    expect(exported.events[0].name).toBe('publish.failed');
    expect(exported.events[0].attributes).toEqual(
      expect.arrayContaining([{ key: 'sc.seq', value: { intValue: '7' } }])
    );
  });

  it('parents child spans and records links', async () => {
    const { telemetry, sent } = makeHarness();
    const parent = telemetry.startSpan('bg.wake');
    const remote = { traceId: 'c'.repeat(32), spanId: 'd'.repeat(16) };
    const child = telemetry.startSpan('publish.fix', {
      parent: parent.context,
      links: [remote],
    });
    child.end();
    parent.end();
    await telemetry.flush();

    const spans = spansOf(sent[0]);
    const exportedChild = spans.find((s: any) => s.name === 'publish.fix');
    expect(exportedChild.traceId).toBe(parent.context.traceId);
    expect(exportedChild.parentSpanId).toBe(parent.context.spanId);
    expect(exportedChild.links).toEqual([{ traceId: 'c'.repeat(32), spanId: 'd'.repeat(16) }]);
  });

  it('withSpan marks errors and rethrows', async () => {
    const { telemetry, sent } = makeHarness();
    await expect(
      telemetry.withSpan('publish.fix', {}, async () => {
        throw new Error('node not ready');
      })
    ).rejects.toThrow('node not ready');
    await telemetry.flush();

    const [span] = spansOf(sent[0]);
    expect(span.status.code).toBe(2);
    expect(span.status.message).toBe('node not ready');
    expect(span.events[0].name).toBe('exception');
  });

  it('span.end is idempotent', async () => {
    const { telemetry, sent } = makeHarness();
    const span = telemetry.startSpan('once');
    span.end();
    span.end();
    await telemetry.flush();
    expect(spansOf(sent[0])).toHaveLength(1);
  });

  it('export failures are swallowed (telemetry never breaks the app)', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const telemetry = createTelemetry({
      endpoint: 'http://collector:4318',
      transport: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    telemetry.startSpan('doomed').end();
    await expect(telemetry.flush()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe('telemetry log export', () => {
  it('exports logs with severity and span correlation', async () => {
    const { telemetry, sent } = makeHarness();
    const span = telemetry.startSpan('bg.wake');
    telemetry.log('warn', 'outbox overflow: dropped oldest', { dropped: 2 }, span.context);
    span.end();
    await telemetry.flush();

    const logCapture = sent.find((c) => c.url.endsWith('/v1/logs'))!;
    const record = (logCapture.body as any).resourceLogs[0].scopeLogs[0].logRecords[0];
    expect(record.severityNumber).toBe(13);
    expect(record.severityText).toBe('WARN');
    expect(record.body).toEqual({ stringValue: 'outbox overflow: dropped oldest' });
    expect(record.traceId).toBe(span.context.traceId);
    expect(record.spanId).toBe(span.context.spanId);
  });
});

describe('resource attributes', () => {
  it('stamps service.name and late-merged instance id', async () => {
    const { telemetry, sent } = makeHarness();
    telemetry.setResourceAttributes({ 'service.instance.id': 'ab12cd34ef' });
    telemetry.startSpan('s').end();
    await telemetry.flush();

    const resourceAttrs = (sent[0].body as any).resourceSpans[0].resource.attributes;
    expect(resourceAttrs).toEqual(
      expect.arrayContaining([
        { key: 'service.name', value: { stringValue: 'streetcryptid-app' } },
        { key: 'service.instance.id', value: { stringValue: 'ab12cd34ef' } },
      ])
    );
  });
});

describe('traceparent helpers', () => {
  it('round-trips', () => {
    const context = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) };
    expect(parseTraceparent(traceparentFor(context))).toEqual(context);
  });

  it('rejects malformed and all-zero values', () => {
    expect(parseTraceparent(null)).toBeNull();
    expect(parseTraceparent('')).toBeNull();
    expect(parseTraceparent('garbage')).toBeNull();
    expect(parseTraceparent(`00-${'0'.repeat(32)}-${'b'.repeat(16)}-01`)).toBeNull();
    expect(parseTraceparent(`00-${'a'.repeat(32)}-${'0'.repeat(16)}-01`)).toBeNull();
  });
});
