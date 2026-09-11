import { decodePairLink, isWebPairLink } from '@/features/social/core/pair-link';

interface NativeIntentOptions {
  path: string;
  initial: boolean;
}

/**
 * Every pair link lands on the active pairing screen immediately, before the
 * sharing service is ready or the SAS challenge has arrived.
 *
 * Invites now arrive as `https://streetcrypt.id/pair#token=…` — an App Link on
 * Android, a Universal Link on iOS — because a messaging app only linkifies a
 * fixed set of schemes and never made the `streetcryptid://` form tappable. That
 * shape is handled by the codec rather than `URL` here: the token rides in the
 * fragment, and React Native's `URL` shim does not reliably expose `.hash`.
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
  const trimmed = path.trim();
  if (isWebPairLink(trimmed)) {
    try {
      return `/pairing?token=${encodeURIComponent(decodePairLink(trimmed))}`;
    } catch {
      // A claimed URL with no usable token: the /pair page it would otherwise have
      // reached is not available to us, so open the map rather than nothing.
      return '/';
    }
  }

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
    return token ? `/pairing?token=${encodeURIComponent(token)}` : '/pairing';
  } catch {
    return path;
  }
}
