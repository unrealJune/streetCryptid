import { newTraceId } from './ids';
import { readMeta, writeMeta } from './event-log';
import type { Attributes } from './types';

/**
 * A stable per-install device id, and the build that produced the running bundle.
 *
 * ## Why `service.instance.id` was not enough
 * `service.instance.id` is the short iroh endpoint id, and it is stamped only once keys exist
 * (`configureDevTelemetry`). Every span emitted before that — an early `bg.wake`, a `bg.session`
 * refusal, `runtime.idle_wait`, and now `storage.degraded` — therefore shipped with no device
 * attribution at all, which is precisely the window the hardest background bugs live in. It also
 * changes if the identity is ever regenerated, so it cannot answer "is this the same phone as
 * last week?".
 *
 * `device.id` is ours: minted once, persisted in the journal database, and never derived from a
 * vendor identifier. It is a random 32-hex value truncated to 12 chars — enough to separate a
 * handful of dev phones, deliberately not enough to be an identifier worth having.
 *
 * ## Timing
 * Resolution needs SQLite, so it is async, while `getDeviceResource()` is sync. That is fine:
 * OTLP resource attributes are serialized per *batch*, at flush time, not when a span is created
 * (see `exporter.ts`). So as long as the id lands before the first flush — and `Telemetry.flush()`
 * awaits it — spans created earlier in the same process still carry it.
 */

const DEVICE_ID_KEY = 'device.id';
const DEVICE_ID_LENGTH = 12;

let resolved: string | undefined;
let inflight: Promise<string | undefined> | undefined;

type ConstantsModule = typeof import('expo-constants');
type ApplicationModule = typeof import('expo-application');

function tryRequireConstants(): ConstantsModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- deliberate lazy, guarded load
    return require('expo-constants') as ConstantsModule;
  } catch {
    return null;
  }
}

function tryRequireApplication(): ApplicationModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- deliberate lazy, guarded load
    return require('expo-application') as ApplicationModule;
  } catch {
    return null;
  }
}

/**
 * Build provenance, synchronously. `app.config.ts` already computes `extra.buildProvenance`
 * ({buildId, commit, profile}) for the Settings screen; putting the same values on every span is
 * what makes "which build is this phone actually running?" a filter rather than a phone call —
 * the question that has repeatedly turned out to be the answer.
 */
export function getBuildResource(): Attributes {
  const attrs: Attributes = {};

  const extra = tryRequireConstants()?.default?.expoConfig?.extra;
  const provenance = (extra as { buildProvenance?: Record<string, unknown> } | undefined)
    ?.buildProvenance;
  if (provenance) {
    if (typeof provenance.buildId === 'string') attrs['app.build_id'] = provenance.buildId;
    if (typeof provenance.commit === 'string') attrs['app.commit'] = provenance.commit.slice(0, 12);
    if (typeof provenance.profile === 'string') attrs['app.build_profile'] = provenance.profile;
  }

  const application = tryRequireApplication();
  if (application) {
    if (application.nativeApplicationVersion) {
      attrs['app.native_version'] = application.nativeApplicationVersion;
    }
    if (application.nativeBuildVersion) {
      attrs['app.native_build'] = application.nativeBuildVersion;
    }
  }

  return attrs;
}

/**
 * The device id once resolved, or undefined before that. Synchronous, for callers that cannot
 * await (the `device.health` record reads it after its own await, so it is populated by then).
 */
export function getResolvedDeviceId(): string | undefined {
  return resolved;
}

/**
 * Load the persisted device id, minting and storing one on first run. Idempotent and safe to
 * call concurrently — later callers join the in-flight resolution rather than minting a second id.
 *
 * Resolves to undefined only when storage is unavailable AND minting failed, which in practice
 * means a test environment.
 */
export function resolveDeviceId(): Promise<string | undefined> {
  if (resolved !== undefined) return Promise.resolve(resolved);
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const stored = await readMeta(DEVICE_ID_KEY);
      if (stored) {
        resolved = stored;
        return resolved;
      }
      const minted = newTraceId().slice(0, DEVICE_ID_LENGTH);
      await writeMeta(DEVICE_ID_KEY, minted);
      resolved = minted;
      return resolved;
    } catch {
      return undefined;
    } finally {
      inflight = undefined;
    }
  })();
  return inflight;
}

/** Test seam. */
export function resetIdentityForTesting(): void {
  resolved = undefined;
  inflight = undefined;
}
