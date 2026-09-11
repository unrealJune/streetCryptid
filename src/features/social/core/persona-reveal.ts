import type { Friend } from './types';

/**
 * The persona reveal: turning "we have a key" into "we have a person".
 *
 * A completed pair hands the UI a placeholder friend — `@<first 8 of the endpoint id>` with no
 * sigil — because the peer's profile replicates over a separate namespace and arrives a moment
 * (sometimes several) later. Rendering both states the same way makes the real handle look like
 * a glitch: an id appears, then is silently swapped for a name.
 *
 * So the wait is drawn as what it actually is. The id IS the ciphertext — it is the only thing
 * about this person we can see before their profile decrypts — and it churns until the profile
 * lands, then settles into the handle a character at a time. Nothing here fakes progress: the
 * churn says "still working", the settle says "it arrived", and {@link PERSONA_PATIENCE_MS} says
 * when to stop pretending either.
 */

/** Hex, because the thing being churned is an endpoint id and an endpoint id is hex. */
export const CIPHER_GLYPHS = '0123456789abcdef';

/**
 * How long the churn runs before it gives up and shows the short id plainly.
 *
 * Not the same as giving up on the profile — `backfillMissingProfiles` keeps retrying for minutes
 * — only on the animation. A scramble still going after this long has stopped reading as "working"
 * and started reading as broken.
 */
export const PERSONA_PATIENCE_MS = 12_000;

/** How long the settle takes per character once the profile lands. */
export const PERSONA_SETTLE_PER_CHAR_MS = 42;

/** Where the persona reveal stands. */
export type PersonaRevealPhase = 'decrypting' | 'settling' | 'resolved' | 'unavailable';

/** True once a verified profile has been merged. `profileEpoch` is set by nothing else. */
export function hasVerifiedProfile(friend: Pick<Friend, 'profileEpoch'>): boolean {
  return friend.profileEpoch !== undefined;
}

/**
 * A deterministic glyph for one position on one frame.
 *
 * Deterministic rather than random so a frame can be asserted in a test, and so two characters
 * never churn in lockstep — the multiply is what decorrelates neighbouring positions, which is the
 * difference between ciphertext and a row of identical spinning digits.
 */
export function cipherGlyph(index: number, frame: number): string {
  const mixed = Math.imul(index + 1, 2654435761) ^ Math.imul(frame + 1, 40503);
  return CIPHER_GLYPHS[Math.abs(mixed) % CIPHER_GLYPHS.length];
}

/**
 * One frame of the reveal: the first `settled` characters of `plain`, the rest churning.
 *
 * Whitespace is never churned, so the text keeps its shape while it resolves rather than turning
 * into one unbroken block that then springs apart. The leading `@` of a handle is held for the
 * same reason — it is punctuation, not payload.
 */
export function scrambleFrame(plain: string, settled: number, frame: number): string {
  let out = '';
  for (let index = 0; index < plain.length; index += 1) {
    const char = plain[index];
    if (index < settled || char === ' ' || char === '@' || char === '\n') {
      out += char;
      continue;
    }
    out += cipherGlyph(index, frame);
  }
  return out;
}

/** How many leading characters have settled at `progress` (0…1) through the settle. */
export function settledCount(plain: string, progress: number): number {
  return Math.round(Math.max(0, Math.min(1, progress)) * plain.length);
}

/** How long the settle runs for a handle of this length. */
export function settleDurationMs(plain: string): number {
  return Math.max(PERSONA_SETTLE_PER_CHAR_MS * 4, plain.length * PERSONA_SETTLE_PER_CHAR_MS);
}
