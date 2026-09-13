import { AppState } from 'react-native';

import { getTelemetry } from './telemetry';

/**
 * Whether the UI thread is still drawing, measured from the JS thread.
 *
 * ## Why this exists
 * A frozen app and a dead app leave the same evidence — silence — but a frozen one is still
 * running, and that is the difference this measures. On 2026-09-13 an iPhone kept servicing its
 * 4 s pairing poll with native calls returning in 1 ms, then stopped for 82 s and never came back.
 * The JS side was demonstrably healthy the whole way; what nothing recorded was whether anything
 * was still reaching the screen.
 *
 * The probe is a self-rearming `requestAnimationFrame` and a timer that asks how long ago the last
 * frame was. Frames are driven by the platform's display link; timers are not the same mechanism,
 * so a UI thread wedged in native work stops the first while the second keeps running. If BOTH
 * stop together the runtime itself was suspended or killed — which is a different bug, and worth
 * being able to say so.
 *
 * ## Reporting while it is still happening
 * A hang that ends in the process dying can never report on recovery, so the interesting case is
 * exactly the one a recover-then-report design would lose. Anything past
 * {@link HANG_THRESHOLD_MS} is therefore reported *ongoing* and flushed immediately, and reported
 * again with its true length if it ever does recover.
 */

/** How often to ask when the last frame was. */
const CHECK_INTERVAL_MS = 1_000;

/**
 * A frame gap past this is a hang rather than a slow frame.
 *
 * Three seconds is well beyond any legitimate stall (the worst measured on this app is a ~600 ms
 * shader compile) and well inside iOS's own patience before a watchdog kill.
 */
export const HANG_THRESHOLD_MS = 3_000;

/** While a hang continues, re-report on this cadence so its growth is visible. */
const ONGOING_REPORT_INTERVAL_MS = 10_000;

export interface UiLivenessOptions {
  now?(): number;
  /** Schedule a frame callback. Injected so tests can drive frames by hand. */
  requestFrame?(callback: () => void): void;
}

let running: (() => void) | null = null;

/**
 * Start watching. Returns a stop function; calling twice is a no-op that returns the first.
 *
 * Foreground only — a headless background context never gets frames at all, so the probe would
 * report one continuous hang for the life of every wake.
 */
export function startUiLivenessProbe(options: UiLivenessOptions = {}): () => void {
  if (running) return running;
  const now = options.now ?? Date.now;
  const requestFrame =
    options.requestFrame ??
    ((callback: () => void) => void requestAnimationFrame(() => callback()));

  let alive = true;
  let lastFrameAt = now();
  /** The timestamp of the last frame BEFORE the current hang, or null if not hanging. */
  let hangStartedAt: number | null = null;
  let lastReportAt = 0;

  const onFrame = (): void => {
    lastFrameAt = now();
    if (alive) requestFrame(onFrame);
  };
  requestFrame(onFrame);

  const report = (durationMs: number, ongoing: boolean): void => {
    const telemetry = getTelemetry();
    telemetry
      .startSpan('ui.hang', {
        attributes: { duration_ms: Math.round(durationMs), ongoing },
      })
      .end();
    // The whole point: get it off the device before the thing that caused it finishes the job.
    if (ongoing) void telemetry.flush();
  };

  const timer = setInterval(() => {
    if (AppState.currentState !== 'active') {
      // Frames stop legitimately when the app is not on screen. Treat backgrounding as a fresh
      // start rather than the beginning of an hours-long "hang".
      lastFrameAt = now();
      hangStartedAt = null;
      return;
    }
    const gap = now() - lastFrameAt;
    if (gap < HANG_THRESHOLD_MS) {
      if (hangStartedAt !== null) {
        report(lastFrameAt - hangStartedAt, false);
        hangStartedAt = null;
        lastReportAt = 0;
      }
      return;
    }
    if (hangStartedAt === null) hangStartedAt = lastFrameAt;
    if (lastReportAt !== 0 && now() - lastReportAt < ONGOING_REPORT_INTERVAL_MS) return;
    lastReportAt = now();
    report(gap, true);
  }, CHECK_INTERVAL_MS);
  (timer as unknown as { unref?: () => void }).unref?.();

  running = () => {
    alive = false;
    clearInterval(timer);
    running = null;
  };
  return running;
}

/** Test seam. */
export function resetUiLivenessForTesting(): void {
  running?.();
  running = null;
}
