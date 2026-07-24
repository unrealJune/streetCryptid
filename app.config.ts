import { execFileSync } from 'node:child_process';

import type { ConfigContext, ExpoConfig } from 'expo/config';

/**
 * The `development` (dev-client) build allows cleartext ATS loads to Tailscale
 * MagicDNS names (`*.ts.net`), so the dev client can reach Metro over the tailnet.
 * Requires your tailnet to have MagicDNS enabled (DNS only; HTTPS certs not needed).
 * ATS can only scope cleartext by hostname, not by IP range, so this targets the
 * MagicDNS name rather than the tailnet IP.
 *
 * Scoped to the `development` profile only.
 */
const IS_DEV_CLIENT = process.env.EAS_BUILD_PROFILE === 'development';

function gitCommit(): string | undefined {
  if (process.env.EAS_BUILD_GIT_COMMIT_HASH) {
    return process.env.EAS_BUILD_GIT_COMMIT_HASH;
  }

  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return undefined;
  }
}

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: config.name ?? 'streetCryptid',
  slug: config.slug ?? 'streetCryptid',
  ios: {
    ...config.ios,
    infoPlist: {
      ...config.ios?.infoPlist,
      ...(IS_DEV_CLIENT
        ? {
            NSAppTransportSecurity: {
              NSExceptionDomains: {
                'ts.net': {
                  NSIncludesSubdomains: true,
                  NSExceptionAllowsInsecureHTTPLoads: true,
                },
              },
            },
          }
        : {}),
    },
  },
  extra: {
    ...config.extra,
    buildProvenance: {
      buildId: process.env.EAS_BUILD_ID,
      commit: gitCommit(),
      profile: process.env.EAS_BUILD_PROFILE,
    },
  },
});
