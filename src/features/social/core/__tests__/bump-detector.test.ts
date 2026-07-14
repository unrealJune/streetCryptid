import { createBumpDetector, type MotionSample } from '../bump-detector';

function sample(timestampMs: number, magnitude: number): MotionSample {
  return { timestampMs, x: magnitude, y: 0, z: 0 };
}

describe('bump detector', () => {
  it('detects one clear impact after the arming settle period', () => {
    const detector = createBumpDetector();
    detector.push(sample(0, 1));
    detector.push(sample(250, 1.02));
    detector.push(sample(500, 1.01));

    expect(detector.push(sample(560, 1.85)).detected).toBe(true);
  });

  it('ignores the tap that armed Bump', () => {
    const detector = createBumpDetector();
    detector.push(sample(0, 1));

    expect(detector.push(sample(120, 1.9)).detected).toBe(false);
  });

  it('ignores normal tilting and walking-sized changes', () => {
    const detector = createBumpDetector();
    for (let index = 0; index < 30; index++) {
      const result = detector.push(sample(index * 60, 1 + Math.sin(index / 3) * 0.12));
      expect(result.detected).toBe(false);
    }
  });

  it('applies a cooldown after an impact', () => {
    const detector = createBumpDetector();
    detector.push(sample(0, 1));
    detector.push(sample(500, 1));
    expect(detector.push(sample(560, 1.9)).detected).toBe(true);
    expect(detector.push(sample(900, 0.2)).detected).toBe(false);
    expect(detector.push(sample(3800, 1.9)).detected).toBe(true);
  });

  it('can be reset for a fresh arming window', () => {
    const detector = createBumpDetector();
    detector.push(sample(0, 1));
    detector.push(sample(500, 1));
    expect(detector.push(sample(560, 1.9)).detected).toBe(true);

    detector.reset();
    detector.push(sample(1000, 1));
    detector.push(sample(1500, 1));
    expect(detector.push(sample(1560, 1.9)).detected).toBe(true);
  });
});
