import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { ExplorationBackupRow } from '../exploration-backup-row';

jest.mock('@/global.css', () => ({}));

const COLORS = { accent: '#2f9e6a', warningColor: '#f2ad42' };

function press(renderer: ReactTestRenderer, label: string): void {
  renderer.root.findByProps({ accessibilityLabel: label }).props.onPress();
}

function hasText(renderer: ReactTestRenderer, text: string): boolean {
  return renderer.root.findAllByProps({ children: text }).length > 0;
}

describe('ExplorationBackupRow', () => {
  let renderer: ReactTestRenderer;

  afterEach(() => {
    act(() => renderer?.unmount());
  });

  async function render(props: Partial<React.ComponentProps<typeof ExplorationBackupRow>> = {}) {
    await act(async () => {
      renderer = create(
        <ExplorationBackupRow
          {...COLORS}
          busy={false}
          onExport={async () => ({ status: 'empty' })}
          onRestore={async () => ({ status: 'canceled' })}
          {...props}
        />
      );
    });
    return renderer;
  }

  it('reports how many hexes were backed up', async () => {
    const onExport = jest.fn(async () => ({ status: 'shared' as const, cells: 1234 }));
    await render({ onExport });
    await act(async () => press(renderer, 'Back up explored hexes'));
    expect(onExport).toHaveBeenCalled();
    expect(hasText(renderer, `Backed up ${(1234).toLocaleString()} hexes.`)).toBe(true);
  });

  it('says there is nothing to back up yet', async () => {
    await render();
    await act(async () => press(renderer, 'Back up explored hexes'));
    expect(hasText(renderer, 'Nothing to back up yet — go uncover some hexes.')).toBe(true);
  });

  it('reports restored, already-known and unreadable counts', async () => {
    const onRestore = jest.fn(async () => ({
      status: 'restored' as const,
      added: 2,
      skipped: 3,
      rejected: 1,
    }));
    await render({ onRestore });
    await act(async () => press(renderer, 'Restore explored hexes'));
    expect(hasText(renderer, 'Restored 2 hexes, 3 already known, 1 unreadable.')).toBe(true);
  });

  it('leaves the status idle when the picker is cancelled', async () => {
    await render();
    await act(async () => press(renderer, 'Restore explored hexes'));
    expect(hasText(renderer, 'Ready')).toBe(true);
  });

  it('shows a failure message from a bad file', async () => {
    const onRestore = jest.fn(async () => ({
      status: 'failed' as const,
      message: 'That file is not a streetCryptid backup.',
    }));
    await render({ onRestore });
    await act(async () => press(renderer, 'Restore explored hexes'));
    expect(hasText(renderer, 'That file is not a streetCryptid backup.')).toBe(true);
  });

  it('disables both actions while a backup action runs', async () => {
    await render({ busy: true });
    expect(
      renderer.root.findByProps({ accessibilityLabel: 'Back up explored hexes' }).props.disabled
    ).toBe(true);
    expect(
      renderer.root.findByProps({ accessibilityLabel: 'Restore explored hexes' }).props.disabled
    ).toBe(true);
  });
});
