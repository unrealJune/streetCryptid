#!/usr/bin/env node
/**
 * Guards what developer telemetry a store-bound EAS profile ships.
 *
 * ## Why this exists
 * `eas.json`'s `production` profile is what `release.yml` builds and what `submit.production`
 * uploads. Telemetry being switched on there is a decision with real consequences — traces leave
 * real users' devices for a developer-controlled collector — and it had previously happened by
 * default, with every code comment and README still claiming the opposite. A comment cannot keep
 * that in sync; this can.
 *
 * ## It does not forbid, it requires an ANSWER
 * Shipping telemetry from a store profile is allowed, but only as an explicit, dated entry in
 * {@link ACKNOWLEDGED} that says why and what would end it. Deleting that entry re-arms the check
 * immediately. So the invariant is not "production is always clean" — it is "nobody enables this
 * without noticing", which is the property that was actually missing.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Profiles that can reach a public app store. Everything else may carry telemetry freely. */
const STORE_PROFILES = ['production'];

/**
 * Env vars that switch developer telemetry on. Either one alone is enough to matter.
 *
 * Only `eas.json` is read, so there IS a blind spot: `EXPO_PUBLIC_OTEL_ENDPOINT` actually lives in
 * the EAS server-side environments (alongside the relay, tile and stash endpoints — internal
 * hostnames are kept out of this public repo), and nothing here can see it.
 *
 * That is sound rather than lucky. `EXPO_PUBLIC_DEV_TELEMETRY` is the load-bearing gate: without
 * it `metro.config.js` swaps the telemetry barrel for no-ops and the exporter, shipper and journal
 * are not in the bundle at all, so an endpoint configured in EAS has nothing to reach it. The flag
 * is therefore the thing worth checking, and it stays visible in `eas.json` on purpose — it is the
 * readable record of which profiles compile telemetry in.
 */
const TELEMETRY_KEYS = ['EXPO_PUBLIC_OTEL_ENDPOINT', 'EXPO_PUBLIC_DEV_TELEMETRY'];

/**
 * Deliberate, temporary exceptions.
 *
 * Remove an entry and the check fails again on the next run — that is the intended way to turn
 * this back off. `until` is a condition, not a date, because the thing that ends the exception is
 * an event we cannot detect from here.
 */
const ACKNOWLEDGED = {
  production: {
    since: '2026-08-28',
    why: 'production IS TestFlight for now — the profile we build is the one we install on our own phones, and a build we cannot see is not worth shipping while the background pipeline is still being diagnosed.',
    until:
      'the app is available to anyone outside our own TestFlight group. At that point either drop EXPO_PUBLIC_DEV_TELEMETRY from this profile (which strips the whole graph from the bundle) and unset EXPO_PUBLIC_OTEL_ENDPOINT in the EAS production environment, or declare the collection in App Store Connect and the privacy policy — the app would otherwise be sending diagnostics from strangers’ devices to a private endpoint.',
  },
};

const eas = JSON.parse(readFileSync(join(repoRoot, 'eas.json'), 'utf8'));

/** Resolve a profile's env through its `extends` chain, nearest definition winning. */
function resolveEnv(name, seen = new Set()) {
  if (seen.has(name)) throw new Error(`eas.json: circular "extends" at profile "${name}"`);
  seen.add(name);
  const profile = eas.build?.[name];
  if (!profile) throw new Error(`eas.json: no build profile named "${name}"`);
  const inherited = profile.extends ? resolveEnv(profile.extends, seen) : {};
  return { ...inherited, ...(profile.env ?? {}) };
}

const failures = [];
const warnings = [];

for (const name of STORE_PROFILES) {
  const env = resolveEnv(name);
  const enabled = TELEMETRY_KEYS.filter((key) => env[key] !== undefined);
  if (enabled.length === 0) continue;

  const ack = ACKNOWLEDGED[name];
  const settings = enabled.map((key) => `${key}=${JSON.stringify(env[key])}`).join(', ');
  if (!ack) {
    failures.push(
      `  build profile "${name}" sets ${settings}\n` +
        `    → a store build ships no telemetry unless there is an entry for "${name}" in ACKNOWLEDGED.`
    );
    continue;
  }
  warnings.push(
    `  "${name}" ships developer telemetry (${settings})\n` +
      `    acknowledged ${ack.since}: ${ack.why}\n` +
      `    revisit when: ${ack.until}`
  );
}

if (failures.length > 0) {
  console.error('Developer telemetry would ship to an app store, unacknowledged:\n');
  console.error(failures.join('\n'));
  console.error(
    '\nEither remove the variable from that profile, or — if this is deliberate — add an entry to\n' +
      'ACKNOWLEDGED in this script recording why and what ends it. Internal-distribution profiles\n' +
      '(production-internal-*) never need one: they cannot reach a store.\n'
  );
  process.exit(1);
}

if (warnings.length > 0) {
  console.log('Store profiles ship developer telemetry, deliberately:\n');
  console.log(warnings.join('\n'));
  console.log('\nRemove the ACKNOWLEDGED entry to make this a CI failure again.');
} else {
  console.log(
    `Store profiles ship no developer telemetry (checked ${STORE_PROFILES.map((p) => `"${p}"`).join(', ')}).`
  );
}
