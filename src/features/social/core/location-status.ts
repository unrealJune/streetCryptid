import type { BackgroundAccess } from '../net/location-sharing';

/** What the map is told about the location runtime. */
export type LocationRuntimeStatus =
  'starting' | 'running' | 'permission-denied' | 'unavailable' | 'error';

export interface LocationStatusInput {
  /** What `startBackground` reported, once, at launch. */
  readonly reported: LocationRuntimeStatus;
  /** What the service last re-read from the OS — refreshed on every foreground. */
  readonly backgroundAccess: BackgroundAccess | undefined;
}

/**
 * Reconcile the status latched at launch with the OS's current answer.
 *
 * `startBackground` runs ONCE per app session and writes `reported` once. Authorization moves in
 * both directions without us, and each direction has cost a day:
 *
 * * **Granted late.** iOS resolves `requestBackgroundPermissionsAsync` before its authorization
 *   delegate has settled. On 2026-08-30 a fresh install read denied at 17:44:13 and
 *   `authorizedAlways` two seconds later, then spent the evening showing "allow background
 *   location" while holding full permission.
 * * **Taken away later.** iOS re-prompts days after the grant with a map of everywhere the app has
 *   tracked someone, and plenty of people downgrade to "While Using"; a REINSTALL — much the more
 *   common event in a TestFlight group — resets it outright with no callback at all. On 2026-09-17
 *   an iPhone reinstalled, paired at a bar, published exactly one fix (the pairing introduction,
 *   sent while the app was open) and went dark for the night, reporting `sharing.enabled=true`
 *   beside `perm.background=denied` the whole time. Only the first direction was implemented, so
 *   nothing moved the status off `running` and nothing was shown.
 *
 * The service re-reads the OS on every foreground, so `backgroundAccess` is the live value and
 * `reported` is the stale one. Where they disagree the live one wins — in both directions.
 *
 * `unknown` is not an answer and never overrides anything: it means the read has not happened yet
 * (or the build predates the native probe), and treating "we have not asked" as "denied" would put
 * a warning in front of every user for the first seconds of every launch.
 */
export function resolveLocationStatus({
  reported,
  backgroundAccess,
}: LocationStatusInput): LocationRuntimeStatus {
  if (reported === 'permission-denied' && backgroundAccess === 'full') return 'running';
  if (reported === 'running' && backgroundAccess === 'foreground') return 'permission-denied';
  return reported;
}
