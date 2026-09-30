import { AppState } from 'react-native';

import { getEventLog, resetEventLogForTesting } from '../event-log';
import { createTelemetry, setTelemetryForTesting } from '../telemetry';
import { resetUiLivenessForTesting, startUiLivenessProbe } from '../ui-liveness';

/** Drives frames by hand so a "hang" is just a frame callback we decline to invoke. */
function frameDriver() {
  let pending: (() => void) | null = null;
  let requested = 0;
  return {
    requestFrame(callback: () => void) {
      requested += 1;
      pending = callback;
    },
    /** How many frames the probe has asked for, ever. */
    requested: () => requested,
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

/** Replace `addEventListener` so an AppState transition can actually be delivered. */
function appStateHarness() {
  const listeners: ((state: string) => void)[] = [];
  const original = AppState.addEventListener;
  (AppState as unknown as { addEventListener: unknown }).addEventListener = (
    _event: string,
    listener: (state: string) => void
  ) => {
    listeners.push(listener);
    return {
      remove: () => {
        const at = listeners.indexOf(listener);
        if (at >= 0) listeners.splice(at, 1);
      },
    };
  };
  return {
    go(state: string) {
      (AppState as unknown as { currentState: string }).currentState = state;
      for (const listener of [...listeners]) listener(state);
    },
    listenerCount: () => listeners.length,
    restore: () => {
      (AppState as unknown as { addEventListener: unknown }).addEventListener = original;
    },
  };
}

describe('UI liveness probe', () => {
  let appState: ReturnType<typeof appStateHarness>;
  let clock = 0;
  const now = () => clock;

  beforeEach(() => {
    jest.useFakeTimers();
    clock = 0;
    resetEventLogForTesting();
    resetUiLivenessForTesting();
    setTelemetryForTesting(createTelemetry({ now }));
    (AppState as unknown as { currentState: string }).currentState = 'active';
    appState = appStateHarness();
  });

  afterEach(() => {
    resetUiLivenessForTesting();
    appState.restore();
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

  // In bridgeless RN `requestAnimationFrame` is `setTimeout(0)`, and a backgrounded iOS app runs
  // due timers from an NSTimer rather than the display link — so a frame loop that keeps re-arming
  // off screen is a busy loop. It cost 48 s of CPU per minute on 2026-09-29.
  it('stops asking for frames while the app is off screen', () => {
    const driver = frameDriver();
    startUiLivenessProbe({ now, requestFrame: driver.requestFrame });
    advance(3_000, { paint: true }, driver);

    appState.go('background');
    // The frame already requested may still be delivered; it must not re-arm.
    driver.paint();
    const requested = driver.requested();
    for (let i = 0; i < 100; i += 1) driver.paint();
    advance(60_000, { paint: true }, driver);

    expect(driver.requested()).toBe(requested);
  });

  it('resumes the frame loop on return, without calling the time away a hang', () => {
    const driver = frameDriver();
    startUiLivenessProbe({ now, requestFrame: driver.requestFrame });
    appState.go('background');
    driver.paint();
    advance(120_000, { paint: false }, driver);

    appState.go('active');
    advance(10_000, { paint: true }, driver);

    expect(hangs()).toHaveLength(0);
    expect(driver.requested()).toBeGreaterThan(5);
  });

  it('does not start a frame loop in a launch that begins off screen', () => {
    (AppState as unknown as { currentState: string }).currentState = 'background';
    const driver = frameDriver();
    startUiLivenessProbe({ now, requestFrame: driver.requestFrame });
    expect(driver.requested()).toBe(0);

    appState.go('active');
    expect(driver.requested()).toBe(1);
  });

  it('stops listening when stopped', () => {
    const stop = startUiLivenessProbe({ now, requestFrame: frameDriver().requestFrame });
    expect(appState.listenerCount()).toBe(1);
    stop();
    expect(appState.listenerCount()).toBe(0);
  });
});
