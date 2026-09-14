import { diagnosticAttributes, reportOsDiagnostics } from '../crash-diagnostics';
import { getEventLog, resetEventLogForTesting } from '../event-log';
import { createTelemetry, setTelemetryForTesting } from '../telemetry';

function reported() {
  return getEventLog()
    .filter((entry) => entry.action === 'ios.diagnostic')
    .map((entry) => (entry.details as { attributes: Record<string, unknown> }).attributes);
}

describe('OS crash/hang diagnostics', () => {
  beforeEach(() => {
    resetEventLogForTesting();
    setTelemetryForTesting(createTelemetry({ now: () => 1_000 }));
  });

  afterEach(() => setTelemetryForTesting(undefined));

  // The convention every optional native export here follows: a phone can be running an older
  // binary than the JS bundle, so absence is normal and must be silent, not a throw.
  it('does nothing when the binary predates the native half', async () => {
    await expect(reportOsDiagnostics({})).resolves.toBe(0);
    await expect(reportOsDiagnostics(null)).resolves.toBe(0);
    expect(reported()).toHaveLength(0);
  });

  it('survives a native call that throws', async () => {
    const source = {
      takeCrashDiagnostics: jest.fn(async () => {
        throw new Error('bridge is gone');
      }),
    };
    await expect(reportOsDiagnostics(source)).resolves.toBe(0);
  });

  // A hang's duration is the number this whole path exists to recover: it needs no symbolication
  // and it is the one thing nothing in-process can measure about its own death.
  it('reports a hang with its duration', async () => {
    const source = {
      takeCrashDiagnostics: jest.fn(async () => [
        JSON.stringify({
          kind: 'hang',
          duration_ms: 4_312.7,
          app_build: '77',
          os_version: 'iPhone OS 26.6.2',
          frames: ['streetCryptid+0x1a2b', 'libsystem_kernel.dylib+0x4f0'],
        }),
      ]),
    };

    await expect(reportOsDiagnostics(source)).resolves.toBe(1);
    const [span] = reported();
    expect(span).toMatchObject({
      kind: 'hang',
      duration_ms: 4_313,
      'diag.app_build': '77',
      frame_count: 2,
      frames: 'streetCryptid+0x1a2b\nlibsystem_kernel.dylib+0x4f0',
    });
  });

  it('carries the fields that name how a crash ended', () => {
    const attributes = diagnosticAttributes({
      kind: 'crash',
      termination_reason: 'Namespace JETSAM, Code 0xdead10cc',
      exception_type: 10,
      exception_code: 0,
      signal: 6,
    });
    expect(attributes).toMatchObject({
      kind: 'crash',
      termination_reason: 'Namespace JETSAM, Code 0xdead10cc',
      exception_type: 10,
      signal: 6,
    });
  });

  // A diagnostic outlives the build that produced it — it is delivered to the NEXT launch, which
  // may already be the build installed to fix it. Attributing it to the running build would make
  // the fix look like the cause, so the reported build is namespaced separately.
  it('keeps the reporting build separate from the build that died', () => {
    const attributes = diagnosticAttributes({
      kind: 'crash',
      app_version: '2.9.0',
      app_build: '71',
    });
    expect(attributes['diag.app_version']).toBe('2.9.0');
    expect(attributes['diag.app_build']).toBe('71');
    expect(attributes.app_version).toBeUndefined();
  });

  it('bounds a malformed payload rather than emitting an unbounded span', () => {
    const attributes = diagnosticAttributes({
      kind: 'crash',
      termination_reason: 'x'.repeat(5_000),
      frames: Array.from({ length: 500 }, (_, i) => `f${i}`),
    });
    expect((attributes.termination_reason as string).length).toBe(256);
    expect(attributes.frame_count).toBe(48);
  });

  it('skips entries that are not JSON, and reports the rest', async () => {
    const source = {
      takeCrashDiagnostics: jest.fn(async () => [
        'not json at all',
        JSON.stringify({ noKind: true }),
        JSON.stringify({ kind: 'crash', signal: 11 }),
      ]),
    };
    await expect(reportOsDiagnostics(source)).resolves.toBe(1);
    expect(reported()).toHaveLength(1);
  });
});
