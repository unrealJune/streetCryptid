import {
  getEventLog,
  recordEventLog,
  resetEventLogForTesting,
  subscribeEventLog,
} from '../event-log';
import { createTelemetry } from '../telemetry';

describe('local event log', () => {
  beforeEach(() => resetEventLogForTesting());

  it('records spans even when remote OTLP export is disabled', () => {
    const telemetry = createTelemetry({ now: () => 1234 });
    const span = telemetry.startSpan('publish.fix', {
      attributes: { recipients: 2, 'sc.seq': 7 },
    });
    span.addEvent('gossip.publish.completed');
    span.setStatus('ok');
    span.end();

    expect(telemetry.enabled).toBe(false);
    expect(getEventLog()).toEqual([
      expect.objectContaining({
        timestamp: 1234,
        category: 'transport',
        action: 'publish.fix',
        level: 'debug',
        status: 'ok',
        transport: 'iroh',
      }),
    ]);
    expect(getEventLog()[0].details).toEqual(
      expect.objectContaining({
        attributes: expect.objectContaining({ recipients: 2, 'sc.seq': 7 }),
        events: [expect.objectContaining({ name: 'gossip.publish.completed' })],
      })
    );
  });

  it('uses warning and error levels for meaningful failures', () => {
    const telemetry = createTelemetry({ now: () => 1234 });
    const dropped = telemetry.startSpan('engine.ingest', {
      attributes: { 'sc.drop_reason': 'sampling-suspended' },
    });
    dropped.end();
    telemetry.log('error', 'publish failed');

    expect(getEventLog().map(({ level }) => level)).toEqual(['error', 'warn']);
  });

  it('redacts credentials and precise locations from details', () => {
    recordEventLog({
      category: 'transport',
      action: 'send',
      summary: 'sent',
      details: {
        pushToken: 'secret-token',
        authorization: '******',
        payload: { lat: 45.1, longitude: -122.2, accuracyM: 5 },
      },
    });

    expect(getEventLog()[0].details).toEqual({
      pushToken: '[REDACTED]',
      authorization: '[REDACTED]',
      payload: {
        lat: '[LOCATION REDACTED]',
        longitude: '[LOCATION REDACTED]',
        accuracyM: 5,
      },
    });
  });

  it('redacts credentials and coordinates from unstructured summaries', () => {
    recordEventLog({
      category: 'transport',
      action: 'log',
      summary: 'authorization: ****** token=xyz lat=45.1 longitude=-122.2',
    });

    expect(getEventLog()[0].summary).not.toContain('xyz');
    expect(getEventLog()[0].summary).not.toContain('45.1');
    expect(getEventLog()[0].summary).not.toContain('-122.2');
    expect(getEventLog()[0].summary).toContain('[REDACTED]');
  });

  it('notifies subscribers for new entries', () => {
    const listener = jest.fn();
    const unsubscribe = subscribeEventLog(listener);
    recordEventLog({
      category: 'transport',
      action: 'transport.poll',
      summary: 'no active paths',
    });

    expect(listener).toHaveBeenLastCalledWith([
      expect.objectContaining({ action: 'transport.poll' }),
    ]);
    unsubscribe();
  });
});
