/**
 * Client-side config for the optional **trail stash** — an always-on, ciphertext-blind iroh-docs
 * replica that lets friends exchange trails even when they're never online at the same time
 * (see `infra/trail-stash/`). Unlike the relay config this is **optional**: if a deployment doesn't
 * provide a stash, {@link getStashConfig} returns `null` and the app runs exactly as before
 * (peer-only reconciliation). Being configured only means a stash is *available*; whether to use it
 * is a separate, per-user **opt-in** (persisted in the social feature).
 */

export interface StashConfig {
  /** Base URL of the stash HTTP control API (`EXPO_PUBLIC_TRAIL_STASH_URL`). */
  baseUrl: string;
  /** The stash node's endpoint ticket — added to bootstrap sets so the node can dial it. */
  ticket: string;
  /** Pre-shared key for the control API (`EXPO_PUBLIC_TRAIL_STASH_PSK`), or null if none. */
  psk: string | null;
}

function normalizeBaseUrl(url: string | undefined): string | null {
  const trimmed = url?.trim();
  if (!trimmed) return null;
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
}

/**
 * Resolve the stash config from the environment, or `null` when the feature isn't deployed. Both a
 * base URL (for grants) and a ticket (for reconciliation) are required — one without the other is
 * useless, so a partial config is treated as "not configured".
 */
export function getStashConfig(env: NodeJS.ProcessEnv = process.env): StashConfig | null {
  const baseUrl = normalizeBaseUrl(env.EXPO_PUBLIC_TRAIL_STASH_URL);
  const ticket = env.EXPO_PUBLIC_TRAIL_STASH_TICKET?.trim();
  if (!baseUrl || !ticket) return null;

  const psk = env.EXPO_PUBLIC_TRAIL_STASH_PSK?.trim();
  return { baseUrl, ticket, psk: psk && psk.length > 0 ? psk : null };
}
