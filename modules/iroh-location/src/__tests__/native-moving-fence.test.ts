/**
 * A moving-fence crossing on iOS keeps the process awake until the fence is redrawn.
 *
 * After an exit the phone is outside every fence it holds, and the fresh fix that redraws it was
 * simply waited for. A process relaunched in the background is suspended within seconds of each
 * callback, so the wait was often lost: on 2026-11-16 the last event `14befa639f` sent was a
 * crossing at 13 m/s, followed by seventeen hours of silence, because no exit can fire from a
 * region the phone is already outside. There is no XCTest target for the module, so, like
 * `native-publish-assertion.test.ts`, the rule is checked in the source.
 */

import { readFileSync } from 'fs';
import path from 'path';

const MODULE_ROOT = path.resolve(__dirname, '../..');
const RUNTIME = readFileSync(path.join(MODULE_ROOT, 'ios/BackgroundLocationRuntime.swift'), 'utf8');
const REPORTER = readFileSync(path.join(MODULE_ROOT, 'ios/LocationRuntimeReporter.swift'), 'utf8');

/** Source with `//` and `///` comments removed, so prose cannot satisfy or fail a check. */
function code(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

/** The body of the first function whose declaration contains `signature`. */
function body(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start).toBeGreaterThan(-1);
  const rest = source.slice(start);
  return rest.slice(0, rest.indexOf('\n  }\n'));
}

describe('moving-fence crossings are held until the fence is redrawn (iOS)', () => {
  const runtime = code(RUNTIME);

  it('a crossing holds background time and lifts the filter before restarting the stream', () => {
    const crossed = body(runtime, 'private func crossedMovingFence()');
    const hold = crossed.indexOf('holdForFenceRearm()');
    const unfilter = crossed.indexOf('manager.distanceFilter = kCLDistanceFilterNone');
    const start = crossed.indexOf('manager.startUpdatingLocation()');
    expect(hold).toBeGreaterThan(-1);
    expect(unfilter).toBeGreaterThan(crossed.indexOf('applyMovingCadence()'));
    expect(start).toBeGreaterThan(unfilter);
    expect(crossed).toMatch(/setMovingFenceState\(\.crossed\)/);
  });

  it('the hold is a real background task with a deadline, and both end in a redraw', () => {
    const hold = body(runtime, 'private func holdForFenceRearm()');
    expect(hold).toMatch(/beginBackgroundTask\(withName:/);
    expect(hold).toMatch(/fenceRearmDue\(reason: "expired"\)/);
    expect(hold).toMatch(/fenceRearmDue\(reason: "deadline"\)/);
    expect(hold).toMatch(/asyncAfter\(/);
  });

  it('every drawn fence ends the hold, and so does clearing one', () => {
    expect(body(runtime, 'private func registerMovingFence(')).toMatch(/endFenceRearmHold\(\)/);
    expect(body(runtime, 'private func clearMovingFence()')).toMatch(/endFenceRearmHold\(\)/);
    expect(body(runtime, 'private func endFenceRearmHold()')).toMatch(/endBackgroundTask\(/);
  });

  it('the fallback redraws without asking for state, so it cannot spin', () => {
    const due = body(runtime, 'private func fenceRearmDue(');
    expect(due).toMatch(/registerMovingFence\(around: here, radius: radius, as: \.fallback\)/);
    expect(due).not.toMatch(/requestState/);
    expect(due).toMatch(/defer \{ endFenceRearmHold\(\) \}/);
  });

  it('an ordinary fence reaches ahead of a moving fix', () => {
    expect(body(runtime, 'private func armMovingFence(')).toMatch(
      /Self\.movingFenceRadius\(speedMps: location\.speed\)/
    );
  });

  it('reports what the moving fence is on every runtime event', () => {
    expect(body(runtime, 'private func reportSnapshot()')).toMatch(
      /movingFence: movingFenceState\.rawValue/
    );
    expect(code(REPORTER)).toMatch(/movingFence: snap\?\.movingFence/);
  });
});
