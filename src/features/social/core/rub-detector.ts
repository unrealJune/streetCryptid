export interface MotionSample {
  x: number;
  y: number;
  z: number;
  timestampMs: number;
}

export interface RubDetectorOptions {
  jerkThreshold?: number;
  strikeWindowMs?: number;
  requiredStrikes?: number;
  cooldownMs?: number;
}

export interface RubDetection {
  detected: boolean;
  intensity: number;
}

export interface RubDetector {
  push(sample: MotionSample): RubDetection;
  reset(): void;
}

const DEFAULT_JERK_THRESHOLD = 0.85;
const DEFAULT_STRIKE_WINDOW_MS = 650;
const DEFAULT_REQUIRED_STRIKES = 2;
const DEFAULT_COOLDOWN_MS = 2500;

/**
 * Detects the short, repeated acceleration changes produced when two phones are tapped/rubbed
 * together. The gesture is only a local UX signal; iroh still authenticates the peer connection.
 */
export function createRubDetector(options: RubDetectorOptions = {}): RubDetector {
  const jerkThreshold = options.jerkThreshold ?? DEFAULT_JERK_THRESHOLD;
  const strikeWindowMs = options.strikeWindowMs ?? DEFAULT_STRIKE_WINDOW_MS;
  const requiredStrikes = options.requiredStrikes ?? DEFAULT_REQUIRED_STRIKES;
  const cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;

  let previous: MotionSample | null = null;
  let strikes: number[] = [];
  let lastDetectedAt = Number.NEGATIVE_INFINITY;

  return {
    push(sample): RubDetection {
      if (!previous) {
        previous = sample;
        return { detected: false, intensity: 0 };
      }

      const dx = sample.x - previous.x;
      const dy = sample.y - previous.y;
      const dz = sample.z - previous.z;
      const intensity = Math.sqrt(dx * dx + dy * dy + dz * dz);
      previous = sample;

      strikes = strikes.filter((timestamp) => sample.timestampMs - timestamp <= strikeWindowMs);
      if (intensity >= jerkThreshold) strikes.push(sample.timestampMs);

      if (strikes.length >= requiredStrikes && sample.timestampMs - lastDetectedAt >= cooldownMs) {
        lastDetectedAt = sample.timestampMs;
        strikes = [];
        return { detected: true, intensity };
      }

      return { detected: false, intensity };
    },

    reset(): void {
      previous = null;
      strikes = [];
      lastDetectedAt = Number.NEGATIVE_INFINITY;
    },
  };
}
