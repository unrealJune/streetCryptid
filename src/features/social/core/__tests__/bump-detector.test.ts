import {
  ANDROID_BUMP_SENSITIVITY,
  bumpOptionsForPlatform,
  bumpSampleIntervalMs,
  createBumpDetector,
  type MotionSample,
} from '../bump-detector';

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

  describe('platform tuning', () => {
    it('leaves iOS on the default thresholds', () => {
      expect(bumpOptionsForPlatform('ios')).toEqual({});
      expect(bumpOptionsForPlatform('web')).toEqual({});
    });

    it('lowers both Android thresholds by the sensitivity factor', () => {
      const options = bumpOptionsForPlatform('android');

      expect(options.impactThreshold).toBeCloseTo(0.55 * ANDROID_BUMP_SENSITIVITY, 6);
      expect(options.jerkThreshold).toBeCloseTo(0.35 * ANDROID_BUMP_SENSITIVITY, 6);
      expect(ANDROID_BUMP_SENSITIVITY).toBeCloseTo(0.5, 6);
    });

    // The point of the whole change: a tap that Android's coarser sampling reports too weakly to
    // clear the default bar still counts there, while iOS keeps its stricter reading.
    it('registers a softer tap on Android that iOS thresholds would miss', () => {
      const softTap = (detector: ReturnType<typeof createBumpDetector>): boolean => {
        detector.push(sample(0, 1));
        detector.push(sample(250, 1.0));
        detector.push(sample(500, 1.0));
        return detector.push(sample(560, 1.45)).detected;
      };

      expect(softTap(createBumpDetector())).toBe(false);
      expect(softTap(createBumpDetector(bumpOptionsForPlatform('android')))).toBe(true);
    });

    // The lever that costs nothing in false positives: a tap's peak lasts ~10-30ms, so 20ms
    // sampling measures it weaker than it was.
    it('samples faster on Android to catch the peak of a short tap', () => {
      expect(bumpSampleIntervalMs('android')).toBeLessThan(bumpSampleIntervalMs('ios'));
      expect(bumpSampleIntervalMs('ios')).toBe(20);
    });

    it('still rejects tilting and walking on the Android thresholds', () => {
      const detector = createBumpDetector(bumpOptionsForPlatform('android'));
      for (let index = 0; index < 30; index++) {
        const result = detector.push(sample(index * 60, 1 + Math.sin(index / 3) * 0.12));
        expect(result.detected).toBe(false);
      }
    });
  });
});
