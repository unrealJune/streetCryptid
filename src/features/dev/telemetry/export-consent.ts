import { readMeta, writeMeta } from './event-log';

/**
 * Whether this phone may SEND telemetry — the user's switch in Settings → App & Data.
 *
 * On by default, because the people running these builds have agreed to it; the switch exists so
 * that agreement can be withdrawn without reinstalling. It is a third gate below the two build-time
 * ones (`EXPO_PUBLIC_DEV_TELEMETRY`, `EXPO_PUBLIC_OTEL_ENDPOINT`) and only ever narrows them: a
 * stripped build has no switch to turn on.
 *
 * Off stops every path off the phone: the JS shipper discards instead of sending (so turning it
 * back on never uploads what was recorded while it was off), and `location-sharing.ts` points the
 * Rust exporter at `""`, which the native configurators persist so a JS-free background wake stays
 * quiet too. The local journal keeps recording, because the Debug screen's event log reads it and
 * nothing in it leaves the phone.
 *
 * Stored in the journal's own `meta` table rather than with the display preferences: every JS
 * context (a headless wake included) must read the same answer before its first drain, and this
 * module may not depend on `net/persistence.ts` (see {@link readMeta}).
 */
const META_KEY = 'export_enabled';

let known: boolean | undefined;
const listeners = new Set<(enabled: boolean) => void>();

/** The stored choice; `true` when never set or when SQLite is unavailable. */
export async function isTelemetryExportEnabled(): Promise<boolean> {
  if (known !== undefined) return known;
  const stored = await readMeta(META_KEY);
  // A setter that landed while the read was in flight wins over what the read saw.
  known ??= stored !== '0';
  return known;
}

export async function setTelemetryExportEnabled(enabled: boolean): Promise<void> {
  known = enabled;
  await writeMeta(META_KEY, enabled ? '1' : '0');
  listeners.forEach((listener) => listener(enabled));
}

export function subscribeTelemetryExport(listener: (enabled: boolean) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function resetTelemetryExportForTesting(): void {
  known = undefined;
  listeners.clear();
}
