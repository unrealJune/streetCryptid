import { copySegments } from '@/components/copy-text';

jest.mock('expo-web-browser', () => ({
  openBrowserAsync: jest.fn(),
  WebBrowserPresentationStyle: {},
}));

describe('copySegments', () => {
  it('splits Markdown links out of a paragraph', () => {
    expect(copySegments('Read more on our [website](https://streetcrypt.id), today.')).toEqual([
      { text: 'Read more on our ' },
      { text: 'website', href: 'https://streetcrypt.id' },
      { text: ', today.' },
    ]);
  });

  it('leaves text without a web link alone', () => {
    expect(copySegments('A [note] (not a link) and [x](javascript:alert)')).toEqual([
      { text: 'A [note] (not a link) and [x](javascript:alert)' },
    ]);
  });
});
