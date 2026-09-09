import type { PersistentKV } from '@/features/social/net/background/persistent-kv';
import {
  dialBudgetMs,
  foldObservation,
  initialReachability,
  type PeerKind,
  type PeerReachability,
} from '@/features/social/core/peer-reachability';
import type { PresenceState } from '@/features/social/core/presence';

/**
 * Durable memory for the per-peer dial budgets — what each peer did, the last several times we
 * pushed to it, in each presence state.
 *
 * Persisted rather than held in memory because the pushes that matter happen on **headless wakes**:
 * a background process lives for seconds and dies, so an in-memory estimate would be re-seeded from
 * the prior on every single wake and would never learn anything. The whole model turns on
 * accumulating across processes.
 */

/** Where the map lives in {@link PersistentKV}. */
export const PEER_REACHABILITY_KEY = 'social.peer-reachability.v1';

/**
 * The stash's endpoint id, learned rather than configured.
 *
 * JS holds the stash as an opaque iroh ticket and does not parse it, so we cannot know its endpoint
 * id before the first push. The push reports come back keyed by endpoint hex, so any reported peer
 * that is not a known friend is the stash — remember it and the next push can look its history up
 * directly. Self-healing: point the app at a different stash and it relearns on the next push.
 */
export const STASH_PEER_KEY = 'social.stash-endpoint.v1';

/** Reachability keyed `"<endpointHex>|<presenceState>"`. See {@link reachabilityKey}. */
export type ReachabilityMap = Record<string, PeerReachability>;

/**
 * Conditioning on the presence state, not just the peer, is the point of the model.
 *
 * "Parked" does not mean the same thing on both platforms — an Android phone parked behind the
 * location foreground service still answers immediately, a parked iPhone is riding `BGProcessing`
 * wakes and is not there — so the same peer needs separate estimates per state. That is what lets
 * the two diverge from observation without the model ever naming a platform.
 */
export function reachabilityKey(endpointHex: string, presence: PresenceState): string {
  return `${endpointHex.trim().toLowerCase()}|${presence}`;
}

/** Read the persisted map. A malformed or absent value is an empty map, never a throw. */
export async function loadReachability(kv: PersistentKV): Promise<ReachabilityMap> {
  try {
    const raw = await kv.get(PEER_REACHABILITY_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as ReachabilityMap;
  } catch {
    // A corrupt estimate is not worth failing a push over; the priors are a safe fallback.
    return {};
  }
}

/** Persist the map. Best-effort: losing an update costs accuracy, never delivery. */
export async function saveReachability(kv: PersistentKV, map: ReachabilityMap): Promise<void> {
  try {
    await kv.set(PEER_REACHABILITY_KEY, JSON.stringify(map));
  } catch {
    // Ignored on purpose — see the doc comment.
  }
}

/** The stash endpoint id we learned on a previous push, if any. */
export async function loadStashPeer(kv: PersistentKV): Promise<string | null> {
  try {
    return await kv.get(STASH_PEER_KEY);
  } catch {
    return null;
  }
}

/** Remember the stash's endpoint id once a push report reveals it. */
export async function saveStashPeer(kv: PersistentKV, endpointHex: string): Promise<void> {
  try {
    await kv.set(STASH_PEER_KEY, endpointHex.trim().toLowerCase());
  } catch {
    // Ignored on purpose — the next push simply relearns it.
  }
}

/** One peer we are about to push to, with everything needed to budget and then to learn. */
export interface PlannedDial {
  ticket: string;
  /** `null` for the stash before its endpoint id has ever been observed. */
  endpointHex: string | null;
  kind: PeerKind;
  presence: PresenceState;
  budgetMs: number;
}

/**
 * Decide what to grant each peer. Pure, so the decision is testable without a node or a store.
 *
 * A peer whose budget comes out zero is still included: {@link PlannedDial} carries it through to
 * the native call, which hands it the data via the live engine and records it as `skipped` rather
 * than pretending it was never considered. Dropping it here would make the model unauditable.
 */
export function planDials(
  peers: readonly {
    ticket: string;
    endpointHex: string | null;
    kind: PeerKind;
    presence: PresenceState;
  }[],
  reachability: ReachabilityMap
): PlannedDial[] {
  return peers.map((peer) => {
    const history = peer.endpointHex
      ? reachability[reachabilityKey(peer.endpointHex, peer.presence)]
      : undefined;
    return {
      ...peer,
      budgetMs: dialBudgetMs({ kind: peer.kind, presence: peer.presence, history }),
    };
  });
}

/** One row as the native push reports it. Mirrors `NativePeerPushReport`. */
export interface DialOutcome {
  peer: string;
  outcome: 'finished' | 'failed' | 'silent' | 'skipped';
  latencyMs?: number | null;
  entriesSent: number;
  budgetMs: number;
}

/**
 * Fold a push's reports back into the map.
 *
 * `skipped` rows are deliberately NOT folded. We never dialled those peers, so they carry no
 * evidence about whether they would have answered — learning from them would be the model marking
 * its own homework, and a peer that dropped to a zero budget once could never climb back out.
 * Their `presence` still moves over time, and a different state has its own estimate, which is what
 * lets a peer recover.
 */
export function foldOutcomes(
  reachability: ReachabilityMap,
  planned: readonly PlannedDial[],
  outcomes: readonly DialOutcome[],
  now: number
): ReachabilityMap {
  const byEndpoint = new Map<string, PlannedDial>();
  for (const dial of planned) {
    if (dial.endpointHex) byEndpoint.set(dial.endpointHex.trim().toLowerCase(), dial);
  }
  const next: ReachabilityMap = { ...reachability };
  for (const outcome of outcomes) {
    if (outcome.outcome === 'skipped') continue;
    const endpointHex = outcome.peer.trim().toLowerCase();
    const dial = byEndpoint.get(endpointHex);
    // A peer we could not match back to a plan is still worth learning from — it is how the stash
    // is recognised on the very first push, before its endpoint id is known.
    const presence: PresenceState = dial?.presence ?? 'unknown';
    const kind: PeerKind = dial?.kind ?? 'stash';
    const key = reachabilityKey(endpointHex, presence);
    const current = next[key] ?? initialReachability(kind, presence, now);
    next[key] = foldObservation(current, {
      answered: outcome.outcome === 'finished',
      latencyMs: typeof outcome.latencyMs === 'number' ? outcome.latencyMs : undefined,
      at: now,
    });
  }
  return next;
}

/**
 * Which reported peer is the stash: the one that is not a friend we planned a dial for.
 *
 * Returns `null` when every reported peer is accounted for, so a deployment with no stash never
 * mislabels a friend as one.
 */
export function inferStashPeer(
  outcomes: readonly DialOutcome[],
  friendEndpointHexes: readonly string[]
): string | null {
  const friends = new Set(friendEndpointHexes.map((hex) => hex.trim().toLowerCase()));
  for (const outcome of outcomes) {
    const endpointHex = outcome.peer.trim().toLowerCase();
    if (!friends.has(endpointHex)) return endpointHex;
  }
  return null;
}
