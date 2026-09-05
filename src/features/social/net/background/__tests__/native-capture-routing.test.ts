/**
 * Where a capture handed up by the native runtime goes.
 *
 * This is the mounted publish path, and it exists because the writer claim in `durable.rs` is
 * process-wide: on iOS the app and the background runtime are one process sharing one set of
 * storage roots, so while the app is open it holds the stores and the runtime cannot build a node
 * at all. It captures anyway and hands the result up. Before this existed, a foregrounded app ran
 * Core Location, received fixes, and dropped every one — a fresh install on 2026-08-30 paired, sat
 * with the map open, and published nothing at all.
 */

import type { LocationFix } from '../../../core/types';
import { routeNativeCapture, type EngineState } from '../location-engine';

function engineStub(accepted: LocationFix | null) {
  const calls = { ingest: [] as LocationFix[], heartbeat: 0 };
  return {
    calls,
    engine: {
      ingest: async (fix: LocationFix) => {
        calls.ingest.push(fix);
        return null as never;
      },
      heartbeat: async () => {
        calls.heartbeat += 1;
        return 0;
      },
      getState: () => ({ lastAcceptedFix: accepted }) as EngineState,
    },
  };
}

const fix: LocationFix = { lat: 47.6062, lon: -122.3321, accuracyM: 12, headingDeg: 0, ts: 5_000 };

describe('routeNativeCapture', () => {
  it('runs a captured fix through the engine, so the mounted app publishes at all', async () => {
    const { engine, calls } = engineStub(fix);
    await routeNativeCapture({ kind: 'fix', fix }, engine);
    expect(calls.ingest).toEqual([fix]);
    expect(calls.heartbeat).toBe(0);
  });

  it('returns the position the gate ACCEPTED, not the one that arrived', async () => {
    // The dot must never follow the raw capture: the gate exists because a phone sometimes reports
    // a position kilometres away, and rendering it before discarding it throws the user's own
    // marker across town for a frame.
    const accepted: LocationFix = { ...fix, lat: 47.61, ts: 4_000 };
    const { engine } = engineStub(accepted);
    await expect(routeNativeCapture({ kind: 'fix', fix }, engine)).resolves.toBe(accepted);
  });

  it('establishes no position when the gate has accepted nothing yet', async () => {
    const { engine } = engineStub(null);
    await expect(routeNativeCapture({ kind: 'fix', fix }, engine)).resolves.toBeNull();
  });

  it('sends a parked tick to the heartbeat, which has no position to gate', async () => {
    // The coarse stream reports a three-kilometre radius. It is a clock, not a location — feeding
    // it to `ingest` would spend the gate's time refusing it, correctly, forever.
    const { engine, calls } = engineStub(fix);
    await expect(routeNativeCapture({ kind: 'heartbeat' }, engine)).resolves.toBeNull();
    expect(calls.heartbeat).toBe(1);
    expect(calls.ingest).toEqual([]);
  });

  it('treats a fix-kind capture with no fix as a heartbeat rather than throwing', async () => {
    // Defensive: the payload crosses the Expo bridge from Swift, and a capture that arrives
    // malformed must degrade to the cheap path, not take the publish loop down with it.
    const { engine, calls } = engineStub(fix);
    await expect(routeNativeCapture({ kind: 'fix' }, engine)).resolves.toBeNull();
    expect(calls.heartbeat).toBe(1);
  });
});
