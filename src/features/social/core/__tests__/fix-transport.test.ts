import { describeDelivery, shortEndpoint } from '../fix-transport';

const MAYA = 'aa'.repeat(32);
const OWLBEAR = 'bb'.repeat(32);
const STASH = 'cc'.repeat(32);
const STRANGER = '3f9c1a' + 'dd'.repeat(29) + 'dd';

const pool = new Map([[OWLBEAR, '@owlbear']]);

function describe_(overrides: Partial<Parameters<typeof describeDelivery>[0]> = {}) {
  return describeDelivery({
    via: 'relay',
    viaPeer: OWLBEAR,
    author: MAYA,
    authorHandle: '@maya',
    friendHandles: pool,
    stashEndpointId: STASH,
    ...overrides,
  });
}

describe('describeDelivery', () => {
  it('names a mutual who forwarded the fix', () => {
    const result = describe_();
    expect(result.kind).toBe('friend');
    expect(result.headline).toBe('Forwarded by @owlbear');
    // No id for someone we can name — the handle is the identity that matters.
    expect(result.peerId).toBeUndefined();
  });

  it('describes a recovery differently from a live forward', () => {
    expect(describe_({ via: 'docs' }).detail).toContain("replica of @maya's trail");
    expect(describe_({ via: 'relay' }).detail).toContain('carried');
  });

  it('says so plainly when the fix came straight from its author', () => {
    const result = describe_({ viaPeer: MAYA });
    expect(result.kind).toBe('author');
    expect(result.headline).toBe("Straight from @maya's phone");
  });

  it('recognises the stash rather than calling it a stranger', () => {
    const result = describe_({ via: 'stash', viaPeer: STASH });
    expect(result.kind).toBe('stash');
    expect(result.headline).toBe('Served by the trail stash');
  });

  /**
   * The swarm belongs to the author, not to us, so most deliverers are people we have never
   * paired with. That is an ordinary case and must never be dressed up as an identity.
   */
  it('shows an unpaired deliverer as a short id and no name', () => {
    const result = describe_({ viaPeer: STRANGER });
    expect(result.kind).toBe('stranger');
    expect(result.headline).toBe("Forwarded by a device you haven't paired with");
    expect(result.peerId).toBe('3f9c1a…');
    expect(result.detail).not.toContain('@owlbear');
  });

  it('never invents a delivery when no peer was recorded', () => {
    const live = describe_({ viaPeer: undefined, via: 'live' });
    expect(live.kind).toBe('unknown');
    expect(live.headline).toBe('Deliverer not recorded');

    // A replica read is not a delivery: nobody handed it over on that pass, and the sentence says
    // that rather than falling back to the friendlier-sounding "straight from her phone".
    const recovered = describe_({ viaPeer: undefined, via: 'sync' });
    expect(recovered.kind).toBe('unknown');
    expect(recovered.detail).toContain('durable replica');
  });

  it('matches endpoints case-insensitively', () => {
    expect(describe_({ viaPeer: OWLBEAR.toUpperCase() }).kind).toBe('friend');
    expect(describe_({ viaPeer: MAYA.toUpperCase() }).kind).toBe('author');
    expect(describe_({ viaPeer: STASH.toUpperCase() }).kind).toBe('stash');
  });

  it('falls back to an unpaired device when the stash id is unknown', () => {
    // No `endpointIdFromTicket` on this binary: uninformative, never wrong.
    expect(describe_({ viaPeer: STASH, stashEndpointId: null }).kind).toBe('stranger');
  });
});

describe('shortEndpoint', () => {
  it('keeps enough to tell two neighbours apart', () => {
    expect(shortEndpoint(STRANGER)).toBe('3f9c1a…');
    expect(shortEndpoint(OWLBEAR)).not.toBe(shortEndpoint(STRANGER));
  });
});
