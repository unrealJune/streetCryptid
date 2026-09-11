/**
 * Pair-link codec. A bilateral-pairing invite is shared as an `https://streetcrypt.id/pair#token=…`
 * link that wraps an opaque native `scpair2:` invite token. This is deliberately a *separate*
 * shape from the legacy `streetcryptid://contact?…` card: a contact link seeds a one-way friend
 * add, whereas a pair link bootstraps the two-way pairing handshake. The two must never be
 * conflated. See docs/social/ARCHITECTURE.md §4.
 *
 * **Why https and not the custom scheme.** Messaging apps linkify a fixed set of schemes
 * (`http`, `https`, `mailto`, `tel`…) and nothing else, so a `streetcryptid://` invite arrives as
 * inert text that cannot be tapped — the Android intent filter was never the problem. The https
 * shape is claimed as an Android App Link / iOS Universal Link, verified by the well-known files
 * served from `apps/streetcrypt-id/` in the buttercup infra repo.
 *
 * **Why the fragment and not a query string.** A fragment is never sent to a server. When the
 * recipient has no app installed the request does reach streetcrypt.id, and putting the token
 * after `#` keeps a live invite out of that origin's logs and anything in front of it. The query
 * form is still decoded, because an intermediary that rewrites links can drop a fragment and the
 * legacy custom-scheme links in the wild use it.
 *
 * Decoding is deliberately permissive across every shape ever minted; only the shape we *emit*
 * changes. A recipient on an older build cannot decode an https link at all, which is what the
 * copy-paste code on the /pair fallback page is for.
 *
 * Only the opaque token crosses the codec — decoding/encoding of the token's internals stays in the
 * native module ({@link IrohLocationApi.encodePairInvite} / `decodePairInvite`).
 */

export const PAIR_SCHEME = 'streetcryptid';
export const PAIR_PATH = 'social';
/**
 * Host claimed as an App Link / Universal Link. Must match the `app.json` intent filter and the
 * well-known files served at that host byte-for-byte — apex only, no `www`.
 */
export const PAIR_WEB_HOST = 'streetcrypt.id';
/** Path the claim is scoped to (`pathPrefix` on Android, `components` on iOS). */
export const PAIR_WEB_PATH = 'pair';
/** Prefix of the opaque native invite token (`scpair2:<base64url>`). */
export const PAIR_TOKEN_PREFIX = 'scpair2:';

const PAIR_WEB_PREFIX = `https://${PAIR_WEB_HOST}/${PAIR_WEB_PATH}`;
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

/** True when `s` is a raw opaque native invite token (`scpair2:<…>`). */
export function isPairToken(s: string): boolean {
  return s.startsWith(PAIR_TOKEN_PREFIX) && s.length > PAIR_TOKEN_PREFIX.length;
}

/**
 * True when `s` is the https App Link shape. Exported because `+native-intent` has to recognise it
 * without leaning on `URL`: React Native's shim does not reliably expose `.hash`, and the token
 * lives in the fragment.
 */
export function isWebPairLink(s: string): boolean {
  if (!s.startsWith(PAIR_WEB_PREFIX)) return false;
  // Only a boundary may follow, so `/pairing-guide` is never mistaken for an invite.
  const rest = s.slice(PAIR_WEB_PREFIX.length);
  return rest === '' || rest.startsWith('/') || rest.startsWith('?') || rest.startsWith('#');
}

/** True when `s` is a streetCryptid pair link or a raw `scpair2:` token. */
export function isPairLink(s: string): boolean {
  const trimmed = s.trim();
  return (
    isPairToken(trimmed) ||
    isWebPairLink(trimmed) ||
    ACCEPTED_LINK_PREFIXES.some((prefix) => trimmed.startsWith(`${prefix}?`))
  );
}

/** Encode an opaque token into the shareable https invite link. */
export function encodePairLink(token: string): string {
  const trimmed = token.trim();
  if (!isPairToken(trimmed)) {
    throw new Error('pair link: expected a scpair2: token');
  }
  return `${PAIR_WEB_PREFIX}#token=${encodeURIComponent(trimmed)}`;
}

/**
 * Read `key=value` pairs out of both the query string and the fragment. Query is read first and
 * the fragment only fills what it lacks, so a link carrying both does not change meaning based on
 * which half something along the way rewrote.
 */
function parseParams(input: string): Map<string, string> {
  const hash = input.indexOf('#');
  const beforeHash = hash === -1 ? input : input.slice(0, hash);
  const fragment = hash === -1 ? '' : input.slice(hash + 1);
  const q = beforeHash.indexOf('?');
  const query = q === -1 ? '' : beforeHash.slice(q + 1);
  const params = new Map<string, string>();
  for (const section of [query, fragment]) {
    for (const pair of section.split('&')) {
      if (!pair) continue;
      const eq = pair.indexOf('=');
      const rawKey = eq === -1 ? pair : pair.slice(0, eq);
      const rawVal = eq === -1 ? '' : pair.slice(eq + 1);
      const key = decodeURIComponent(rawKey);
      if (!params.has(key)) params.set(key, decodeURIComponent(rawVal));
    }
  }
  return params;
}

/**
 * Decode a pair link (or a raw `scpair2:` token) back into the opaque native token. Accepts the
 * https App Link shape and every custom-scheme shape ever minted — links sit in message threads
 * and QR codes indefinitely, so nothing here may be retired.
 *
 * Rejects legacy `streetcryptid://contact?…` cards and anything that isn't a pair link, so the two
 * schemes can't be confused.
 */
export function decodePairLink(input: string): string {
  const trimmed = input.trim();
  if (isPairToken(trimmed)) return trimmed;
  if (
    !isWebPairLink(trimmed) &&
    !ACCEPTED_LINK_PREFIXES.some((prefix) => trimmed === prefix || trimmed.startsWith(`${prefix}?`))
  ) {
    throw new Error('pair link: not a streetcryptid pair link');
  }
  const token = parseParams(trimmed).get('token') ?? '';
  if (!isPairToken(token)) {
    throw new Error('pair link: missing or invalid scpair2: token');
  }
  return token;
}
