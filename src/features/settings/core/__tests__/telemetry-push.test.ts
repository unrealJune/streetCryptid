import { describeTelemetryPush, pushAllTelemetry } from '../telemetry-push';

const nativeOk = {
  configured: true,
  delivered: 12,
  dropped: 0,
  reachable: true,
  remainingBatches: 0,
  remainingBytes: 0,
};

describe('pushAllTelemetry', () => {
  it('pushes both halves and reports each', async () => {
    const result = await pushAllTelemetry({
      native: { pushTelemetryNow: async () => nativeOk },
      pushJournal: async () => ({ sent: 40, reachable: true, remaining: 0 }),
    });
    expect(result).toEqual({
      js: { sent: 40, reachable: true, remaining: 0 },
      native: nativeOk,
      osDiagnostics: 0,
    });
  });

  it('still pushes the journal on a binary without the native push, and never rejects', async () => {
    const result = await pushAllTelemetry({
      native: {},
      pushJournal: async () => {
        throw new Error('sqlite gone');
      },
    });
    expect(result).toEqual({ js: undefined, native: undefined, osDiagnostics: 0 });
  });
});

describe('describeTelemetryPush', () => {
  it('says what went and what is left', () => {
    expect(
      describeTelemetryPush({
        js: { sent: 40, reachable: true, remaining: 0 },
        native: { ...nativeOk, dropped: 2, remainingBatches: 1, remainingBytes: 20_480 },
        osDiagnostics: 1,
      })
    ).toEqual([
      'JS: sent 40 rows, 0 left',
      'Rust: sent 12 batches, 2 dropped, 1 batches (20 KiB) left',
      'iOS: 1 OS diagnostics reported',
    ]);
  });

  it('names an unreachable collector and an old binary', () => {
    expect(
      describeTelemetryPush({
        js: { sent: 0, reachable: false, remaining: 300 },
        osDiagnostics: 0,
      })
    ).toEqual([
      'JS: collector unreachable — sent 0, 300 rows still queued',
      'Rust: this build cannot push (update the app)',
    ]);
  });
});
