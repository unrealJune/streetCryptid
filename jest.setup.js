/**
 * Jest environment fixes that have to run before any module is required.
 */

/**
 * Liquid glass is OFF unless a test asks for it.
 *
 * jest-expo runs the suite as iOS and answers every native constant with a truthy mock, so
 * `isLiquidGlassAvailable()` reports `true` here — an artifact of the mock, not a fact about any
 * device. Left alone, every island and FAB test would assert the liquid-glass path and the opaque
 * surface that Android, web, the store-shot pipeline and every iPhone before iOS 26 actually draw
 * would go untested. `glass-surface.test.tsx` overrides this to cover the other side.
 */
jest.mock('expo-glass-effect', () => {
  const { View } = require('react-native');
  return {
    GlassView: View,
    GlassContainer: View,
    isLiquidGlassAvailable: () => false,
    isGlassEffectAPIAvailable: () => false,
  };
});
