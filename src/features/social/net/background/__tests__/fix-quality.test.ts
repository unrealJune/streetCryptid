import type { LocationFix } from '../../../core/types';
import { assessFix, DEFAULT_FIX_QUALITY_CONFIG, type FixQualityInputs } from '../fix-quality';

const M_PER_DEG_LAT = 6_371_000 * (Math.PI / 180);
const BASE_LAT = 40;

function fix(overrides: Partial<LocationFix> = {}): LocationFix {
  return { lat: BASE_LAT, lon: -73, accuracyM: 10, headingDeg: 0, ts: 0, ...overrides };
}

/** A fix `metres` north of the base. */
function north(metres: number, overrides: Partial<LocationFix> = {}): LocationFix {
  return fix({ lat: BASE_LAT + metres / M_PER_DEG_LAT, ...overrides });
}

/** Inputs with nothing accepted yet — the escape hatch disarmed. */
function fresh(now = 0): FixQualityInputs {
  return { lastAccepted: null, lastAcceptedAt: null, now };
}

describe('assessFix', () => {
  it('accepts an ordinary fix', () => {
    expect(assessFix(fix(), fresh())).toBeNull();
  });

  describe('accuracy', () => {
    it('rejects a fix coarser than the threshold', () => {
      // The signature of a cell-tower or Wi-Fi trilateration fix when GPS has no sky.
      expect(assessFix(fix({ accuracyM: 2_000 }), fresh())).toBe('inaccurate');
    });

    it('accepts a fix exactly at the threshold', () => {
      const at = DEFAULT_FIX_QUALITY_CONFIG.maxAccuracyM;
      expect(assessFix(fix({ accuracyM: at }), fresh())).toBeNull();
    });

    // The providers map a missing radius to 0 (`pos.coords.accuracy ?? 0`). Treating that as
    // perfect would wave through precisely the fixes we cannot vouch for.
    it('does not treat an unreported radius as a perfect one', () => {
      expect(assessFix(fix({ accuracyM: 0 }), fresh())).toBeNull();

      // ...and the other gates still apply to it.
      const jumped = north(500_000, { accuracyM: 0, ts: 10_000 });
      const inputs = { lastAccepted: fix(), lastAcceptedAt: 0, now: 10_000 };
      expect(assessFix(jumped, inputs)).toBe('implausible-jump');
    });
  });

  describe('staleness', () => {
    it('rejects a replayed cached fix', () => {
      const now = 60 * 60_000;
      expect(assessFix(fix({ ts: 0 }), fresh(now))).toBe('stale');
    });

    it('accepts a fix delivered in a normal background batch', () => {
      expect(assessFix(fix({ ts: 0 }), fresh(60_000))).toBeNull();
    });

    // Unlike the other gates, staleness holds even when starved: an ancient position is not new
    // information, and the heartbeat is already covering the cadence with the last good one.
    it('still rejects when the escape hatch is armed', () => {
      const now = 60 * 60_000;
      const inputs = { lastAccepted: fix(), lastAcceptedAt: 0, now };
      expect(assessFix(fix({ ts: 0 }), inputs)).toBe('stale');
    });
  });

  describe('implausible jumps', () => {
    const lastAccepted = fix({ ts: 0 });

    it('rejects a teleport', () => {
      // 5 km in 10 s — the lone wild sample that scatters a friend across town.
      const jumped = north(5_000, { ts: 10_000 });
      expect(assessFix(jumped, { lastAccepted, lastAcceptedAt: 0, now: 10_000 })).toBe(
        'implausible-jump'
      );
    });

    it('accepts ordinary travel', () => {
      // 300 m in 30 s — a brisk cyclist.
      const moved = north(300, { ts: 30_000 });
      expect(assessFix(moved, { lastAccepted, lastAcceptedAt: 0, now: 30_000 })).toBeNull();
    });

    it('accepts a long gap covering a long distance', () => {
      // 50 km in half an hour is a train, not a teleport — speed, not distance, is the test.
      const moved = north(50_000, { ts: 30 * 60_000 });
      const now = 30 * 60_000;
      expect(assessFix(moved, { lastAccepted, lastAcceptedAt: 0, now })).toBeNull();
    });

    it('does not call jitter within the error radii a jump', () => {
      // Two coarse fixes 100 m apart 2 s apart: 50 m/s on paper, but well inside their combined
      // uncertainty, so nobody actually moved.
      const jittered = north(100, { ts: 2_000, accuracyM: 60 });
      const coarse = fix({ ts: 0, accuracyM: 60 });
      expect(
        assessFix(jittered, { lastAccepted: coarse, lastAcceptedAt: 0, now: 2_000 })
      ).toBeNull();
    });

    it('ignores the speed test for fixes arriving back to back', () => {
      // A sub-second gap turns ordinary jitter into an absurd velocity; there is no signal there.
      const next = north(80, { ts: 100 });
      expect(assessFix(next, { lastAccepted, lastAcceptedAt: 0, now: 100 })).toBeNull();
    });

    it('skips the test when fixes arrive out of order', () => {
      const earlier = north(5_000, { ts: -10_000 });
      expect(assessFix(earlier, { lastAccepted, lastAcceptedAt: 0, now: 0 })).toBeNull();
    });
  });

  describe('starvation escape hatch', () => {
    const now = DEFAULT_FIX_QUALITY_CONFIG.acceptAnythingAfterMs;

    it('takes a coarse fix rather than let the trail freeze', () => {
      const inputs = { lastAccepted: fix(), lastAcceptedAt: 0, now };
      expect(assessFix(fix({ accuracyM: 5_000, ts: now }), inputs)).toBeNull();
    });

    it('stays fussy until the timeout is reached', () => {
      const inputs = { lastAccepted: fix(), lastAcceptedAt: 0, now: now - 1 };
      expect(assessFix(fix({ accuracyM: 5_000, ts: now - 1 }), inputs)).toBe('inaccurate');
    });
  });
});
