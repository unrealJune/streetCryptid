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

/**
 * PR builds override the marketing version so each upload is strictly newer than
 * the last one a tester installed.
 *
 * iOS silently declines an `itms-services` OTA install whose manifest
 * `bundle-version` is not greater than the copy already on the device — no
 * prompt, no error, the Install button just does nothing until the app is
 * deleted. The internal distribution server fills that manifest field from
 * `CFBundleShortVersionString` (the marketing version), not `CFBundleVersion`,
 * so bumping `ios.buildNumber` does not help: the manifest comes out byte-identical.
 *
 * Leaving `expo.version` at its app.json value therefore stamps every PR build
 * with the same version, and testers can install exactly one of them.
 * `pr-development-builds.yml` sets this to `<run_number>.<run_attempt>.0`, which
 * never repeats and never decreases across PRs. It is unset everywhere else, so
 * release builds keep the real version app.json carries.
 *
 * The run number leads deliberately. Which installed key iOS compares the
 * manifest's `bundle-version` against is not something Apple documents clearly:
 * the field name matches `CFBundleVersion`, while the value this server puts
 * there comes from `CFBundleShortVersionString`. That distinction bites because
 * `appVersionSource: "remote"` plus `autoIncrement: false` on the
 * `production-internal-*` profiles has pinned `CFBundleVersion` at 45 for every
 * build this workflow has ever produced. A `1.<run_number>.<run_attempt>` scheme
 * loses to that 45 on the first component and installs nothing; leading with the
 * run number clears 45 and the installed `1.3.x` marketing version at once, so
 * the comparison resolves the same way whichever key iOS actually reads.
 *
 * Consequence, accepted deliberately: a device holding a PR build cannot upgrade
 * in place to an App Store release, because `<run_number>.x.0` outranks any real
 * version. That crossing already required a delete — the two are signed with
 * different keys.
 */
function prBuildVersion(): string | undefined {
  const version = process.env.SC_PR_BUILD_VERSION;
  if (!version) {
    return undefined;
  }

  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(
      `SC_PR_BUILD_VERSION must be MAJOR.MINOR.PATCH, got "${version}". ` +
        'iOS only accepts period-separated integers in CFBundleShortVersionString.'
    );
  }

  return version;
}

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
  version: prBuildVersion() ?? config.version,
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
