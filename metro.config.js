const path = require('node:path');

const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

if (!config.resolver.assetExts.includes('wasm')) {
  config.resolver.assetExts.push('wasm');
}

/**
 * Developer telemetry is compiled OUT unless `EXPO_PUBLIC_DEV_TELEMETRY=1`.
 *
 * Every consumer imports the barrel (`@/features/dev/telemetry`), so redirecting that one
 * specifier to `index.noop.ts` removes the entire graph behind it from the bundle: the OTLP
 * encoder, the journal shipper, the SQLite event log, the console bridge, the device snapshot.
 * `index.noop.ts` re-declares the same surface as no-ops and imports its siblings with
 * `import type` only, which Babel erases — so nothing pulls the real implementation back in.
 *
 * This is deliberately the same mechanism as the native core's `otel` cargo feature: a
 * `--no-default-features` build swaps `telemetry.rs`'s implementation for stubs behind an
 * identical UniFFI surface. Both halves of the app now strip the same way.
 *
 * Why a resolver rule rather than an `if (__DEV__)` or an env check at the call sites: a runtime
 * gate still ships the code, the database schema, and the network paths in the store binary, and
 * leaves them one mistyped environment variable away from running. There is nothing here to
 * enable — the modules are not in the bundle.
 *
 * `src/features/dev/telemetry/__tests__/index-parity.test.ts` asserts the two barrels export the
 * same names, because a mismatch would otherwise surface only in a release build.
 */
const DEV_TELEMETRY = process.env.EXPO_PUBLIC_DEV_TELEMETRY === '1';
const TELEMETRY_SPECIFIER = '@/features/dev/telemetry';
const TELEMETRY_NOOP = path.resolve(__dirname, 'src/features/dev/telemetry/index.noop.ts');

if (!DEV_TELEMETRY) {
  const upstream = config.resolver.resolveRequest;
  config.resolver.resolveRequest = (context, moduleName, platform) => {
    if (moduleName === TELEMETRY_SPECIFIER) {
      return { type: 'sourceFile', filePath: TELEMETRY_NOOP };
    }
    return (upstream ?? context.resolveRequest)(context, moduleName, platform);
  };
}

module.exports = config;
