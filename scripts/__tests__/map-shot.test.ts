import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const script = resolve(__dirname, '../map-shot.ts');

function run(...args: string[]) {
  return spawnSync('bun', [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, EXPO_PUBLIC_TILE_URL: '' },
    timeout: 10_000,
  });
}

describe('map screenshot road-study controls', () => {
  it.each(['--road-width', '--road-dilation', '--road-contrast', '--road-glow'])(
    'rejects missing, non-finite and out-of-range values for %s',
    (flag) => {
      for (const value of [undefined, 'NaN', 'Infinity', '-1', '1.1']) {
        const result = run('--fixture', flag, ...(value === undefined ? [] : [value]));
        expect(result.error).toBeUndefined();
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(`${flag} expects a number between`);
      }
    }
  );

  it('rejects zero-width Skia hairlines', () => {
    expect(run('--fixture', '--road-width', '0').stderr).toContain(
      '--road-width expects a number between 0.1 and 1'
    );
  });

  it.each(['--places', '--terrain-url'])('rejects misleading fixture combinations: %s', (flag) => {
    expect(run('--fixture', flag, 'example').stderr).toContain(
      '--fixture cannot be combined with --places or --terrain-url'
    );
  });

  it('still requires a tile URL unless the fixture was explicitly requested', () => {
    const result = run('--road-width', '0.7');
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('EXPO_PUBLIC_TILE_URL is unset');
  });

  it.each(['NaN', 'Infinity', '-1', '19'])('rejects invalid zoom %s', (zoom) => {
    expect(run('--fixture', '--zooms', zoom).stderr).toContain(
      '--zooms expects finite zooms between 1 and 18'
    );
  });
});
