import {
  deriveActivePairingStage,
  inviteScreenState,
  type PairingRouteIntent,
} from '../active-pairing-state';

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
    inviteExpired: false,
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
});

describe('inviteScreenState', () => {
  const link = 'https://streetcrypt.id/pair#token=scpair2:abc';

  it('lets a live link own the screen', () => {
    expect(inviteScreenState({ inviteLink: link, remainingSeconds: 90, dismissedLink: null })).toBe(
      'live'
    );
  });

  it('reports nothing when this phone has not minted a link', () => {
    expect(inviteScreenState({ inviteLink: null, remainingSeconds: 0, dismissedLink: null })).toBe(
      'none'
    );
  });

  it('expires a link once its timer runs out', () => {
    expect(inviteScreenState({ inviteLink: link, remainingSeconds: 0, dismissedLink: null })).toBe(
      'expired'
    );
  });

  // The bug this rule exists for: a live link outranks the Bump intent, so without recording the
  // dismissal, leaving the link screen sets an intent the next render converts straight back.
  it('releases the screen once the user has finished with that link', () => {
    expect(inviteScreenState({ inviteLink: link, remainingSeconds: 90, dismissedLink: link })).toBe(
      'dismissed'
    );
  });

  it('does not let a dismissal leak onto the next link', () => {
    expect(
      inviteScreenState({
        inviteLink: 'https://streetcrypt.id/pair#token=scpair2:xyz',
        remainingSeconds: 120,
        dismissedLink: link,
      })
    ).toBe('live');
  });

  it('keeps a dismissed link dismissed after it would have expired', () => {
    expect(inviteScreenState({ inviteLink: link, remainingSeconds: 0, dismissedLink: link })).toBe(
      'dismissed'
    );
  });
});
