import {
  pendingPermissionSteps,
  permissionStepCanDecline,
  permissionStepExists,
  projectedPermissionSteps,
  seedLegacyInstall,
  showsPermissionIntro,
  type PermissionContext,
} from '../permission-steps';

const NATIVE = { bluetooth: true, localNetwork: true, battery: true };

function ctx(overrides: Partial<PermissionContext> = {}): PermissionContext {
  return {
    platform: 'android',
    androidApi: 37,
    native: NATIVE,
    disclosure: null,
    asked: new Set(),
    recorded: false,
    granted: {},
    ...overrides,
  };
}

describe('pendingPermissionSteps', () => {
  it('opens a fresh Android 17 install on location, holding back what needs it', () => {
    expect(pendingPermissionSteps(ctx())).toEqual(['location', 'bluetooth', 'local-network']);
  });

  it('asks the background steps once location is accepted and granted', () => {
    const next = ctx({
      disclosure: 'accepted',
      asked: new Set(['location']),
      recorded: true,
      granted: { location: true },
    });
    expect(pendingPermissionSteps(next)).toEqual([
      'background-location',
      'bluetooth',
      'local-network',
      'notifications',
      'battery',
    ]);
  });

  it('skips background location when the while-in-use grant was refused', () => {
    const next = ctx({
      disclosure: 'accepted',
      asked: new Set(['location']),
      recorded: true,
      granted: {},
    });
    expect(pendingPermissionSteps(next)).not.toContain('background-location');
    expect(pendingPermissionSteps(next)).toContain('notifications');
  });

  it('drops everything that serves sharing after "Not now" on location', () => {
    const next = ctx({ disclosure: 'declined', asked: new Set(['location']), recorded: true });
    expect(pendingPermissionSteps(next)).toEqual(['bluetooth', 'local-network']);
  });

  it('skips what the OS already grants, but never the disclosure itself', () => {
    const granted = {
      location: true,
      'background-location': true,
      bluetooth: true,
      'local-network': true,
      notifications: true,
      battery: true,
    };
    expect(pendingPermissionSteps(ctx({ granted }))).toEqual(['location']);
    expect(
      pendingPermissionSteps(
        ctx({ granted, disclosure: 'accepted', asked: new Set(['location']), recorded: true })
      )
    ).toEqual([]);
  });

  it('never asks a step twice', () => {
    const next = ctx({
      disclosure: 'accepted',
      asked: new Set(['location', 'background-location', 'bluetooth', 'local-network']),
      recorded: true,
      granted: { location: true },
    });
    expect(pendingPermissionSteps(next)).toEqual(['notifications', 'battery']);
  });

  it('folds local network into the Bluetooth dialog before Android 17', () => {
    expect(pendingPermissionSteps(ctx({ androidApi: 34 }))).toEqual(['location', 'bluetooth']);
  });

  it('has no Bluetooth or notification steps on old Android', () => {
    const next = ctx({
      androidApi: 30,
      disclosure: 'accepted',
      asked: new Set(['location']),
      recorded: true,
    });
    expect(pendingPermissionSteps({ ...next, granted: { location: true } })).toEqual([
      'background-location',
      'battery',
    ]);
  });

  it('asks every iOS step, local network included, and nothing Android-only', () => {
    const ios = ctx({ platform: 'ios', androidApi: 0 });
    expect(pendingPermissionSteps(ios)).toEqual(['location', 'bluetooth', 'local-network']);
    expect(
      pendingPermissionSteps({
        ...ios,
        disclosure: 'accepted',
        asked: new Set(['location']),
        recorded: true,
        granted: { location: true },
      })
    ).toEqual(['background-location', 'bluetooth', 'local-network']);
  });

  it('asks only location on web', () => {
    expect(pendingPermissionSteps(ctx({ platform: 'web', native: NATIVE }))).toEqual(['location']);
  });

  it('leaves out steps an older binary cannot ask', () => {
    const old = ctx({
      platform: 'ios',
      native: { bluetooth: false, localNetwork: false, battery: false },
    });
    expect(pendingPermissionSteps(old)).toEqual(['location']);
  });

  describe('an install onboarded before this flow', () => {
    it('is owed only the battery step, like the gate it replaced', () => {
      const legacy = ctx({ androidApi: 34, disclosure: 'accepted', granted: { location: true } });
      expect(pendingPermissionSteps(legacy)).toEqual(['battery']);
    });

    it('is owed Android 17 local network when it is still missing', () => {
      const legacy = ctx({
        disclosure: 'accepted',
        granted: { location: true, 'local-network': false },
      });
      expect(pendingPermissionSteps(legacy)).toEqual(['local-network', 'battery']);
    });

    it('is owed nothing on iOS, where local network cannot be read', () => {
      expect(
        pendingPermissionSteps(ctx({ platform: 'ios', disclosure: 'declined', granted: {} }))
      ).toEqual([]);
    });

    it('is not owed the battery step its older record says was asked', () => {
      const legacy = ctx({
        androidApi: 34,
        disclosure: 'accepted',
        asked: new Set(['battery']),
        granted: { location: true },
      });
      expect(pendingPermissionSteps(legacy)).toEqual([]);
    });

    it('stops being legacy once anything is recorded', () => {
      const recorded = ctx({
        disclosure: 'accepted',
        recorded: true,
        granted: { location: true },
      });
      expect(pendingPermissionSteps(recorded)).toContain('bluetooth');
    });
  });
});

describe('seedLegacyInstall', () => {
  it('records everything an older install is not owed, so its first answer cannot unseed it', () => {
    const legacy = ctx({ androidApi: 34, disclosure: 'accepted', granted: { location: true } });
    const seeded = seedLegacyInstall(legacy);
    expect(seeded?.recorded).toBe(true);
    expect(pendingPermissionSteps(seeded!)).toEqual(['battery']);
    const answered = { ...seeded!, asked: new Set([...seeded!.asked, 'battery' as const]) };
    expect(pendingPermissionSteps(answered)).toEqual([]);
  });

  it('leaves fresh and recorded installs alone', () => {
    expect(seedLegacyInstall(ctx())).toBeNull();
    expect(seedLegacyInstall(ctx({ disclosure: 'accepted', recorded: true }))).toBeNull();
  });
});

describe('projectedPermissionSteps', () => {
  it('counts the steps that accepting location opens up', () => {
    expect(projectedPermissionSteps(ctx())).toEqual([
      'location',
      'background-location',
      'bluetooth',
      'local-network',
      'notifications',
      'battery',
    ]);
  });

  it('is what is pending once the disclosure is answered', () => {
    const answered = ctx({ disclosure: 'declined', asked: new Set(['location']), recorded: true });
    expect(projectedPermissionSteps(answered)).toEqual(pendingPermissionSteps(answered));
  });
});

describe('permissionStepExists', () => {
  it('has no battery step without the native export', () => {
    expect(permissionStepExists('battery', ctx({ native: { ...NATIVE, battery: false } }))).toBe(
      false
    );
  });
});

describe('showsPermissionIntro', () => {
  it('opens on the overview only when there is more than one step', () => {
    expect(showsPermissionIntro(['location', 'bluetooth'])).toBe(true);
    expect(showsPermissionIntro(['battery'])).toBe(false);
    expect(showsPermissionIntro([])).toBe(false);
  });
});

describe('permissionStepCanDecline', () => {
  it('leaves the decline to the system alert on iOS', () => {
    expect(permissionStepCanDecline('ios')).toBe(false);
    expect(permissionStepCanDecline('android')).toBe(true);
    expect(permissionStepCanDecline('web')).toBe(true);
  });
});
