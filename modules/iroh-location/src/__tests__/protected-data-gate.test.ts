/**
 * A launch before the phone's first unlock waits for it (`ios/ProtectedDataGate.swift`).
 *
 * After a reboot iOS can relaunch the app for a Core Location event while every file protected
 * `untilFirstUserAuthentication` is unreadable, `UserDefaults` included. Nothing errors: defaults
 * read back empty, so the launch armed nothing, and a fence exit persisted `sc.bg.armed = false`
 * over a domain it could not read. On 2026-11-17 two phones ran flat and neither came back by
 * itself. There is no XCTest target and no simulator for a locked boot, so the rules are checked
 * in the source, like `native-publish-assertion.test.ts`.
 */

import { readFileSync } from 'fs';
import path from 'path';

const IOS = path.resolve(__dirname, '../../ios');
const read = (file: string) =>
  readFileSync(path.join(IOS, file), 'utf8')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');

const RUNTIME = read('BackgroundLocationRuntime.swift');
const BOOTSTRAP = read('IrohBackgroundBootstrap.swift');
const REFRESH = read('NativeRefreshTask.swift');

/** The body of the first function whose signature contains `signature`, braces balanced. */
function body(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error(`not found: ${signature}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(open + 1, i);
  }
  throw new Error(`unbalanced: ${signature}`);
}

const firstStatement = (text: string) => text.trim().split('\n')[0].trim();

describe('protected data gate (iOS)', () => {
  it('restores persisted state only once data is readable', () => {
    const init = body(RUNTIME, 'private override init()');
    expect(init).toMatch(/ProtectedDataGate\.whenAvailable\s*\{[^}]*restorePersistedState\(\)/);
  });

  it('runs the launch work only once data is readable', () => {
    const finish = body(BOOTSTRAP, 'static func finishLaunch(');
    expect(finish).toMatch(/ProtectedDataGate\.whenAvailable\s*\{\s*finishUnlockedLaunch\(/);
    expect(finish).not.toContain('UserDefaults');
  });

  it('never persists while the launch is deferred', () => {
    const persist = body(RUNTIME, 'private func persistState()');
    expect(firstStatement(persist)).toBe('guard !ProtectedDataGate.isDeferring else {');
    expect(persist).toContain('ArmedMarker.record(running)');
  });

  it('falls back to the unprotected marker for the armed flag', () => {
    expect(body(RUNTIME, 'static var wasArmed: Bool')).toContain('ArmedMarker.read()');
  });

  it.each([
    'didUpdateLocations locations: [CLLocation])',
    'didVisit visit: CLVisit)',
    'didExitRegion region: CLRegion',
  ])('polls the gate first in %s', (signature) => {
    expect(firstStatement(body(RUNTIME, signature))).toBe(
      'ProtectedDataGate.poll(via: "location")'
    );
  });

  it('lets a refresh wake finish a deferred launch before servicing it', () => {
    const handle = body(REFRESH, 'private static func handle(');
    const poll = handle.indexOf('ProtectedDataGate.poll(via: "refresh")');
    expect(poll).toBeGreaterThan(-1);
    expect(poll).toBeLessThan(handle.indexOf('serviceRefresh()'));
  });
});
