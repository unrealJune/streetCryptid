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
