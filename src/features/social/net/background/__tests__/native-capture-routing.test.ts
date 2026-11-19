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
import { routeNativeCapture, type CaptureClaim, type EngineState } from '../location-engine';

function engineStub(accepted: LocationFix | null) {
  const calls = {
    ingest: [] as LocationFix[],
    claims: [] as (CaptureClaim | undefined)[],
    heartbeat: 0,
    parked: [] as (boolean | null)[],
  };
  return {
    calls,
    engine: {
      ingest: async (fix: LocationFix, _parent?: unknown, claim?: CaptureClaim) => {
        calls.ingest.push(fix);
        calls.claims.push(claim);
        return null as never;
      },
      heartbeat: async (_parent?: unknown, parked?: boolean | null) => {
        calls.heartbeat += 1;
        calls.parked.push(parked ?? null);
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

  it("forwards the runtime's parked claim, and makes none when it made none", async () => {
    // The tick's `fix_state` is decided by what the native runtime proved. A JS layer that filled
    // in `true` for it is how a moving iPhone published four hours of "parked" on 2026-10-02.
    const { engine, calls } = engineStub(fix);
    await routeNativeCapture({ kind: 'heartbeat', parked: true }, engine);
    await routeNativeCapture({ kind: 'heartbeat', parked: false }, engine);
    await routeNativeCapture({ kind: 'heartbeat' }, engine);
    expect(calls.parked).toEqual([true, false, null]);
  });

  it("carries a fix's claim and budget INTO its ingest, never as a heartbeat after it", async () => {
    // 2026-11-18: the arrival's fix and its `parked` claim were two drains; the phone was
    // suspended inside the first one's push and the claim never sealed. One drain or nothing.
    const { engine, calls } = engineStub(fix);
    await routeNativeCapture({ kind: 'fix', fix, parked: true, budgetMs: 12_000 }, engine);
    await routeNativeCapture({ kind: 'fix', fix }, engine);
    expect(calls.claims).toEqual([
      { parked: true, budgetMs: 12_000 },
      { parked: null, budgetMs: null },
    ]);
    expect(calls.heartbeat).toBe(0);
  });

  it('treats a fix-kind capture with no fix as a heartbeat rather than throwing', async () => {
    // Defensive: the payload crosses the Expo bridge from Swift, and a capture that arrives
    // malformed must degrade to the cheap path, not take the publish loop down with it.
    const { engine, calls } = engineStub(fix);
    await expect(routeNativeCapture({ kind: 'fix' }, engine)).resolves.toBeNull();
    expect(calls.heartbeat).toBe(1);
  });
});
