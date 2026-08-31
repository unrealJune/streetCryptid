import {
  decodePairLink,
  encodePairLink,
  isPairLink,
  isPairToken,
  PAIR_TOKEN_PREFIX,
} from '../pair-link';

const TOKEN = `${PAIR_TOKEN_PREFIX}deadbeefcafe`;

describe('pair-link codec', () => {
  it('encodes a token directly onto the Friends route', () => {
    const link = encodePairLink(TOKEN);
    expect(link.startsWith('streetcryptid:///social?token=')).toBe(true);
    expect(decodePairLink(link)).toBe(TOKEN);
  });

  it('continues decoding legacy double-slash social links', () => {
    expect(decodePairLink(`streetcryptid://social?token=${encodeURIComponent(TOKEN)}`)).toBe(TOKEN);
  });

  it('continues decoding legacy /pair links', () => {
    expect(decodePairLink(`streetcryptid://pair?token=${encodeURIComponent(TOKEN)}`)).toBe(TOKEN);
  });

  it('round-trips a token with url-unsafe characters', () => {
    // Real v2 payloads are base64url and never contain these, but the codec must not depend on
    // that: the raw special characters have to be percent-encoded on the wire either way.
    const token = `${PAIR_TOKEN_PREFIX}ab+cd/ef=gh`;
    const link = encodePairLink(token);
    expect(link).not.toContain('+cd/ef=gh');
    expect(decodePairLink(link)).toBe(token);
  });

  it('leaves a base64url payload untouched apart from the prefix colon', () => {
    const token = `${PAIR_TOKEN_PREFIX}Ab9-_xyZ`;
    expect(encodePairLink(token)).toBe('streetcryptid:///social?token=scpair2%3AAb9-_xyZ');
  });

  it('rejects the never-shipped scpair1: prefix', () => {
    const legacy = 'scpair1:deadbeefcafe';
    expect(isPairToken(legacy)).toBe(false);
    expect(isPairLink(legacy)).toBe(false);
    expect(() => decodePairLink(legacy)).toThrow(/pair link/);
  });

  it('accepts a raw scpair2: token directly', () => {
    expect(decodePairLink(TOKEN)).toBe(TOKEN);
    expect(decodePairLink(`  ${TOKEN}  `)).toBe(TOKEN);
  });

  it('recognizes pair links and tokens', () => {
    expect(isPairToken(TOKEN)).toBe(true);
    expect(isPairToken('scpair2:')).toBe(false); // prefix only, no payload
    expect(isPairLink(TOKEN)).toBe(true);
    expect(isPairLink(encodePairLink(TOKEN))).toBe(true);
  });

  it('does not conflate a legacy contact link with a pair link', () => {
    const contact = 'streetcryptid://contact?e=ab&h=%40old&s=owl&r=cd&t=endpoint-ticket';
    expect(isPairLink(contact)).toBe(false);
    expect(() => decodePairLink(contact)).toThrow(/pair link/);
  });

  it('rejects encoding a non-token', () => {
    expect(() => encodePairLink('not-a-token')).toThrow(/scpair2/);
  });

  it('rejects a pair link without a valid token', () => {
    expect(() => decodePairLink('streetcryptid://pair?token=nope')).toThrow(/token/);
    expect(() => decodePairLink('streetcryptid://pair')).toThrow(/token/);
  });

  it('rejects unrelated input', () => {
    expect(() => decodePairLink('https://example.com')).toThrow(/pair link/);
  });
});
