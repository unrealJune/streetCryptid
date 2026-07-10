import {
  CRYPTID_PRESETS,
  createCryptidProfile,
  defaultCryptidProfileDraft,
  parseCryptidProfile,
  validateCryptidProfile,
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
    ).toContain('The custom form must use ASCII characters, spaces, tabs, and line breaks only.');
  });

  it('round-trips a versioned saved profile', () => {
    const profile = createCryptidProfile({
      ...defaultCryptidProfileDraft(),
      handle: 'wanderer',
    });
    expect(parseCryptidProfile(JSON.parse(JSON.stringify(profile)))).toEqual(profile);
  });
});
