import type { NativeRepeaterRoster } from 'iroh-location';

/**
 * What Settings → Repeaters shows, derived from the rosters the core knows
 * (`docs/social/REPEATERS.md` §4.4). Pure: the native calls live in `../net`, and nothing here
 * decides anything a repeater would judge differently — the roster rules are the shared crate's.
 */

/** The prefix a repeater's console prints its claim link under (`streetcryptid-repeater` crate). */
export const CLAIM_SCHEME = 'streetcryptid-repeater:';

/**
 * The same link as a URL any camera can open: `https://streetcrypt.id/repeater#t=<ticket>&s=<secret>`.
 * Claimed as a Universal Link / App Link beside `/pair`, so scanning the repeater's QR code with
 * the phone's own camera opens Settings → Repeaters with the link filled in. The ticket and the
 * secret ride in the fragment, which is never sent to streetcrypt.id when the app is missing.
 */
export const CLAIM_WEB_HOST = 'streetcrypt.id';
export const CLAIM_WEB_PATH = 'repeater';
const CLAIM_WEB_PREFIX = `https://${CLAIM_WEB_HOST}/${CLAIM_WEB_PATH}`;

export type ClaimLinkCheck = { ok: true; link: string } | { ok: false; reason: string };

/** True when `s` is the https claim URL (possibly without its fragment). */
export function isWebClaimLink(s: string): boolean {
  if (!s.startsWith(CLAIM_WEB_PREFIX)) return false;
  // Only a boundary may follow, so `/repeaters-guide` is never mistaken for a claim.
  const rest = s.slice(CLAIM_WEB_PREFIX.length);
  return rest === '' || rest.startsWith('/') || rest.startsWith('?') || rest.startsWith('#');
}

const CUT_SHORT = 'That link is cut short. Copy the whole line from the console.';

function shaped(ticket: string, secret: string): ClaimLinkCheck {
  if (ticket.length === 0 || /[\s#]/.test(ticket) || !/^[0-9a-fA-F]{64}$/.test(secret)) {
    return { ok: false, reason: CUT_SHORT };
  }
  return { ok: true, link: `${CLAIM_SCHEME}${ticket}#${secret.toLowerCase()}` };
}

/**
 * Check a claim link before dialling anything, and return it in the one shape the core parses
 * (`streetcryptid-repeater:<ticket>#<64 hex>`, `parse_claim_link`). Takes either shape: the
 * console's, or the https URL its QR code carries (fragment, or query if something in between
 * moved it). Text around the link (a terminal line, a chat message) is tolerated, because that is
 * how a link copied from a console arrives.
 */
export function checkClaimLink(text: string): ClaimLinkCheck {
  const web = text.indexOf(CLAIM_WEB_PREFIX);
  if (web >= 0) {
    const url = text.slice(web).split(/\s/)[0];
    if (!isWebClaimLink(url)) {
      return { ok: false, reason: 'Paste the link the repeater printed when it started.' };
    }
    const at = url.search(/[#?]/);
    const params = new Map<string, string>();
    for (const pair of (at < 0 ? '' : url.slice(at + 1)).split('&')) {
      const eq = pair.indexOf('=');
      if (eq > 0) params.set(pair.slice(0, eq), safeDecode(pair.slice(eq + 1)));
    }
    return shaped(params.get('t') ?? '', params.get('s') ?? '');
  }
  const start = text.indexOf(CLAIM_SCHEME);
  if (start < 0) {
    return { ok: false, reason: 'Paste the link the repeater printed when it started.' };
  }
  const rest = text.slice(start).split(/\s/)[0].slice(CLAIM_SCHEME.length);
  const hash = rest.indexOf('#');
  return hash < 0
    ? { ok: false, reason: CUT_SHORT }
    : shaped(rest.slice(0, hash), rest.slice(hash + 1));
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return '';
  }
}

export interface RosterPerson {
  readonly id: string;
  /** "You", a friend's handle, or a short id for someone this phone does not know. */
  readonly label: string;
  readonly isMe: boolean;
}

export interface RosterMachine {
  readonly id: string;
  readonly short: string;
}

export interface RosterView {
  readonly rosterId: string;
  /** "Your repeaters", or the friend whose they are, or a short id for someone unknown. */
  readonly ownerLabel: string;
  readonly mine: boolean;
  readonly open: boolean;
  readonly carriesMe: boolean;
  readonly machines: readonly RosterMachine[];
  /** How many people's trails it carries. */
  readonly carried: number;
  /** Who it carries, me first; empty on a binary that reports only the count. */
  readonly members: readonly RosterPerson[];
  /** Friends whose repeater cards list it and who are in it themselves. */
  readonly vouchers: readonly RosterPerson[];
  /** Enrolling would be accepted: open, or an invite naming me. */
  readonly canEnrol: boolean;
}

export interface RosterSections {
  /** The roster this phone owns, if it has claimed a repeater. */
  readonly mine: RosterView | null;
  /** Other people's rosters that carry this phone's trail. */
  readonly carryingMe: readonly RosterView[];
  /** Rosters friends' cards vouch for that do not carry me (REPEATERS.md §4.4). */
  readonly throughFriends: readonly RosterView[];
  /** Everything else this phone knows and is not enrolled in. */
  readonly others: readonly RosterView[];
}

export interface FriendName {
  readonly endpointId: string;
  readonly handle: string;
}

/** Six hex characters are enough to tell two machines apart at a glance. */
export function shortId(hex: string): string {
  return hex.slice(0, 6);
}

export function rosterSections(
  rosters: readonly NativeRepeaterRoster[],
  friends: readonly FriendName[],
  /** This phone's endpoint id, so it can be told apart in a member list. */
  self: string | null = null
): RosterSections {
  const names = new Map(friends.map((f) => [f.endpointId.toLowerCase(), f.handle]));
  const me = self?.toLowerCase() ?? null;
  const person = (id: string): RosterPerson => {
    const key = id.toLowerCase();
    const isMe = key === me;
    return { id, isMe, label: isMe ? 'You' : (names.get(key) ?? shortId(id)) };
  };
  const view = (r: NativeRepeaterRoster): RosterView => ({
    rosterId: r.rosterId,
    ownerLabel: r.mine
      ? 'Your repeaters'
      : `${names.get(r.owner.toLowerCase()) ?? shortId(r.owner)}’s repeaters`,
    mine: r.mine,
    open: r.open,
    carriesMe: r.carriesMe,
    machines: r.repeaters.map((id) => ({ id, short: shortId(id) })),
    carried: r.carried,
    members: (r.members ?? [])
      .map(person)
      .sort((a, b) => Number(b.isMe) - Number(a.isMe) || a.label.localeCompare(b.label)),
    vouchers: (r.vouchers ?? []).map(person).sort((a, b) => a.label.localeCompare(b.label)),
    // A binary without the field could always try; the repeater is what judges.
    canEnrol: r.carriesMe ? false : (r.canEnrol ?? true),
  });
  const views = rosters.map(view);
  const byLabel = (a: RosterView, b: RosterView) => a.ownerLabel.localeCompare(b.ownerLabel);
  return {
    mine: views.find((v) => v.mine) ?? null,
    carryingMe: views.filter((v) => !v.mine && v.carriesMe).sort(byLabel),
    throughFriends: views
      .filter((v) => !v.mine && !v.carriesMe && v.vouchers.length > 0)
      .sort(byLabel),
    others: views.filter((v) => !v.mine && !v.carriesMe && v.vouchers.length === 0).sort(byLabel),
  };
}

/** The Settings menu's one-line answer to "what do repeaters do for me right now". */
export function repeatersSummary(sections: RosterSections): string {
  const carriers = (sections.mine?.carriesMe ? 1 : 0) + sections.carryingMe.length;
  const machines = sections.mine?.machines.length ?? 0;
  const parts: string[] = [];
  if (machines > 0) parts.push(`${machines} ${machines === 1 ? 'machine' : 'machines'}`);
  if (carriers > 0) parts.push(`carried by ${carriers}`);
  const offered = sections.throughFriends.filter((r) => r.canEnrol).length;
  if (offered > 0) parts.push(`${offered} offered by friends`);
  return parts.length > 0 ? parts.join(' · ') : 'None';
}

/** A retention window in words: "48 hours", "30 minutes", "1 hour". */
export function retentionWords(ms: number): string {
  const hours = ms / 3_600_000;
  if (hours >= 1 && Number.isInteger(hours)) return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  const minutes = Math.round(ms / 60_000);
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}

/**
 * Words for a refused or failed repeater call. The core reports a refusal by its `Refusal` name
 * inside the error text (`the repeater refused: AlreadyClaimed`), and the native bridges pass that
 * text through, so this matches on the names the shared crate defines.
 */
export function repeaterErrorCopy(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const cases: [RegExp, string][] = [
    [
      /BadClaimSecret/,
      'That code has expired or was already used. Use the newest one the repeater printed.',
    ],
    [/removed, and not invited again/, 'The owner removed you. Only a new invite lets you back.'],
    [/this roster is invite-only/, 'This roster is invite-only, and nobody has invited you to it.'],
    [/only the roster's owner/, 'Only the owner can change this roster.'],
    [/AlreadyClaimed/, 'Someone has already claimed this repeater.'],
    [/BadClaimRoster/, 'The repeater refused this roster.'],
    [/NotClaimed/, 'Nobody has claimed this repeater yet.'],
    [/NotCarried/, 'This roster is invite-only, and nobody has invited you to it.'],
    [/TooMany/, 'The repeater is at its limit.'],
    [/Unavailable/, 'The repeater had a problem on its end. Try again later.'],
    [
      /attestation does not match/,
      'The machine that answered is not the one the link names. Nothing was added.',
    ],
    [/not a repeater claim link/, 'That is not a repeater link.'],
    [/no such roster/, 'This phone does not know that roster any more.'],
    [/NoNode|createNode first|NotStarted/, 'Sharing has not started yet. Try again in a moment.'],
    [/timed out|timeout|Timeout/, 'The repeater did not answer. Is it running, and online?'],
  ];
  for (const [pattern, copy] of cases) {
    if (pattern.test(text)) return copy;
  }
  return 'Could not reach the repeater. Try again.';
}
