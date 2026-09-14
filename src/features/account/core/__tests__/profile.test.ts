import {
  CRYPTID_PRESETS,
  createCryptidProfile,
  defaultCryptidProfileDraft,
  parseCryptidProfile,
  USERNAME_GUIDANCE,
  validateCryptidProfile,
  validateCryptidProfileFields,
} from '../profile';

describe('cryptid profile', () => {
  it('normalizes the handle and line endings without trimming ASCII whitespace', () => {
    const sigil = '  /\\  \r\n (  ) \r\n/_  _\\  ';
    const profile = createCryptidProfile({
      ...defaultCryptidProfileDraft(),
      handle: '  @Night_Owl ',
      cryptidName: '  Window Thing ',
      sigil,
    });

    expect(profile.handle).toBe('@night_owl');
    expect(profile.cryptidName).toBe('Window Thing');
    expect(profile.sigil).toBe('  /\\  \n (  ) \n/_  _\\  ');
  });

  it('normalizes common phone paste characters without changing the art layout', () => {
    const profile = createCryptidProfile({
      ...defaultCryptidProfileDraft(),
      handle: 'paste_test',
      cryptidName: 'Phone Paste',
      presetId: null,
      sigil: '\ufeff\u201cowl\u201d\u00a0\u2014\u2028  \u2026\u200b',
    });

    expect(profile.sigil).toBe('"owl" -\n  ...');
  });

  it('keeps every bundled preset within the contact-card bounds', () => {
    for (const preset of CRYPTID_PRESETS) {
      expect(
        validateCryptidProfile({
          handle: '@tester',
          cryptidName: preset.name,
          sigil: preset.art,
          color: '#2F9E6A',
          presetId: preset.id,
        })
      ).toEqual([]);
    }
  });

  it('rejects non-ASCII custom art', () => {
    expect(
      validateCryptidProfile({
        ...defaultCryptidProfileDraft(),
        handle: '@tester',
        presetId: null,
        sigil: '  /\\\n (👁)',
      })
    ).toContain('Use ASCII characters, spaces, tabs, and line breaks only.');
  });

  it('groups validation messages beside the field that needs attention', () => {
    const issues = validateCryptidProfileFields({
      ...defaultCryptidProfileDraft(),
      handle: '?',
      cryptidName: '',
      presetId: null,
      sigil: '👁',
      color: 'green',
    });

    expect(issues.handle).toEqual([USERNAME_GUIDANCE]);
    expect(issues.cryptidName).toEqual([]);
    expect(issues.sigil).toContain('Use ASCII characters, spaces, tabs, and line breaks only.');
    expect(issues.color).toEqual(['Choose a valid six-digit profile color.']);
  });

  it('accepts a one-character handle and an unnamed icon', () => {
    expect(
      validateCryptidProfile({
        ...defaultCryptidProfileDraft(),
        handle: '@j',
        cryptidName: '',
        presetId: null,
      })
    ).toEqual([]);
  });

  it('round-trips a versioned saved profile', () => {
    const profile = createCryptidProfile({
      ...defaultCryptidProfileDraft(),
      handle: 'wanderer',
    });

    expect(parseCryptidProfile(JSON.parse(JSON.stringify(profile)))).toEqual(profile);
  });

  it.each(['', 'a'.repeat(21), '_owl', '-owl', 'night owl', 'owl!'])(
    'rejects invalid username %j with the same guidance shown in the editor',
    (handle) => {
      expect(
        validateCryptidProfileFields({ ...defaultCryptidProfileDraft(), handle }).handle
      ).toEqual([USERNAME_GUIDANCE]);
    }
  );

  it.each(['a', 'ab', 'a'.repeat(20), '1owl', 'night_owl', 'night-owl'])(
    'accepts username %j according to the guidance',
    (handle) => {
      expect(
        validateCryptidProfileFields({ ...defaultCryptidProfileDraft(), handle }).handle
      ).toEqual([]);
    }
  );
});
