import { resolveLocationStatus } from '../location-status';

/**
 * Both directions of this reconciliation exist because of a specific outage, and the second one
 * was missing until 2026-09-17.
 */
describe('resolveLocationStatus', () => {
  it('passes the reported status through when the OS has not been re-read yet', () => {
    // `unknown` is "we have not asked", not "denied". Treating it as an answer would put a
    // background-location warning in front of every user for the first seconds of every launch.
    expect(resolveLocationStatus({ reported: 'running', backgroundAccess: 'unknown' })).toBe(
      'running'
    );
    expect(
      resolveLocationStatus({ reported: 'permission-denied', backgroundAccess: 'unknown' })
    ).toBe('permission-denied');
    expect(resolveLocationStatus({ reported: 'running', backgroundAccess: undefined })).toBe(
      'running'
    );
  });

  it('clears a denial that iOS settled a beat after the request resolved', () => {
    // 2026-08-30: a fresh install read denied at 17:44:13 and `authorizedAlways` two seconds
    // later, and showed "allow background location" for the rest of the evening.
    expect(resolveLocationStatus({ reported: 'permission-denied', backgroundAccess: 'full' })).toBe(
      'running'
    );
  });

  it('raises a denial for a grant that went away after launch', () => {
    // 2026-09-17: an iPhone reinstalled — which resets iOS location authorization to "While
    // Using" — then paired at a bar and published exactly one fix, the pairing introduction, sent
    // while the app was still open. `startLocation` had already run and written `running`, and
    // nothing moved it, so nothing was ever shown.
    expect(resolveLocationStatus({ reported: 'running', backgroundAccess: 'foreground' })).toBe(
      'permission-denied'
    );
  });

  it('leaves the statuses that are not claims about permission alone', () => {
    // `unavailable` is a claim about the BUILD and `error` about the runtime; neither is fixed by
    // granting anything, so neither may be overwritten by a permission read.
    for (const reported of ['starting', 'unavailable', 'error'] as const) {
      expect(resolveLocationStatus({ reported, backgroundAccess: 'foreground' })).toBe(reported);
      expect(resolveLocationStatus({ reported, backgroundAccess: 'full' })).toBe(reported);
    }
  });
});
