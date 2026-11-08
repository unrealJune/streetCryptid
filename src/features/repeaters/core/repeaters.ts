import type { NativeRepeaterRoster } from 'iroh-location';

/**
 * What Settings → Repeaters shows, derived from the rosters the core knows
 * (`docs/social/REPEATERS.md` §4.4). Pure: the native calls live in `../net`, and nothing here
 * decides anything a repeater would judge differently — the roster rules are the shared crate's.
 */

/** The prefix a repeater's console prints its claim link under (`streetcryptid-repeater` crate). */
export const CLAIM_SCHEME = 'streetcryptid-repeater:';

export type ClaimLinkCheck = { ok: true; link: string } | { ok: false; reason: string };

/**
 * Check a pasted claim link before dialling anything. Mirrors `parse_claim_link`: the scheme, a
 * non-empty endpoint ticket, `#`, and a 64-hex secret. Text around the link (a terminal line, a
 * chat message) is tolerated, because that is how a link copied from a console arrives.
 */
export function checkClaimLink(text: string): ClaimLinkCheck {
  const start = text.indexOf(CLAIM_SCHEME);
  if (start < 0) {
    return { ok: false, reason: 'Paste the link the repeater printed when it started.' };
  }
  const link = text.slice(start).split(/\s/)[0];
  const rest = link.slice(CLAIM_SCHEME.length);
  const hash = rest.indexOf('#');
  const ticket = hash < 0 ? '' : rest.slice(0, hash);
  const secret = hash < 0 ? '' : rest.slice(hash + 1);
  if (ticket.length === 0 || !/^[0-9a-fA-F]{64}$/.test(secret)) {
    return { ok: false, reason: 'That link is cut short. Copy the whole line from the console.' };
  }
  return { ok: true, link };
}

export interface RosterView {
  readonly rosterId: string;
  /** "Your repeaters", or the friend whose they are, or a short id for someone unknown. */
  readonly ownerLabel: string;
  readonly mine: boolean;
  readonly open: boolean;
  readonly carriesMe: boolean;
  /** Short ids of the machines in it. */
  readonly machines: readonly string[];
  /** How many people's trails it carries. */
  readonly carried: number;
}

export interface RosterSections {
  /** The roster this phone owns, if it has claimed a repeater. */
  readonly mine: RosterView | null;
  /** Other people's rosters that carry this phone's trail. */
  readonly carryingMe: readonly RosterView[];
  /** Other rosters this phone knows and is not enrolled in. */
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
  friends: readonly FriendName[]
): RosterSections {
  const names = new Map(friends.map((f) => [f.endpointId.toLowerCase(), f.handle]));
  const view = (r: NativeRepeaterRoster): RosterView => ({
    rosterId: r.rosterId,
    ownerLabel: r.mine
      ? 'Your repeaters'
      : `${names.get(r.owner.toLowerCase()) ?? shortId(r.owner)}’s repeaters`,
    mine: r.mine,
    open: r.open,
    carriesMe: r.carriesMe,
    machines: r.repeaters.map(shortId),
    carried: r.carried,
  });
  const views = rosters.map(view);
  const byLabel = (a: RosterView, b: RosterView) => a.ownerLabel.localeCompare(b.ownerLabel);
  return {
    mine: views.find((v) => v.mine) ?? null,
    carryingMe: views.filter((v) => !v.mine && v.carriesMe).sort(byLabel),
    others: views.filter((v) => !v.mine && !v.carriesMe).sort(byLabel),
  };
}

/** The Settings menu's one-line answer to "what do repeaters do for me right now". */
export function repeatersSummary(sections: RosterSections): string {
  const carriers = (sections.mine?.carriesMe ? 1 : 0) + sections.carryingMe.length;
  const machines = sections.mine?.machines.length ?? 0;
  const parts: string[] = [];
  if (machines > 0) parts.push(`${machines} ${machines === 1 ? 'machine' : 'machines'}`);
  if (carriers > 0) parts.push(`carried by ${carriers}`);
  return parts.length > 0 ? parts.join(' · ') : 'None';
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
      'The code has expired or was already used. Restart the repeater for a new link.',
    ],
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
