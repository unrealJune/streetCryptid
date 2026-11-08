import type { NativeRepeaterRoster } from 'iroh-location';

import {
  checkClaimLink,
  isWebClaimLink,
  repeaterErrorCopy,
  repeatersSummary,
  rosterSections,
} from '../repeaters';

const SECRET = 'ab'.repeat(32);
const ME = '11'.repeat(32);
const SAM = '22'.repeat(32);
const STRANGER = '33'.repeat(32);

function roster(over: Partial<NativeRepeaterRoster>): NativeRepeaterRoster {
  return {
    rosterId: 'r'.repeat(64),
    owner: ME,
    mine: false,
    open: false,
    carriesMe: false,
    repeaters: [],
    carried: 0,
    ...over,
  };
}

describe('checkClaimLink', () => {
  it('accepts a whole link, and one copied with the console line around it', () => {
    const link = `streetcryptid-repeater:endpointabc#${SECRET}`;
    expect(checkClaimLink(link)).toEqual({ ok: true, link });
    expect(checkClaimLink(`  Unclaimed repeater: ${link}\n(valid 30 min)`)).toEqual({
      ok: true,
      link,
    });
  });

  it('turns the https URL a QR code carries into the shape the core parses', () => {
    const link = `streetcryptid-repeater:endpointabc#${SECRET}`;
    expect(checkClaimLink(`https://streetcrypt.id/repeater#t=endpointabc&s=${SECRET}`)).toEqual({
      ok: true,
      link,
    });
    // An intermediary that moved the fragment into the query, or upper-cased the hex.
    expect(
      checkClaimLink(`https://streetcrypt.id/repeater?t=endpointabc&s=${SECRET.toUpperCase()}`)
    ).toEqual({ ok: true, link });
    expect(checkClaimLink('https://streetcrypt.id/repeater#t=endpointabc').ok).toBe(false);
    expect(checkClaimLink(`https://streetcrypt.id/repeaters#t=x&s=${SECRET}`).ok).toBe(false);
    expect(isWebClaimLink('https://streetcrypt.id/repeater')).toBe(true);
    expect(isWebClaimLink('https://streetcrypt.id/pair#token=x')).toBe(false);
  });

  it('refuses anything the core would refuse, before dialling', () => {
    expect(checkClaimLink('https://streetcrypt.id/pair#token=x').ok).toBe(false);
    expect(checkClaimLink('streetcryptid-repeater:endpointabc').ok).toBe(false);
    expect(checkClaimLink(`streetcryptid-repeater:#${SECRET}`).ok).toBe(false);
    expect(checkClaimLink(`streetcryptid-repeater:endpointabc#${SECRET.slice(2)}`).ok).toBe(false);
    expect(checkClaimLink('streetcryptid-repeater:endpointabc#' + 'zz'.repeat(32)).ok).toBe(false);
  });
});

describe('rosterSections', () => {
  it('splits mine, those carrying me and the rest, naming owners by friend handle', () => {
    const sections = rosterSections(
      [
        roster({ rosterId: 'a', owner: STRANGER }),
        roster({ rosterId: 'b', owner: SAM, carriesMe: true, repeaters: [SAM], carried: 3 }),
        roster({ rosterId: 'c', owner: ME, mine: true, open: true, repeaters: ['ff'.repeat(32)] }),
      ],
      [{ endpointId: SAM.toUpperCase(), handle: '@sam' }]
    );
    expect(sections.mine).toMatchObject({ rosterId: 'c', ownerLabel: 'Your repeaters' });
    expect(sections.mine?.machines).toEqual([{ id: 'ff'.repeat(32), short: 'ffffff' }]);
    expect(sections.carryingMe.map((r) => r.ownerLabel)).toEqual(['@sam’s repeaters']);
    expect(sections.others.map((r) => r.ownerLabel)).toEqual(['333333’s repeaters']);
  });

  it('lists who a roster carries, me first and by name', () => {
    const sections = rosterSections(
      [roster({ mine: true, owner: ME, members: [STRANGER, SAM, ME], carried: 3 })],
      [{ endpointId: SAM, handle: '@sam' }],
      ME.toUpperCase()
    );
    expect(sections.mine?.members.map((m) => [m.label, m.isMe])).toEqual([
      ['You', true],
      ['@sam', false],
      ['333333', false],
    ]);
    // A binary that reports only the count lists nobody, rather than guessing.
    expect(rosterSections([roster({ carried: 2 })], []).others[0].members).toEqual([]);
  });

  it('offers what friends vouch for, named by who vouched and whether I may enrol', () => {
    const sections = rosterSections(
      [
        roster({ rosterId: 'open', owner: SAM, open: true, vouchers: [SAM], canEnrol: true }),
        roster({ rosterId: 'closed', owner: STRANGER, vouchers: [SAM], canEnrol: false }),
        roster({ rosterId: 'seen', owner: STRANGER }),
      ],
      [{ endpointId: SAM, handle: '@sam' }]
    );
    expect(sections.throughFriends.map((r) => [r.rosterId, r.canEnrol])).toEqual([
      ['open', true],
      ['closed', false],
    ]);
    expect(sections.throughFriends[0].vouchers.map((v) => v.label)).toEqual(['@sam']);
    expect(sections.others.map((r) => r.rosterId)).toEqual(['seen']);
    expect(repeatersSummary(sections)).toBe('1 offered by friends');
  });

  it('has nothing to show for a phone in no roster', () => {
    const sections = rosterSections([], []);
    expect(sections).toEqual({ mine: null, carryingMe: [], throughFriends: [], others: [] });
    expect(repeatersSummary(sections)).toBe('None');
  });
});

describe('repeatersSummary', () => {
  it('counts my machines and every roster carrying me', () => {
    const sections = rosterSections(
      [
        roster({ rosterId: 'c', mine: true, carriesMe: true, repeaters: ['a', 'b'] }),
        roster({ rosterId: 'b', owner: SAM, carriesMe: true }),
      ],
      []
    );
    expect(repeatersSummary(sections)).toBe('2 machines · carried by 2');
  });

  it('says a single machine and a single carrier in the singular', () => {
    const sections = rosterSections([roster({ mine: true, repeaters: ['a'] })], []);
    expect(repeatersSummary(sections)).toBe('1 machine');
  });
});

describe('repeaterErrorCopy', () => {
  it('names each refusal the shared crate defines', () => {
    expect(repeaterErrorCopy(new Error('Network(the repeater refused: AlreadyClaimed)'))).toMatch(
      /already claimed/
    );
    expect(repeaterErrorCopy(new Error('the repeater refused: BadClaimSecret'))).toMatch(/expired/);
    expect(repeaterErrorCopy(new Error('the repeater refused: NotCarried'))).toMatch(/invite-only/);
    expect(
      repeaterErrorCopy(new Error("the repeater's attestation does not match: wrong repeater"))
    ).toMatch(/not the one the link names/);
  });

  it('falls back to something that is still true', () => {
    expect(repeaterErrorCopy('boom')).toBe('Could not reach the repeater. Try again.');
  });
});
