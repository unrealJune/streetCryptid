/**
 * The gate itself, across every combination the four checks can be in.
 *
 * `NATIVE_GLASS` is read once at module scope — the constants it reads cannot change during a
 * process — so each case re-imports the module against its own mock rather than mutating one.
 */

interface Native {
  liquid: boolean;
  api: boolean;
  throws?: boolean;
}

function loadGate(native: Native) {
  let diagnosis: ReturnType<typeof import('../glass-surface').useGlassDiagnosis> | undefined;

  jest.isolateModules(() => {
    jest.doMock('expo-glass-effect', () => ({
      GlassView: () => null,
      GlassContainer: () => null,
      isLiquidGlassAvailable: () => {
        if (native.throws) throw new Error('no native module');
        return native.liquid;
      },
      isGlassEffectAPIAvailable: () => {
        if (native.throws) throw new Error('no native module');
        return native.api;
      },
    }));
    // Reduce Transparency resolves asynchronously and starts false, which is the state every
    // assertion below is about; the hook is called outside React only for its synchronous half.
    jest.doMock('react', () => ({
      ...jest.requireActual('react'),
      useState: (initial: unknown) => [initial, () => {}],
      useEffect: () => {},
    }));

    const gate = require('../glass-surface') as typeof import('../glass-surface');
    diagnosis = gate.useGlassDiagnosis();
  });

  return diagnosis!;
}

afterEach(() => {
  jest.dontMock('expo-glass-effect');
  jest.dontMock('react');
});

describe('the liquid glass gate', () => {
  it('draws glass only when both native checks agree', () => {
    expect(loadGate({ liquid: true, api: true }).available).toBe(true);
  });

  it('refuses when the UIGlassEffect class is missing, even though the build says glass', () => {
    // The bug this exists for. `GlassView.swift` guards every one of its methods on the same
    // check, so the view mounts and draws NOTHING — and the surface has already handed its
    // background to it. An invisible island is worse than no glass, and only JS can choose the
    // fallback in time.
    const gate = loadGate({ liquid: true, api: false });
    expect(gate.available).toBe(false);
    expect(gate.reason).toBe('This iOS build has no UIGlassEffect class');
  });

  it('refuses when the build or the OS is too old, and says which', () => {
    const gate = loadGate({ liquid: false, api: true });
    expect(gate.available).toBe(false);
    expect(gate.reason).toBe('Needs iOS 26 on the phone and an Xcode 26 build');
  });

  it('survives a bundle whose JS is ahead of the binary it runs on', () => {
    const gate = loadGate({ liquid: false, api: false, throws: true });
    expect(gate.available).toBe(false);
    expect(gate.liquidGlass).toBe(false);
    expect(gate.glassEffectApi).toBe(false);
  });

  it('reports the platform and OS version, so the phone can answer for itself', () => {
    const gate = loadGate({ liquid: true, api: true });
    expect(gate.platform).toBe('ios');
    expect(gate.osVersion).toEqual(expect.any(String));
  });
});
