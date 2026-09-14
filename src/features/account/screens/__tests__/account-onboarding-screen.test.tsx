import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { DeliveryOptions } from '@/features/settings/components/delivery-options';
import { InMemoryKV } from '@/features/social/net/background/persistent-kv';
import {
  loadDeliveryMode,
  saveDeliveryMode,
  saveStashOptIn,
} from '@/features/social/net/persistence';

import { CryptidProfileEditor } from '../../components/cryptid-profile-editor';
import type { CryptidProfile } from '../../core/profile';
import { AccountOnboardingScreen } from '../account-onboarding-screen';

jest.mock('@/global.css', () => ({}));
jest.mock('expo-router', () => ({ useRouter: () => ({ back: jest.fn() }) }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
let mockStashConfigured = true;
jest.mock('iroh-location', () => ({
  getStashConfig: () =>
    mockStashConfigured ? { baseUrl: 'https://stash.example.test', ticket: 'test-ticket' } : null,
}));
jest.mock('../../components/cryptid-profile-editor', () => ({
  CryptidProfileEditor: () => null,
}));
jest.mock('@/features/settings/components/delivery-options', () => ({
  DeliveryOptions: () => null,
}));

const mockSaveProfile = jest.fn();
let mockKV = new InMemoryKV();
jest.mock('../../hooks/use-cryptid-profile', () => ({
  useCryptidProfile: () => ({ profile: null, error: null, saveProfile: mockSaveProfile }),
}));
jest.mock('@/features/social/net/persistence', () => ({
  ...jest.requireActual('@/features/social/net/persistence'),
  createPersistentKV: () => mockKV,
}));

const PROFILE: CryptidProfile = {
  version: 1,
  handle: '@cryptid',
  cryptidName: 'Moth',
  sigil: '(oo)',
  color: '#00FFFF',
  presetId: null,
};

describe('delivery onboarding', () => {
  let renderer: ReactTestRenderer;
  const onSaveStart = jest.fn();
  const onComplete = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    mockKV = new InMemoryKV();
    mockStashConfigured = true;
    mockSaveProfile.mockResolvedValue(PROFILE);
  });
  afterEach(() => {
    act(() => renderer?.unmount());
  });

  async function render() {
    await act(async () => {
      renderer = create(
        <AccountOnboardingScreen onSaveStart={onSaveStart} onComplete={onComplete} />
      );
    });
  }

  async function openDelivery() {
    await act(async () => {
      const editor = renderer.root.findByType(CryptidProfileEditor);
      await editor.props.onSave(PROFILE);
      editor.props.onDone();
    });
    return renderer.root.findAllByType(DeliveryOptions)[0];
  }

  async function finish() {
    await act(async () => {
      renderer.root.findByProps({ testID: 'onboarding-delivery-continue' }).props.onPress();
    });
  }

  it('defaults new users to stash and does not complete after the profile step', async () => {
    await render();
    const delivery = await openDelivery();
    expect(delivery.props.selected).toBe('stash');
    expect(mockSaveProfile).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('writes delivery before the profile completion marker', async () => {
    mockSaveProfile.mockImplementation(async () => {
      expect(await loadDeliveryMode(mockKV)).toBe('stash');
      expect(onSaveStart).toHaveBeenCalledTimes(1);
      return PROFILE;
    });
    await render();
    await openDelivery();
    await finish();
    expect(mockSaveProfile).toHaveBeenCalledWith(PROFILE);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it.each(['explicit', 'legacy'])('preserves an existing %s mutual choice', async (kind) => {
    if (kind === 'explicit') await saveDeliveryMode(mockKV, 'mutual');
    else await saveStashOptIn(mockKV, false);
    await render();
    expect((await openDelivery()).props.selected).toBe('mutual');
    await finish();
    expect(await loadDeliveryMode(mockKV)).toBe('mutual');
  });

  it('persists a changed route and keeps the draft when going back', async () => {
    await render();
    const delivery = await openDelivery();
    act(() => {
      delivery.props.onSelect('mutual');
      renderer.root.findByProps({ accessibilityLabel: 'Back to profile' }).props.onPress();
    });
    const editor = renderer.root.findByType(CryptidProfileEditor);
    expect(editor.props.initialProfile).toEqual(PROFILE);
    act(() => editor.props.onDone());
    expect(renderer.root.findByType(DeliveryOptions).props.selected).toBe('mutual');
    await finish();
    expect(await loadDeliveryMode(mockKV)).toBe('mutual');
  });

  it('keeps setup open after a failed profile save and permits retry', async () => {
    mockSaveProfile.mockRejectedValueOnce(new Error('full'));
    await render();
    await openDelivery();
    await finish();
    expect(onComplete).not.toHaveBeenCalled();
    expect(renderer.root.findByType(DeliveryOptions)).toBeTruthy();
    expect(JSON.stringify(renderer.toJSON())).toContain('Could not finish setup');
    await finish();
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('does not save a profile if delivery persistence fails', async () => {
    jest.spyOn(mockKV, 'set').mockRejectedValueOnce(new Error('full'));
    await render();
    await openDelivery();
    await finish();
    expect(mockSaveProfile).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('waits for preferences to load and can retry a failed read without overwriting a choice', async () => {
    await saveDeliveryMode(mockKV, 'mutual');
    jest.spyOn(mockKV, 'get').mockRejectedValueOnce(new Error('busy'));
    await render();
    await openDelivery();
    expect(renderer.root.findAllByType(DeliveryOptions)).toHaveLength(0);
    expect(
      renderer.root.findByProps({ testID: 'onboarding-delivery-continue' }).props.disabled
    ).toBe(true);
    await finish();
    expect(mockSaveProfile).not.toHaveBeenCalled();
    await act(async () => {
      renderer.root
        .findByProps({ accessibilityLabel: 'Retry loading delivery preferences' })
        .props.onPress();
    });
    expect(renderer.root.findByType(DeliveryOptions).props.selected).toBe('mutual');
    expect(
      renderer.root.findByProps({ testID: 'onboarding-delivery-continue' }).props.disabled
    ).toBe(false);
  });

  it('does not show a transient stash selection while a saved choice is hydrating', async () => {
    let resolveRead!: (value: string) => void;
    jest.spyOn(mockKV, 'get').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        })
    );
    await render();
    await openDelivery();
    expect(renderer.root.findAllByType(DeliveryOptions)).toHaveLength(0);
    expect(JSON.stringify(renderer.toJSON())).toContain('Loading delivery preferences');
    expect(
      renderer.root.findByProps({ testID: 'onboarding-delivery-continue' }).props.disabled
    ).toBe(true);
    await act(async () => resolveRead('mutual'));
    expect(renderer.root.findByType(DeliveryOptions).props.selected).toBe('mutual');
  });

  it('keeps the new default visible when this build has no stash', async () => {
    mockStashConfigured = false;
    await render();
    const delivery = await openDelivery();
    expect(delivery.props.selected).toBe('stash');
    expect(delivery.props.availability).toEqual({ stashConfigured: false });
    await finish();
    expect(await loadDeliveryMode(mockKV)).toBe('stash');
  });
});
