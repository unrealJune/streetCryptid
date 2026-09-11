import type { BumpStage } from '../net/location-sharing';

export type PairingRouteIntent = 'bump' | 'link' | 'redeem';

export type ActivePairingStage =
  | 'loading'
  | 'discovered'
  | 'verifying'
  | 'redeeming'
  | 'redeem-failed'
  | 'handshaking'
  | 'link-creating'
  | 'link-live'
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
  readonly inviteExpired: boolean;
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
  if (input.redeeming) return 'redeeming';
  if (input.intent === 'redeem' && input.inputError) return 'redeem-failed';
  if (input.hasActiveSession) return 'handshaking';

  if (input.intent === 'link') {
    if (input.creatingLink) return 'link-creating';
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

/** What the invite this phone minted is currently doing to the screen. */
export type InviteScreenState = 'none' | 'live' | 'expired' | 'dismissed';

interface InviteScreenInput {
  /** The one-time link this phone last minted, if any. */
  readonly inviteLink: string | null | undefined;
  /** Seconds left on that link. Zero once it has expired. */
  readonly remainingSeconds: number;
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
 */
export function inviteScreenState({
  inviteLink,
  remainingSeconds,
  dismissedLink,
}: InviteScreenInput): InviteScreenState {
  if (!inviteLink) return 'none';
  if (inviteLink === dismissedLink) return 'dismissed';
  return remainingSeconds > 0 ? 'live' : 'expired';
}
