import * as noop from '../index.noop';
import * as real from '../index';

/**
 * The stripped build swaps `index.ts` for `index.noop.ts` via a Metro resolver rule, so a name
 * exported by one and not the other is a bundling error that ONLY appears in a release build —
 * the exact class of bug this mechanism must not introduce, since no development build can
 * reproduce it. This test is the thing that makes the swap safe to rely on.
 *
 * Only runtime values can be compared: TypeScript types are erased, so type-only exports are
 * checked by `tsc` instead (both files are type-checked, and every consumer imports the barrel).
 */
describe('telemetry barrel parity', () => {
  const realNames = Object.keys(real).sort();
  const noopNames = Object.keys(noop).sort();

  it('exports the same runtime names from the real and stripped barrels', () => {
    expect(noopNames).toEqual(realNames);
  });

  it('exports each name as the same kind of value', () => {
    const kinds = (mod: Record<string, unknown>): Record<string, string> =>
      Object.fromEntries(Object.keys(mod).map((key) => [key, typeof mod[key]]));
    expect(kinds(noop)).toEqual(kinds(real));
  });

  it('leaves telemetry disabled and every span inert in the stripped build', () => {
    const telemetry = noop.getTelemetry();
    expect(telemetry.enabled).toBe(false);
    expect(noop.getOtelConfig()).toBeNull();

    // The contract call sites depend on: every method is safe in any state, so no instrumented
    // path ever has to branch on whether telemetry is compiled in.
    const span = telemetry.startSpan('bg.wake', { attributes: { fixes: 1 } });
    expect(() => {
      span.setAttribute('published', 1);
      span.setAttributes({ 'sc.seq': 2 });
      span.addEvent('publish.failed');
      span.recordError(new Error('boom'));
      span.setStatus('error', 'boom');
      span.end();
      span.end();
    }).not.toThrow();
  });

  it('still runs the work wrapped by withSpan and withEventLogLaunchContext', async () => {
    // These two wrap real behaviour rather than only observing it, so stubbing them out to no-ops
    // would silently delete the background pipeline from a stripped build.
    await expect(noop.getTelemetry().withSpan('bg.session', {}, async () => 'ran')).resolves.toBe(
      'ran'
    );
    await expect(noop.withEventLogLaunchContext('background', async () => 'ran')).resolves.toBe(
      'ran'
    );
  });
});
