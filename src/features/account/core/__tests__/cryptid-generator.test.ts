import {
  generateLocalCryptid,
  normalizeCryptidDescription,
  validateGeneratedCryptid,
} from '../cryptid-generator';
import { sigilMeasurements, validateCryptidProfile } from '../profile';

const DESCRIPTIONS = [
  'a rain-soaked moth',
  'an antlered forest watcher',
  'a black hound',
  'a shy lake thing',
  'an owl above the city',
  'a very tall night crawler',
  'a horned mountain cryptid',
  'a fog wisp',
  '',
];

describe('cryptid generator', () => {
  it.each(DESCRIPTIONS)('keeps generated art inside the profile grid: %s', (description) => {
    const generated = generateLocalCryptid(description, 42);
    const measurements = sigilMeasurements(generated.sigil);

    expect(measurements.lines).toBeLessThanOrEqual(12);
    expect(measurements.columns).toBeLessThanOrEqual(32);
    expect(
      validateCryptidProfile({
        handle: '@generator',
        cryptidName: generated.name,
        sigil: generated.sigil,
        color: '#2F9E6A',
        presetId: null,
      })
    ).toEqual([]);
  });

  it('is deterministic for the same description and seed', () => {
    expect(generateLocalCryptid('quiet alley moth', 17)).toEqual(
      generateLocalCryptid('quiet alley moth', 17)
    );
  });

  it('uses the seed to produce another variation', () => {
    expect(generateLocalCryptid('quiet alley moth', 17)).not.toEqual(
      generateLocalCryptid('quiet alley moth', 18)
    );
  });

  it('preserves variation for timestamp-sized seeds', () => {
    expect(generateLocalCryptid('quiet alley moth', 1_800_000_000_017)).not.toEqual(
      generateLocalCryptid('quiet alley moth', 1_800_000_000_018)
    );
  });

  it('normalizes and bounds descriptions before inference', () => {
    expect(normalizeCryptidDescription(`  foggy\n\n${'x'.repeat(200)}  `)).toBe(
      `foggy ${'x'.repeat(154)}`
    );
  });

  it('rejects malformed model output', () => {
    expect(() => validateGeneratedCryptid({ name: 'Eye', sigil: '(👁)' }, 'system')).toThrow(
      'does not fit the profile grid'
    );
  });
});
