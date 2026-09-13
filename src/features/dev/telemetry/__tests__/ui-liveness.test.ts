import { AppState } from 'react-native';

import { getEventLog, resetEventLogForTesting } from '../event-log';
import { createTelemetry, setTelemetryForTesting } from '../telemetry';
import { resetUiLivenessForTesting, startUiLivenessProbe } from '../ui-liveness';

/** Drives frames by hand so a "hang" is just a frame callback we decline to invoke. */
function frameDriver() {
  let pending: (() => void) | null = null;
  return {
    requestFrame(callback: () => void) {
      pending = callback;
    },
    /** Deliver one frame, as the display link would. */
    paint() {
      const next = pending;
      pending = null;
      next?.();
    },
  };
}

function hangs() {
  return getEventLog()
    .filter((entry) => entry.action === 'ui.hang')
    .map((entry) => (entry.details as { attributes: Record<string, unknown> }).attributes);
}

describe('UI liveness probe', () => {
  let clock = 0;
  const now = () => clock;

  beforeEach(() => {
    jest.useFakeTimers();
    clock = 0;
    resetEventLogForTesting();
    resetUiLivenessForTesting();
    setTelemetryForTesting(createTelemetry({ now }));
    (AppState as unknown as { currentState: string }).currentState = 'active';
  });

  afterEach(() => {
    resetUiLivenessForTesting();
    setTelemetryForTesting(undefined);
    jest.useRealTimers();
  });

  /** Advance both clocks together, painting a frame on each tick unless told otherwise. */
  function advance(
    ms: number,
    { paint = true }: { paint?: boolean } = {},
    driver?: ReturnType<typeof frameDriver>
  ) {
    for (let elapsed = 0; elapsed < ms; elapsed += 1_000) {
      clock += 1_000;
      if (paint) driver?.paint();
      jest.advanceTimersByTime(1_000);
    }
  }

  it('says nothing while frames keep arriving', () => {
    const driver = frameDriver();
    startUiLivenessProbe({ now, requestFrame: driver.requestFrame });
    advance(30_000, { paint: true }, driver);
    expect(hangs()).toHaveLength(0);
  });

  // The case a recover-then-report design would lose entirely: the app never comes back, so the
  // only chance to record the hang is while it is still happening.
  it('reports an ongoing hang before it is over', () => {
    const driver = frameDriver();
    startUiLivenessProbe({ now, requestFrame: driver.requestFrame });
    advance(5_000, { paint: false }, driver);

    const reported = hangs();
    expect(reported.length).toBeGreaterThan(0);
    expect(reported[0]).toMatchObject({ ongoing: true });
    expect(reported[0].duration_ms as number).toBeGreaterThanOrEqual(3_000);
  });

  it('reports the true length once the UI comes back', () => {
    const driver = frameDriver();
    startUiLivenessProbe({ now, requestFrame: driver.requestFrame });
    advance(6_000, { paint: false }, driver);
    advance(2_000, { paint: true }, driver);

    const settled = hangs().filter((h) => h.ongoing === false);
    expect(settled).toHaveLength(1);
    expect(settled[0].duration_ms as number).toBeGreaterThanOrEqual(6_000);
  });

  // Frames stop legitimately when the app is off screen. Counting that as a hang would bury the
  // real ones under one report per backgrounded minute.
  it('does not call a backgrounded app hung', () => {
    const driver = frameDriver();
    startUiLivenessProbe({ now, requestFrame: driver.requestFrame });
    (AppState as unknown as { currentState: string }).currentState = 'background';
    advance(60_000, { paint: false }, driver);
    expect(hangs()).toHaveLength(0);
  });
});
