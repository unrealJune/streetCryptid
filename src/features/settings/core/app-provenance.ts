import * as Application from 'expo-application';
import Constants from 'expo-constants';

interface EmbeddedBuildProvenance {
  buildId?: unknown;
  commit?: unknown;
  profile?: unknown;
}

export interface AppProvenance {
  appVersion: string | null;
  buildId: string | null;
  buildVersion: string | null;
  commit: string | null;
  profile: string | null;
  runtimeVersion: string | null;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function getAppProvenance(): AppProvenance {
  const embedded = Constants.expoConfig?.extra?.buildProvenance as
    | EmbeddedBuildProvenance
    | undefined;

  return {
    appVersion: Application.nativeApplicationVersion ?? Constants.expoConfig?.version ?? null,
    buildVersion: Application.nativeBuildVersion,
    commit: optionalString(embedded?.commit),
    buildId: optionalString(embedded?.buildId),
    profile: optionalString(embedded?.profile),
    runtimeVersion: Constants.expoRuntimeVersion,
  };
}
