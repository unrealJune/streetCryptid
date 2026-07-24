import {
  MOTION_STALE_AFTER_MS,
  createExpoMotionSource,
  createNullMotionSource,
  motionActivityToState,
  type MotionActivityKind,
  type MotionActivityLike,
} from '../motion-source';
import type { MotionState } from '../types';

/** Build an activity snapshot from a sparse list of detected kinds (confidence defaults to High). */
function snapshot(
  detected: Partial<Record<MotionActivityKind, number>>,
  timestamp = 0
): MotionActivityLike {
  const activities: MotionActivityLike['activities'] = {};
  for (const [kind, confidence] of Object.entries(detected)) {
    activities[kind as MotionActivityKind] = { detected: true, confidence };
  }
  return { activities, timestamp };
}

describe('motionActivityToState', () => {
  it('maps each OS class onto our coarse motion state', () => {
    expect(motionActivityToState(snapshot({ stationary: 2 }))).toBe('stationary');
    expect(motionActivityToState(snapshot({ walking: 2 }))).toBe('walking');
    // Running is still the on-foot ambient case — `movingAccuracy` covers a res-9 hex at run pace.
    expect(motionActivityToState(snapshot({ running: 2 }))).toBe('walking');
    // Cycling and automotive both routinely exceed the 3 m/s `deriveMotion` driving threshold.
    expect(motionActivityToState(snapshot({ cycling: 2 }))).toBe('driving');
    expect(motionActivityToState(snapshot({ automotive: 2 }))).toBe('driving');
  });

  it('has no opinion when nothing is detected', () => {
    expect(motionActivityToState({ activities: {}, timestamp: 0 })).toBeNull();
    expect(
      motionActivityToState({
        activities: { walking: { detected: false, confidence: 2 } },
        timestamp: 0,
      })
    ).toBeNull();
  });

  it('rejects low-confidence readings rather than flapping the cadence', () => {
    expect(motionActivityToState(snapshot({ walking: 0 }))).toBeNull();
    expect(motionActivityToState(snapshot({ walking: 1 }))).toBe('walking');
  });

  it('prefers the fastest class when several are detected at once', () => {
    // The OS reports overlapping classes; erring fast keeps a moving trail from being under-sampled.
    expect(motionActivityToState(snapshot({ walking: 2, automotive: 2 }))).toBe('driving');
    expect(motionActivityToState(snapshot({ stationary: 2, walking: 2 }))).toBe('walking');
  });
});

describe('createExpoMotionSource', () => {
  type Cb = (activity: MotionActivityLike) => void;

  function fakeModule() {
    let cb: Cb | null = null;
    let errorCb: ((message: string) => void) | null = null;
    let removed = false;
    return {
      get removed(): boolean {
        return removed;
      },
      emit(activity: MotionActivityLike): void {
        cb?.(activity);
      },
      fail(): void {
        errorCb?.('denied');
      },
      watchMotionActivityAsync: (async (callback: Cb, onError?: (m: string) => void) => {
        cb = callback;
        errorCb = onError ?? null;
        return {
          remove: () => {
            removed = true;
          },
        };
      }) as never,
    };
  }

  it('reports the latest classification once started', async () => {
    const mod = fakeModule();
    const source = createExpoMotionSource(mod, () => 0);
    expect(source.read()).toBeNull();

    await source.start();
    mod.emit(snapshot({ walking: 2 }));

    expect(source.read()).toBe('walking');
  });

  it('notifies subscribers only when the class actually changes', async () => {
    const mod = fakeModule();
    const source = createExpoMotionSource(mod, () => 0);
    const seen: MotionState[] = [];
    source.subscribe((m) => seen.push(m));
    await source.start();

    mod.emit(snapshot({ walking: 2 }));
    mod.emit(snapshot({ walking: 2 }));
    mod.emit(snapshot({ stationary: 2 }));

    // The coprocessor re-reports the same class constantly; each notification would cost an
    // engine re-evaluate and a possible OS re-arm.
    expect(seen).toEqual(['walking', 'stationary']);
  });

  it('expires stale readings, because the stream is foreground-only', async () => {
    const mod = fakeModule();
    let now = 0;
    const source = createExpoMotionSource(mod, () => now);
    await source.start();
    mod.emit(snapshot({ walking: 2 }));

    now = MOTION_STALE_AFTER_MS;
    expect(source.read()).toBe('walking');

    // Backgrounded, the last reading freezes — typically `walking`, right before the phone goes
    // in a pocket and sits still. Serving that forever would pin cadence at moving rates.
    now = MOTION_STALE_AFTER_MS + 1;
    expect(source.read()).toBeNull();
  });

  it('drops its opinion when the platform reports an error', async () => {
    const mod = fakeModule();
    const source = createExpoMotionSource(mod, () => 0);
    await source.start();
    mod.emit(snapshot({ walking: 2 }));
    expect(source.read()).toBe('walking');

    mod.fail();

    expect(source.read()).toBeNull();
  });

  it('ignores a no-opinion reading rather than clearing a good one', async () => {
    const mod = fakeModule();
    const source = createExpoMotionSource(mod, () => 0);
    await source.start();
    mod.emit(snapshot({ walking: 2 }));
    mod.emit(snapshot({ walking: 0 })); // low confidence ⇒ null ⇒ ignored

    expect(source.read()).toBe('walking');
  });

  it('stop() removes the subscription and forgets the reading', async () => {
    const mod = fakeModule();
    const source = createExpoMotionSource(mod, () => 0);
    await source.start();
    mod.emit(snapshot({ walking: 2 }));

    source.stop();

    expect(mod.removed).toBe(true);
    expect(source.read()).toBeNull();
  });

  it('start() resolves false when the motion API throws (permission denied)', async () => {
    const source = createExpoMotionSource({
      watchMotionActivityAsync: (async () => {
        throw new Error('Motion & Fitness permission denied');
      }) as never,
    });
    await expect(source.start()).resolves.toBe(false);
    expect(source.read()).toBeNull();
  });
});

describe('createNullMotionSource', () => {
  it('never has an opinion, so callers fall back to GPS-derived motion', async () => {
    const source = createNullMotionSource();
    expect(source.read()).toBeNull();
    await expect(source.start()).resolves.toBe(false);
    expect(source.subscribe(() => {})).toBeInstanceOf(Function);
    source.stop();
  });
});
