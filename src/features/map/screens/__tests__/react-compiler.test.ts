import { transformSync } from '@babel/core';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * The map screen re-renders whenever the drawer or a settled readout changes, and only the React
 * Compiler's caching keeps those renders from reaching the map's Skia tree and its labels. The
 * compiler gives no warning when it gives up: a component it cannot lower simply ships
 * uncompiled (babel-preset-expo sets `panicThreshold: 'NONE'`). From 43d78fa, `MapScreenBody`
 * ran that way because of one optional chain in a `&&` test, and every screen render
 * re-rendered the map mid-gesture. This runs the compiler the app builds with over the screen
 * and fails on any component it skipped.
 */

// The copy babel-preset-expo (and so Metro) applies, not whichever one happens to be hoisted.
const presetDir = dirname(
  require.resolve('babel-preset-expo/package.json', {
    paths: [dirname(require.resolve('expo/package.json'))],
  })
);
const compilerPlugin = require.resolve('babel-plugin-react-compiler', { paths: [presetDir] });
const typescriptPreset = require.resolve('@babel/preset-typescript', { paths: [presetDir] });

interface CompilerEvent {
  kind: string;
  fnName?: string | null;
  detail?: unknown;
}

function compile(file: string): { compiled: string[]; failures: string[] } {
  const events: CompilerEvent[] = [];
  transformSync(readFileSync(file, 'utf8'), {
    filename: file,
    babelrc: false,
    configFile: false,
    presets: [[typescriptPreset, { isTSX: true, allExtensions: true }]],
    plugins: [
      [
        compilerPlugin,
        {
          target: '19',
          panicThreshold: 'none',
          logger: { logEvent: (_file: string | null, event: CompilerEvent) => events.push(event) },
        },
      ],
    ],
  });
  return {
    compiled: events
      .filter((event) => event.kind === 'CompileSuccess')
      .map((event) => event.fnName ?? '<anonymous>'),
    failures: events
      .filter((event) => event.kind === 'CompileError')
      .map((event) => `${event.fnName ?? '<anonymous>'}: ${JSON.stringify(event.detail)}`),
  };
}

describe('React Compiler', () => {
  it('compiles every component of the map screen', () => {
    const { compiled, failures } = compile(join(__dirname, '..', 'map-screen-body.tsx'));
    expect(failures).toEqual([]);
    expect(compiled).toEqual(expect.arrayContaining(['MapScreenBody', 'MapSession', 'MeIsland']));
  });
});
