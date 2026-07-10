import {
  CRYPTID_PRESETS,
  createCryptidProfile,
  defaultCryptidProfileDraft,
  parseCryptidProfile,
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

    expect(issues.handle).toEqual([
      'Use 2-20 lowercase letters, numbers, underscores, or dashes for the username.',
    ]);
    expect(issues.cryptidName).toEqual([
      'Give the profile icon a name between 1 and 24 characters.',
    ]);
    expect(issues.sigil).toContain('Use ASCII characters, spaces, tabs, and line breaks only.');
    expect(issues.color).toEqual(['Choose a valid six-digit profile color.']);
  });

  it('round-trips a versioned saved profile', () => {
    const profile = createCryptidProfile({
      ...defaultCryptidProfileDraft(),
      handle: 'wanderer',
    });
    expect(parseCryptidProfile(JSON.parse(JSON.stringify(profile)))).toEqual(profile);
  });
});
