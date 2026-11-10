import { useRef } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { SharedValue } from 'react-native-reanimated';

import type { ViewTransform } from '../../core/camera';
import { interpolateViewTransform } from '../../core/gesture';
import { useCameraAnimation, type CameraAnimation } from '../use-camera-animation';

jest.mock('react-native-reanimated', () => {
  const { useRef: useStableRef } = jest.requireActual('react');
  return {
    __esModule: true,
    useSharedValue: (value: unknown) => useStableRef({ value }).current,
  };
});

/** UI frames: every callback queued before a flush runs with that flush's ONE timestamp. */
let queued: FrameRequestCallback[] = [];
function frame(timestamp: number) {
  const run = queued;
  queued = [];
  for (const callback of run) callback(timestamp);
}

const linear = (t: number) => t;
// Kyoto seen from a Seattle-anchored session: translations in the hundreds of thousands of px,
// where a skew between the three components shows up as a jump.
const FROM: ViewTransform = { k: 16, tx: -760_000, ty: -310_000 };
const TO: ViewTransform = { k: 32, tx: -1_520_195, ty: -620_390 };

describe('useCameraAnimation', () => {
  let renderer: ReactTestRenderer | undefined;
  let camera: CameraAnimation;
  let k: SharedValue<number>;
  let tx: SharedValue<number>;
  let ty: SharedValue<number>;

  function Harness() {
    k = useRef({ value: FROM.k }).current as SharedValue<number>;
    tx = useRef({ value: FROM.tx }).current as SharedValue<number>;
    ty = useRef({ value: FROM.ty }).current as SharedValue<number>;
    camera = useCameraAnimation(k, tx, ty);
    return null;
  }

  const now = (): ViewTransform => ({ k: k.value, tx: tx.value, ty: ty.value });

  beforeEach(() => {
    queued = [];
    jest.spyOn(global, 'requestAnimationFrame').mockImplementation((callback) => {
      queued.push(callback);
      return queued.length;
    });
    act(() => {
      renderer = create(<Harness />);
    });
  });

  afterEach(() => {
    act(() => renderer?.unmount());
    renderer = undefined;
    jest.restoreAllMocks();
  });

  it('writes k, tx and ty from one progress, clocked from its first frame', () => {
    const finished = jest.fn();
    camera.animate(TO, 200, linear, finished);
    // Nothing moves until a frame says when the animation started.
    expect(now()).toEqual(FROM);

    frame(1_000);
    expect(now()).toEqual(FROM);
    for (const at of [50, 100, 150]) {
      frame(1_000 + at);
      expect(now()).toEqual(interpolateViewTransform(FROM, TO, at / 200));
      expect(finished).not.toHaveBeenCalled();
    }
    frame(1_200);
    expect(now()).toEqual(TO);
    expect(finished).toHaveBeenCalledTimes(1);
    expect(queued).toHaveLength(0);
  });

  it('starts a new animation from where the old one is, and never finishes the old one', () => {
    const first = jest.fn();
    const second = jest.fn();
    camera.animate(TO, 200, linear, first);
    frame(0);
    frame(100);
    const midway = now();

    camera.animate(FROM, 200, linear, second);
    frame(116);
    expect(now()).toEqual(midway);
    frame(316);
    expect(now()).toEqual(FROM);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('stops where it is without finishing, so nothing commits an unreached camera', () => {
    const finished = jest.fn();
    camera.animate(TO, 200, linear, finished, true);
    frame(0);
    frame(50);
    expect(camera.locating.value).toBe(true);
    const stopped = now();

    camera.stop();
    expect(camera.locating.value).toBe(false);
    frame(400);
    expect(now()).toEqual(stopped);
    expect(finished).not.toHaveBeenCalled();
  });

  it('flags a locate flight only while it runs', () => {
    camera.animate(TO, 100, linear, undefined, true);
    expect(camera.locating.value).toBe(true);
    frame(0);
    frame(100);
    expect(camera.locating.value).toBe(false);
    expect(now()).toEqual(TO);
  });

  it('lands at once for a zero duration (reduced motion)', () => {
    const finished = jest.fn();
    camera.animate(TO, 0, linear, finished, true);
    expect(now()).toEqual(TO);
    expect(camera.locating.value).toBe(false);
    expect(finished).toHaveBeenCalledTimes(1);
    expect(queued).toHaveLength(0);
  });
});
