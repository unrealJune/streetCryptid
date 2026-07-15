import { installConsoleTelemetryBridge, uninstallConsoleTelemetryBridge } from '../console-bridge';
import { setTelemetryForTesting, type Telemetry } from '../telemetry';
import type { LogSeverity } from '../types';

function fakeTelemetry(enabled: boolean) {
  const logs: { severity: LogSeverity; body: string }[] = [];
  const instance = {
    enabled,
    startSpan: () => {
      throw new Error('unused');
    },
    withSpan: async (_n: string, _o: unknown, fn: (span: unknown) => Promise<unknown>) => fn({}),
    log: (severity: LogSeverity, body: string) => {
      logs.push({ severity, body });
    },
    setResourceAttributes: () => {},
    flush: async () => {},
  } as unknown as Telemetry;
  return { instance, logs };
}

describe('installConsoleTelemetryBridge', () => {
  let realWarn: typeof console.warn;
  let realError: typeof console.error;

  beforeEach(() => {
    realWarn = console.warn;
    realError = console.error;
  });

  afterEach(() => {
    uninstallConsoleTelemetryBridge();
    console.warn = realWarn;
    console.error = realError;
    setTelemetryForTesting(undefined);
  });

  it('mirrors console.warn to telemetry.log and still calls the original', () => {
    const { instance, logs } = fakeTelemetry(true);
    setTelemetryForTesting(instance);
    const spy = jest.fn();
    console.warn = spy;

    installConsoleTelemetryBridge();
    console.warn('[background-location] sink failed', new Error('boom'));

    expect(spy).toHaveBeenCalled();
    expect(logs).toEqual([
      { severity: 'warn', body: '[background-location] sink failed Error: boom' },
    ]);
  });

  it('mirrors console.error at error severity', () => {
    const { instance, logs } = fakeTelemetry(true);
    setTelemetryForTesting(instance);
    console.error = jest.fn();

    installConsoleTelemetryBridge();
    console.error('kaboom');

    expect(logs).toEqual([{ severity: 'error', body: 'kaboom' }]);
  });

  it("does not capture the exporter's own [dev-telemetry] failure notice (no feedback loop)", () => {
    const { instance, logs } = fakeTelemetry(true);
    setTelemetryForTesting(instance);
    console.warn = jest.fn();

    installConsoleTelemetryBridge();
    console.warn('[dev-telemetry] OTLP export to http://x failed');

    expect(logs).toHaveLength(0);
  });

  it('is inert when telemetry is disabled — leaves console untouched', () => {
    const { instance, logs } = fakeTelemetry(false);
    setTelemetryForTesting(instance);
    const spy = jest.fn();
    console.warn = spy;

    installConsoleTelemetryBridge();
    console.warn('hello');

    expect(spy).toHaveBeenCalledWith('hello');
    expect(logs).toHaveLength(0);
    expect(console.warn).toBe(spy);
  });
});
