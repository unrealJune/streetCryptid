import {
  decodePairLink,
  encodePairLink,
  isPairLink,
  isPairToken,
  isWebPairLink,
  PAIR_TOKEN_PREFIX,
} from '../pair-link';

const TOKEN = `${PAIR_TOKEN_PREFIX}deadbeefcafe`;

describe('pair-link codec', () => {
  it('encodes a token into the shareable https App Link', () => {
    const link = encodePairLink(TOKEN);
    // The https shape is the whole point: a messaging app will not linkify a custom
    // scheme, so the old `streetcryptid://` invite arrived as untappable text.
    expect(link.startsWith('https://streetcrypt.id/pair#token=')).toBe(true);
    expect(decodePairLink(link)).toBe(TOKEN);
  });

  it('keeps the token in the fragment, where it is never sent to a server', () => {
    expect(encodePairLink(TOKEN)).not.toContain('?');
  });

  it('decodes the https link whether the token rides in the fragment or the query', () => {
    const encoded = encodeURIComponent(TOKEN);
    // A link-rewriting intermediary can drop a fragment; the query form is the way back.
    expect(decodePairLink(`https://streetcrypt.id/pair?token=${encoded}`)).toBe(TOKEN);
    expect(decodePairLink(`https://streetcrypt.id/pair/#token=${encoded}`)).toBe(TOKEN);
  });

  it('does not claim a host or path it was not verified for', () => {
    const encoded = encodeURIComponent(TOKEN);
    // The intent filter matches streetcrypt.id/pair exactly, so the codec must not be
    // looser than the manifest — anything else has to fall through to the browser.
    expect(isWebPairLink(`https://streetcrypt.id/pairing-guide#token=${encoded}`)).toBe(false);
    expect(isWebPairLink(`https://www.streetcrypt.id/pair#token=${encoded}`)).toBe(false);
    expect(isWebPairLink(`http://streetcrypt.id/pair#token=${encoded}`)).toBe(false);
    expect(isWebPairLink(`https://streetcrypt.id/pair#token=${encoded}`)).toBe(true);
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
    expect(encodePairLink(token)).toBe('https://streetcrypt.id/pair#token=scpair2%3AAb9-_xyZ');
  });

  it('rejects the shipped-but-unsupported scpair1: prefix', () => {
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
    expect(() => decodePairLink('https://streetcrypt.id/pair')).toThrow(/token/);
    expect(() => decodePairLink('https://streetcrypt.id/pair#token=nope')).toThrow(/token/);
  });

  it('rejects unrelated input', () => {
    expect(() => decodePairLink('https://example.com')).toThrow(/pair link/);
  });
});
