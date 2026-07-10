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

function motionFromChanges(
  startAt: number,
  changes: readonly Pick<MotionSample, 'x' | 'y' | 'z'>[]
): MotionSample[] {
  const samples = [sample(startAt, 0)];
  let current = samples[0];

  for (const [index, change] of changes.entries()) {
    current = sample(
      startAt + (index + 1) * 140,
      current.x + change.x,
      current.y + change.y,
      current.z + change.z
    );
    samples.push(current);
  }
  return samples;
}

function circularSamples(startAt: number, sweepRadians = Math.PI * 2): MotionSample[] {
  const steps = Math.ceil((sweepRadians / (Math.PI * 2)) * 18);
  return Array.from({ length: steps + 1 }, (_, index) => {
    const angle = (sweepRadians * index) / steps;
    return sample(startAt + index * 70, Math.cos(angle) * 0.6, Math.sin(angle) * 0.6);
  });
}

describe('rub detector', () => {
  it('detects one small back-and-forth motion', () => {
    const detector = createRubDetector();
    const oneRub = [0, 0.5, 0, -0.5, 0].map((x, index) => sample(index * 110, x));

    expect(pushSamples(detector, oneRub)).not.toBeNull();
  });

  it('allows a gentler gesture to drift across axes', () => {
    const detector = createRubDetector();
    const imperfectRub = motionFromChanges(0, [
      { x: 0.38, y: 0.04, z: 0.02 },
      { x: -0.24, y: 0.32, z: -0.03 },
      { x: 0.3, y: -0.28, z: 0.04 },
    ]);

    expect(pushSamples(detector, imperfectRub)).not.toBeNull();
  });

  it('detects a three-quarter circular motion', () => {
    const detector = createRubDetector();

    expect(pushSamples(detector, circularSamples(0, Math.PI * 1.5))).not.toBeNull();
  });

  it('ignores one sharp reversal', () => {
    const detector = createRubDetector();
    const oneReversal = [0, 0.7, 0].map((x, index) => sample(index * 100, x));

    expect(pushSamples(detector, oneReversal)).toBeNull();
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
    const shortBurst = (startAt: number) =>
      [0, 1.1, 0, -1.1].map((x, index) => sample(startAt + index * 100, x));

    expect(pushSamples(detector, shortBurst(0))).toBeNull();
    expect(pushSamples(detector, shortBurst(2200))).toBeNull();
  });

  it('applies a cooldown after detection', () => {
    const detector = createRubDetector();

    expect(pushSamples(detector, backAndForthSamples(0))).not.toBeNull();
    expect(pushSamples(detector, backAndForthSamples(1000))).toBeNull();
    expect(pushSamples(detector, backAndForthSamples(4000))).not.toBeNull();
  });
});
