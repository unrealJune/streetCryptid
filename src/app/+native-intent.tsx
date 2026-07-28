interface NativeIntentOptions {
  path: string;
  initial: boolean;
}

/**
 * There is one screen now, so every pair link lands on the map. The map opens the
 * friends island and redeems the token; `/social` no longer exists, but old links
 * in the wild still use it and must keep working.
 */
export function redirectSystemPath({ path }: NativeIntentOptions): string {
  try {
    const url = new URL(path, 'streetcryptid:///');
    if (url.protocol !== 'streetcryptid:') return path;

    const route = url.hostname || url.pathname.replace(/^\/+/, '').split('/')[0];
    if (route !== 'social' && route !== 'pair') return path;

    const token = url.searchParams.get('token');
    return token ? `/?pair=${encodeURIComponent(token)}` : '/';
  } catch {
    return path;
  }
}
