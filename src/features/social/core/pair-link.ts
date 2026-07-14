/**
 * Pair-link codec. A bilateral-pairing invite is shared as a `streetcryptid:///social?token=<token>`
 * deep link (QR / tappable link) that wraps an opaque native `scpair1:` invite token. This is
 * deliberately a *separate* scheme+path from the legacy `streetcryptid://contact?…` card: a contact
 * link seeds a one-way friend add, whereas a pair link bootstraps the two-way pairing handshake.
 * The two must never be conflated. See docs/social/ARCHITECTURE.md §4.
 *
 * Only the opaque token crosses the codec — decoding/encoding of the token's internals stays in the
 * native module ({@link IrohLocationApi.encodePairInvite} / `decodePairInvite`).
 */

export const PAIR_SCHEME = 'streetcryptid';
export const PAIR_PATH = 'social';
/** Prefix of the opaque native invite token (`scpair1:<hex>`). */
export const PAIR_TOKEN_PREFIX = 'scpair1:';

const PAIR_LINK_PREFIX = `${PAIR_SCHEME}:///${PAIR_PATH}`;
const LEGACY_SOCIAL_LINK_PREFIX = `${PAIR_SCHEME}://${PAIR_PATH}`;
const LEGACY_PAIR_LINK_PREFIX = `${PAIR_SCHEME}://pair`;
const LEGACY_TRIPLE_PAIR_LINK_PREFIX = `${PAIR_SCHEME}:///pair`;
const ACCEPTED_LINK_PREFIXES = [
  PAIR_LINK_PREFIX,
  LEGACY_SOCIAL_LINK_PREFIX,
  LEGACY_PAIR_LINK_PREFIX,
  LEGACY_TRIPLE_PAIR_LINK_PREFIX,
] as const;

/** True when `s` is a raw opaque native invite token (`scpair1:<…>`). */
export function isPairToken(s: string): boolean {
  return s.startsWith(PAIR_TOKEN_PREFIX) && s.length > PAIR_TOKEN_PREFIX.length;
}

/** True when `s` is a streetCryptid pair link or a raw `scpair1:` token. */
export function isPairLink(s: string): boolean {
  const trimmed = s.trim();
  return (
    isPairToken(trimmed) ||
    ACCEPTED_LINK_PREFIXES.some((prefix) => trimmed.startsWith(`${prefix}?`))
  );
}

/** Encode an opaque token directly onto the existing Friends route so query params survive. */
export function encodePairLink(token: string): string {
  const trimmed = token.trim();
  if (!isPairToken(trimmed)) {
    throw new Error('pair link: expected a scpair1: token');
  }
  return `${PAIR_LINK_PREFIX}?token=${encodeURIComponent(trimmed)}`;
}

function parseQuery(input: string): Map<string, string> {
  const q = input.indexOf('?');
  const query = q === -1 ? '' : input.slice(q + 1);
  const params = new Map<string, string>();
  for (const pair of query.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const rawKey = eq === -1 ? pair : pair.slice(0, eq);
    const rawVal = eq === -1 ? '' : pair.slice(eq + 1);
    params.set(decodeURIComponent(rawKey), decodeURIComponent(rawVal));
  }
  return params;
}

/**
 * Decode a pair link (or a raw `scpair1:` token) back into the opaque native token. Rejects legacy
 * `streetcryptid://contact?…` cards and anything that isn't a pair link, so the two schemes can't be
 * confused.
 */
export function decodePairLink(input: string): string {
  const trimmed = input.trim();
  if (isPairToken(trimmed)) return trimmed;
  if (
    !ACCEPTED_LINK_PREFIXES.some((prefix) => trimmed === prefix || trimmed.startsWith(`${prefix}?`))
  ) {
    throw new Error('pair link: not a streetcryptid pair link');
  }
  const token = parseQuery(trimmed).get('token') ?? '';
  if (!isPairToken(token)) {
    throw new Error('pair link: missing or invalid scpair1: token');
  }
  return token;
}
