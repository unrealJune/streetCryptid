import { execFileSync } from 'node:child_process';

import type { ConfigContext, ExpoConfig } from 'expo/config';

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
  extra: {
    ...config.extra,
    buildProvenance: {
      buildId: process.env.EAS_BUILD_ID,
      commit: gitCommit(),
      profile: process.env.EAS_BUILD_PROFILE,
    },
  },
});
