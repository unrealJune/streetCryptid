export interface MotionSample {
  x: number;
  y: number;
  z: number;
  timestampMs: number;
}

export interface RubDetectorOptions {
  jerkThreshold?: number;
  circularJerkThreshold?: number;
  strikeWindowMs?: number;
  requiredStrikes?: number;
  circularTurnThresholdRadians?: number;
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

interface Vector3 {
  x: number;
  y: number;
  z: number;
}

interface DirectionalStroke {
  direction: Vector3;
  intensity: number;
  timestampMs: number;
}

interface CircularProgress {
  startDirection: Vector3;
  lastDirection: Vector3;
  normal: Vector3 | null;
  startedAt: number;
  lastMotionAt: number;
  peakIntensity: number;
  turnCount: number;
  turnRadians: number;
}

const DEFAULT_JERK_THRESHOLD = 0.32;
const DEFAULT_CIRCULAR_JERK_THRESHOLD = 0.06;
const DEFAULT_STRIKE_WINDOW_MS = 1800;
const DEFAULT_REQUIRED_STRIKES = 3;
const DEFAULT_CIRCULAR_TURN_THRESHOLD_RADIANS = 4.2;
const DEFAULT_COOLDOWN_MS = 2500;

const MIN_STROKE_GAP_MS = 60;
const MAX_STROKE_GAP_MS = 700;
const SAME_DIRECTION_DOT = 0.55;
const REVERSAL_DOT = -0.35;
const AXIS_ALIGNMENT_DOT = 0.45;

const MAX_CIRCULAR_GAP_MS = 420;
const MIN_CIRCULAR_TURN_RADIANS = 0.08;
const MAX_CIRCULAR_TURN_RADIANS = 1.25;
const CIRCULAR_NORMAL_ALIGNMENT_DOT = 0.25;
const CIRCULAR_CLOSURE_DOT = -0.4;
const MIN_CIRCULAR_TURNS = 6;

function magnitude(vector: Vector3): number {
  return Math.sqrt(vector.x * vector.x + vector.y * vector.y + vector.z * vector.z);
}

function normalize(vector: Vector3, vectorMagnitude = magnitude(vector)): Vector3 {
  return {
    x: vector.x / vectorMagnitude,
    y: vector.y / vectorMagnitude,
    z: vector.z / vectorMagnitude,
  };
}

function dot(left: Vector3, right: Vector3): number {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

function cross(left: Vector3, right: Vector3): Vector3 {
  return {
    x: left.y * right.z - left.z * right.y,
    y: left.z * right.x - left.x * right.z,
    z: left.x * right.y - left.y * right.x,
  };
}

function clampUnit(value: number): number {
  return Math.max(-1, Math.min(1, value));
}

/**
 * Detects either a short back-and-forth acceleration pattern or a mostly complete circular turn.
 * The gesture is only a local UX signal; iroh still authenticates the peer connection.
 */
export function createRubDetector(options: RubDetectorOptions = {}): RubDetector {
  const jerkThreshold = options.jerkThreshold ?? DEFAULT_JERK_THRESHOLD;
  const circularJerkThreshold = options.circularJerkThreshold ?? DEFAULT_CIRCULAR_JERK_THRESHOLD;
  const strikeWindowMs = options.strikeWindowMs ?? DEFAULT_STRIKE_WINDOW_MS;
  const requiredStrikes = options.requiredStrikes ?? DEFAULT_REQUIRED_STRIKES;
  const circularTurnThresholdRadians =
    options.circularTurnThresholdRadians ?? DEFAULT_CIRCULAR_TURN_THRESHOLD_RADIANS;
  const cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;

  let previous: MotionSample | null = null;
  let strokes: DirectionalStroke[] = [];
  let circular: CircularProgress | null = null;
  let lastDetectedAt = Number.NEGATIVE_INFINITY;

  const clearGesture = (): void => {
    strokes = [];
    circular = null;
  };

  const startCircle = (direction: Vector3, intensity: number, timestampMs: number): void => {
    circular = {
      startDirection: direction,
      lastDirection: direction,
      normal: null,
      startedAt: timestampMs,
      lastMotionAt: timestampMs,
      peakIntensity: intensity,
      turnCount: 0,
      turnRadians: 0,
    };
  };

  const pushStroke = (
    direction: Vector3,
    intensity: number,
    timestampMs: number
  ): number | null => {
    strokes = strokes.filter((stroke) => timestampMs - stroke.timestampMs <= strikeWindowMs);
    const nextStroke = { direction, intensity, timestampMs };
    const lastStroke = strokes.at(-1);

    if (!lastStroke || timestampMs - lastStroke.timestampMs > MAX_STROKE_GAP_MS) {
      strokes = [nextStroke];
      return null;
    }

    const alignment = dot(lastStroke.direction, direction);
    if (alignment >= SAME_DIRECTION_DOT) {
      lastStroke.timestampMs = timestampMs;
      if (intensity > lastStroke.intensity) {
        lastStroke.direction = direction;
        lastStroke.intensity = intensity;
      }
      return null;
    }

    if (
      alignment > REVERSAL_DOT ||
      timestampMs - lastStroke.timestampMs < MIN_STROKE_GAP_MS ||
      Math.abs(dot(strokes[0].direction, direction)) < AXIS_ALIGNMENT_DOT
    ) {
      strokes = [nextStroke];
      return null;
    }

    strokes.push(nextStroke);
    if (strokes.length < requiredStrikes) return null;
    return Math.max(...strokes.map((stroke) => stroke.intensity));
  };

  const pushCircularTurn = (
    direction: Vector3,
    intensity: number,
    timestampMs: number
  ): number | null => {
    if (
      !circular ||
      timestampMs - circular.startedAt > strikeWindowMs ||
      timestampMs - circular.lastMotionAt > MAX_CIRCULAR_GAP_MS
    ) {
      startCircle(direction, intensity, timestampMs);
      return null;
    }

    circular.lastMotionAt = timestampMs;
    circular.peakIntensity = Math.max(circular.peakIntensity, intensity);

    const turnRadians = Math.acos(clampUnit(dot(circular.lastDirection, direction)));
    if (turnRadians < MIN_CIRCULAR_TURN_RADIANS) return null;
    if (turnRadians > MAX_CIRCULAR_TURN_RADIANS) {
      startCircle(direction, intensity, timestampMs);
      return null;
    }

    const turnCross = cross(circular.lastDirection, direction);
    const turnNormal = normalize(turnCross);
    if (circular.normal && dot(circular.normal, turnNormal) < CIRCULAR_NORMAL_ALIGNMENT_DOT) {
      startCircle(direction, intensity, timestampMs);
      return null;
    }

    if (circular.normal) {
      circular.normal = normalize({
        x: circular.normal.x * 3 + turnNormal.x,
        y: circular.normal.y * 3 + turnNormal.y,
        z: circular.normal.z * 3 + turnNormal.z,
      });
    } else {
      circular.normal = turnNormal;
    }

    circular.lastDirection = direction;
    circular.turnCount += 1;
    circular.turnRadians += turnRadians;

    if (
      circular.turnCount < MIN_CIRCULAR_TURNS ||
      circular.turnRadians < circularTurnThresholdRadians ||
      dot(circular.startDirection, direction) < CIRCULAR_CLOSURE_DOT
    ) {
      return null;
    }
    return circular.peakIntensity;
  };

  return {
    push(sample): RubDetection {
      if (!previous) {
        previous = sample;
        return { detected: false, intensity: 0 };
      }

      const elapsedMs = sample.timestampMs - previous.timestampMs;
      if (elapsedMs <= 0 || elapsedMs > strikeWindowMs) {
        previous = sample;
        clearGesture();
        return { detected: false, intensity: 0 };
      }

      const change = {
        x: sample.x - previous.x,
        y: sample.y - previous.y,
        z: sample.z - previous.z,
      };
      const intensity = magnitude(change);
      previous = sample;

      strokes = strokes.filter(
        (stroke) => sample.timestampMs - stroke.timestampMs <= strikeWindowMs
      );
      if (
        circular &&
        (sample.timestampMs - circular.startedAt > strikeWindowMs ||
          sample.timestampMs - circular.lastMotionAt > MAX_CIRCULAR_GAP_MS)
      ) {
        circular = null;
      }

      if (sample.timestampMs - lastDetectedAt < cooldownMs) {
        clearGesture();
        return { detected: false, intensity };
      }

      if (intensity >= jerkThreshold) {
        const strokeIntensity = pushStroke(
          normalize(change, intensity),
          intensity,
          sample.timestampMs
        );
        if (strokeIntensity !== null) {
          lastDetectedAt = sample.timestampMs;
          clearGesture();
          return { detected: true, intensity: strokeIntensity };
        }
      }

      if (intensity >= circularJerkThreshold) {
        const circularIntensity = pushCircularTurn(
          normalize(change, intensity),
          intensity,
          sample.timestampMs
        );
        if (circularIntensity !== null) {
          lastDetectedAt = sample.timestampMs;
          clearGesture();
          return { detected: true, intensity: circularIntensity };
        }
      }

      return { detected: false, intensity };
    },

    reset(): void {
      previous = null;
      clearGesture();
      lastDetectedAt = Number.NEGATIVE_INFINITY;
    },
  };
}
