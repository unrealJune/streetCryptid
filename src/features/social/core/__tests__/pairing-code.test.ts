import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes as nodeRandomBytes,
} from 'crypto';

import { PAIR_TOKEN_PREFIX } from '../pair-link';
import {
  type AesDecryptFn,
  type AesEncryptFn,
  CAPSULE_PREFIX,
  decodeCrockfordBase32,
  encodeCrockfordBase32,
  formatPairingCodeForDisplay,
  isPairingCode,
  mintPairingCode,
  normalizePairingCode,
  openPairCapsule,
  PairingCodeError,
  pairingCodeFromSecret,
  PAIRING_CODE_LENGTH,
  PAIRING_SECRET_BYTES,
  sealPairToken,
  type Sha256Fn,
  secretFromPairingCode,
} from '../pairing-code';

/**
 * Jest can't run Expo's native AES module directly (see the module doc comment on
 * `defaultAesEncrypt`/`defaultAesDecrypt`) — jest-expo's auto-mock only stubs flat function names,
 * not the `AESEncryptionKey`/`AESSealedData` classes those defaults depend on. These fakes swap in
 * Node's `crypto` for the seal/open tests, preserving real AES-256-GCM authenticated-encryption
 * semantics (12-byte random IV, 16-byte tag, AAD-bound) so tamper/wrong-key rejection is genuine.
 */
const nodeSha256: Sha256Fn = async (data) =>
  new Uint8Array(createHash('sha256').update(data).digest());

const nodeAesEncrypt: AesEncryptFn = async (key, plaintext, aad) => {
  const iv = nodeRandomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key), iv);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ciphertext, tag]).toString('base64');
};

const nodeAesDecrypt: AesDecryptFn = async (key, combinedBase64, aad) => {
  const combined = Buffer.from(combinedBase64, 'base64');
  const iv = combined.subarray(0, 12);
  const tag = combined.subarray(combined.length - 16);
  const ciphertext = combined.subarray(12, combined.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key), iv);
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tag);
  return new Uint8Array(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
};

const CRYPTO_OVERRIDES = {
  sha256: nodeSha256,
  aesEncrypt: nodeAesEncrypt,
  aesDecrypt: nodeAesDecrypt,
};

function fixedSecret(fill: number): Uint8Array {
  return new Uint8Array(PAIRING_SECRET_BYTES).fill(fill);
}

describe('Crockford Base32 codec', () => {
  it('round-trips arbitrary byte strings', () => {
    for (const bytes of [fixedSecret(0), fixedSecret(0xff), fixedSecret(0x5a)]) {
      const encoded = encodeCrockfordBase32(bytes);
      expect(decodeCrockfordBase32(encoded)).toEqual(bytes);
    }
  });

  it('encodes an 80-bit secret as exactly 16 characters, no padding', () => {
    const secret = new Uint8Array([0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99]);
    const encoded = encodeCrockfordBase32(secret);
    expect(encoded).toHaveLength(PAIRING_CODE_LENGTH);
    expect(decodeCrockfordBase32(encoded)).toEqual(secret);
  });

  it('rejects a character outside the alphabet', () => {
    expect(() => decodeCrockfordBase32('uuuuuuuuuuuuuuuu')).toThrow(PairingCodeError);
  });
});

describe('normalizePairingCode', () => {
  const secret = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const canonical = encodeCrockfordBase32(secret);

  it('accepts the canonical lowercase code unchanged', () => {
    expect(normalizePairingCode(canonical)).toBe(canonical);
  });

  it('normalizes uppercase, spaces, and hyphens', () => {
    const display = formatPairingCodeForDisplay(canonical);
    expect(display).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(normalizePairingCode(display)).toBe(canonical);
    expect(normalizePairingCode(`  ${display.toLowerCase()}  `)).toBe(canonical);
    expect(normalizePairingCode(display.replace(/-/g, ' '))).toBe(canonical);
  });

  it('remaps common misreads o→0 and i/l→1', () => {
    const target = '0000111122223333';
    const withMisreads = 'oOoOiIlL22223333';
    expect(normalizePairingCode(withMisreads)).toBe(target);
  });

  it('rejects the wrong length', () => {
    expect(() => normalizePairingCode('abcd')).toThrow(PairingCodeError);
    expect(() => normalizePairingCode(`${canonical}ab`)).toThrow(PairingCodeError);
  });

  it('rejects invalid characters (e.g. u, which Crockford excludes)', () => {
    expect(() => normalizePairingCode('uuuuuuuuuuuuuuuu')).toThrow(PairingCodeError);
  });

  it('isPairingCode is a non-throwing predicate', () => {
    expect(isPairingCode(canonical)).toBe(true);
    expect(isPairingCode('not a code')).toBe(false);
    expect(isPairingCode(`${PAIR_TOKEN_PREFIX}deadbeef`)).toBe(false);
  });
});

describe('mintPairingCode / secretFromPairingCode', () => {
  it('mints a code whose secret round-trips through the display form', async () => {
    const randomBytes = async (n: number): Promise<Uint8Array> => {
      expect(n).toBe(PAIRING_SECRET_BYTES);
      return fixedSecret(0x2a);
    };
    const minted = await mintPairingCode(randomBytes);
    expect(minted.code).toHaveLength(PAIRING_CODE_LENGTH);
    expect(minted.display).toBe(formatPairingCodeForDisplay(minted.code));
    expect(secretFromPairingCode(minted.display)).toEqual(minted.secret);
  });

  it('pairingCodeFromSecret rejects a wrong-length secret', () => {
    expect(() => pairingCodeFromSecret(new Uint8Array(4))).toThrow(PairingCodeError);
  });
});

describe('sealPairToken / openPairCapsule (deterministic, Node-crypto AES)', () => {
  const secret = fixedSecret(7);
  const token = `${PAIR_TOKEN_PREFIX}cafef00dfeedface`;

  it('round-trips a token through seal + open', async () => {
    const capsule = await sealPairToken(token, secret, CRYPTO_OVERRIDES);
    expect(capsule.startsWith(CAPSULE_PREFIX)).toBe(true);
    const opened = await openPairCapsule(capsule, secret, CRYPTO_OVERRIDES);
    expect(opened).toBe(token);
  });

  it('rejects sealing a non scpair1: token', async () => {
    await expect(sealPairToken('not-a-token', secret, CRYPTO_OVERRIDES)).rejects.toThrow(
      PairingCodeError
    );
  });

  it('rejects opening with the wrong secret (wrong code)', async () => {
    const capsule = await sealPairToken(token, secret, CRYPTO_OVERRIDES);
    const wrongSecret = fixedSecret(8);
    await expect(openPairCapsule(capsule, wrongSecret, CRYPTO_OVERRIDES)).rejects.toThrow(
      PairingCodeError
    );
  });

  it('rejects a tampered capsule (flipped ciphertext byte fails GCM auth)', async () => {
    const capsule = await sealPairToken(token, secret, CRYPTO_OVERRIDES);
    const combinedBase64 = capsule.slice(CAPSULE_PREFIX.length);
    const combined = Buffer.from(combinedBase64, 'base64');
    // Flip a byte squarely inside the ciphertext region (after the 12-byte IV).
    combined[12] ^= 0xff;
    const tampered = `${CAPSULE_PREFIX}${combined.toString('base64')}`;
    await expect(openPairCapsule(tampered, secret, CRYPTO_OVERRIDES)).rejects.toThrow(
      PairingCodeError
    );
  });

  it('rejects a capsule missing the version prefix', async () => {
    await expect(openPairCapsule('nope:abcd', secret, CRYPTO_OVERRIDES)).rejects.toThrow(
      PairingCodeError
    );
  });

  it('rejects a decrypted payload that is not an scpair1: token', async () => {
    const combinedBase64 = await nodeAesEncrypt(
      await deriveKeyForTest(secret),
      new TextEncoder().encode('not-an-invite-token'),
      new TextEncoder().encode('streetcryptid/pair-mailbox/capsule/v1')
    );
    const capsule = `${CAPSULE_PREFIX}${combinedBase64}`;
    await expect(openPairCapsule(capsule, secret, CRYPTO_OVERRIDES)).rejects.toThrow(
      PairingCodeError
    );
  });
});

/** Re-derive the mailbox key the same way `deriveMailboxKey` does, for a targeted test fixture. */
async function deriveKeyForTest(secret: Uint8Array): Promise<Uint8Array> {
  const context = new TextEncoder().encode('streetcryptid/pair-mailbox/key/v1');
  const combined = new Uint8Array(context.byteLength + secret.byteLength);
  combined.set(context, 0);
  combined.set(secret, context.byteLength);
  return nodeSha256(combined);
}
