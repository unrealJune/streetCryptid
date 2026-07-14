/**
 * W3C trace/span id generation. Uses `expo-crypto`'s synchronous CSPRNG when the native module is
 * present, falling back to `Math.random` — these ids only correlate developer telemetry, they carry
 * no security weight, so a weak fallback beats throwing inside a headless background task.
 */

let getRandomBytes: ((count: number) => Uint8Array) | null | undefined;

function randomBytes(count: number): Uint8Array {
  if (getRandomBytes === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy: keep import side-effect free
      const crypto = require('expo-crypto') as typeof import('expo-crypto');
      getRandomBytes = crypto.getRandomBytes;
    } catch {
      getRandomBytes = null;
    }
  }
  if (getRandomBytes) return getRandomBytes(count);
  const bytes = new Uint8Array(count);
  for (let i = 0; i < count; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return bytes;
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/** 16-byte lowercase hex trace id (never all-zero, per the W3C spec). */
export function newTraceId(): string {
  const id = toHex(randomBytes(16));
  return id === '0'.repeat(32) ? newTraceId() : id;
}

/** 8-byte lowercase hex span id (never all-zero). */
export function newSpanId(): string {
  const id = toHex(randomBytes(8));
  return id === '0'.repeat(16) ? newSpanId() : id;
}
