import { createRubDetector, type MotionSample } from '../rub-detector';

function sample(timestampMs: number, x: number, y = 0, z = 1): MotionSample {
  return { timestampMs, x, y, z };
}

describe('rub detector', () => {
  it('detects two sharp motion changes inside the strike window', () => {
    const detector = createRubDetector();

    expect(detector.push(sample(0, 0)).detected).toBe(false);
    expect(detector.push(sample(120, 1.1)).detected).toBe(false);
    expect(detector.push(sample(360, 0)).detected).toBe(true);
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

  it('requires strikes to occur close together', () => {
    const detector = createRubDetector();

    detector.push(sample(0, 0));
    detector.push(sample(100, 1.2));
    expect(detector.push(sample(1000, 0)).detected).toBe(false);
  });

  it('applies a cooldown after detection', () => {
    const detector = createRubDetector();

    detector.push(sample(0, 0));
    detector.push(sample(100, 1.2));
    expect(detector.push(sample(200, 0)).detected).toBe(true);
    detector.push(sample(400, 1.2));
    expect(detector.push(sample(500, 0)).detected).toBe(false);
    detector.push(sample(2800, 1.2));
    expect(detector.push(sample(2900, 0)).detected).toBe(true);
  });
});
