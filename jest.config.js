/**
 * Jest configuration. Lives here rather than in package.json so the budgets can carry their
 * reasons: Jest 30 rejects unknown keys, which is what a `//comment` key in package.json is.
 *
 * @type {import('jest').Config}
 */
module.exports = {
  preset: 'jest-expo',
  // Jest charges a suite's module evaluation to its FIRST test, so with a cold babel transform cache
  // the first test of a heavy suite pays for transforming its entire graph.
  // cryptid-profile-editor sat at 4.7s of the 5s default with a cold cache and failed the moment
  // anything was added to its imports. CI restores the cache now (JEST_CACHE_DIRECTORY, ci.yml), but
  // it is still cold after every lockfile change, so this budget stays: it is for a genuinely hung
  // test, not for a cold transform.
  testTimeout: 20000,
  // Only CI sets this, to a directory it caches between runs; locally Jest keeps its default.
  ...(process.env.JEST_CACHE_DIRECTORY ? { cacheDirectory: process.env.JEST_CACHE_DIRECTORY } : {}),
  setupFiles: ['@shopify/react-native-skia/jestSetup.js', '<rootDir>/jest.setup.js'],
  testPathIgnorePatterns: ['/node_modules/', '/.expo/', '/docs/', '/.claude/'],
  modulePathIgnorePatterns: ['<rootDir>/.claude/'],
  transformIgnorePatterns: [
    'node_modules/(?!(.pnpm|react-native|@react-native|@react-native-community|expo|@expo|@expo-google-fonts|react-navigation|@react-navigation|@sentry/react-native|native-base|standard-navigation|@mapbox|pbf|geojson-vt))',
    '/node_modules/react-native-reanimated/plugin/',
    '/node_modules/@react-native/babel-preset/',
  ],
};
