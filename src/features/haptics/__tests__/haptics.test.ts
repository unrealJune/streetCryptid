import {
  hapticsSupported,
  patternHaptic,
  resetHapticsForTesting,
  setHapticsEnabled,
  stopHaptics,
  tapHaptic,
  toggleHaptic,
  transientHaptic,
} from '../haptics';

const mockApi = {
  isSupported: true,
  initialize: jest.fn(async () => {}),
  start: jest.fn(async () => {}),
  stop: jest.fn(async () => {}),
  selectionAsync: jest.fn(async () => {}),
  impactAsync: jest.fn(async () => {}),
  notificationAsync: jest.fn(async () => {}),
  playTransientAsync: jest.fn(async () => {}),
  playContinuousAsync: jest.fn(async () => {}),
  playPatternAsync: jest.fn(
    async (_events: { time: number; parameters: { id: string | number; value: number }[] }[]) => {}
  ),
  createTransientEvent: jest.fn(
    (options: { intensity?: number; sharpness?: number; time?: number }) => ({
      type: 'transient',
      time: options.time ?? 0,
      parameters: [
        { id: 'intensity', value: options.intensity ?? 1 },
        { id: 'sharpness', value: options.sharpness ?? 1 },
      ],
    })
  ),
};

jest.mock('expo-better-haptics', () => ({ default: mockApi }), { virtual: true });

describe('haptics service', () => {
  beforeEach(() => {
    resetHapticsForTesting();
    jest.clearAllMocks();
    mockApi.isSupported = true;
  });

  it('initialises the engine lazily, exactly once', async () => {
    await tapHaptic();
    await tapHaptic();

    expect(mockApi.initialize).toHaveBeenCalledTimes(1);
    expect(mockApi.playTransientAsync).toHaveBeenCalledTimes(2);
  });

  it('re-initialises after the engine is released', async () => {
    await tapHaptic();
    await stopHaptics();
    await tapHaptic();

    expect(mockApi.stop).toHaveBeenCalledTimes(1);
    expect(mockApi.initialize).toHaveBeenCalledTimes(2);
  });

  it('goes silent when disabled without touching the engine', async () => {
    setHapticsEnabled(false);
    await tapHaptic();
    await transientHaptic(1, 1);
    setHapticsEnabled(true);

    expect(mockApi.initialize).not.toHaveBeenCalled();
    expect(mockApi.playTransientAsync).not.toHaveBeenCalled();
  });

  it('stays silent on a device that reports no haptic support', async () => {
    mockApi.isSupported = false;

    await tapHaptic();

    expect(hapticsSupported()).toBe(false);
    expect(mockApi.playTransientAsync).not.toHaveBeenCalled();
  });

  // Haptics decorate; they must never be able to break the thing they decorate.
  it('swallows a failing engine rather than rejecting', async () => {
    mockApi.initialize.mockRejectedValueOnce(new Error('engine unavailable'));

    await expect(tapHaptic()).resolves.toBeUndefined();
  });

  it('swallows a failing effect too', async () => {
    mockApi.playTransientAsync.mockRejectedValueOnce(new Error('primitive unsupported'));

    await expect(tapHaptic()).resolves.toBeUndefined();
  });

  it('clamps out-of-range intensity and sharpness', async () => {
    await transientHaptic(5, -3);

    expect(mockApi.playTransientAsync).toHaveBeenCalledWith(1, 0);
  });

  it('gives toggle-on a firmer, sharper beat than toggle-off', async () => {
    await toggleHaptic(true);
    await toggleHaptic(false);

    const [onIntensity, onSharpness] = mockApi.playTransientAsync.mock
      .calls[0] as unknown as number[];
    const [offIntensity, offSharpness] = mockApi.playTransientAsync.mock
      .calls[1] as unknown as number[];
    expect(onIntensity).toBeGreaterThan(offIntensity);
    expect(onSharpness).toBeGreaterThan(offSharpness);
  });

  it('builds a composed pattern with clamped values and ordered offsets', async () => {
    await patternHaptic([
      { intensity: 0.4, sharpness: 0.3, atSeconds: 0 },
      { intensity: 2, sharpness: 0.9, atSeconds: 0.12 },
    ]);

    expect(mockApi.playPatternAsync).toHaveBeenCalledTimes(1);
    const events = mockApi.playPatternAsync.mock.calls[0][0];
    expect(events).toHaveLength(2);
    expect(events[1].time).toBeCloseTo(0.12, 5);
    expect(events[1].parameters[0].value).toBe(1);
  });
});
