import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Text } from 'react-native';

import { AppProvenanceDetails } from '../app-provenance';

jest.mock('@/global.css', () => ({}));

describe('AppProvenanceDetails', () => {
  let renderer: ReactTestRenderer;

  afterEach(() => {
    act(() => renderer?.unmount());
  });

  it('shows available version and build provenance', () => {
    act(() => {
      renderer = create(
        <AppProvenanceDetails
          provenance={{
            appVersion: '1.2.3',
            buildVersion: '42',
            commit: '88f28ab5ea39108ade978de2d0d1adeedf0ece76',
            buildId: 'f51831f0-ea30-406a-8c5f-f8e1cc57d39c',
            profile: 'production',
            runtimeVersion: null,
          }}
        />
      );
    });

    const text = renderer.root.findAllByType(Text).map((node) => node.props.children);
    expect(text).toEqual(
      expect.arrayContaining([
        'App version',
        '1.2.3',
        'Native build',
        '42',
        'Commit',
        '88f28ab5ea39108ade978de2d0d1adeedf0ece76',
        'EAS build',
        'f51831f0-ea30-406a-8c5f-f8e1cc57d39c',
        'Build profile',
        'production',
      ])
    );
    expect(text).not.toContain('Runtime');
  });
});
