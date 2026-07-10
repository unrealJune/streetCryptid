import {
  AESEncryptionKey,
  AESSealedData,
  aesDecryptAsync,
  aesEncryptAsync,
  CryptoDigestAlgorithm,
  digest,
  getRandomBytesAsync,
} from 'expo-crypto';

import { bytesToHex } from './hex';
import { PAIR_TOKEN_PREFIX } from './pair-link';

/**
 * Short human pairing codes for the encrypted mailbox handoff. A code is an 80-bit random
 * secret encoded as 16 Crockford-Base32 characters, displayed `XXXX-XXXX-XXXX-XXXX`. The
 * secret alone (never sent anywhere) deterministically derives:
 *  - a **lookup id** — the mailbox address, a random-looking 32-hex-char string that carries no
 *    identity or key material by construction; and
 *  - an **AES-256 key** used to seal/open the opaque `scpair1:` invite token entirely on-device.
 *
 * The mailbox server only ever sees the lookup id and the sealed capsule bytes — never the code,
 * the secret, the key, or the plaintext token. This module owns that seal/open + code codec; the
 * mailbox transport itself lives in `net/pairing-mailbox.ts`.
 */

/** 80-bit secret → exactly 16 Crockford-Base32 characters (80 / 5), no padding. */
export const PAIRING_SECRET_BYTES = 10;
/** Length of a normalized (unformatted) pairing code. */
export const PAIRING_CODE_LENGTH = 16;
/** Version prefix for a sealed mailbox capsule: `<prefix><base64 iv‖ciphertext‖tag>`. */
export const CAPSULE_PREFIX = 'scmail1:';

/** Hard bound on the plaintext `scpair1:` token we'll ever seal (real invites are far smaller). */
export const MAX_TOKEN_BYTES = 4096;
/** Hard bound on a capsule string's length — comfortably under the mailbox's 16 KiB limit. */
export const MAX_CAPSULE_BYTES = 8192;

export class PairingCodeError extends Error {}

// Crockford Base32: excludes I, L, O, U to avoid visual/verbal ambiguity. Callers normalize
// common misreads (o→0, i/l→1) before validating against this alphabet.
const CROCKFORD_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const CROCKFORD_LOOKUP = new Map<string, number>();
for (let i = 0; i < CROCKFORD_ALPHABET.length; i++) CROCKFORD_LOOKUP.set(CROCKFORD_ALPHABET[i], i);

const LOOKUP_CONTEXT = utf8Bytes('streetcryptid/pair-mailbox/lookup/v1');
const KEY_CONTEXT = utf8Bytes('streetcryptid/pair-mailbox/key/v1');
const CAPSULE_AAD = utf8Bytes('streetcryptid/pair-mailbox/capsule/v1');

function utf8Bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function utf8Decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

// ── Crockford Base32 codec (pure, no padding for our fixed 80-bit secret) ─────────────────────

/** Encode `bytes` as lowercase Crockford Base32 (no padding). */
export function encodeCrockfordBase32(bytes: Uint8Array): string {
  let value = 0;
  let bits = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += CROCKFORD_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return out;
}

/**
 * Decode a lowercase Crockford Base32 string (already validated against the alphabet) back into
 * bytes. Rejects a final partial group whose padding bits aren't zero — that can only happen from
 * a corrupted/mistyped code, never from one we minted ourselves.
 */
export function decodeCrockfordBase32(code: string): Uint8Array {
  let value = 0;
  let bits = 0;
  const out: number[] = [];
  for (const ch of code) {
    const v = CROCKFORD_LOOKUP.get(ch);
    if (v === undefined) {
      throw new PairingCodeError(`pairing code: invalid character '${ch}'`);
    }
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  if (bits > 0 && (value & ((1 << bits) - 1)) !== 0) {
    throw new PairingCodeError('pairing code: invalid trailing bits');
  }
  return new Uint8Array(out);
}

// ── Human code normalization / display ────────────────────────────────────────────────────────

/**
 * Normalize a pasted/typed pairing code: lowercases, strips whitespace/hyphens, remaps the common
 * misreads `o→0` and `i`/`l→1`, then validates the length and remaining alphabet. Throws
 * {@link PairingCodeError} for anything that isn't exactly {@link PAIRING_CODE_LENGTH} valid
 * Crockford characters afterwards.
 */
export function normalizePairingCode(input: string): string {
  const stripped = input
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '');
  const remapped = stripped.replace(/[oil]/g, (ch) => (ch === 'o' ? '0' : '1'));
  if (remapped.length !== PAIRING_CODE_LENGTH) {
    throw new PairingCodeError(
      `pairing code: expected ${PAIRING_CODE_LENGTH} characters, got ${remapped.length}`
    );
  }
  for (const ch of remapped) {
    if (!CROCKFORD_LOOKUP.has(ch)) {
      throw new PairingCodeError(`pairing code: invalid character '${ch}'`);
    }
  }
  return remapped;
}

/** True when `input` normalizes to a well-formed pairing code (without throwing). */
export function isPairingCode(input: string): boolean {
  try {
    normalizePairingCode(input);
    return true;
  } catch {
    return false;
  }
}

/** Format a normalized code for display/sharing as `XXXX-XXXX-XXXX-XXXX` (uppercase). */
export function formatPairingCodeForDisplay(code: string): string {
  const normalized = normalizePairingCode(code);
  const groups: string[] = [];
  for (let i = 0; i < normalized.length; i += 4) groups.push(normalized.slice(i, i + 4));
  return groups.join('-').toUpperCase();
}

// ── Minting a code from a fresh 80-bit secret ─────────────────────────────────────────────────

/** A minted pairing code and the secret it encodes. */
export interface PairingCode {
  /** Normalized lowercase 16-char code — the canonical form used to re-derive everything. */
  code: string;
  /** `XXXX-XXXX-XXXX-XXXX`, for showing/sharing. */
  display: string;
  /** The raw 80-bit secret backing the code. */
  secret: Uint8Array;
}

/** Injectable random-byte source, defaulting to Expo Crypto in production; deterministic in tests. */
export type RandomBytesFn = (byteCount: number) => Promise<Uint8Array>;

async function defaultRandomBytes(byteCount: number): Promise<Uint8Array> {
  return getRandomBytesAsync(byteCount);
}

/** Build a {@link PairingCode} from an already-generated secret (pure; used by mint + tests). */
export function pairingCodeFromSecret(secret: Uint8Array): PairingCode {
  if (secret.byteLength !== PAIRING_SECRET_BYTES) {
    throw new PairingCodeError(
      `pairing code: expected a ${PAIRING_SECRET_BYTES}-byte secret, got ${secret.byteLength}`
    );
  }
  const code = encodeCrockfordBase32(secret);
  return { code, display: formatPairingCodeForDisplay(code), secret };
}

/** Mint a fresh pairing code from `PAIRING_SECRET_BYTES` of randomness. */
export async function mintPairingCode(
  randomBytes: RandomBytesFn = defaultRandomBytes
): Promise<PairingCode> {
  const secret = await randomBytes(PAIRING_SECRET_BYTES);
  return pairingCodeFromSecret(secret);
}

/** Recover the 80-bit secret from a pasted/typed code, normalizing first. */
export function secretFromPairingCode(input: string): Uint8Array {
  const normalized = normalizePairingCode(input);
  const secret = decodeCrockfordBase32(normalized);
  if (secret.byteLength !== PAIRING_SECRET_BYTES) {
    throw new PairingCodeError('pairing code: decoded secret has an unexpected length');
  }
  return secret;
}

// ── Derivation (SHA-256 via Expo Crypto) ──────────────────────────────────────────────────────

/** Injectable SHA-256, defaulting to Expo Crypto; tests can substitute a Node `crypto` shim. */
export type Sha256Fn = (data: Uint8Array) => Promise<Uint8Array>;

async function defaultSha256(data: Uint8Array): Promise<Uint8Array> {
  // `digest` expects a `BufferSource` typed against a plain `ArrayBuffer`; `data` may be backed by
  // an `ArrayBufferLike` (e.g. under @types/node), so it's re-wrapped to satisfy the stricter type
  // without copying semantics changing at runtime (Expo reads the view's bytes either way).
  const buffer = await digest(CryptoDigestAlgorithm.SHA256, data as BufferSource);
  return new Uint8Array(buffer);
}

/** Derive the mailbox lookup id: first 16 bytes (32 hex chars) of SHA256(context‖secret). */
export async function deriveLookupId(
  secret: Uint8Array,
  sha256: Sha256Fn = defaultSha256
): Promise<string> {
  const digestBytes = await sha256(concatBytes(LOOKUP_CONTEXT, secret));
  return bytesToHex(digestBytes.slice(0, 16));
}

/** Derive the AES-256 capsule key: SHA256(context‖secret). */
export async function deriveMailboxKey(
  secret: Uint8Array,
  sha256: Sha256Fn = defaultSha256
): Promise<Uint8Array> {
  return sha256(concatBytes(KEY_CONTEXT, secret));
}

// ── AES-GCM seal / open ────────────────────────────────────────────────────────────────────────

/** Injectable AES-GCM seal, returning base64 `iv‖ciphertext‖tag`. Defaults to Expo Crypto AES. */
export type AesEncryptFn = (
  key: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array
) => Promise<string>;
/** Injectable AES-GCM open, given base64 `iv‖ciphertext‖tag`. Defaults to Expo Crypto AES. */
export type AesDecryptFn = (
  key: Uint8Array,
  combinedBase64: string,
  aad: Uint8Array
) => Promise<Uint8Array>;

async function defaultAesEncrypt(
  key: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array
): Promise<string> {
  const cryptoKey = await AESEncryptionKey.import(key);
  const sealed = await aesEncryptAsync(plaintext, cryptoKey, { additionalData: aad });
  return sealed.combined('base64');
}

async function defaultAesDecrypt(
  key: Uint8Array,
  combinedBase64: string,
  aad: Uint8Array
): Promise<Uint8Array> {
  const cryptoKey = await AESEncryptionKey.import(key);
  const sealed = AESSealedData.fromCombined(combinedBase64);
  const plaintext = await aesDecryptAsync(sealed, cryptoKey, { additionalData: aad });
  return plaintext as Uint8Array;
}

export interface SealCryptoOverrides {
  sha256?: Sha256Fn;
  aesEncrypt?: AesEncryptFn;
}

export interface OpenCryptoOverrides {
  sha256?: Sha256Fn;
  aesDecrypt?: AesDecryptFn;
}

/**
 * Seal an opaque `scpair1:` token for the mailbox: derives the AES-256 key from `secret` and
 * encrypts under a fixed AAD context, returning `scmail1:<base64 iv‖ciphertext‖tag>`.
 */
export async function sealPairToken(
  token: string,
  secret: Uint8Array,
  overrides: SealCryptoOverrides = {}
): Promise<string> {
  if (!token.startsWith(PAIR_TOKEN_PREFIX)) {
    throw new PairingCodeError('pairing capsule: expected an scpair1: token');
  }
  const tokenBytes = utf8Bytes(token);
  if (tokenBytes.byteLength > MAX_TOKEN_BYTES) {
    throw new PairingCodeError('pairing capsule: token exceeds the size limit');
  }
  const key = await deriveMailboxKey(secret, overrides.sha256);
  const aesEncrypt = overrides.aesEncrypt ?? defaultAesEncrypt;
  const combinedBase64 = await aesEncrypt(key, tokenBytes, CAPSULE_AAD);
  const capsule = `${CAPSULE_PREFIX}${combinedBase64}`;
  if (capsule.length > MAX_CAPSULE_BYTES) {
    throw new PairingCodeError('pairing capsule: sealed capsule exceeds the size limit');
  }
  return capsule;
}

/**
 * Open a mailbox capsule back into the opaque `scpair1:` token: validates the `scmail1:` prefix,
 * derives the AES-256 key from `secret`, decrypts, and validates the resulting token prefix.
 * Throws {@link PairingCodeError} for a bad prefix, oversized payload, or failed
 * decryption/authentication (wrong code or a tampered capsule) — never falls back silently.
 */
export async function openPairCapsule(
  capsule: string,
  secret: Uint8Array,
  overrides: OpenCryptoOverrides = {}
): Promise<string> {
  if (!capsule.startsWith(CAPSULE_PREFIX)) {
    throw new PairingCodeError('pairing capsule: missing scmail1: prefix');
  }
  if (capsule.length > MAX_CAPSULE_BYTES) {
    throw new PairingCodeError('pairing capsule: capsule exceeds the size limit');
  }
  const combinedBase64 = capsule.slice(CAPSULE_PREFIX.length);
  if (!combinedBase64) {
    throw new PairingCodeError('pairing capsule: empty capsule payload');
  }
  const key = await deriveMailboxKey(secret, overrides.sha256);
  const aesDecrypt = overrides.aesDecrypt ?? defaultAesDecrypt;
  let plaintext: Uint8Array;
  try {
    plaintext = await aesDecrypt(key, combinedBase64, CAPSULE_AAD);
  } catch {
    throw new PairingCodeError(
      'pairing capsule: decryption failed — wrong code or a tampered capsule'
    );
  }
  const token = utf8Decode(plaintext);
  if (!token.startsWith(PAIR_TOKEN_PREFIX)) {
    throw new PairingCodeError('pairing capsule: decrypted payload is not a valid scpair1: token');
  }
  return token;
}
