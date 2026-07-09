// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');
const eslintConfigPrettier = require('eslint-config-prettier');

module.exports = defineConfig([
  expoConfig,
  // Turn off ESLint rules that conflict with Prettier formatting.
  eslintConfigPrettier,
  {
    ignores: ['dist/*', 'node_modules/*', '.expo/*', 'expo-env.d.ts', 'docs/design/**'],
  },
  // The map core and tile logic are pure TypeScript: no React, React Native, or
  // Skia imports allowed, so they stay runnable (and testable) outside the app.
  // The single fetch-based tile source is the one sanctioned impure edge.
  {
    files: ['src/features/map/core/**', 'src/features/map/tiles/**', 'src/features/map/engine/**'],
    ignores: ['src/features/map/tiles/martin-source.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'react', message: 'map core must stay pure (no React).' },
            { name: 'react-native', message: 'map core must stay pure (no React Native).' },
            {
              name: '@shopify/react-native-skia',
              message: 'map core must stay pure (no Skia); rendering lives in render/.',
            },
          ],
          patterns: [
            {
              group: ['react-native/*', '@shopify/react-native-skia/*', 'expo*'],
              message: 'map core must stay pure (no RN/Skia/Expo modules).',
            },
          ],
        },
      ],
    },
  },
  // The render layer drives Skia via Reanimated shared values, which are mutable
  // by design and must be written inside gesture worklets (`sv.value += …`). The
  // react-compiler `immutability` rule (eslint-config-expo@57) doesn't model
  // reanimated shared values and false-positives on these idiomatic writes — and
  // it can't be silenced with inline disables — so turn it off for render/ only.
  // The pure map logic the rule protects lives in core/ (no shared values).
  {
    files: ['src/features/map/render/**'],
    rules: {
      'react-hooks/immutability': 'off',
    },
  },
]);
