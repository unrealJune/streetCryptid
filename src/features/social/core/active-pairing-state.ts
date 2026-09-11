import type { BumpStage, PairingFailure } from '../net/location-sharing';

export type PairingRouteIntent = 'bump' | 'link' | 'redeem';

export type ActivePairingStage =
  | 'loading'
  | 'discovered'
  | 'verifying'
  | 'pair-failed'
  | 'redeeming'
  | 'redeem-failed'
  | 'handshaking'
  | 'link-creating'
  | 'link-live'
  | 'link-spent'
  | 'link-expired'
  | 'link-failed'
  | 'unavailable'
  | 'radio-off'
  | 'radio-unsupported'
  | 'bump-failed'
  | 'bump-searching'
  | 'bump-contact'
  | 'bump-starting'
  | 'bump-armed';

interface ActivePairingStateInput {
  readonly intent: PairingRouteIntent;
  readonly pairingLoaded: boolean;
  readonly available: boolean;
  readonly radio: 'poweredOn' | 'poweredOff' | 'unauthorized' | 'unsupported' | 'unknown';
  readonly bumpStage: BumpStage;
  readonly bumpArming: boolean;
  readonly bumpError: string | null;
  readonly hasFriend: boolean;
  readonly hasVerification: boolean;
  readonly hasActiveSession: boolean;
  readonly redeeming: boolean;
  readonly creatingLink: boolean;
  readonly inputError: string | null;
  readonly inviteLive: boolean;
  readonly inviteSpent: boolean;
  readonly inviteExpired: boolean;
  /** A pairing that started and then broke, until the user dismisses it. */
  readonly failure: PairingFailure | null;
}

/**
 * One ordered state machine for the full-screen pairing route.
 *
 * Security/session states always win. Below them, only the user's selected pairing
 * channel may contribute state: a stale Bump miss cannot surface while a link owns
 * the screen, and an expired link cannot trap someone after they return to Bump.
 */
export function deriveActivePairingStage(input: ActivePairingStateInput): ActivePairingStage {
  if (input.hasFriend) return 'discovered';
  if (input.hasVerification) return 'verifying';
  // Above every channel state and below the live ones. A pairing that broke is the most recent
  // true thing about this screen, and the service retires it the moment anything starts again —
  // so this cannot strand anyone. Ranked under `verifying` because a second, live check outranks
  // the corpse of the first; ranked over `link-live` so a spent link cannot resurface beneath it.
  if (input.failure) return 'pair-failed';
  if (input.redeeming) return 'redeeming';
  if (input.intent === 'redeem' && input.inputError) return 'redeem-failed';
  if (input.hasActiveSession) return 'handshaking';

  if (input.intent === 'link') {
    if (input.creatingLink) return 'link-creating';
    if (input.inviteSpent) return 'link-spent';
    if (input.inviteLive) return 'link-live';
    if (input.inviteExpired) return 'link-expired';
    if (input.inputError) return 'link-failed';
    return 'link-creating';
  }

  if (!input.pairingLoaded) return 'loading';
  if (!input.available) return 'unavailable';
  if (input.radio === 'poweredOff') return 'radio-off';
  if (input.radio === 'unsupported') return 'radio-unsupported';
  if (input.bumpStage === 'failed' || input.bumpError) return 'bump-failed';
  if (input.bumpStage === 'searching') return 'bump-searching';
  if (input.bumpStage === 'contact') return 'bump-contact';
  if (input.bumpStage === 'armed') return 'bump-armed';
  if (input.bumpArming || input.bumpStage === 'idle') return 'bump-starting';
  return 'bump-starting';
}

/** Headline and explanation for a pairing that broke after it had started. */
export interface PairingFailureCopy {
  readonly status: string;
  readonly detail: string;
}

/**
 * Say what happened, at exactly the resolution the wire supports and no finer.
 *
 * `declined` splits on whether this phone reached the visual check, because that changes what the
 * other person actually did: past the gate they looked at two figures and said they differed —
 * which is the security check doing its job and must not be softened into a network hiccup.
 */
export function describePairingFailure(failure: PairingFailure): PairingFailureCopy {
  switch (failure.reason) {
    case 'declined':
      return failure.verified
        ? {
            status: 'FIGURES DID NOT MATCH',
            detail:
              'The other phone reported a different figure, so nothing was shared. If you were both looking at the same screens, try again — and if it keeps happening, stop and compare in person.',
          }
        : {
            status: 'THEY DECLINED',
            detail: 'The other phone turned this pairing down. Nothing was shared.',
          };
    case 'expired':
      return {
        status: 'CHECK RAN OUT OF TIME',
        detail:
          'The visual check closed before both people confirmed. Nothing was shared. Start again with both phones in hand.',
      };
    case 'lost':
      return {
        status: failure.nearby ? 'CONTACT LOST' : 'CONNECTION LOST',
        detail: failure.nearby
          ? 'The other phone dropped out before pairing finished. Nothing was shared. Keep both phones together and try again.'
          : 'The other phone dropped out before pairing finished. Nothing was shared. Make a new link and send it again.',
      };
  }
}

/** What the invite this phone minted is currently doing to the screen. */
export type InviteScreenState = 'none' | 'live' | 'spent' | 'expired' | 'dismissed';

interface InviteScreenInput {
  /** The one-time link this phone last minted, if any. */
  readonly inviteLink: string | null | undefined;
  /** Seconds left on that link. Zero once it has expired. */
  readonly remainingSeconds: number;
  /** Whether another phone has already opened this link. */
  readonly redeemed: boolean;
  /**
   * The link the user finished with. Keyed to the link text rather than a boolean so that
   * minting a *new* link takes the screen back automatically.
   */
  readonly dismissedLink: string | null;
}

/**
 * Where a minted invite stands, from the screen's point of view.
 *
 * A live link has to outrank the Bump intent, or re-arming the radio would fight the link the
 * user is in the middle of showing someone. That precedence is exactly why dismissal has to be
 * explicit and has to be recorded: without it, leaving the link screen sets an intent that the
 * very next render silently converts straight back into `link`, and the button does nothing.
 *
 * `spent` outranks the clock. A redeemed invite is finished whatever its timer says, and a
 * countdown still running over a token nobody will honour is the exact lie this state removes.
 */
export function inviteScreenState({
  inviteLink,
  remainingSeconds,
  redeemed,
  dismissedLink,
}: InviteScreenInput): InviteScreenState {
  if (!inviteLink) return redeemed ? 'spent' : 'none';
  if (inviteLink === dismissedLink) return 'dismissed';
  if (redeemed) return 'spent';
  return remainingSeconds > 0 ? 'live' : 'expired';
}
