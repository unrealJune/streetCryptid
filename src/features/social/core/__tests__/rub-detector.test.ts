import {
  createRubDetector,
  type MotionSample,
  type RubDetection,
  type RubDetector,
} from '../rub-detector';

function sample(timestampMs: number, x: number, y = 0, z = 1): MotionSample {
  return { timestampMs, x, y, z };
}

function pushSamples(detector: RubDetector, samples: MotionSample[]): RubDetection | null {
  let detection: RubDetection | null = null;
  for (const motionSample of samples) {
    const result = detector.push(motionSample);
    if (result.detected) detection = result;
  }
  return detection;
}

function backAndForthSamples(startAt: number): MotionSample[] {
  return [0, 1.1, 0, -1.1, 0, 1.1, 0, -1.1, 0].map((x, index) => sample(startAt + index * 100, x));
}

function circularSamples(startAt: number, sweepRadians = Math.PI * 2): MotionSample[] {
  const steps = Math.ceil((sweepRadians / (Math.PI * 2)) * 18);
  return Array.from({ length: steps + 1 }, (_, index) => {
    const angle = (sweepRadians * index) / steps;
    return sample(startAt + index * 70, Math.cos(angle) * 0.6, Math.sin(angle) * 0.6);
  });
}

describe('rub detector', () => {
  it('detects sustained back-and-forth motion', () => {
    const detector = createRubDetector();

    expect(pushSamples(detector, backAndForthSamples(0))).not.toBeNull();
  });

  it('detects a near-complete circular motion', () => {
    const detector = createRubDetector();

    expect(pushSamples(detector, circularSamples(0))).not.toBeNull();
  });

  it('ignores one vigorous wave', () => {
    const detector = createRubDetector();
    const oneWave = [0, 1.1, 0, -1.1, 0].map((x, index) => sample(index * 100, x));

    expect(pushSamples(detector, oneWave)).toBeNull();
  });

  it('ignores a partial circular arc', () => {
    const detector = createRubDetector();

    expect(pushSamples(detector, circularSamples(0, Math.PI))).toBeNull();
  });

  it('ignores ordinary low-amplitude motion', () => {
    const detector = createRubDetector();

    detector.push(sample(0, 0));
    for (let timestampMs = 50; timestampMs <= 1000; timestampMs += 50) {
      expect(detector.push(sample(timestampMs, Math.sin(timestampMs / 200) * 0.2)).detected).toBe(
        false
      );
    }
  });

  it('requires directional changes to remain continuous', () => {
    const detector = createRubDetector();

    const firstHalf = backAndForthSamples(0).slice(0, 4);
    const secondHalf = backAndForthSamples(2200).slice(4);

    expect(pushSamples(detector, firstHalf)).toBeNull();
    expect(pushSamples(detector, secondHalf)).toBeNull();
  });

  it('applies a cooldown after detection', () => {
    const detector = createRubDetector();

    expect(pushSamples(detector, backAndForthSamples(0))).not.toBeNull();
    expect(pushSamples(detector, backAndForthSamples(1000))).toBeNull();
    expect(pushSamples(detector, backAndForthSamples(4000))).not.toBeNull();
  });
});
