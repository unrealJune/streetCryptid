interface NativeIntentOptions {
  path: string;
  initial: boolean;
}

export function redirectSystemPath({ path }: NativeIntentOptions): string {
  try {
    const url = new URL(path, 'streetcryptid:///');
    if (url.protocol !== 'streetcryptid:') return path;

    const route = url.hostname || url.pathname.replace(/^\/+/, '').split('/')[0];
    if (route !== 'social' && route !== 'pair') return path;

    const token = url.searchParams.get('token');
    return token ? `/social?token=${encodeURIComponent(token)}` : '/social';
  } catch {
    return path;
  }
}
