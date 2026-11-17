/**
 * Every native publish on iOS runs under a background-task assertion taken before the work hops
 * off the Core Location callback that decided on it.
 *
 * There is no XCTest target for the module, and the failure is not one a runtime assertion can
 * catch: a `Task { await self.heartbeat(...) }` compiles, runs fine in the foreground and on the
 * simulator, and on a backgrounded iPhone is suspended mid-seal or mid-push with nothing to say so.
 * On 2026-11-10/11 that left a parked declaration sealed and never sent (`14befa639f`, silent for
 * 25 h) and another never sealed at all (`e485af31aa`). So the rule is checked in the source, the
 * way `tests/node_lock.rs` checks the node lock: see `ios/PublishAssertion.swift`.
 */

import { readFileSync } from 'fs';
import path from 'path';

const MODULE_ROOT = path.resolve(__dirname, '../..');
const RUNTIME = readFileSync(path.join(MODULE_ROOT, 'ios/BackgroundLocationRuntime.swift'), 'utf8');
const ASSERTION = readFileSync(path.join(MODULE_ROOT, 'ios/PublishAssertion.swift'), 'utf8');

/** Source with `//` comments removed, so prose about the old shape cannot satisfy or fail a check. */
function code(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

describe('native publish runs under a background assertion (iOS)', () => {
  const runtime = code(RUNTIME);

  it('never starts a heartbeat or ingest from a bare Task', () => {
    // A `Task` body that reaches the publish path without going through `publish(_:_:)`.
    const bare = [...runtime.matchAll(/Task\s*\{[^}]*?self\.(heartbeat|ingest)\(/g)].map(
      (m) => m[0]
    );
    expect(bare).toEqual([]);
  });

  it('passes an assertion (or an explicit nil) at every heartbeat and ingest call', () => {
    const calls = [
      ...runtime.matchAll(/\b(?:self\.)?(heartbeat|ingest)\(\s*(?:fix|battery):[^)]*\)/g),
    ];
    // The two definitions plus every call site; there are many, so a zero here means the regex
    // stopped matching rather than that the rule holds.
    expect(calls.length).toBeGreaterThan(10);
    for (const [call] of calls) {
      expect(call).toMatch(/under(?: assertion)?:/);
    }
  });

  it('only the BGProcessingTask path publishes without one', () => {
    const unasserted = [...runtime.matchAll(/(heartbeat|ingest)\([^)]*under:\s*nil\)/g)];
    expect(unasserted).toHaveLength(1);
    const refresh = runtime.slice(runtime.indexOf('func serviceRefresh()'));
    expect(refresh.slice(0, refresh.indexOf('\n  }\n'))).toMatch(/under:\s*nil/);
  });

  it('takes the assertion synchronously, before the Task hop', () => {
    const helper = runtime.slice(runtime.indexOf('private func publish('));
    const body = helper.slice(0, helper.indexOf('\n  }\n'));
    const begin = body.indexOf('PublishAssertion(');
    const hop = body.indexOf('Task {');
    expect(begin).toBeGreaterThan(-1);
    expect(hop).toBeGreaterThan(begin);
    expect(body.slice(hop)).toMatch(/assertion\.finish\(\)/);
  });

  it('begins the OS assertion in the initializer, not lazily', () => {
    const init = ASSERTION.slice(ASSERTION.indexOf('  init('));
    expect(init.slice(0, init.indexOf('\n  }\n'))).toMatch(/beginBackgroundTask\(withName:/);
  });

  it('bounds the push by calling the budgeted entry points under an assertion', () => {
    expect(runtime).toMatch(/node\.ingestFixWithin\(/);
    expect(runtime).toMatch(/node\.heartbeatFixWithin\(/);
  });
});
