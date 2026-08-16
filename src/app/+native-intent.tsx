interface NativeIntentOptions {
  path: string;
  initial: boolean;
}

/**
 * There is one screen now, so every pair link lands on the map. The map opens the
 * friends island and redeems the token; `/social` no longer exists, but old links
 * in the wild still use it and must keep working.
 *
 * `streetcryptid://dev?cmd=…&id=…` is the second shape: the e2e harness's command
 * channel (`scripts/e2e/lib/device.sh`, `device_dev_command`). It rides the same
 * deep link the invite does because, unlike Maestro's `launchApp`, opening a URL
 * foregrounds a RUNNING app instead of terminating and relaunching it — so a test
 * can drive the app without tearing the iroh node down and paying a cold dial.
 * The `id` nonce is what lets an identical command be issued twice and observed
 * twice; see `useDevCommand`.
 *
 * Pure by contract: this is a sync path mapper, so it decides the route and
 * nothing else. Running the command is the map screen's job.
 */
export function redirectSystemPath({ path }: NativeIntentOptions): string {
  try {
    const url = new URL(path, 'streetcryptid:///');
    if (url.protocol !== 'streetcryptid:') return path;

    const route = url.hostname || url.pathname.replace(/^\/+/, '').split('/')[0];

    if (route === 'dev') {
      const cmd = url.searchParams.get('cmd');
      const id = url.searchParams.get('id');
      // Both halves or nothing: a command with no nonce could not be observed, and a
      // nonce with no command names nothing to run.
      if (!cmd || !id) return '/';
      return `/?dev=${encodeURIComponent(cmd)}&devId=${encodeURIComponent(id)}`;
    }

    if (route !== 'social' && route !== 'pair') return path;

    const token = url.searchParams.get('token');
    return token ? `/?pair=${encodeURIComponent(token)}` : '/';
  } catch {
    return path;
  }
}
