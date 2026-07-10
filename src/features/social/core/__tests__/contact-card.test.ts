import { decodeContactCard, encodeContactCard } from '../contact-card';
import type { ContactCard } from '../types';

const card: ContactCard = {
  endpointId: 'a1b2c3d4',
  handle: '@june phil', // note the space -> must survive url-encoding
  sigil: '  \\.  ./ \n   (oo)  \n  /_||_\\  ',
  cryptidName: 'Mothman',
  color: '#2F9E6A',
  recvPublic: 'deadbeef',
  ticket: 'endpointaaaabbbbcccc',
};

describe('contact-card codec', () => {
  it('round-trips a card through the deep link', () => {
    const link = encodeContactCard(card);
    expect(link.startsWith('streetcryptid://contact?')).toBe(true);
    expect(decodeContactCard(link)).toEqual(card);
  });

  it('url-encodes values with special characters', () => {
    const link = encodeContactCard(card);
    expect(link).not.toContain('@june phil'); // the raw space must not appear
    expect(decodeContactCard(link).handle).toBe('@june phil');
    expect(decodeContactCard(link).sigil).toBe(card.sigil);
  });

  it('keeps older cards without form metadata valid', () => {
    const decoded = decodeContactCard(
      'streetcryptid://contact?e=ab&h=%40old&s=owl&r=cd&t=endpoint-ticket'
    );
    expect(decoded).toEqual({
      endpointId: 'ab',
      handle: '@old',
      sigil: 'owl',
      recvPublic: 'cd',
      ticket: 'endpoint-ticket',
    });
  });

  it('rejects a card with a non-hex endpointId', () => {
    const bad = encodeContactCard({ ...card, endpointId: 'nothex!' });
    expect(() => decodeContactCard(bad)).toThrow(/endpointId/);
  });

  it('rejects a card missing the ticket', () => {
    expect(() => decodeContactCard('streetcryptid://contact?e=ab&h=x&r=cd')).toThrow(/ticket/);
  });

  it('rejects a card with an invalid recvPublic', () => {
    const bad = encodeContactCard({ ...card, recvPublic: 'zz' });
    expect(() => decodeContactCard(bad)).toThrow(/recvPublic/);
  });

  it('rejects an invalid signal color', () => {
    const bad = encodeContactCard({ ...card, color: 'green' });
    expect(() => decodeContactCard(bad)).toThrow(/color/);
  });
});
