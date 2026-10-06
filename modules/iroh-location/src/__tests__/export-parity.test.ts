/**
 * The native module's surface, checked against itself across all three languages that declare it.
 *
 * The JS side reaches native code through one TypeScript declaration (`IrohLocationNativeModule`)
 * that two hand-written modules — Kotlin and Swift — are supposed to implement. Nothing compiled
 * that promise: an export missing on one platform type-checks, bundles, ships, and then either
 * throws at the call site or, worse, silently takes a `typeof x === 'function'` fallback forever.
 * That is not hypothetical:
 *
 * - `handOverNativeBackground` existed on iOS and not on Android, so on 2026-10-03 a Pixel 10's
 *   background runtime kept the store claim, the app's `init()` rejected, and pairing showed
 *   "NOTHING FOUND" for 13.7 hours.
 * - `publishIntroduction` and `pushTrailBudgeted` were declared here and called (guarded) by JS for
 *   their whole lives, and exported by NEITHER platform: every new friend waited for the next slot
 *   for their first dot, and every push paid the flat 30 s budget. This test found both.
 *
 * So the surface is read straight from the three sources and compared. Platform-specific exports
 * are allowed, but only by name in the lists below, each with its reason — and a list entry that
 * stops being true fails too, so the lists cannot rot into a place where drift hides.
 */

import { readFileSync } from 'fs';
import path from 'path';

const MODULE_ROOT = path.resolve(__dirname, '../..');

function source(relative: string): string {
  return readFileSync(path.join(MODULE_ROOT, relative), 'utf8');
}

/** `Function("name")` / `AsyncFunction("name")`, the Expo module DSL in both languages. */
function nativeExports(text: string): Set<string> {
  const names = new Set<string>();
  for (const match of text.matchAll(/\b(?:AsyncFunction|Function)\("(\w+)"\)/g)) {
    names.add(match[1]);
  }
  return names;
}

/** Method name → whether it is optional (`name?(`), from the `declare class` block. */
function declaredMethods(text: string): Map<string, boolean> {
  const start = text.indexOf('export declare class IrohLocationNativeModule');
  if (start < 0) throw new Error('IrohLocationNativeModule declaration not found');
  const end = text.indexOf('\n}\n', start);
  const body = text.slice(start, end);
  const methods = new Map<string, boolean>();
  for (const match of body.matchAll(/^ {2}(\w+)(\?)?\(/gm)) {
    methods.set(match[1], match[2] === '?');
  }
  return methods;
}

const kotlin = nativeExports(
  source('android/src/main/java/com/unrealjune/irohlocation/IrohLocationModule.kt')
);
const swift = nativeExports(source('ios/IrohLocationModule.swift'));
const declared = declaredMethods(source('src/IrohLocationModule.ts'));

/** Exported by iOS only, on purpose. */
const IOS_ONLY: Record<string, string> = {
  nativeBackgroundAuthorized:
    'Core Location authorization read live from the delegate; Android reads it through expo-location',
  nativeBackgroundState:
    "the iOS runtime's moving/stopped/anchor state machine, which Android's service does not have",
  takeBackgroundWakeStats:
    'BackgroundWakeLedger samples the CPU budget iOS grants a wake; a foreground service has none',
  resetBackgroundWakeStats: 'the other half of takeBackgroundWakeStats',
  takeCrashDiagnostics: 'MetricKit, which exists only on iOS',
};

/** Exported by Android only, on purpose. */
const ANDROID_ONLY: Record<string, string> = {};

/** Declared for OLDER binaries a newer JS bundle may still meet; no current binary exports them. */
const LEGACY: Record<string, string> = {
  handOverNativeBackground:
    'the pre-host handover; with a node host both halves lease ONE node and nothing is handed over',
  nativeNodeOwner: "the pre-host iOS owner flag; the host's snapshot replaced it",
};

function difference(a: Set<string>, b: Set<string>): string[] {
  return [...a].filter((name) => !b.has(name)).sort();
}

describe('the native module surface', () => {
  it('is actually being read — a parser that finds nothing would pass every check below', () => {
    expect(kotlin.size).toBeGreaterThan(60);
    expect(swift.size).toBeGreaterThan(60);
    expect(declared.size).toBeGreaterThan(60);
    expect(kotlin.has('createNode')).toBe(true);
    expect(swift.has('createNode')).toBe(true);
    expect(declared.has('createNode')).toBe(true);
  });

  it('declares every export either platform makes, so JS can know it exists', () => {
    const native = new Set([...kotlin, ...swift]);
    expect(difference(native, new Set(declared.keys()))).toEqual([]);
  });

  it('has every REQUIRED method on both platforms', () => {
    const required = new Set([...declared].filter(([, optional]) => !optional).map(([n]) => n));
    expect({ missingOnAndroid: difference(required, kotlin) }).toEqual({ missingOnAndroid: [] });
    expect({ missingOnIos: difference(required, swift) }).toEqual({ missingOnIos: [] });
  });

  it('differs between the platforms only where a reason is written down', () => {
    expect(difference(swift, kotlin)).toEqual(Object.keys(IOS_ONLY).sort());
    expect(difference(kotlin, swift)).toEqual(Object.keys(ANDROID_ONLY).sort());
  });

  it('declares no optional method that nothing implements, except what is kept for old binaries', () => {
    const optional = [...declared].filter(([, isOptional]) => isOptional).map(([name]) => name);
    const unimplemented = optional.filter((name) => !kotlin.has(name) && !swift.has(name)).sort();
    expect(unimplemented).toEqual(Object.keys(LEGACY).sort());
  });

  it('keeps the node host exports on both platforms', () => {
    // The surface the shared node rests on. Losing one of these on a platform is the 2026-10-03
    // shape again: that half of the process falling back to building a node of its own.
    for (const name of ['createNode', 'shutdown', 'restartNode', 'nodeHostSnapshot']) {
      expect({ name, android: kotlin.has(name), ios: swift.has(name) }).toEqual({
        name,
        android: true,
        ios: true,
      });
    }
  });
});
