import {
  describePairingFailure,
  deriveActivePairingStage,
  inviteScreenState,
  type PairingRouteIntent,
} from '../active-pairing-state';
import type { PairingFailure } from '../../net/location-sharing';

function brokenPair(overrides: Partial<PairingFailure> = {}): PairingFailure {
  return {
    sessionId: 'session-1',
    reason: 'lost',
    nearby: true,
    verified: false,
    at: 1_700_000_000_000,
    ...overrides,
  };
}

function stage(
  overrides: Partial<Parameters<typeof deriveActivePairingStage>[0]> = {},
  intent: PairingRouteIntent = 'bump'
) {
  return deriveActivePairingStage({
    intent,
    pairingLoaded: true,
    available: true,
    radio: 'poweredOn',
    bumpStage: 'armed',
    bumpArming: false,
    bumpError: null,
    hasFriend: false,
    hasVerification: false,
    hasActiveSession: false,
    redeeming: false,
    creatingLink: false,
    inputError: null,
    inviteLive: false,
    inviteSpent: false,
    inviteExpired: false,
    failure: null,
    ...overrides,
  });
}

describe('deriveActivePairingStage', () => {
  it('does not leak a stale Bump failure into an active link', () => {
    expect(
      stage(
        {
          bumpStage: 'failed',
          bumpError: 'No other phone answered.',
          inviteLive: true,
        },
        'link'
      )
    ).toBe('link-live');
  });

  it('lets the user return to Bump after a link expires', () => {
    const expired = {
      bumpStage: 'idle' as const,
      inviteExpired: true,
    };
    expect(stage(expired, 'link')).toBe('link-expired');
    expect(stage(expired, 'bump')).toBe('bump-starting');
  });

  it('shows an incoming link immediately before the service snapshot loads', () => {
    expect(stage({ pairingLoaded: false, redeeming: true }, 'redeem')).toBe('redeeming');
  });

  it('keeps session and verification states above the selected channel', () => {
    expect(stage({ hasActiveSession: true, inviteLive: true }, 'link')).toBe('handshaking');
    expect(stage({ hasVerification: true, bumpStage: 'failed' })).toBe('verifying');
    expect(stage({ hasFriend: true, hasVerification: true })).toBe('discovered');
  });

  it('reports a pairing that broke instead of silently reverting', () => {
    expect(stage({ failure: brokenPair() })).toBe('pair-failed');
    // The exact regression: a failed link pairing must not drop the user back onto the link
    // that caused it, still counting down as though it were good.
    expect(stage({ failure: brokenPair({ nearby: false }), inviteLive: true }, 'link')).toBe(
      'pair-failed'
    );
  });

  it('lets a live check outrank the corpse of the last one', () => {
    expect(stage({ failure: brokenPair(), hasVerification: true })).toBe('verifying');
    expect(stage({ failure: brokenPair(), hasFriend: true })).toBe('discovered');
  });

  it('retires a link the moment another phone opens it', () => {
    expect(stage({ inviteLive: false, inviteSpent: true }, 'link')).toBe('link-spent');
    // Spent beats the clock: an unexpired token nobody will honour is still finished.
    expect(stage({ inviteLive: true, inviteSpent: true }, 'link')).toBe('link-spent');
  });
});

describe('describePairingFailure', () => {
  it('names the security check when the figures were compared and refused', () => {
    const copy = describePairingFailure(brokenPair({ reason: 'declined', verified: true }));
    expect(copy.status).toMatch(/FIGURES/);
    expect(copy.detail).toMatch(/nothing was shared/i);
  });

  it('does not claim a figure mismatch for a session that never reached the check', () => {
    const copy = describePairingFailure(brokenPair({ reason: 'declined', verified: false }));
    expect(copy.status).not.toMatch(/FIGURES/);
  });

  it('points a link failure at a new link and a bump failure at another try', () => {
    expect(describePairingFailure(brokenPair({ reason: 'lost', nearby: false })).detail).toMatch(
      /new link/i
    );
    expect(describePairingFailure(brokenPair({ reason: 'lost', nearby: true })).detail).toMatch(
      /both phones together/i
    );
  });

  it('always says nothing was shared', () => {
    for (const reason of ['declined', 'lost', 'expired'] as const) {
      expect(describePairingFailure(brokenPair({ reason })).detail).toMatch(/nothing was shared/i);
    }
  });
});

describe('inviteScreenState', () => {
  const link = 'https://streetcrypt.id/pair#token=scpair2:abc';

  it('lets a live link own the screen', () => {
    expect(
      inviteScreenState({
        inviteLink: link,
        remainingSeconds: 90,
        redeemed: false,
        dismissedLink: null,
      })
    ).toBe('live');
  });

  it('reports nothing when this phone has not minted a link', () => {
    expect(
      inviteScreenState({
        inviteLink: null,
        remainingSeconds: 0,
        redeemed: false,
        dismissedLink: null,
      })
    ).toBe('none');
  });

  it('expires a link once its timer runs out', () => {
    expect(
      inviteScreenState({
        inviteLink: link,
        remainingSeconds: 0,
        redeemed: false,
        dismissedLink: null,
      })
    ).toBe('expired');
  });

  // The bug this rule exists for: a live link outranks the Bump intent, so without recording the
  // dismissal, leaving the link screen sets an intent the next render converts straight back.
  it('releases the screen once the user has finished with that link', () => {
    expect(
      inviteScreenState({
        inviteLink: link,
        remainingSeconds: 90,
        redeemed: false,
        dismissedLink: link,
      })
    ).toBe('dismissed');
  });

  it('does not let a dismissal leak onto the next link', () => {
    expect(
      inviteScreenState({
        inviteLink: 'https://streetcrypt.id/pair#token=scpair2:xyz',
        remainingSeconds: 120,
        redeemed: false,
        dismissedLink: link,
      })
    ).toBe('live');
  });

  it('retires a link another phone has already opened, whatever the clock says', () => {
    expect(
      inviteScreenState({
        inviteLink: link,
        remainingSeconds: 90,
        redeemed: true,
        dismissedLink: null,
      })
    ).toBe('spent');
  });

  // The service drops the link itself once the attempt behind it is over, but the screen still
  // has to say WHY it went — so the latch has to outlive the link.
  it('still reports spent after the link itself has been retired', () => {
    expect(
      inviteScreenState({
        inviteLink: null,
        remainingSeconds: 0,
        redeemed: true,
        dismissedLink: null,
      })
    ).toBe('spent');
  });

  it('keeps a dismissed link dismissed after it would have expired', () => {
    expect(
      inviteScreenState({
        inviteLink: link,
        remainingSeconds: 0,
        redeemed: false,
        dismissedLink: link,
      })
    ).toBe('dismissed');
  });
});
