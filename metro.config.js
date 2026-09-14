const path = require('node:path');

const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

if (!config.resolver.assetExts.includes('wasm')) {
  config.resolver.assetExts.push('wasm');
}

/**
 * Keep Metro out of the Rust build directories.
 *
 * `modules/iroh-location/rust/target` is 120+ GB of cargo intermediates on a
 * machine that has built the crate a few times, and `rust-wasm/target` adds
 * several more. Metro's file map crawls and then WATCHES everything under the
 * project root, so without this the watcher hits its start-up timeout and the
 * dev server dies with "Failed to start watch mode" before it serves anything.
 *
 * Nothing under `target/` is ever imported: the checked-in build outputs the
 * bundler does need are `modules/iroh-location/web/` (the wasm-pack bundle) and
 * the generated bindings under `android/` and `ios/`, none of which live here.
 */
config.resolver.blockList = [
  ...[config.resolver.blockList ?? []].flat(),
  /[/\\]modules[/\\]iroh-location[/\\](rust|rust-wasm)[/\\]target[/\\].*/,
];

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
/**
 * Screenshot fixtures are compiled OUT unless `EXPO_PUBLIC_SCREENSHOT_FIXTURES=1`.
 *
 * `@/features/dev/fixtures` supplies the demo friends and the demo walk that `just store-shots`
 * needs, because neither can be staged on one device: pairing is bilateral and in person, and
 * map coverage is the residue of weeks of walking. It strips by exactly the mechanism above, and
 * for a sharper version of the same reason — a runtime gate on fabricated friends is one mistyped
 * variable away from putting strangers on a real user's map.
 *
 * `src/features/dev/fixtures/__tests__/index-parity.test.ts` asserts the two barrels match AND
 * that the stripped one is an identity rather than a no-op: both functions take the user's real
 * friends and trail and return them with demo data appended, so a stub returning `[]` would erase
 * real data in precisely the build nobody can debug.
 */
const STRIPPABLE = [
  {
    enabled: process.env.EXPO_PUBLIC_DEV_TELEMETRY === '1',
    specifier: '@/features/dev/telemetry',
    noop: 'src/features/dev/telemetry/index.noop.ts',
  },
  {
    enabled: process.env.EXPO_PUBLIC_SCREENSHOT_FIXTURES === '1',
    specifier: '@/features/dev/fixtures',
    noop: 'src/features/dev/fixtures/index.noop.ts',
  },
];

const STRIPPED = new Map(
  STRIPPABLE.filter((entry) => !entry.enabled).map((entry) => [
    entry.specifier,
    path.resolve(__dirname, entry.noop),
  ])
);

if (STRIPPED.size > 0) {
  const upstream = config.resolver.resolveRequest;
  config.resolver.resolveRequest = (context, moduleName, platform) => {
    const noop = STRIPPED.get(moduleName);
    if (noop) {
      return { type: 'sourceFile', filePath: noop };
    }
    return (upstream ?? context.resolveRequest)(context, moduleName, platform);
  };
}

module.exports = config;
