import { defaultCryptidProfileDraft } from '../../core/profile';
import { InMemoryKV } from '@/features/social/net/background/fix-outbox';
import { createCryptidProfileStore } from '../profile-store';

describe('cryptid profile store', () => {
  it('persists custom ASCII art exactly', async () => {
    const store = createCryptidProfileStore(new InMemoryKV());
    const sigil = '  .---.  \n /     \\ \n|  o o  |\n \\  _  /  ';

    const saved = await store.save({
      ...defaultCryptidProfileDraft(),
      handle: 'signal_lost',
      cryptidName: 'Tunnel Oracle',
      sigil,
      presetId: null,
    });

    expect((await store.load())?.sigil).toBe(sigil);
    expect(await store.load()).toEqual(saved);
  });
});
