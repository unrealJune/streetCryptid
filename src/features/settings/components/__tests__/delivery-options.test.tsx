import { Platform } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { DeliveryOptions } from '../delivery-options';

jest.mock('@/global.css', () => ({}));
jest.mock('../delivery-preview', () => ({ DeliveryPreview: () => null }));

describe('DeliveryOptions', () => {
  let renderer: ReactTestRenderer;
  afterEach(() => {
    act(() => renderer?.unmount());
  });

  it('shows the platform-specific mutual friend relay warning without secondary copy', () => {
    act(() => {
      renderer = create(
        <DeliveryOptions
          selected="mutual"
          availability={{ stashConfigured: true }}
          onSelect={jest.fn()}
        />
      );
    });
    const json = JSON.stringify(renderer.toJSON());
    expect(json).toContain('Mutual friend relay');
    expect(json).toContain(`background processing on ${Platform.OS === 'ios' ? 'iOS' : 'Android'}`);
    expect(json).not.toContain('They cannot read');
    expect(json).not.toContain('shared pool');
  });

  it('names stash honestly and keeps unavailable stored choices visible', () => {
    act(() => {
      renderer = create(
        <DeliveryOptions
          selected="stash"
          availability={{ stashConfigured: false }}
          onSelect={jest.fn()}
        />
      );
    });
    const json = JSON.stringify(renderer.toJSON());
    expect(json).toContain('Mutuals + Stash Server');
    expect(json).toContain('Stash entries are encrypted');
    expect(json).toContain('No stash server is configured');
    expect(json).not.toContain('30 minutes');
  });
});
