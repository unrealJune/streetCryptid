import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Platform, StyleSheet } from 'react-native';
import { SymbolView } from 'expo-symbols';

import { ThemedText } from '@/components/themed-text';
import { fullBrightnessColor } from '@/constants/signal-colors';
import { createCryptidProfile, USERNAME_GUIDANCE, type CryptidProfile } from '../../core/profile';
import { CryptidGeneratorDialog } from '../cryptid-generator-dialog';
import { CryptidProfileEditor } from '../cryptid-profile-editor';
import { SignalColorPicker } from '../signal-color-picker';

jest.mock('@/global.css', () => ({}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('../cryptid-generator-dialog', () => ({ CryptidGeneratorDialog: () => null }));
jest.mock('../signal-color-picker', () => ({ SignalColorPicker: () => null }));
// Keep the Skia leaf stubbed without asking Jest's CJS runtime to execute import().
jest.mock('react', () => ({
  ...jest.requireActual('react'),
  lazy: () => jest.requireMock('../signal-color-picker').SignalColorPicker,
}));
jest.mock('react-native-reanimated', () => ({
  getUseOfValueInStyleWarning: () => '',
}));

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
  const originalOS = Platform.OS;

  beforeEach(() => {
    jest.useFakeTimers();
    Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
  });

  afterEach(() => {
    act(() => renderer?.unmount());
    jest.useRealTimers();
    Object.defineProperty(Platform, 'OS', { value: originalOS, configurable: true });
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
  const input = (accessibilityLabel: string) => renderer.root.findByProps({ accessibilityLabel });
  const change = (label: string, value: string) =>
    act(() => input(label).props.onChangeText(value));
  const settle = async () => act(async () => {});
  const waitForAutosave = async () =>
    act(async () => {
      jest.advanceTimersByTime(1000);
    });
  const hero = () =>
    renderer.root.findByProps({ accessibilityHint: 'Opens the profile icon picker' });
  const openIcon = () => act(() => hero().props.onPress());
  const openSignal = async () => {
    act(() => renderer.root.findByProps({ label: 'Signal color' }).props.onPress());
    await settle();
  };
  const text = () =>
    renderer.root
      .findAllByType(ThemedText)
      .map((node) => node.props.children)
      .join(' ');
  const previewColor = () =>
    StyleSheet.flatten(find('randomize-persona').props.style({ pressed: false })).backgroundColor;

  it('does not save an untouched profile or show Saved status', async () => {
    const onSave = render();
    await waitForAutosave();
    expect(renderer.root.findAllByProps({ testID: 'save-profile' })).toHaveLength(0);
    expect(text()).not.toContain('Saved');
    act(() => renderer.unmount());
    expect(onSave).not.toHaveBeenCalled();
  });

  it('uses one dice icon in the top-right of the preview, without redundant copy', () => {
    render();
    openIcon();
    const randomizers = renderer.root.findAll(
      (node) =>
        node.props.accessibilityLabel === 'Randomize profile' &&
        typeof node.props.onPress === 'function'
    );
    expect(randomizers).toHaveLength(1);
    expect(find('randomize-persona').findByType(SymbolView).props.name).toEqual({
      ios: 'dice',
      android: 'casino',
      web: 'casino',
    });
    expect(
      StyleSheet.flatten(find('randomize-persona').props.style({ pressed: false }))
    ).toMatchObject({
      position: 'absolute',
      width: 44,
      height: 44,
    });
    expect(text()).not.toContain('This is how you appear to friends.');
    expect(text()).not.toContain('Rolls a cryptid');
    expect(text()).not.toContain('Random');
  });

  it.each([
    ['Username', 'new_june'],
    ['Custom profile icon name', 'Marsh Owl'],
    ['Custom ASCII profile icon', '(o.o)'],
  ])('keeps %s changes as drafts until explicitly saved', async (label, value) => {
    const onSave = render();
    openIcon();
    change(label, value);
    await waitForAutosave();

    expect(onSave).not.toHaveBeenCalled();
    expect(find('save-profile').props.disabled).toBe(false);
    expect(text()).toContain('Unsaved profile changes');

    press('save-profile');
    await settle();
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(renderer.root.findAllByProps({ testID: 'save-profile' })).toHaveLength(0);
    await waitForAutosave();
    act(() => renderer.unmount());
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('keeps wheel and quick-color changes as drafts, and removes the signal subtitle', async () => {
    const onSave = render();
    await openSignal();
    act(() => renderer.root.findByType(SignalColorPicker).props.onChange('#FF0000'));
    await waitForAutosave();
    expect(onSave).not.toHaveBeenCalled();
    expect(previewColor()).toBe('#FF0000');
    expect(text()).not.toContain('This marks your profile icon');
    press('discard-profile');
    expect(previewColor()).toBe(savedProfile().color);

    const quickColor = renderer.root.findAll(
      (node) =>
        node.props.accessibilityRole === 'radio' &&
        !node.props.accessibilityState.checked &&
        typeof node.props.onPress === 'function'
    )[0];
    act(() => quickColor.props.onPress());
    await waitForAutosave();
    expect(onSave).not.toHaveBeenCalled();
    press('save-profile');
    await settle();
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0].color).toBe(previewColor());
  });

  it('discards every field together, including edits mixed with repeated rolls', async () => {
    const onSave = render();
    const originalName = hero().props.accessibilityLabel;
    openIcon();
    change('Username', 'new_june');
    press('randomize-persona');
    press('randomize-persona');
    change('Custom profile icon name', 'Marsh Owl');
    change('Custom ASCII profile icon', '(o.o)');
    press('discard-profile');
    await waitForAutosave();

    expect(hero().props.accessibilityLabel).toBe(originalName);
    expect(input('Username').props.value).toBe('june');
    expect(input('Custom ASCII profile icon').props.value).toBe(savedProfile().sigil);
    expect(previewColor()).toBe(savedProfile().color);
    expect(onSave).not.toHaveBeenCalled();
    expect(renderer.root.findAllByProps({ testID: 'save-profile' })).toHaveLength(0);
  });

  it('saves the whole draft once and later discards back to that saved profile', async () => {
    const onSave = render();
    change('Username', 'new_june');
    press('randomize-persona');
    const chosenName = hero().props.accessibilityLabel;
    const chosenColor = previewColor();
    press('save-profile');
    await settle();

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0]).toMatchObject({ handle: '@new_june', color: chosenColor });
    expect(onSave.mock.calls[0][0].cryptidName).not.toBe(savedProfile().cryptidName);

    change('Username', 'another_name');
    press('randomize-persona');
    press('discard-profile');
    expect(input('Username').props.value).toBe('new_june');
    expect(hero().props.accessibilityLabel).toBe(chosenName);
    expect(previewColor()).toBe(chosenColor);
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('uses identical username guidance and validation copy, and blocks invalid saves', async () => {
    const onSave = render();
    expect(text()).toContain(USERNAME_GUIDANCE);
    change('Username', '_invalid');
    const guidance = renderer.root
      .findAllByType(ThemedText)
      .filter((node) => node.props.children === USERNAME_GUIDANCE);
    expect(guidance).toHaveLength(1);
    expect(guidance[0].props.accessibilityLiveRegion).toBe('polite');
    expect(find('save-profile').props.disabled).toBe(true);
    press('save-profile');
    await settle();
    expect(onSave).not.toHaveBeenCalled();
    press('discard-profile');
    expect(input('Username').props.value).toBe('june');
  });

  it.each([
    ['Custom profile icon name', ''],
    ['Custom ASCII profile icon', '👁'],
  ])('prevents saving invalid %s and permits discarding it', async (label, value) => {
    const onSave = render();
    openIcon();
    change(label, value);
    expect(find('save-profile').props.disabled).toBe(true);
    press('save-profile');
    await settle();
    expect(onSave).not.toHaveBeenCalled();
    press('discard-profile');
    expect(renderer.root.findAllByProps({ testID: 'save-profile' })).toHaveLength(0);
  });

  it('does not persist unsaved changes when leaving through settings or unmounting', async () => {
    const onDone = jest.fn();
    const onSave = render({ onDone });
    change('Username', 'new_june');
    press('randomize-persona');
    act(() => input('Back to settings').props.onPress());
    expect(onDone).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
    await waitForAutosave();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('retains the draft after a failed save so it can be retried or discarded', async () => {
    const onSave = jest
      .fn()
      .mockRejectedValueOnce(new Error('Storage is unavailable'))
      .mockResolvedValue(undefined);
    render({ onSave });
    change('Username', 'new_june');
    press('save-profile');
    await settle();
    expect(text()).toContain('Storage is unavailable');
    expect(input('Username').props.value).toBe('new_june');
    expect(find('save-profile').props.disabled).toBe(false);
    press('save-profile');
    await settle();
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(renderer.root.findAllByProps({ testID: 'save-profile' })).toHaveLength(0);
    expect(text()).not.toContain('Storage is unavailable');
  });

  it('prevents duplicate saves and freezes editing while a save is pending', async () => {
    let resolveSave!: () => void;
    const onSave = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        })
    );
    render({ onSave });
    change('Username', 'new_june');
    press('save-profile');
    expect(find('save-profile').props.disabled).toBe(true);
    expect(find('discard-profile').props.disabled).toBe(true);
    expect(find('randomize-persona').props.disabled).toBe(true);
    expect(input('Username').props.editable).toBe(false);
    press('save-profile');
    expect(onSave).toHaveBeenCalledTimes(1);
    await act(async () => resolveSave());
    expect(renderer.root.findAllByProps({ testID: 'save-profile' })).toHaveLength(0);
  });

  it('starts onboarding with a rolled persona but saves only when Continue is pressed', async () => {
    const onDone = jest.fn();
    const onSave = render({ mode: 'onboarding', initialProfile: null, onDone });
    expect(hero().props.accessibilityLabel).not.toBe('Profile icon: Custom icon');
    expect(find('onboarding-continue').props.disabled).toBe(true);
    press('randomize-persona');
    change('Username', 'first_profile');
    await waitForAutosave();
    expect(onSave).not.toHaveBeenCalled();
    expect(renderer.root.findAllByProps({ testID: 'save-profile' })).toHaveLength(0);
    press('onboarding-continue');
    await settle();
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0].handle).toBe('@first_profile');
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('waits for first-profile persistence before completing onboarding', async () => {
    let resolveSave!: () => void;
    const onSave = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        })
    );
    const onDone = jest.fn();
    render({ mode: 'onboarding', initialProfile: null, onSave, onDone });
    change('Username', 'first_profile');
    press('onboarding-continue');
    expect(find('onboarding-continue').props.disabled).toBe(true);
    expect(onDone).not.toHaveBeenCalled();
    press('onboarding-continue');
    expect(onSave).toHaveBeenCalledTimes(1);
    await act(async () => resolveSave());
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('keeps onboarding open if saving fails', async () => {
    const onSave = jest.fn().mockRejectedValue(new Error('Storage is unavailable'));
    const onDone = jest.fn();
    render({ mode: 'onboarding', initialProfile: null, onSave, onDone });
    change('Username', 'first_profile');
    press('onboarding-continue');
    await settle();
    expect(onDone).not.toHaveBeenCalled();
    expect(find('onboarding-continue').props.disabled).toBe(false);
    expect(text()).toContain('Storage is unavailable');
  });

  it('keeps every rolled color at full brightness', () => {
    render();
    for (let roll = 0; roll < 25; roll += 1) {
      press('randomize-persona');
      expect(fullBrightnessColor(previewColor())).toBe(previewColor());
    }
  });

  it('does not offer the generator on iOS', () => {
    render();
    openIcon();
    expect(
      renderer.root.findAllByProps({ accessibilityLabel: 'Generate a profile icon' })
    ).toHaveLength(0);
    expect(renderer.root.findAllByType(CryptidGeneratorDialog)).toHaveLength(0);
  });

  it('retains the Android generator but stages generated icons until Save', async () => {
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
    const onSave = render();
    openIcon();
    act(() => input('Generate a profile icon').props.onPress());
    expect(renderer.root.findByType(CryptidGeneratorDialog).props.visible).toBe(true);
    act(() =>
      renderer.root.findByType(CryptidGeneratorDialog).props.onUse({
        name: 'Generated Owl',
        sigil: '(o.o)',
      })
    );
    await waitForAutosave();
    expect(onSave).not.toHaveBeenCalled();
    expect(input('Custom profile icon name').props.value).toBe('Generated Owl');
    press('discard-profile');
    expect(input('Custom profile icon name').props.value).toBe(savedProfile().cryptidName);
  });
});
