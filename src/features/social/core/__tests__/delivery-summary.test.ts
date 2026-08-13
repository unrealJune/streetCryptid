import { buildDeliverySummary, shortEndpointId } from '../delivery-summary';
import type { DeliveryDetail } from '../types';

const PEER = 'aa'.repeat(32);
const STASH = 'bb'.repeat(32);

function live(overrides: Partial<DeliveryDetail> = {}): DeliveryDetail {
  return {
    via: 'direct',
    from: PEER,
    fromStash: false,
    paths: [
      { kind: 'direct', address: '203.0.113.7:4433', active: true },
      { kind: 'relay', address: 'https://relay.example.com', active: true },
      { kind: 'lan', address: '192.168.1.22:4433', active: false },
    ],
    ...overrides,
  };
}

describe('shortEndpointId', () => {
  it('elides the middle of a full endpoint id', () => {
    expect(shortEndpointId(PEER)).toBe('aaaaaaaa…aaaa');
  });

  it('leaves an already-short id alone', () => {
    expect(shortEndpointId('abcd')).toBe('abcd');
  });
});

describe('buildDeliverySummary', () => {
  it('names the delivering peer and the active path', () => {
    const summary = buildDeliverySummary('direct', live());
    expect(summary.badge).toBe('DIRECT');
    expect(summary.rows).toContainEqual({ label: 'HANDED OVER BY', value: 'aaaaaaaa…aaaa' });
    expect(summary.rows).toContainEqual({ label: 'OVER', value: '203.0.113.7:4433' });
  });

  it('uses a friend handle when the delivering peer is one, keeping the id visible', () => {
    const summary = buildDeliverySummary('direct', live(), (id) =>
      id === PEER ? '@mothman' : undefined
    );
    expect(summary.rows).toContainEqual({
      label: 'HANDED OVER BY',
      value: '@mothman · aaaaaaaa…aaaa',
    });
  });

  /** Epidemic gossip routinely forwards through strangers; inventing a name would be a lie. */
  it('shows a bare id for a peer that is not a friend', () => {
    const summary = buildDeliverySummary('relay', live(), () => undefined);
    expect(summary.rows).toContainEqual({ label: 'HANDED OVER BY', value: 'aaaaaaaa…aaaa' });
  });

  it('lists every path, marking which were open', () => {
    const summary = buildDeliverySummary('direct', live());
    expect(summary.paths).toEqual([
      { kind: 'DIRECT', address: '203.0.113.7:4433', active: true },
      { kind: 'RELAY', address: 'https://relay.example.com', active: true },
      { kind: 'LAN', address: '192.168.1.22:4433', active: false },
    ]);
  });

  /** The whole point of the tooltip: the badge says DIRECT, but relay was open too. */
  it('keeps the losing active paths the badge hides', () => {
    const summary = buildDeliverySummary('direct', live());
    const alsoOpen = summary.paths.filter((path) => path.active).map((path) => path.kind);
    expect(alsoOpen).toEqual(['DIRECT', 'RELAY']);
  });

  it('calls out the trail stash by name when it served the fix', () => {
    const summary = buildDeliverySummary('stash', {
      via: 'stash',
      from: STASH,
      fromStash: true,
      paths: [],
    });
    expect(summary.badge).toBe('STASH');
    expect(summary.rows).toContainEqual({
      label: 'SERVED BY',
      value: 'Trail stash · bbbbbbbb…bbbb',
    });
  });

  it('attributes a docs backfill to the serving peer, not the stash', () => {
    const summary = buildDeliverySummary('docs', {
      via: 'docs',
      from: PEER,
      fromStash: false,
      paths: [],
    });
    expect(summary.badge).toBe('TRAIL');
    expect(summary.rows).toContainEqual({ label: 'SERVED BY', value: 'aaaaaaaa…aaaa' });
    expect(summary.paths).toEqual([]);
  });

  it('degrades to a note when the native core reported no detail', () => {
    const summary = buildDeliverySummary('relay', undefined);
    expect(summary.badge).toBe('RELAY');
    expect(summary.rows).toEqual([]);
    expect(summary.paths).toEqual([]);
    expect(summary.note).toMatch(/did not report/);
  });

  it('reports no peer rather than a blank one when iroh could not name it', () => {
    const summary = buildDeliverySummary('live', {
      via: 'live',
      from: '',
      fromStash: false,
      paths: [],
    });
    expect(summary.rows).toContainEqual({ label: 'SERVED BY', value: 'Not reported' });
  });

  /** The tooltip must never read as a traceroute — see the module doc. */
  it('always carries a one-hop caveat', () => {
    expect(buildDeliverySummary('direct', live()).note).toMatch(/not necessarily who recorded it/);
    expect(
      buildDeliverySummary('stash', { via: 'stash', from: STASH, fromStash: true, paths: [] }).note
    ).toMatch(/no gossip neighbour/);
  });

  it('omits the OVER row when nothing was open', () => {
    const summary = buildDeliverySummary('live', {
      via: 'live',
      from: PEER,
      fromStash: false,
      paths: [{ kind: 'relay', address: 'https://relay.example.com', active: false }],
    });
    expect(summary.rows.some((row) => row.label === 'OVER')).toBe(false);
  });
});
