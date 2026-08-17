import type { LocationFix } from '../../core/types';

/**
 * Confidence gate for incoming GPS fixes. Pure and synchronous, like `sampling-policy.ts`, so the
 * rules are unit-testable without native deps.
 *
 * Android's fused provider periodically hands us fixes that are simply wrong: cell-tower or Wi-Fi
 * trilateration with a kilometre-wide radius when GPS has no sky, a cached fix replayed long after
 * it was taken, or a lone sample that teleports a few kilometres and back. Published as-is they
 * scatter a friend across town.
 *
 * A rejected fix never replaces the last accepted position. When the engine is awake, due slots
 * can still reuse that last good fix instead of publishing a known-bad coordinate.
 */

export interface FixQualityConfig {
  /** Reject fixes whose reported radius is coarser than this. */
  maxAccuracyM: number;
  /** Reject fixes older than this — the provider is replaying a cached position. */
  maxAgeMs: number;
  /** Reject fixes implying a ground speed above this since the last accepted one. */
  maxSpeedMps: number;
  /**
   * After this long with nothing accepted, take the next fix whatever its accuracy. A coarse
   * position beats a trail frozen at a position from an hour ago; someone genuinely stuck with poor
   * reception should still show up, roughly.
   */
  acceptAnythingAfterMs: number;
  /**
   * Ignore the speed test below this gap. Two fixes milliseconds apart turn ordinary GPS jitter
   * into an implausible velocity.
   */
  minSpeedTestGapMs: number;
}

/**
 * Tuned for an ambient friend map.
 *
 * `maxAccuracyM` is 150 m: loose enough that an ordinary urban fix passes and tight enough to drop
 * tower-derived ones, which come back at 500 m to several km. It must stay coarser than the
 * accuracy tier we actually request (`SamplingConfig.normalAccuracy`), or we would spend battery
 * asking for fixes we then throw away.
 *
 * `maxSpeedMps` is 100 m/s (360 km/h) — above any car or train, below a cruising airliner. Flying
 * therefore trips it, and `acceptAnythingAfterMs` is what recovers the trail afterwards.
 */
export const DEFAULT_FIX_QUALITY_CONFIG: FixQualityConfig = {
  maxAccuracyM: 150,
  maxAgeMs: 10 * 60_000,
  maxSpeedMps: 100,
  acceptAnythingAfterMs: 15 * 60_000,
  minSpeedTestGapMs: 1_000,
};

/** Why a fix was refused. Stamped on telemetry as `sc.drop_reason: fix-<reason>`. */
export type FixRejection = 'inaccurate' | 'stale' | 'implausible-jump';

export interface FixQualityInputs {
  /** The last fix that passed the gate, or null before the first one. */
  lastAccepted: LocationFix | null;
  /** When that fix was accepted (ms epoch). Seeded at engine start so the escape hatch can arm. */
  lastAcceptedAt: number | null;
  /** Current time (ms epoch); injected so the gate stays pure. */
  now: number;
}

/** Great-circle distance between two fixes in metres. Private. */
function haversineMetres(a: LocationFix, b: LocationFix): number {
  const R = 6_371_000;
  const toRad = (d: number): number => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** `null` ⇒ accept the fix; otherwise why it was refused. */
export function assessFix(
  fix: LocationFix,
  { lastAccepted, lastAcceptedAt, now }: FixQualityInputs,
  config: FixQualityConfig = DEFAULT_FIX_QUALITY_CONFIG
): FixRejection | null {
  // Checked even when starved (below): a replayed cached fix carries no new information, and the
  // heartbeat is already covering the cadence with the last good position and its true timestamp.
  if (now - fix.ts > config.maxAgeMs) return 'stale';

  // Nothing has passed in a long time — stop being fussy rather than let the trail freeze.
  if (lastAcceptedAt !== null && now - lastAcceptedAt >= config.acceptAnythingAfterMs) return null;

  // `accuracyM <= 0` means the provider gave us no radius (the `?? 0` in the location providers),
  // not a perfect one. Skip the test we cannot run instead of silently passing it.
  if (fix.accuracyM > 0 && fix.accuracyM > config.maxAccuracyM) return 'inaccurate';

  if (lastAccepted !== null) {
    const dtMs = fix.ts - lastAccepted.ts;
    if (dtMs >= config.minSpeedTestGapMs) {
      // Discount the combined error radii: two fixes can differ by their own uncertainty without
      // anyone having moved, and calling that a teleport would reject a stationary phone's jitter.
      const slack = Math.max(0, lastAccepted.accuracyM) + Math.max(0, fix.accuracyM);
      const travelled = Math.max(0, haversineMetres(lastAccepted, fix) - slack);
      if (travelled / (dtMs / 1000) > config.maxSpeedMps) return 'implausible-jump';
    }
  }

  return null;
}
