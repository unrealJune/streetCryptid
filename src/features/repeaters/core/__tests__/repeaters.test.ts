import type { NativeRepeaterRoster } from 'iroh-location';

import {
  checkClaimLink,
  claimLinkMachineId,
  enrollFacts,
  inviteCandidates,
  offeredCount,
  isWebClaimLink,
  pairingOffers,
  repeaterErrorCopy,
  repeatersSummary,
  retentionWords,
  rosterLine,
  rosterRowDetail,
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
    expect(sections.mine?.machines).toEqual([
      { id: 'ff'.repeat(32), short: 'ffffff', name: null, label: 'ffffff' },
    ]);
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

  it('offers what friends vouch for, named by who vouched and whether I may enroll', () => {
    const sections = rosterSections(
      [
        roster({ rosterId: 'open', owner: SAM, open: true, vouchers: [SAM], canEnroll: true }),
        roster({ rosterId: 'closed', owner: STRANGER, vouchers: [SAM], canEnroll: false }),
        roster({ rosterId: 'seen', owner: STRANGER }),
      ],
      [{ endpointId: SAM, handle: '@sam' }]
    );
    expect(sections.throughFriends.map((r) => [r.rosterId, r.canEnroll])).toEqual([
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

describe('pairingOffers', () => {
  it('asks to enroll in the new friend’s own rosters, and offers to invite them to mine', () => {
    const sections = rosterSections(
      [
        roster({ rosterId: 'sams', owner: SAM, open: true, vouchers: [SAM], canEnroll: true }),
        roster({ rosterId: 'theirs', owner: STRANGER, vouchers: [STRANGER], canEnroll: true }),
        roster({ rosterId: 'mine', owner: ME, mine: true, canInvite: true, inviters: [ME] }),
      ],
      [{ endpointId: SAM, handle: '@sam' }],
      ME
    );
    const offers = pairingOffers(sections, SAM.toUpperCase());
    expect(offers.enroll.map((r) => r.rosterId)).toEqual(['sams']);
    expect(offers.invite.map((r) => r.rosterId)).toEqual(['mine']);
  });

  it('offers nothing to invite them to once they are in it or invited, or if it is open', () => {
    const invited = rosterSections(
      [roster({ rosterId: 'mine', mine: true, canInvite: true, invited: [SAM] })],
      []
    );
    expect(pairingOffers(invited, SAM).invite).toEqual([]);
    const open = rosterSections(
      [roster({ rosterId: 'mine', mine: true, open: true, canInvite: true })],
      []
    );
    expect(pairingOffers(open, SAM).invite).toEqual([]);
    expect(pairingOffers(rosterSections([], []), SAM)).toEqual({ enroll: [], invite: [] });
  });

  it('offers each invite-only roster I may invite to, not only my own', () => {
    const sections = rosterSections(
      [
        roster({ rosterId: 'mine', mine: true, canInvite: true }),
        roster({ rosterId: 'kits', owner: STRANGER, carriesMe: true, canInvite: true }),
        roster({ rosterId: 'nope', owner: STRANGER, carriesMe: true, canInvite: false }),
      ],
      [],
      ME
    );
    expect(pairingOffers(sections, SAM).invite.map((r) => r.rosterId)).toEqual(['mine', 'kits']);
  });
});

describe('machine names', () => {
  it('shows a machine by the name it signed, and by its short id without one', () => {
    const { mine } = rosterSections(
      [
        roster({
          rosterId: 'mine',
          mine: true,
          repeaters: ['a1'.repeat(32), 'b2'.repeat(32)],
          repeaterNames: ['  Living room PC ', ''],
        }),
      ],
      [],
      ME
    );
    expect(mine?.machines.map((m) => [m.name, m.label])).toEqual([
      ['Living room PC', 'Living room PC'],
      [null, 'b2b2b2'],
    ]);
  });

  it('reads a binary without names as every machine unnamed', () => {
    const { mine } = rosterSections(
      [roster({ rosterId: 'mine', mine: true, repeaters: ['a1'.repeat(32)] })],
      [],
      ME
    );
    expect(mine?.machines[0]).toMatchObject({ name: null, label: 'a1a1a1' });
  });
});

describe('claimLinkMachineId', () => {
  // iroh-tickets 1.0's own golden vector (`test_ticket_base32`): variant 0, then the endpoint id.
  const TICKET =
    'endpointacxfr74igmsbvsbnn73wcecg5vt3kbzncqwfrdiampuufwnhkublmaqacbuhi5dqhixs6zdfojyc43lffyxqcad7aaaadaai';

  it('reads the machine a claim link names, without dialling', () => {
    expect(claimLinkMachineId(`streetcryptid-repeater:${TICKET}#${SECRET}`)).toBe(
      'ae58ff8833241ac82d6ff7611046ed67b5072d142c588d0063e942d9a75502b6'
    );
  });

  it('says nothing about a link it cannot read', () => {
    expect(claimLinkMachineId(`streetcryptid-repeater:endpointabc#${SECRET}`)).toBeNull();
    expect(claimLinkMachineId(`streetcryptid-repeater:blobabc#${SECRET}`)).toBeNull();
    expect(claimLinkMachineId('https://streetcrypt.id/repeater')).toBeNull();
  });
});

describe('enrollFacts', () => {
  it('says what enrolling gives, what it never does, and who will see it', () => {
    const [sections] = [
      rosterSections(
        [roster({ rosterId: 'sams', owner: SAM, carried: 6, vouchers: [SAM], canEnroll: true })],
        [{ endpointId: SAM, handle: '@sam' }],
        ME
      ),
    ];
    const facts = enrollFacts(sections.throughFriends[0]);
    expect(facts.map((f) => f.good)).toEqual([true, true, false]);
    expect(facts[2].text).toBe(
      'The 6 people it carries can see you’re carried. sam can remove you.'
    );
    expect(rosterLine(sections.throughFriends[0])).toBe(
      '0 machines · invite only · carrying 6 people'
    );
    expect(offeredCount(sections)).toBe(1);
  });
});

describe('inviteCandidates', () => {
  it('lists friends who are not the owner, not in it and not invited', () => {
    const KIT = '44'.repeat(32);
    const { mine } = rosterSections(
      [roster({ mine: true, owner: ME, members: [SAM], invited: [KIT], canInvite: true })],
      [],
      ME
    );
    if (!mine) throw new Error('expected my roster');
    const friends = [
      { endpointId: SAM, handle: '@sam' },
      { endpointId: KIT, handle: '@kit' },
      { endpointId: STRANGER, handle: '@ash' },
      { endpointId: ME, handle: '@me' },
    ];
    expect(inviteCandidates(mine, friends).map((p) => p.label)).toEqual(['@ash']);
  });
});

describe('rosterRowDetail', () => {
  const view = (over: Partial<NativeRepeaterRoster>) => {
    const s = rosterSections([roster(over)], [{ endpointId: SAM, handle: '@sam' }], ME);
    return s.mine ?? s.carryingMe[0] ?? s.throughFriends[0] ?? s.others[0];
  };

  it('leaves the policy off my own roster, and says when it is not carrying me', () => {
    expect(
      rosterRowDetail(view({ mine: true, carriesMe: true, repeaters: ['a', 'b'], carried: 4 }))
    ).toBe('2 machines · 4 people');
    expect(rosterRowDetail(view({ mine: true, repeaters: ['a'], carried: 1 }))).toBe(
      '1 machine · 1 person · not carrying you'
    );
  });

  it('names the policy of a roster carrying me', () => {
    expect(
      rosterRowDetail(
        view({ owner: SAM, open: true, carriesMe: true, repeaters: ['a'], carried: 9 })
      )
    ).toBe('1 machine · open · 9 people');
  });

  it('names who vouches for an offer, and says when nobody invited me', () => {
    expect(
      rosterRowDetail(
        view({
          owner: STRANGER,
          open: true,
          canEnroll: true,
          vouchers: [SAM],
          repeaters: ['a'],
          carried: 3,
        })
      )
    ).toBe('1 machine · open · 3 people · @sam is in it');
    expect(
      rosterRowDetail(
        view({ owner: STRANGER, canEnroll: false, vouchers: [SAM], repeaters: ['a'], carried: 3 })
      )
    ).toBe('1 machine · invite only · 3 people · not invited');
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

describe('retentionWords', () => {
  it('says the stash window the way a person would', () => {
    expect(retentionWords(48 * 3_600_000)).toBe('48 hours');
    expect(retentionWords(3_600_000)).toBe('1 hour');
    expect(retentionWords(30 * 60_000)).toBe('30 minutes');
  });
});
