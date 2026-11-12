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

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/**
 * The machine a claim link names, as lowercase hex, read without dialling: the link's endpoint
 * ticket is `endpoint` + base32 (no padding) of postcard bytes whose first is the wire variant and
 * whose next 32 are the endpoint id (`iroh-tickets` 1.0, `EndpointTicket`). It is what the
 * console prints beside the code, so the person can see they scanned the machine in front of
 * them. Only a label: the core checks the signed cert against the machine that actually answers,
 * so a wrong answer here can mislabel a screen and never add a machine. `null` when unreadable.
 */
export function claimLinkMachineId(link: string): string | null {
  const ticket = link.startsWith(CLAIM_SCHEME) ? link.slice(CLAIM_SCHEME.length).split('#')[0] : '';
  if (!ticket.startsWith('endpoint')) return null;
  const body = ticket.slice('endpoint'.length).toLowerCase();
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of body) {
    const digit = BASE32.indexOf(ch);
    if (digit < 0) return null;
    value = (value << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >> bits) & 0xff);
      if (bytes.length === 33) break;
    }
  }
  if (bytes.length < 33 || bytes[0] !== 0) return null;
  return bytes
    .slice(1)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
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
  /** What the person at the machine called it ("Living room PC"), or null. Signed by the machine. */
  readonly name: string | null;
  /** The name when it has one, else the short id: how the machine is shown. */
  readonly label: string;
}

export interface RosterView {
  readonly rosterId: string;
  /** The owner's endpoint id. */
  readonly owner: string;
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
  readonly canEnroll: boolean;
  /** This phone may invite people: it owns it or holds `inviter` (any policy). */
  readonly canInvite: boolean;
  /** Who besides the owner may invite people. */
  readonly inviters: readonly RosterPerson[];
  /** Invited and not carried yet. */
  readonly invited: readonly RosterPerson[];
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
  const byName = (a: RosterPerson, b: RosterPerson) => a.label.localeCompare(b.label);
  const view = (r: NativeRepeaterRoster): RosterView => ({
    rosterId: r.rosterId,
    owner: r.owner,
    ownerLabel: r.mine
      ? 'Your repeaters'
      : `${names.get(r.owner.toLowerCase()) ?? shortId(r.owner)}’s repeaters`,
    mine: r.mine,
    open: r.open,
    carriesMe: r.carriesMe,
    machines: r.repeaters.map((id, i) => {
      const name = r.repeaterNames?.[i]?.trim() || null;
      return { id, short: shortId(id), name, label: name ?? shortId(id) };
    }),
    carried: r.carried,
    members: (r.members ?? [])
      .map(person)
      .sort((a, b) => Number(b.isMe) - Number(a.isMe) || a.label.localeCompare(b.label)),
    vouchers: (r.vouchers ?? []).map(person).sort((a, b) => a.label.localeCompare(b.label)),
    // A binary without the field could always try; the repeater is what judges.
    canEnroll: r.carriesMe ? false : (r.canEnroll ?? true),
    canInvite: r.canInvite ?? false,
    inviters: (r.inviters ?? [])
      .filter((id) => id.toLowerCase() !== r.owner.toLowerCase())
      .map(person)
      .sort(byName),
    invited: (r.invited ?? []).map(person).sort(byName),
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

/** Friends who could be invited to `roster`: not its owner, not in it, not already invited. */
export function inviteCandidates(
  roster: RosterView,
  friends: readonly FriendName[]
): RosterPerson[] {
  const taken = new Set([roster.owner.toLowerCase()]);
  for (const person of [...roster.members, ...roster.invited]) {
    taken.add(person.id.toLowerCase());
  }
  return friends
    .filter((f) => !taken.has(f.endpointId.toLowerCase()))
    .map((f) => ({ id: f.endpointId, label: f.handle, isMe: false }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** What the pairing screen can offer about a friend just found (REPEATERS.md §4.4). */
export interface PairingOffers {
  /** Their rosters (owned or vouched for by them) that I may enroll in and am not carried by. */
  readonly enroll: readonly RosterView[];
  /** Invite-only rosters I may invite them to, that they are not in or invited to. */
  readonly invite: readonly RosterView[];
}

/**
 * The Enroll question and the "also invite them" choices for `friendId`, from rosters this phone
 * already knows. Their card may not have arrived yet; then there is nothing to ask here, and the
 * roster turns up under Available through friends once it does.
 */
export function pairingOffers(sections: RosterSections, friendId: string): PairingOffers {
  const friend = friendId.toLowerCase();
  const all = [
    ...(sections.mine ? [sections.mine] : []),
    ...sections.carryingMe,
    ...sections.throughFriends,
    ...sections.others,
  ];
  const isFriend = (p: RosterPerson) => p.id.toLowerCase() === friend;
  return {
    enroll: all.filter(
      (r) =>
        !r.mine &&
        !r.carriesMe &&
        r.canEnroll &&
        (r.owner.toLowerCase() === friend || r.vouchers.some(isFriend))
    ),
    // Open rosters need no invite to join; offering one there would only add an op.
    invite: all.filter(
      (r) =>
        r.canInvite &&
        !r.open &&
        r.owner.toLowerCase() !== friend &&
        !r.members.some(isFriend) &&
        !r.invited.some(isFriend)
    ),
  };
}

/** Rosters friends offer that I could enroll in now: what the Settings menu's badge counts. */
export function offeredCount(sections: RosterSections): number {
  return sections.throughFriends.filter((r) => r.canEnroll).length;
}

/** The Settings menu's one-line answer to "what do repeaters do for me right now". */
export function repeatersSummary(sections: RosterSections): string {
  const carriers = (sections.mine?.carriesMe ? 1 : 0) + sections.carryingMe.length;
  const machines = sections.mine?.machines.length ?? 0;
  const parts: string[] = [];
  if (machines > 0) parts.push(`${machines} ${machines === 1 ? 'machine' : 'machines'}`);
  if (carriers > 0) parts.push(`carried by ${carriers}`);
  const offered = offeredCount(sections);
  if (offered > 0) parts.push(`${offered} offered by friends`);
  return parts.length > 0 ? parts.join(' · ') : 'None';
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "2 machines · invite only · carrying 6 people": a roster in one line. */
export function rosterLine(roster: RosterView): string {
  return [
    count(roster.machines.length, 'machine', 'machines'),
    roster.open ? 'open to anyone' : 'invite only',
    `carrying ${count(roster.carried, 'person', 'people')}`,
  ].join(' · ');
}

/** "Vouched for by Sam, quietmoth", or null when nobody did. */
export function vouchLine(roster: RosterView): string | null {
  return roster.vouchers.length > 0
    ? `Vouched for by ${roster.vouchers.map((v) => v.label).join(', ')}`
    : null;
}

/** The owner's name alone ("lunarhare", "a41f9c"), for sentences: never "Your". */
export function ownerName(roster: RosterView): string {
  return roster.ownerLabel.replace(/’s repeaters$/, '').replace(/^@/, '');
}

export interface EnrollFact {
  /** A benefit (`true`) or a cost the person should know (`false`). */
  readonly good: boolean;
  readonly text: string;
}

/**
 * What enrolling means, said before the person agrees (REPEATERS.md §1, §3.3). Every line is a
 * property of the protocol, not a promise about a machine: ciphertext-blind, memory-only, and a
 * roster that lists its members to each other. Leaving is cooperative (§2.2), so nothing here
 * says a repeater "can no longer" do anything.
 */
export function enrollFacts(roster: RosterView): EnrollFact[] {
  const others = roster.carried;
  return [
    {
      good: true,
      text: 'Friends pick up your sealed location from them while your phone sleeps.',
    },
    { good: true, text: 'They can never read it. Kept in memory, never on their disk.' },
    {
      good: false,
      text:
        others > 0
          ? `The ${count(others, 'person', 'people')} it carries can see you’re carried. ${ownerName(roster)} can remove you.`
          : `Anyone it carries later can see you’re carried. ${ownerName(roster)} can remove you.`,
    },
  ];
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
    [
      /only the owner or an inviter invites/,
      'Only the owner, or someone they allowed, can invite.',
    ],
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
