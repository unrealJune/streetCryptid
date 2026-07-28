export interface MotionSample {
  x: number;
  y: number;
  z: number;
  timestampMs: number;
}

export interface BumpDetectorOptions {
  impactThreshold?: number;
  jerkThreshold?: number;
  settleMs?: number;
  cooldownMs?: number;
}

export interface BumpDetection {
  detected: boolean;
  intensity: number;
}

export interface BumpDetector {
  push(sample: MotionSample): BumpDetection;
  reset(): void;
}

const DEFAULT_IMPACT_THRESHOLD = 0.55;
const DEFAULT_JERK_THRESHOLD = 0.35;
const DEFAULT_SETTLE_MS = 450;
const DEFAULT_COOLDOWN_MS = 3000;
const GRAVITY_SMOOTHING = 0.08;

/**
 * How much of the default threshold an Android phone has to clear. Android accelerometer delivery
 * is coarser and less punctual than Core Motion's — the requested 50Hz is a hint the OS is free to
 * miss — so the short peak of a genuine tap can land between samples and read weaker than it was.
 * Same physical bump, smaller number.
 *
 * Trade-off: this necessarily also admits more near-misses (a firm set-down on a table). That is
 * deliberately the cheap direction to be wrong in — a false detection only *resolves* a nearby
 * peer, and pairing still requires the full authenticated handshake plus a human matching the SAS
 * figure, so nothing is granted by a stray jolt. A missed bump, by contrast, is the user standing
 * there tapping phones together wondering why nothing happens.
 */
export const ANDROID_BUMP_SENSITIVITY = 0.5;

/**
 * Accelerometer sampling period. Android samples faster than the 50Hz default because the peak of
 * a phone-to-phone tap lasts on the order of 10–30ms: at 20ms we routinely sample either side of it
 * and measure a weaker bump than actually happened.
 *
 * This is the lever that does NOT trade against false positives — it makes the *same* physical tap
 * read at its true strength, rather than lowering the bar for everything including near-misses.
 * Lowering thresholds and sampling faster are complementary, and faster sampling is the one to
 * reach for first.
 */
export function bumpSampleIntervalMs(os: string): number {
  return os === 'android' ? 10 : 20;
}

/**
 * Detector tuning for `os` (pass `Platform.OS`). Pure and separate from the hook so the platform
 * split is unit-testable without a running React Native.
 */
export function bumpOptionsForPlatform(os: string): BumpDetectorOptions {
  if (os !== 'android') return {};
  return {
    impactThreshold: DEFAULT_IMPACT_THRESHOLD * ANDROID_BUMP_SENSITIVITY,
    jerkThreshold: DEFAULT_JERK_THRESHOLD * ANDROID_BUMP_SENSITIVITY,
  };
}

function magnitude(sample: Pick<MotionSample, 'x' | 'y' | 'z'>): number {
  return Math.sqrt(sample.x * sample.x + sample.y * sample.y + sample.z * sample.z);
}

/**
 * Detect one short impact while Bump is explicitly armed. Magnitude removes orientation from the
 * signal, a slow gravity baseline ignores normal tilting, and jerk rejects gradual movement.
 */
export function createBumpDetector(options: BumpDetectorOptions = {}): BumpDetector {
  const impactThreshold = options.impactThreshold ?? DEFAULT_IMPACT_THRESHOLD;
  const jerkThreshold = options.jerkThreshold ?? DEFAULT_JERK_THRESHOLD;
  const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
  const cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;

  let startedAt: number | null = null;
  let previousMagnitude: number | null = null;
  let gravity = 1;
  let lastDetectedAt = Number.NEGATIVE_INFINITY;

  return {
    push(sample): BumpDetection {
      const currentMagnitude = magnitude(sample);
      if (startedAt === null) {
        startedAt = sample.timestampMs;
        previousMagnitude = currentMagnitude;
        gravity = currentMagnitude;
        return { detected: false, intensity: 0 };
      }

      const jerk = previousMagnitude === null ? 0 : Math.abs(currentMagnitude - previousMagnitude);
      const impact = Math.abs(currentMagnitude - gravity);
      const intensity = Math.max(impact, jerk);
      previousMagnitude = currentMagnitude;
      gravity += (currentMagnitude - gravity) * GRAVITY_SMOOTHING;

      if (
        sample.timestampMs - startedAt < settleMs ||
        sample.timestampMs - lastDetectedAt < cooldownMs
      ) {
        return { detected: false, intensity };
      }

      const detected =
        (impact >= impactThreshold && jerk >= jerkThreshold) ||
        jerk >= impactThreshold + jerkThreshold;
      if (detected) lastDetectedAt = sample.timestampMs;
      return { detected, intensity };
    },

    reset(): void {
      startedAt = null;
      previousMagnitude = null;
      gravity = 1;
      lastDetectedAt = Number.NEGATIVE_INFINITY;
    },
  };
}
