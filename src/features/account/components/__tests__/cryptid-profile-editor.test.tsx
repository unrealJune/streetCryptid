import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { fullBrightnessColor } from '@/constants/signal-colors';
import { createCryptidProfile, type CryptidProfile } from '../../core/profile';
import { CryptidProfileEditor } from '../cryptid-profile-editor';

jest.mock('@/global.css', () => ({}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// The generator dialog reaches for the native model bridge; it has its own tests.
jest.mock('../cryptid-generator-dialog', () => ({ CryptidGeneratorDialog: () => null }));

const AUTOSAVE_DELAY_MS = 450;

function savedProfile(): CryptidProfile {
  return createCryptidProfile({
    handle: '@june',
    cryptidName: 'Lantern Owl',
    sigil: "   .---.\n  / oo \\\n   '---'",
    color: '#44AAFF',
    presetId: null,
  });
}

describe('CryptidProfileEditor', () => {
  let renderer: ReactTestRenderer;

  beforeEach(() => jest.useFakeTimers());

  afterEach(() => {
    act(() => renderer?.unmount());
    jest.useRealTimers();
  });

  function render(props: Partial<Parameters<typeof CryptidProfileEditor>[0]> = {}) {
    const onSave = jest.fn(async (_profile: CryptidProfile) => {});
    act(() => {
      renderer = create(
        <CryptidProfileEditor
          mode="edit"
          initialProfile={savedProfile()}
          onSave={onSave}
          {...props}
        />
      );
    });
    return onSave;
  }

  const find = (testID: string) => renderer.root.findByProps({ testID });
  const press = (testID: string) => act(() => find(testID).props.onPress());
  const flushAutosave = async () =>
    act(async () => {
      jest.advanceTimersByTime(AUTOSAVE_DELAY_MS + 10);
    });
  const heroName = () =>
    renderer.root.findByProps({ accessibilityHint: 'Opens the profile icon picker' }).props
      .accessibilityLabel;

  it('rolls a whole persona — cryptid, title, and color — from one button', () => {
    render();
    const before = heroName();

    press('randomize-persona');

    expect(heroName()).not.toBe(before);
    expect(renderer.root.findByProps({ testID: 'keep-rolled-persona' })).toBeTruthy();
  });

  it('does not save an unconfirmed roll in the persona editor', async () => {
    const onSave = render();

    press('randomize-persona');
    await flushAutosave();

    expect(onSave).not.toHaveBeenCalled();
  });

  it('restores the displaced persona on revert, across repeated rolls', async () => {
    const onSave = render();
    const original = heroName();

    press('randomize-persona');
    press('randomize-persona');
    press('revert-rolled-persona');
    await flushAutosave();

    expect(heroName()).toBe(original);
    expect(onSave).not.toHaveBeenCalled();
    expect(renderer.root.findAllByProps({ testID: 'keep-rolled-persona' })).toHaveLength(0);
  });

  it('saves the roll once it is kept', async () => {
    const onSave = render();

    press('randomize-persona');
    press('keep-rolled-persona');
    await flushAutosave();

    expect(onSave).toHaveBeenCalledTimes(1);
    const [saved] = onSave.mock.calls[0];
    expect(saved.cryptidName).not.toBe('Lantern Owl');
    expect(saved.color).not.toBe('#44AAFF');
    expect(saved.handle).toBe('@june');
  });

  it('discards an undecided roll when the editor is dismissed', () => {
    const onSave = render();

    press('randomize-persona');
    act(() => renderer.unmount());

    expect(onSave).not.toHaveBeenCalled();
  });

  it('applies a roll immediately during onboarding — there is nothing to overwrite', async () => {
    const onSave = render({ mode: 'onboarding' });

    press('randomize-persona');

    expect(renderer.root.findAllByProps({ testID: 'keep-rolled-persona' })).toHaveLength(0);
    await flushAutosave();
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('starts first run on a rolled persona instead of an empty form', () => {
    render({ mode: 'onboarding', initialProfile: null });

    // A name and a drawing are already in place; only the username is missing.
    expect(heroName()).not.toBe('Profile icon: Custom icon');
  });

  it('keeps every color it produces at full brightness', () => {
    render();
    for (let roll = 0; roll < 25; roll += 1) {
      press('randomize-persona');
      const swatch = find('randomize-persona').props.style({ pressed: false });
      const { backgroundColor } = swatch.find(
        (entry: { backgroundColor?: string }) => entry?.backgroundColor
      );
      expect(fullBrightnessColor(backgroundColor)).toBe(backgroundColor);
    }
  });
});
