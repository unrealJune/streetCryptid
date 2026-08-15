import { getRandomBytesAsync } from 'expo-crypto';
import { Platform } from 'react-native';

import {
  getIrohLocation,
  getStashConfig,
  tryGetIrohLocation,
  type BleCapabilities,
  type BlePeer,
  type IrohLocationNativeModule,
  type NativeControlMsg,
  type NativeLocationFix,
  type NativeRatchetEvent,
  type NodeKeys,
  type OnFixEvent,
  type OnOpaqueEvent,
  type PairEvent,
  type PairResult,
  type PairStateRecord,
  type ProfileView,
  type SasChallenge,
  type SasRole,
  type TransportDiagnostics,
} from 'iroh-location';

import {
  getOtelConfig,
  getTelemetry,
  recordEventLog,
  traceparentFor,
  type Span,
  type SpanContext,
} from '@/features/dev/telemetry';
import { encodeContactCard } from '../core/contact-card';
import { decodePairLink, encodePairLink, isPairLink, PAIR_TOKEN_PREFIX } from '../core/pair-link';
import {
  deriveLookupId,
  isPairingCode,
  mintPairingCode,
  openPairCapsule,
  sealPairToken,
  secretFromPairingCode,
} from '../core/pairing-code';
import { isPairingFigureIndex } from '../core/pairing-figures';
import * as pool from '../core/pool';
import { mergeProfileIntoFriend } from '../core/profile';
import type {
  ContactCard,
  Friend,
  IncomingFix,
  LocationFix,
  PairingMethod,
  RatchetAckKind,
  RatchetAckSource,
  RatchetActivity,
  SelfIdentity,
} from '../core/types';
import type { BackgroundLocationProvider } from './background/background-provider';
import type { BackgroundStartConfig } from './background/background-task';
import type { FixPublisher, LocationEngine } from './background/location-engine';
import { createTrailStore, type TrailPoint, type TrailStore } from './background/trail-store';
import type { PersistentKV } from './background/fix-outbox';
import {
  clampMailboxTtlSeconds,
  createDefaultPairingMailbox,
  type PairingMailbox,
} from './pairing-mailbox';
import {
  createPersistentKV,
  createPersistentTrailStorage,
  loadHandledNonces,
  loadPool,
  loadRatchetActivity,
  loadShareIntervalMs,
  loadStashOptIn,
  loadTransportPreferences,
  saveHandledNonces,
  savePool,
  saveRatchetActivity,
  saveShareIntervalMs,
  saveSharingEnabled,
  saveStashOptIn,
  saveTransportPreferences,
  SHARE_INTERVAL_OPTIONS_MS,
  type TransportPreferences,
  DEFAULT_TRANSPORT_PREFERENCES,
} from './persistence';
import { createAppLifecycleController } from './background/lifecycle';
import {
  awaitNativeRuntimeIdle,
  claimNativeRuntime,
  releaseNativeRuntime,
} from './background/native-runtime-owner';
import { DEFAULT_SAMPLING_CONFIG, DEFAULT_SHARE_INTERVAL_MS } from './background/sampling-policy';
import { createDefaultStashClient, type StashClient } from './stash-client';
import {
  activeWatchers,
  armWatcher,
  buildLiveCancel,
  buildLiveRequest,
  clampLiveTtl,
  disarmWatcher,
  evaluateControlMsg,
  liveUntil as liveUntilFrom,
  markHandled,
  mintNonce,
  LIVE_TTL_DEFAULT_MS,
  type HandledNonce,
  type RandomBytesFn,
  type WatcherSession,
} from './live-requests';
import { loadKeys, saveKeys } from './secure-keys';
import { loadSeq, saveSeq } from './state-store';

/**
 * A single live SAS verification the UI must resolve before a pair can complete. One entry per
 * concurrent pairing session in the `verifying` phase — kept as an array so multiple simultaneous
 * sessions are never silently collapsed. Reconciled from both `verifying` events and
 * `listPairSessions()` state, so an event missed while suspended is recovered on the next poll.
 */
export interface PairingVerification {
  /** The pairing session id (hex). */
  sessionId: string;
  /** The peer's ed25519 EndpointId (hex). */
  peerEndpointId: string;
  /** Whether this is an invite-less nearby pair (vs invite-based). */
  nearby: boolean;
  /** This side's SAS role: `displayer` shows the target figure, `picker` chooses it. */
  role: SasRole;
  /** Correct figure index — the displayer shows it; the picker must match it. */
  targetIndex: number;
  /** The picker's shuffled figure indices (includes the target). */
  optionIndices: number[];
  /** Absolute wall-clock deadline (ms since epoch) — native timeout is authoritative. */
  deadlineMs: number;
  /** Whether this side's human already cleared the SAS gate (submitted a choice / confirmed). */
  localConfirmed: boolean;
  /** Whether the peer's SAS reveal verified (the gate is live). */
  peerVerified: boolean;
}

export type BumpStage = 'idle' | 'armed' | 'searching' | 'contact' | 'failed';

export interface BumpSnapshot {
  stage: BumpStage;
  expiresAt: number | null;
  rssi: number | null;
  peerCount: number;
  error: string | null;
}

/** An immutable view of the bilateral-pairing state for the UI. See ARCHITECTURE.md §2, §4. */
export interface PairingSnapshot {
  /** Whether bilateral pairing is usable here at all (native dev client; false on web/Expo Go). */
  available: boolean;
  /** Whether we currently accept invite-less nearby (BLE) pairing Hellos. */
  ready: boolean;
  /** Honest BLE capability report (null until first polled / when unavailable). */
  capabilities: BleCapabilities | null;
  /** Nearby BLE peers surfaced by the transport snapshot. */
  nearbyPeers: BlePeer[];
  /** All known pairing sessions and their coarse state. */
  sessions: PairStateRecord[];
  /** Incoming pair requests awaiting the user's accept/reject. */
  pendingRequests: PairEvent[];
  /**
   * Live SAS verifications the user must resolve (one per concurrent `verifying` session). The
   * mandatory visual gate before any pair completes — pick or confirm the figure to advance.
   */
  verifications: PairingVerification[];
  /** Explicit foreground Bump rendezvous state. */
  bump: BumpSnapshot;
  /** The friend most recently completed through pairing, until the reveal is acknowledged/rejected. */
  discoveredFriend: Friend | null;
  /** The most recently minted invite link (`streetcryptid:///social?token=…`), if any. */
  inviteLink: string | null;
  /**
   * The most recently minted short pairing code (`XXXX-XXXX-XXXX-XXXX`), if any. Optional so that
   * pre-existing snapshot literals (constructed before this field existed) remain valid; the
   * service always populates it in {@link LocationSharingService.pairingSnapshot}.
   */
  inviteCode?: string | null;
  /**
   * Whether the encrypted pairing mailbox is configured and usable for short codes. Optional for
   * the same reason as {@link inviteCode}.
   */
  mailboxAvailable?: boolean;
  /** A short human-readable status of the last pairing activity. */
  activity: string;
}

/** An immutable view of the sharing state for the UI. */
export interface SharingSnapshot {
  ready: boolean;
  status: string;
  self: SelfIdentity | null;
  /** Encoded `streetcryptid://contact?…` link for our own card (QR / paste). */
  selfLink: string | null;
  friends: Friend[];
  sharingWith: string[];
  /** Whether the background location service is currently running. */
  backgroundSharing: boolean;
  /** Whether the OS granted full background access or only while-in-use access. */
  backgroundAccess: BackgroundAccess;
  /** Fixes recovered by the last durable sync, or null if none yet. */
  lastSyncRecovered: number | null;
  /** Offline-delivery stash: whether a stash is deployed and whether the user opted in. */
  stash: { available: boolean; optedIn: boolean };
  /** Live iroh endpoint addresses and known peer path usage for the diagnostics screen. */
  transportDiagnostics: {
    snapshot: TransportDiagnostics | null;
    updatedAt: number | null;
    error: string | null;
  };
  /** Native endpoint transports currently enabled for protocol-constrained debugging. */
  transports: TransportPreferences;
  /** How often location is published, in ms. Constant by design; see `setShareInterval`. */
  shareIntervalMs: number;
  /** Bilateral-pairing / nearby-discovery state. */
  pairing: PairingSnapshot;
  /** Live-mode request state (ARCHITECTURE §9c). */
  live: LiveSnapshot;
  /** Per-friend forward-secrecy health — who is not receiving our fixes, and why (§4.5, §4.6). */
  sessions: SessionHealthSnapshot;
  /** Latest signed fix/null return envelopes successfully opened from each friend. */
  ratchetActivity: Record<string, RatchetActivity>;
}

/**
 * Why a friend is not currently receiving our location, in the terms §4.5 asks the UI to keep
 * apart. All three look identical from the outside — their dot stops moving — and each needs a
 * different sentence from us.
 */
export type SessionHealth =
  /** Normal: a live ratchet session, publishing to them. */
  | 'ok'
  /** No ratchet session. Only an in-person re-pair can create one. */
  | 'needs-repair'
  /** No fresh ratchet key from them within `T_lapse` — their app has not run for ~a day. */
  | 'lapsed'
  /** We keep failing to open their envelopes; §4.6 recovery is running. */
  | 'desynced'
  /** Recovery has run repeatedly without sticking. Stop retrying and send the humans to a bump. */
  | 'recovery-failed';

/** The drop reasons `sessions.rs` reports that a human can actually act on. */
export type RatchetDropReason = 'no_session' | 'lapsed';

export interface SessionHealthSnapshot {
  /** Endpoint id → health, for every friend that is not `ok`. Absent means healthy. */
  byFriend: Record<string, SessionHealth>;
  /** When the resync driver last ran, or null if it has not yet. */
  lastCheckedAt: number | null;
}

/**
 * Live-mode state for the UI (ARCHITECTURE §9c). There is no consent queue and no per-friend
 * permission: a friend we share with arms live mode directly. This exists so the UI can *show*
 * what is happening and offer a stop, not to gate it.
 */
export interface LiveSnapshot {
  /** Friends currently watching us live, with when each window ends. */
  watchers: { author: string; expiresAt: number }[];
  /** When the current live window ends (ms since epoch), or null when we are not live. */
  liveUntil: number | null;
  /** Friends we have an outstanding live request out to (we are watching them). */
  watching: string[];
}

export interface LocationSharingInitOptions {
  /**
   * Headless mode restores only the identity, pool, and outbound topic needed
   * to drain captured fixes. It skips profile publication, inbound listeners,
   * friend subscriptions, and pairing timers.
   */
  mode?: 'interactive' | 'headless';
}

export type BackgroundAccess = 'unknown' | 'foreground' | 'full';

type SnapshotListener = (snapshot: SharingSnapshot) => void;
type FixListener = (fix: IncomingFix) => void;
type LocalFixListener = (fix: LocationFix) => void;
type TrailChangeListener = () => void;
type ErrorListener = (message: string) => void;
interface Removable {
  remove(): void;
}

/** How often the pairing/discovery queues are drained once the node has started (ms). */
const PAIRING_POLL_INTERVAL_MS = 4000;

/**
 * How often we check friends' control slots for live-mode requests (ARCHITECTURE §9c).
 *
 * Fixed at 5 min rather than following {@link SHARE_INTERVAL_OPTIONS_MS}: riding the share cadence
 * would make requests 15-min-slow for anyone on the long interval and needlessly chatty on the
 * short one. It also keeps this read traffic decoupled from the publish cadence, which is a
 * security property (§9) — and a constant-rate poll reveals nothing about movement.
 *
 * This is the floor on how long a live request takes to be noticed, so it is also the number that
 * makes live mode "ask to watch" rather than "watch now".
 */
const LIVE_REQUEST_POLL_INTERVAL_MS = 5 * 60_000;

/**
 * How often a WATCHER pulls the trail while it has a live session running.
 *
 * The subject's live cadence is worth nothing if we only reconcile when something else happens to
 * trigger a sync. Gossip delivers live fixes when the direct link is carrying, but that is exactly
 * what fails when a friend is far away behind a relay — and then the entire live window lands in one
 * batch on the next unrelated `syncTrail`.
 *
 * Deliberately faster than the subject's `liveMinPublishMs` so we never sit on a published fix, and
 * deliberately foreground-only: the user is looking at the screen, and a background watcher has no
 * one to show it to. Unlike the poll above this IS request-driven traffic, but it is bounded by the
 * live TTL and only runs when the user explicitly asked to watch someone.
 */
const LIVE_WATCH_PULL_INTERVAL_MS = 8_000;

const BUMP_POLL_INTERVAL_MS = 300;
const BUMP_RESOLVE_TIMEOUT_MS = 12_000;
export const BUMP_WINDOW_MS = 15_000;

/**
 * How often we re-arm profile replication for a friend still wearing the pairing placeholder.
 *
 * A friend's persona reaches us only if the single `import_ticket` dial made when the pair
 * completed actually reconciled; nothing behind it retries. A one-way network failure (the exact
 * shape of the Android 15+ local-network block) therefore used to strand one side of a Bump on
 * `@endpointprefix` / `unknown` forever while the other side paired cleanly.
 */
const PROFILE_BACKFILL_INTERVAL_MS = 30_000;

/**
 * Give up re-arming a friend's profile after this many tries (~5 min at the interval above).
 * Bounded because a friend who has genuinely published nothing must not be re-dialled for the
 * lifetime of the process; a relaunch re-imports every ticket anyway and resets the count.
 */
const PROFILE_BACKFILL_MAX_ATTEMPTS = 10;

/**
 * How long trail-change notifications are gathered before the fan-out fires.
 *
 * Docs reconciliation does not trickle: catching up with a friend delivers their whole retained
 * trail as one burst of `onFix` events (956 in ~10s on the device this was diagnosed from). Every
 * listener answers a notification by re-reading the entire trail, so a per-fix fan-out is O(n²) in
 * the trail size and pins the JS thread for minutes — the app stops responding to everything except
 * the map gesture, which the native side drives.
 *
 * Coalescing makes that burst one refresh. The window is short enough to stay imperceptible for the
 * ordinary case of a single fix arriving on its own.
 */
export const TRAIL_CHANGE_COALESCE_MS = 250;

/**
 * How many §4.6 resyncs with one friend before we stop and ask the humans to re-pair.
 *
 * The design is explicit that "a resync loop surfaces a 're-pair with this friend' prompt rather
 * than retrying forever". Three is enough to absorb the ordinary causes — a stash that withheld a
 * record, a phone that was off — while a session that has been rebuilt three times and still does
 * not work is telling us something a fourth rebuild will not fix.
 */
const RESYNC_ATTEMPT_LIMIT = 3;

/**
 * Normalize a ratcheted publish's return value into a dropped-recipient list.
 *
 * The native calls return `string[]`, but an installed iOS binary built before the ratcheted
 * lanes returns nothing at all (Swift bindings regenerate only on macOS, so a device can be
 * running an older XCFramework against newer JS). Treating that as "nobody was dropped" is the
 * right reading: those builds also seal v2, where there is no session to be missing.
 */
function droppedFrom(result: string[] | void | undefined): string[] {
  return Array.isArray(result) ? result : [];
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * `JSON.stringify` with object keys emitted in sorted order, so two structurally equal values
 * always produce the same string.
 *
 * Needed because transport diagnostics arrive across the UniFFI boundary as freshly built records
 * whose key insertion order is not stable between calls. Comparing them with plain
 * `JSON.stringify` reported a change on nearly every 4-second poll: on the device this bug was
 * diagnosed from, 391 of 410 consecutive snapshots were byte-identical once key-sorted, yet each
 * one wrote a fat `transport.status.changed` record (the full diagnostics blob *and* the previous
 * blob — 823 KB of `details` JSON across those 410 rows) plus an OTLP export.
 */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val: unknown) => {
    if (val === null || typeof val !== 'object' || Array.isArray(val)) return val;
    const source = val as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) sorted[key] = source[key];
    return sorted;
  });
}

/**
 * Orchestrates the friend location-sharing feature: owns the native node, the sharing pool, the
 * topic subscriptions, the durable trail, and the background location service. See
 * docs/social/ARCHITECTURE.md §5–6, §9.
 *
 * - We publish our own fixes on OUR topic (`deriveTopic(self.endpointId)`), wrapped only for the
 *   friends we currently share with (revocation = drop them from the wrap list). Each fix is
 *   broadcast live (gossip) AND mirrored to the durable iroh-docs trail (same sealed bytes).
 * - We subscribe to each added friend's topic to receive THEIR fixes (live + backfilled).
 * - The background service (started via {@link startBackground}) samples GPS foreground and
 *   background and feeds fixes through a {@link LocationEngine} into {@link publishFix}.
 */
export class LocationSharingService implements FixPublisher {
  private mod: IrohLocationNativeModule | null = null;
  private keys: NodeKeys | null = null;
  private ticketStr: string | null = null;
  private docTicketStr: string | null = null;
  private profileTicketStr: string | null = null;
  private profileEpoch = 0;
  private handle = '';
  private sigil = '';
  private cryptidName = '';
  private color = '';
  private state = pool.emptyPool();
  private status = 'idle';
  /**
   * Friends the last publish could not reach, and the human-actionable reason (§4.5).
   *
   * Rebuilt from each publish rather than accumulated: a friend who re-pairs or opens their app
   * simply stops appearing, with no separate clearing path to forget. Only `no_session` and
   * `lapsed` land here — see {@link LocationSharing.noteDroppedRecipients}.
   */
  private droppedRecipients = new Map<string, RatchetDropReason>();
  /** Last verdict per friend from the resync driver. See {@link runResyncDriver}. */
  private sessionVerdicts = new Map<string, SessionHealth>();
  private sessionsCheckedAt: number | null = null;
  /** Guards against a slow driver pass overlapping the next tick's. */
  private resyncInFlight = false;

  private mySubId: string | null = null;
  private mySubRecipients = '';
  private readonly friendSubs = new Map<string, string>();
  private readonly removingFriends = new Set<string>();
  private seq = 0;

  private readonly snapshotListeners = new Set<SnapshotListener>();
  private readonly fixListeners = new Set<FixListener>();
  private readonly localFixListeners = new Set<LocalFixListener>();
  private readonly trailChangeListeners = new Set<TrailChangeListener>();
  /** Pending coalesced trail-change fan-out; see {@link TRAIL_CHANGE_COALESCE_MS}. */
  private trailChangeTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Highest `fix.ts` already pulled out of the durable replica, per author.
   *
   * Without it `refreshTrailFromReplica` re-read and re-wrote every entry a friend has ever
   * published on every single sync — and live mode runs a sync every
   * {@link LIVE_WATCH_PULL_INTERVAL_MS}, so the whole trail was decrypted and re-inserted into
   * SQLite eight seconds apart for as long as anyone was watching. Cleared per author whenever
   * their cached points are dropped, or a re-added friend would never be re-read.
   */
  private readonly replicaWatermarks = new Map<string, { ts: number; seq: number }>();
  private readonly errorListeners = new Set<ErrorListener>();
  private fixSub: Removable | null = null;
  private opaqueSub: Removable | null = null;
  private ratchetActivity: Record<string, RatchetActivity> = {};

  // Bilateral pairing / nearby discovery runtime.
  private pairingReadyFlag = false;
  private bleCaps: BleCapabilities | null = null;
  private nearbyPeers: BlePeer[] = [];
  private pairSessions: PairStateRecord[] = [];
  private transportDiagnostics: TransportDiagnostics | null = null;
  private transportDiagnosticsUpdatedAt: number | null = null;
  private transportDiagnosticsError: string | null = null;
  private transportDiagnosticsInFlight: Promise<void> | null = null;
  /** Count of polls that saw a genuine change; asserted by tests to catch comparison regressions. */
  private transportDiagnosticsChangeCount = 0;
  private pendingPairRequests: PairEvent[] = [];
  private verifications: PairingVerification[] = [];
  private bumpUntil = 0;
  private bumpTimer: ReturnType<typeof setInterval> | null = null;
  private bumpStage: BumpStage = 'idle';
  private bumpRssi: number | null = null;
  private bumpPeerCount = 0;
  private bumpError: string | null = null;
  private bumpResolveInFlight: Promise<void> | null = null;
  private bumpGeneration = 0;
  private pairingOperations = 0;
  private rebindInFlight = false;
  private discoveredFriend: Friend | null = null;
  private inviteLink: string | null = null;
  private inviteCode: string | null = null;
  private readonly mailbox: PairingMailbox;
  /**
   * Optional offline-delivery stash (https://github.com/unrealJune/trail-stash). No-op client when
   * not deployed.
   */
  private readonly stash: StashClient;
  /** The stash's dial ticket for reconciliation bootstrap, or null when not configured. */
  private readonly stashTicket: string | null = getStashConfig()?.ticket ?? null;
  /** Per-user opt-in (persisted). Defaults false — the stash is never used unless turned on. */
  private stashOptIn = false;
  /** Persisted native endpoint transports. All paths are enabled by default. */
  private transportPreferences: TransportPreferences = { ...DEFAULT_TRANSPORT_PREFERENCES };
  private pairingActivity = '';
  /** Sessions we initiated, keyed by session id to preserve the pairing method through completion. */
  private readonly initiatedRoutes = new Map<string, PairingMethod>();
  /** Complete sessions already materialized locally, including discoveries the user dismissed. */
  private readonly handledPairSessions = new Set<string>();
  /**
   * Verified profiles that arrived before their friend existed in the pool, keyed by endpoint id.
   *
   * The native profile queue is drained exactly once per poll, and a peer's profile can replicate
   * before their pair `ready` notice is even queued (`finalize` imports the profile namespace,
   * then does the slower trail import, and only then pushes `Ready`). Dropping those on the floor
   * cost the friend their persona until the next relaunch. Flushed by {@link onPairReady}.
   */
  private readonly pendingProfiles = new Map<string, ProfileView>();
  /** Re-arm attempts per friend for {@link backfillMissingProfiles}, bounded and in-memory. */
  private readonly profileBackfillAttempts = new Map<string, number>();
  /** When the profile backfill sweep last ran, so it paces off the pairing poll. */
  private lastProfileBackfillAt = 0;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pollInFlight: Promise<void> | null = null;
  /** Last poll-error message surfaced, so we don't spam listeners with identical errors. */
  private lastPollErrorSig: string | null = null;
  /** JSON signature of the last emitted pairing snapshot, so polling only emits on real change. */
  private lastPairingSig = '';

  /** Local mirror of our own + friends' retained trails, persisted across reloads. */
  private readonly trail: TrailStore = createTrailStore({
    storage: createPersistentTrailStorage(),
  });
  /** Durable KV for the sharing pool. */
  private readonly kv: PersistentKV = createPersistentKV();
  private lastSyncRecovered: number | null = null;

  // Background service runtime (native-only; lazily imported so web/Expo Go never load it).
  private engine: LocationEngine | null = null;
  private bgProvider: BackgroundLocationProvider | null = null;
  private bgTaskHandlerStop: (() => void) | null = null;
  private bgRefreshHandlerStop: (() => void) | null = null;
  private bgLifecycleStop: (() => void) | null = null;
  private bgCadenceStop: (() => Promise<void>) | null = null;
  /** Auto-revert timer for a bounded live-tracking window; null when ambient. */
  private liveTrackingTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Polls friends' control slots for live-mode requests (ARCHITECTURE §9c). Deliberately its OWN
   * timer rather than riding {@link heartbeatTimer}: the share interval is user-selectable
   * (1/5/15 min), so the heartbeat would make requests 15-min-slow on the long cadence and
   * needlessly chatty on the short one. Keeping them separate also keeps the publish cadence — a
   * security property, see §9 — untangled from this read traffic. A constant-rate poll leaks
   * nothing about movement.
   */
  private liveRequestPollTimer: ReturnType<typeof setInterval> | null = null;
  private liveRequestPollInFlight: Promise<void> | null = null;
  /** Armed live sessions, by watching friend. */
  private watcherSessions: WatcherSession[] = [];
  /** Control nonces already acted on. Persisted; see `live-requests.ts`. */
  private handledNonces: HandledNonce[] = [];
  /** Nonce of the outstanding request WE sent per friend, so we can cancel it later. */
  private readonly sentRequestNonces = new Map<string, string>();
  /**
   * Live sessions WE are watching, by friend endpoint id → absolute expiry. The watcher-side mirror
   * of {@link watcherSessions}, which tracks who is watching us.
   *
   * Needed because live mode used to be entirely send-side: the subject sped up, but nothing on this
   * end pulled any faster, so a watcher whose gossip link was not carrying (the normal case when the
   * friend is far away and behind a relay) saw nothing at all until some unrelated `syncTrail` fired
   * and delivered the whole window at once.
   */
  private readonly watchingSessions = new Map<string, number>();
  private liveWatchPullTimer: ReturnType<typeof setInterval> | null = null;
  private liveWatchPullInFlight: Promise<void> | null = null;
  /** Cleans up outstanding live requests when we stop being able to watch (app backgrounded). */
  private watcherLifecycleStop: (() => void) | null = null;
  /** True on the MOUNTED service only — the one that owns the process-wide native node. */
  private ownsNativeRuntime = false;
  /** Injectable CSPRNG for control nonces; tests supply a deterministic one. */
  private readonly randomBytes: RandomBytesFn;
  /**
   * Drives {@link LocationEngine.heartbeat} at the sampling interval while the runtime is alive.
   * iOS may suspend this timer while stationary; the periodic OS refresh is the best-effort backstop.
   */
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** The user's chosen publish cadence; see `loadShareIntervalMs`. */
  private shareIntervalMs: number = DEFAULT_SHARE_INTERVAL_MS;
  private backgroundSharing = false;
  private backgroundAccess: BackgroundAccess = 'unknown';
  private latestLocalFix: LocationFix | null = null;
  private shutdownPromise: Promise<void> | null = null;

  /**
   * @param deps.mailbox Pairing mailbox transport for the short-code path (see
   *   {@link createPairCode} / {@link pairFromInput}). Defaults to the HTTP client built from
   *   `EXPO_PUBLIC_PAIR_MAILBOX_URL`; tests can inject a fake.
   */
  constructor(
    deps: { mailbox?: PairingMailbox; stash?: StashClient; randomBytes?: RandomBytesFn } = {}
  ) {
    this.mailbox = deps.mailbox ?? createDefaultPairingMailbox();
    this.stash = deps.stash ?? createDefaultStashClient();
    this.randomBytes = deps.randomBytes ?? ((n) => getRandomBytesAsync(n));
  }

  /** Whether offline delivery via the stash is both configured (deployed) and opted into. */
  private stashEnabled(): boolean {
    return this.stashOptIn && this.stash.configured && this.stashTicket !== null;
  }

  /** The stash dial ticket to fold into subscribe() bootstrap sets, or [] when disabled. */
  private stashBootstrap(): string[] {
    return this.stashEnabled() && this.stashTicket ? [this.stashTicket] : [];
  }

  /** Current opt-in state for the UI: whether a stash exists and whether it's turned on. */
  stashState(): { available: boolean; optedIn: boolean } {
    return { available: this.stash.configured, optedIn: this.stashOptIn };
  }

  /** Current endpoint transport set. */
  transportState(): TransportPreferences {
    return { ...this.transportPreferences };
  }

  /** Enable or disable one native transport and immediately rebuild the endpoint. */
  async setTransportEnabled(
    transport: keyof TransportPreferences,
    enabled: boolean
  ): Promise<void> {
    if (this.transportPreferences[transport] === enabled) return;
    const next = { ...this.transportPreferences, [transport]: enabled };
    if (!next.relay && !next.ip && !next.ble) {
      throw new Error('Keep at least one transport enabled.');
    }
    if (!this.mod || !this.isReady()) throw new Error('Friend sync is not ready yet.');
    if (this.rebindInFlight || this.pairingOperations > 0 || this.hasActivePairingSession()) {
      throw new Error('Finish the current pairing action before changing transports.');
    }

    const previous = this.transportPreferences;
    this.transportPreferences = next;
    this.rebindInFlight = true;
    try {
      await this.rebindNode();
      await saveTransportPreferences(this.kv, next);
      this.emit();
    } catch (error) {
      this.transportPreferences = previous;
      await this.rebindNode().catch(() => undefined);
      throw error;
    } finally {
      this.rebindInFlight = false;
    }
  }

  /**
   * Opt in/out of offline delivery via the stash. Persists the choice; on opt-in, grants the stash
   * replication of our own + friends' trail namespaces and folds its ticket into our subscription.
   */
  async setStashOptIn(optedIn: boolean): Promise<void> {
    this.stashOptIn = optedIn;
    await saveStashOptIn(this.kv, optedIn);
    if (optedIn) {
      await this.syncStashGrants();
      await this.ensureMySubscription();
    }
    this.emit();
  }

  /**
   * Developer telemetry (dev/preview builds only — inert without `EXPO_PUBLIC_OTEL_ENDPOINT`):
   * stamp the JS tracer with this node's identity and point the NATIVE core's OTLP exporter at
   * the same collector, so JS + Rust spans from this phone share one `service.instance.id`.
   * `configureTelemetry` is guarded: stale iOS bindings (regenerated only on macOS) won't have it.
   */
  private configureDevTelemetry(): void {
    if (!this.keys) return;
    const instanceId = this.keys.endpointId.slice(0, 10);
    getTelemetry().setResourceAttributes({ 'service.instance.id': instanceId });
    const config = getOtelConfig();
    if (!config || !this.mod || typeof this.mod.configureTelemetry !== 'function') return;
    try {
      void this.mod.configureTelemetry(config.endpoint, instanceId);
    } catch {
      // Older binding without the export, or a build with otel compiled out — JS telemetry alone.
    }
  }

  /**
   * Flush buffered telemetry (JS + native exporters). Headless background contexts call this
   * before they end — the OS may freeze the process immediately after.
   */
  async flushDevTelemetry(): Promise<void> {
    try {
      await this.mod?.flushTelemetry?.();
    } catch {
      // best-effort
    }
    await getTelemetry().flush();
  }

  /**
   * Grant the stash replication of our own + every friend's trail namespace (best-effort). The
   * stash is ciphertext-blind, so this only lets it hold + reconcile sealed envelopes, never read
   * them. A failure just degrades offline delivery to peer-only reconciliation.
   *
   * **No device push token is sent, deliberately** — see ARCHITECTURE.md §10. An APNs/FCM token is
   * the one identifier here that a third party can resolve to a real person, and registering it
   * against namespaces told the stash which namespace was OURS: with bilateral pairing, your token
   * appeared against every friend's namespace and never your own, so the missing one identified
   * you by set complement. Live mode's request channel polls instead (§9c), so nothing needs a
   * wake. The cost is that trail delivery is no longer nudged seconds after a publish — it now
   * lands on the next poll / periodic backfill.
   */
  private async syncStashGrants(): Promise<void> {
    if (!this.stashEnabled()) return;
    const tasks: Promise<void>[] = [];
    const swallow = () => {
      /* best-effort */
    };
    if (this.docTicketStr) {
      tasks.push(this.stash.registerNamespace({ readTicket: this.docTicketStr }).catch(swallow));
    }
    const friendTickets = new Set<string>();
    for (const friend of Object.values(this.state.friends)) {
      if (friend.docTicket) friendTickets.add(friend.docTicket);
    }
    for (const readTicket of friendTickets) {
      tasks.push(this.stash.registerNamespace({ readTicket }).catch(swallow));
    }
    await Promise.all(tasks);
  }

  /** Whether the native module exists at all (false on web / in Expo Go). */
  static isAvailable(): boolean {
    return tryGetIrohLocation() !== null;
  }

  async init(
    handle: string,
    sigil: string,
    cryptidName = '',
    color = '',
    options: LocationSharingInitOptions = {}
  ): Promise<void> {
    const interactive = options.mode !== 'headless';
    this.handle = handle;
    this.sigil = sigil;
    this.cryptidName = cryptidName;
    this.color = color;
    this.setStatus('starting');

    this.mod = getIrohLocation();
    const persisted = await loadKeys();
    if (interactive) {
      // Stake the claim BEFORE `createNode`, not after `init` resolves: the node-building window is
      // exactly when a restored OS task callback lands (expo-task-manager restores the persisted
      // location/geofence tasks at module scope, before React mounts), and a headless session that
      // starts in it will `clearRuntime()` the node we are building. See `native-runtime-owner.ts`.
      claimNativeRuntime();
      this.ownsNativeRuntime = true;
      // And if a session is already in flight, let it finish — including its own `shutdown` — so it
      // cannot nil our node out from under us a moment after we create it.
      await awaitNativeRuntimeIdle();
    }
    this.keys = await this.mod.createNode(persisted.identitySecret, persisted.recvSecret);
    await saveKeys({
      identitySecret: this.keys.identitySecret,
      recvSecret: this.keys.recvSecret,
    });
    this.configureDevTelemetry();
    // Restore the monotonic seq before anything can publish, so we never hand out a reused seq.
    this.seq = await loadSeq();
    // Load before listeners attach: a live response arriving during startup must not be overwritten
    // by older persisted diagnostics a few awaits later.
    this.ratchetActivity = await loadRatchetActivity(this.kv);
    this.transportPreferences = await loadTransportPreferences(this.kv);
    await this.mod.start(this.transportPreferences);
    if (interactive) {
      this.ticketStr = await this.mod.ticket();
      this.docTicketStr = await this.safeDocTicket();
      // Publish our profile so friends can replicate it; web reports epoch 0 (no capability).
      this.profileEpoch = await this.safePublishProfile();
      this.profileTicketStr = await this.safeProfileTicket();
      this.fixSub = this.mod.addListener('onFix', (event: OnFixEvent) => this.handleFix(event));
      this.opaqueSub = this.mod.addListener('onOpaque', (event: OnOpaqueEvent) =>
        this.handleOpaque(event)
      );
    }
    await this.restorePool(interactive);
    this.stashOptIn = await loadStashOptIn(this.kv);
    // Restored, not reset: a control nonce we already acted on must stay acted-on across a restart,
    // or the sender's still-current slot would re-arm us on the next poll.
    this.handledNonces = await loadHandledNonces(this.kv);
    // Hydrated here as well as in startBackground so settings shows the real value even before
    // background sharing has been switched on.
    this.shareIntervalMs = await loadShareIntervalMs(this.kv);
    if (interactive) {
      await this.importFriendProfiles();
      await this.syncStashGrants();
      this.startPairingPolling();
      await this.pollPairingOnce();
      this.startWatcherLifecycle();
    }
    this.setStatus('ready');
  }

  /** Publish profile edits without rebuilding the native node or dropping background GPS. */
  async updateProfile(handle: string, sigil: string, cryptidName = '', color = ''): Promise<void> {
    this.handle = handle;
    this.sigil = sigil;
    this.cryptidName = cryptidName;
    this.color = color;
    if (this.mod && this.status === 'ready') {
      this.profileEpoch = await this.safePublishProfile();
      this.profileTicketStr = await this.safeProfileTicket();
    }
    this.emit();
  }

  onChange(listener: SnapshotListener): () => void {
    this.snapshotListeners.add(listener);
    listener(this.snapshot());
    return () => this.snapshotListeners.delete(listener);
  }

  onFix(listener: FixListener): () => void {
    this.fixListeners.add(listener);
    return () => this.fixListeners.delete(listener);
  }

  /** Subscribe to this device's latest foreground/background GPS fix. */
  onLocalFix(listener: LocalFixListener): () => void {
    this.localFixListeners.add(listener);
    if (this.latestLocalFix) listener(this.latestLocalFix);
    return () => this.localFixListeners.delete(listener);
  }

  /** Subscribe to durable trail changes (self publish, live receive, or sync backfill). */
  onTrailChange(listener: TrailChangeListener): () => void {
    this.trailChangeListeners.add(listener);
    return () => this.trailChangeListeners.delete(listener);
  }

  /** Subscribe to service-level errors (e.g. background pairing/discovery poll failures). */
  onError(listener: ErrorListener): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  selfCard(): ContactCard | null {
    if (!this.keys || !this.ticketStr) return null;
    return {
      endpointId: this.keys.endpointId,
      handle: this.handle,
      sigil: this.sigil,
      recvPublic: this.keys.recvPublic,
      ticket: this.ticketStr,
      ...(this.cryptidName ? { cryptidName: this.cryptidName } : {}),
      ...(this.color ? { color: this.color } : {}),
      ...(this.docTicketStr ? { docTicket: this.docTicketStr } : {}),
    };
  }

  async addFriend(card: ContactCard): Promise<void> {
    if (this.removingFriends.has(card.endpointId)) return;
    this.state = pool.addFriend(this.state, card);
    await this.subscribeToFriend(card);
    this.persistPool();
    this.emit();
  }

  async shareWith(endpointId: string): Promise<void> {
    this.state = pool.shareWith(this.state, endpointId);
    await this.ensureMySubscription();
    this.persistPool();
    this.emit();
  }

  async revoke(endpointId: string): Promise<void> {
    this.state = pool.revoke(this.state, endpointId);
    // No re-subscribe needed: future fixes simply omit their wrap.
    this.persistPool();
    this.emit();
  }

  /** Remove a friend locally, revoke future fixes, and tear down their live subscription. */
  async removeFriend(endpointId: string): Promise<void> {
    if (!this.state.friends[endpointId] || this.removingFriends.has(endpointId)) return;

    const wasSharing = pool.isSharingWith(this.state, endpointId);
    const friendSubId = this.friendSubs.get(endpointId);
    const mod = this.mod;
    const previousState = this.state;

    this.removingFriends.add(endpointId);
    this.friendSubs.delete(endpointId);
    this.state = pool.removeFriend(this.state, endpointId);
    try {
      await savePool(this.kv, this.state);
    } catch (error) {
      this.state = previousState;
      if (friendSubId) this.friendSubs.set(endpointId, friendSubId);
      this.removingFriends.delete(endpointId);
      throw error;
    }

    if (this.discoveredFriend?.endpointId === endpointId) this.discoveredFriend = null;
    this.pendingProfiles.delete(endpointId);
    this.profileBackfillAttempts.delete(endpointId);
    this.droppedRecipients.delete(endpointId);
    this.sessionVerdicts.delete(endpointId);
    delete this.ratchetActivity[endpointId];
    void saveRatchetActivity(this.kv, this.ratchetActivity);
    this.emit();

    const cleanup: Promise<void>[] = [];
    if (mod && friendSubId) {
      cleanup.push(mod.unsubscribe(friendSubId));
    }
    // Destroy the ratchet session with them (§4.2). Not merely tidiness: the state is chain keys
    // for a relationship that no longer exists, and §5.4 makes erasure an explicit design surface
    // — keeping it would leave material on disk whose only remaining use is to a seized device.
    // Best-effort: the friendship is already gone from the pool either way.
    if (mod && typeof mod.forgetSession === 'function') {
      cleanup.push(
        mod.forgetSession(endpointId).catch((err: unknown) => {
          getTelemetry().log(
            'warn',
            `could not forget the ratchet session for a removed friend: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        })
      );
    }
    if (wasSharing) cleanup.push(this.ensureMySubscription());
    cleanup.push(
      this.trail.removeFriend(endpointId).then(() => {
        // Their cached fix is gone, so the watermark must go with them — otherwise re-adding this
        // friend later would resume from a timestamp whose fixes we no longer hold, and their dot
        // would never reappear.
        this.replicaWatermarks.delete(endpointId);
        this.notifyTrailChanged();
      })
    );

    const results = await Promise.allSettled(cleanup);
    if (results.some((result) => result.status === 'rejected')) {
      this.reportError(new Error('Friend removed, but some cleanup could not finish.'));
    }
    this.removingFriends.delete(endpointId);
  }

  // ── Bilateral pairing (`streetcryptid/pair/2`) — ARCHITECTURE.md §4 ─────────────────────────

  /** Toggle whether we accept invite-less nearby (BLE) pairing Hellos. */
  async setPairingReady(ready: boolean): Promise<void> {
    if (!this.isReady() || !this.mod) return;
    await this.mod.setPairingReady(ready);
    this.pairingReadyFlag = ready;
    this.emit();
  }

  /** Rebuild the native node after Bluetooth permission changes so BLE is actually attached. */
  async ensureBleReady(): Promise<void> {
    if (!this.mod || !this.isReady()) throw new Error('Friend sync is not ready yet.');
    if (this.rebindInFlight || this.pairingOperations > 0) {
      throw new Error('Another pairing action is already in progress.');
    }
    if (this.hasActivePairingSession()) {
      throw new Error('Finish or cancel the current pairing before starting Bump.');
    }
    this.rebindInFlight = true;
    try {
      if (await this.mod.bleAvailable()) return;
      await this.rebindNode();
      if (!(await this.mod.bleAvailable())) {
        throw new Error(
          'Bluetooth could not start. Confirm Bluetooth is on, then close and reopen streetCryptid.'
        );
      }
    } finally {
      this.rebindInFlight = false;
    }
  }

  /** Arm a short, explicit Bump window. No sensor or nearby acceptance runs while idle. */
  async armBump(windowMs = BUMP_WINDOW_MS): Promise<void> {
    if (!this.mod || this.discoveredFriend) return;
    if (this.rebindInFlight || this.pairingOperations > 0) {
      throw new Error('Another pairing action is already in progress.');
    }
    if (this.hasActivePairingSession()) {
      throw new Error('Finish or cancel the current pairing before starting Bump.');
    }
    if (this.bumpResolveInFlight) await this.bumpResolveInFlight;
    this.bumpGeneration += 1;
    await this.setPairingReady(true);
    this.bumpUntil = Date.now() + Math.max(8000, windowMs);
    this.bumpStage = 'armed';
    this.bumpRssi = null;
    this.bumpPeerCount = 0;
    this.bumpError = null;
    this.setPairingActivity('ready to bump');
    this.startBumpPolling();

    for (const request of this.pendingPairRequests.filter((event) => event.nearby)) {
      this.trackNearbyRequest(request);
    }
    await this.pollPairingOnce();
  }

  /** Commit a physical or visible fallback Bump and resolve the strongest fresh BLE signal. */
  async commitBump(): Promise<void> {
    if (!this.mod || !this.isBumpActive() || this.bumpResolveInFlight) return;
    const generation = this.bumpGeneration;
    this.bumpStage = 'searching';
    this.bumpError = null;
    this.setPairingActivity('finding the bumped phone');

    const run = this.runPairingOperation(async () => {
      const result = await this.mod!.resolveBumpPeer(BUMP_RESOLVE_TIMEOUT_MS);
      if (generation !== this.bumpGeneration || !this.isBumpActive()) return;
      this.bumpPeerCount = result.peerCount;
      this.bumpRssi = result.rssi;
      if (result.status === 'resolved' && result.endpointId) {
        if (this.state.friends[result.endpointId]) {
          this.bumpStage = 'failed';
          this.bumpError = 'That cryptid is already in your atlas.';
          this.setPairingActivity('already paired');
          return;
        }
        this.bumpStage = 'contact';
        this.setPairingActivity('signal found');
        let sessionId: string;
        try {
          sessionId = await this.initiateNearbyPair(result.endpointId);
        } catch (error) {
          if (generation === this.bumpGeneration && this.isBumpActive()) {
            this.bumpStage = 'failed';
            this.bumpError =
              'The phones found each other, but the encrypted handshake did not start. Try again.';
            this.setPairingActivity('handshake failed');
          }
          throw error;
        }
        if (generation !== this.bumpGeneration) {
          this.initiatedRoutes.delete(sessionId);
          await this.mod!.cancelPair(sessionId);
          return;
        }
        await this.pollPairingOnce();
        return;
      }

      this.bumpStage = 'failed';
      this.bumpError =
        result.status === 'ambiguous'
          ? 'More than one phone is equally close. Move the two phones apart and try again.'
          : result.status === 'noPeers'
            ? 'No other streetCryptid phone answered. Keep Friends open on both phones and retry.'
            : result.status === 'unavailable'
              ? 'Bluetooth is not available on this device or build.'
              : 'The nearby phone was found, but its identity could not be read. Try Bump again.';
      this.setPairingActivity('bump needs another try');
    }).finally(() => {
      this.bumpResolveInFlight = null;
      this.emit();
    });
    this.bumpResolveInFlight = run;
    await run;
  }

  async cancelBump(): Promise<void> {
    this.stopBumpPolling();
    if (this.mod && this.pairingReadyFlag) await this.setPairingReady(false);
  }

  private hasActivePairingSession(): boolean {
    return (
      this.verifications.length > 0 ||
      this.pendingPairRequests.length > 0 ||
      this.pairSessions.some(
        (session) => !['complete', 'rejected', 'failed'].includes(session.state)
      )
    );
  }

  private async runPairingOperation<T>(action: () => Promise<T>): Promise<T> {
    if (this.rebindInFlight) throw new Error('Bluetooth is restarting. Try again in a moment.');
    this.pairingOperations += 1;
    try {
      return await action();
    } finally {
      this.pairingOperations -= 1;
    }
  }

  private async rebindNode(): Promise<void> {
    const mod = this.mod;
    const keys = this.keys;
    if (!mod || !keys) throw new Error('Friend sync is not ready yet.');

    const restorePairingReady = this.pairingReadyFlag;
    this.stopPairingPolling();
    this.fixSub?.remove();
    this.fixSub = null;
    this.opaqueSub?.remove();
    this.opaqueSub = null;

    const subscriptionIds = [...(this.mySubId ? [this.mySubId] : []), ...this.friendSubs.values()];
    await Promise.allSettled(
      subscriptionIds.map((subscriptionId) => mod.unsubscribe(subscriptionId))
    );
    this.friendSubs.clear();
    this.mySubId = null;
    this.mySubRecipients = '';
    this.pairSessions = [];
    this.pendingPairRequests = [];
    this.verifications = [];
    this.nearbyPeers = [];
    this.bleCaps = null;
    this.pairingReadyFlag = false;

    await mod.shutdown();
    this.keys = await mod.createNode(keys.identitySecret, keys.recvSecret);
    await mod.start(this.transportPreferences);
    this.ticketStr = await mod.ticket();
    this.docTicketStr = await this.safeDocTicket();
    this.profileEpoch = await this.safePublishProfile();
    this.profileTicketStr = await this.safeProfileTicket();
    this.fixSub = mod.addListener('onFix', (event: OnFixEvent) => this.handleFix(event));
    this.opaqueSub = mod.addListener('onOpaque', (event: OnOpaqueEvent) =>
      this.handleOpaque(event)
    );

    await this.importFriendProfiles();
    for (const friend of pool.friendList(this.state)) await this.subscribeToFriend(friend);
    await this.ensureMySubscription();
    if (restorePairingReady) {
      await mod.setPairingReady(true);
      this.pairingReadyFlag = true;
    }
    this.startPairingPolling();
    await this.pollPairingOnce();
    void this.syncTrail(0);
  }

  /** Acknowledge the one-shot "cryptid discovered" reveal and keep the new friend. */
  acknowledgeDiscoveredFriend(): void {
    if (!this.discoveredFriend) return;
    this.discoveredFriend = null;
    this.emit();
  }

  /** Reject the discovered friend, revoke sharing, and leave their live location topic. */
  async rejectDiscoveredFriend(): Promise<void> {
    const friend = this.discoveredFriend;
    if (!friend) return;

    this.discoveredFriend = null;
    this.state = pool.removeFriend(this.state, friend.endpointId);
    this.pendingProfiles.delete(friend.endpointId);
    this.profileBackfillAttempts.delete(friend.endpointId);
    this.persistPool();
    this.setPairingActivity('cryptid rejected');

    const mod = this.mod;
    const friendSubId = this.friendSubs.get(friend.endpointId);
    const unsubscribeFromFriend = async (): Promise<void> => {
      if (!mod || !friendSubId) return;
      await mod.unsubscribe(friendSubId);
      this.friendSubs.delete(friend.endpointId);
    };
    await Promise.all([unsubscribeFromFriend(), this.ensureMySubscription()]);
  }

  /**
   * Mint a one-shot invite and return its shareable `streetcryptid:///social?token=…` link.
   * The link is also retained in the pairing snapshot as the current invite.
   */
  async createPairInvite(ttlSecs: number): Promise<string> {
    return this.runPairingOperation(async () => {
      if (!this.mod) throw new Error('createPairInvite: native module not bound');
      const invite = await this.mod.createPairInvite(ttlSecs);
      this.inviteLink = encodePairLink(invite.token);
      this.setPairingActivity('invite created');
      return this.inviteLink;
    });
  }

  /**
   * Mint a one-shot invite, seal it entirely on-device, and drop the ciphertext at a mailbox
   * address derived from a fresh short human pairing code (see `core/pairing-code.ts` and
   * `net/pairing-mailbox.ts`). Returns the displayable code (`XXXX-XXXX-XXXX-XXXX`); the same
   * value is retained in the pairing snapshot as `inviteCode`. The invite and mailbox entry share
   * one TTL, clamped into the mailbox's `[60, 900]` second range. The mailbox itself never sees
   * the code, the secret, the key, or the plaintext invite token.
   */
  async createPairCode(ttlSecs = 600): Promise<string> {
    return this.runPairingOperation(async () => {
      if (!this.mod) throw new Error('createPairCode: native module not bound');
      if (!this.mailbox.configured) {
        throw new Error('createPairCode: pairing mailbox is not configured');
      }
      const ttl = clampMailboxTtlSeconds(ttlSecs);
      const invite = await this.mod.createPairInvite(ttl);
      const minted = await mintPairingCode();
      const lookupId = await deriveLookupId(minted.secret);
      const capsule = await sealPairToken(invite.token, minted.secret);
      await this.mailbox.put(lookupId, capsule, ttl);
      this.inviteCode = minted.display;
      this.setPairingActivity('pair code created');
      return this.inviteCode;
    });
  }

  /**
   * Begin an invite-based pair from a short mailbox pairing code, an app pair link
   * (`streetcryptid:///social?token=…`), or a raw `scpair1:` token. The handshake proceeds to the
   * SAS `verifying` gate; neither side is auto-accepted — both humans clear the visual check to
   * complete the pair. Returns the session id. Tags the eventual friend `code` (short code or raw
   * token) or `invite` (app link). A short code is recognized *before* pair-link parsing; its
   * mailbox GET is one-time, so a failed or already-redeemed code surfaces its precise error rather
   * than falling back to anything else.
   */
  async pairFromInput(input: string): Promise<string> {
    return this.runPairingOperation(() => this.pairFromInputUnlocked(input));
  }

  private async pairFromInputUnlocked(input: string): Promise<string> {
    if (!this.mod) throw new Error('pairFromInput: native module not bound');
    if (this.isBumpActive()) throw new Error('Cancel Bump before using a pairing link or code.');
    const trimmed = input.trim();
    if (isPairingCode(trimmed)) {
      return this.pairFromCode(trimmed);
    }
    const token = decodePairLink(trimmed);
    // A full app pair link is an invite; a bare pasted/typed token is a manual code.
    const method: PairingMethod =
      isPairLink(trimmed) && !trimmed.startsWith(PAIR_TOKEN_PREFIX) ? 'invite' : 'code';
    const sessionId = await this.mod.initiatePairByToken(token);
    this.initiatedRoutes.set(sessionId, method);
    this.setPairingActivity('pairing…');
    await this.refreshPairing();
    return sessionId;
  }

  /**
   * Redeem a short mailbox pairing code: derive the lookup id from the code's secret, one-time GET
   * the sealed capsule, decrypt it locally into the opaque invite token, then initiate the pair
   * exactly like {@link pairFromInput}. The handshake advances to the SAS `verifying` gate; no side
   * is auto-accepted. Never falls back silently — mailbox and decryption failures propagate as-is.
   */
  private async pairFromCode(normalizedCode: string): Promise<string> {
    if (!this.mod) throw new Error('pairFromInput: native module not bound');
    if (!this.mailbox.configured) {
      throw new Error('pairFromInput: pairing mailbox is not configured');
    }
    const secret = secretFromPairingCode(normalizedCode);
    const lookupId = await deriveLookupId(secret);
    const capsule = await this.mailbox.take(lookupId);
    const token = await openPairCapsule(capsule, secret);
    const sessionId = await this.mod.initiatePairByToken(token);
    this.initiatedRoutes.set(sessionId, 'code');
    this.setPairingActivity('pairing…');
    await this.refreshPairing();
    return sessionId;
  }

  /**
   * Begin an invite-less nearby pair with a BLE-discovered peer. The handshake proceeds to the SAS
   * `verifying` gate — neither side is auto-accepted. Returns the session id; tags the eventual
   * friend `nearby`.
   */
  async pairNearby(endpointId: string): Promise<string> {
    return this.runPairingOperation(async () => {
      const sessionId = await this.initiateNearbyPair(endpointId);
      await this.refreshPairing();
      return sessionId;
    });
  }

  /**
   * Reject/cancel a pending incoming pair request. Only `accept === false` is supported here:
   * accepting a pair now requires clearing the SAS visual gate (see {@link submitPairChoice} /
   * {@link confirmPairDisplay}), so `accept === true` fails explicitly rather than bypassing SAS.
   */
  async respondPair(sessionId: string, accept: boolean): Promise<void> {
    if (!this.mod) return;
    if (accept) {
      throw new Error(
        'respondPair(accept=true) is no longer supported: clearing the SAS visual check via ' +
          'submitPairChoice / confirmPairDisplay is required to accept a pair.'
      );
    }
    await this.mod.respondPair(sessionId, false);
    this.pendingPairRequests = this.pendingPairRequests.filter((e) => e.sessionId !== sessionId);
    this.verifications = this.verifications.filter((v) => v.sessionId !== sessionId);
    this.initiatedRoutes.delete(sessionId);
    this.setPairingActivity('rejected request');
    await this.refreshPairing();
  }

  /**
   * Picker SAS action: submit the chosen figure index for a live `verifying` session. A correct
   * choice latches the local SAS and sends `Accept` natively; a wrong/late choice is terminal.
   * Role/action mismatches are rejected natively; a known local role mismatch fails fast here.
   */
  async submitPairChoice(sessionId: string, chosenIndex: number): Promise<void> {
    if (!this.mod) throw new Error('submitPairChoice: native module not bound');
    if (!isPairingFigureIndex(chosenIndex)) {
      throw new RangeError('submitPairChoice: pairing figure index must be between 0 and 255');
    }
    const verification = this.verifications.find((v) => v.sessionId === sessionId);
    if (verification && verification.role !== 'picker') {
      throw new Error(
        'submitPairChoice: this session is awaiting a display confirmation, not a pick'
      );
    }
    await this.mod.submitPairChoice(sessionId, chosenIndex);
    this.setPairingActivity('verifying…');
    await this.refreshPairing();
  }

  /**
   * Displayer SAS action: confirm whether the other human matched the shown figure for a live
   * `verifying` session. `matched === true` latches the local SAS and sends `Accept` natively;
   * `false` (or a late action) is terminal. Role/action mismatches are rejected natively.
   */
  async confirmPairDisplay(sessionId: string, matched: boolean): Promise<void> {
    if (!this.mod) throw new Error('confirmPairDisplay: native module not bound');
    const verification = this.verifications.find((v) => v.sessionId === sessionId);
    if (verification && verification.role !== 'displayer') {
      throw new Error(
        'confirmPairDisplay: this session is awaiting a pick, not a display confirmation'
      );
    }
    await this.mod.confirmPairDisplay(sessionId, matched);
    this.setPairingActivity(matched ? 'verifying…' : 'pair canceled');
    await this.refreshPairing();
  }

  /** Cancel a pairing under SAS verification — terminal (a fresh attempt is required). */
  async cancelPair(sessionId: string): Promise<void> {
    if (!this.mod) throw new Error('cancelPair: native module not bound');
    await this.mod.cancelPair(sessionId);
    this.verifications = this.verifications.filter((v) => v.sessionId !== sessionId);
    this.pendingPairRequests = this.pendingPairRequests.filter((e) => e.sessionId !== sessionId);
    this.initiatedRoutes.delete(sessionId);
    this.setPairingActivity('pair canceled');
    await this.refreshPairing();
  }

  /** Drain the pairing/discovery queues once, on demand (also runs on a bounded timer). */
  async refreshPairing(): Promise<void> {
    await this.pollPairingOnce();
  }

  /** Refresh native endpoint addresses and known peer path usage immediately. */
  async refreshTransportDiagnostics(): Promise<void> {
    await this.pollTransportDiagnosticsOnce();
    this.emit();
  }

  /** True once the node is bound and can publish (the {@link FixPublisher} contract). */
  isReady(): boolean {
    return this.mod !== null && this.status === 'ready';
  }

  /**
   * Whether the background location service can run here: native only, native node present, and
   * the `ExpoTaskManager` native module compiled into this build (a dev client built with
   * expo-task-manager). Lets the UI disable the toggle instead of failing on tap.
   */
  async isBackgroundAvailable(): Promise<boolean> {
    if (Platform.OS === 'web' || !this.mod) return false;
    try {
      const { isBackgroundLocationAvailable } = await import('./background/background-task');
      return isBackgroundLocationAvailable();
    } catch {
      return false;
    }
  }

  /**
   * Seal `fix` for the current recipients, broadcast it live (gossip) and mirror it to the durable
   * trail (docs). Returns the monotonic `seq` assigned. **Throws** when the node isn't ready so the
   * outbox drain retains the fix rather than dropping it — never returns a placeholder seq.
   * Satisfies {@link FixPublisher} so the background {@link LocationEngine} can drive it.
   */
  async publishFix(fix: LocationFix, parent?: SpanContext): Promise<number> {
    // Spans below join the native `gossip.publish`/`docs.write` (same sc.author + sc.seq) and,
    // via the envelope hash those record, the stash + receiving phones.
    const stashReplicationEnabled = this.stashEnabled();
    const span = getTelemetry().startSpan('publish.fix', {
      parent,
      attributes: {
        'sc.author': this.keys ? this.keys.endpointId.slice(0, 10) : undefined,
        'stash.client_configured': this.stash.configured,
        'stash.ticket_configured': this.stashTicket !== null,
        'stash.opted_in': this.stashOptIn,
        'stash.replication_enabled': stashReplicationEnabled,
      },
    });
    try {
      if (!this.mod) throw new Error('publishFix: native module not bound');
      await this.ensureMySubscription();
      if (!this.mySubId) throw new Error('publishFix: no active subscription');
      const seq = await this.nextSeq();
      span.setAttribute('sc.seq', seq);
      const native: NativeLocationFix = {
        lat: fix.lat,
        lon: fix.lon,
        accuracyM: fix.accuracyM,
        headingDeg: fix.headingDeg,
        ts: fix.ts,
      };
      // Endpoint ids, not receiving keys: the fix lanes are envelope v3, wrapped under each
      // friend's ratchet session (FORWARD-SECRECY.md §4.7).
      const recipients = pool.recipientEndpoints(this.state);
      span.setAttributes({
        recipients: recipients.length,
        payload_type: 'location-fix',
        payload_ts: fix.ts,
        payload_accuracy_m: fix.accuracyM,
        payload_heading_deg: fix.headingDeg,
        transport_paths: 'gossip-live,docs-durable',
      });
      const traceparent = getTelemetry().enabled ? traceparentFor(span.context) : null;
      span.addEvent('gossip.publish.started', {
        recipients: recipients.length,
        payload_ts: fix.ts,
      });
      const liveDropped = droppedFrom(
        await this.mod.publish(this.mySubId, seq, native, recipients, traceparent)
      );
      span.addEvent('gossip.publish.completed', { dropped: liveDropped.length });
      try {
        // Durable mirror: same sealed bytes, so per-recipient revocation carries over (ARCHITECTURE §6).
        const dropped = droppedFrom(
          await this.mod.docsWrite(this.mySubId, seq, native, recipients, traceparent)
        );
        this.noteDroppedRecipients(dropped, span);
        span.addEvent('docs.write.completed', {
          'stash.replication_enabled': stashReplicationEnabled,
          dropped: dropped.length,
        });
      } catch (err) {
        // Best effort; the live path already delivered. A later syncTrail can reconcile — but the
        // durable/stash mirror is what OFFLINE peers backfill from, so its failure is a real reason
        // a friend never sees this fix. Log it (→ Loki) alongside the span event.
        const reason = err instanceof Error ? err.message : String(err);
        span.addEvent('docs.write.failed', { reason });
        getTelemetry().log(
          'warn',
          `docs.write failed (durable mirror missed; offline peers won't backfill this fix): ${reason}`,
          { 'sc.seq': seq }
        );
      }
      await this.trail.appendOwn(fix, seq);
      this.notifyTrailChanged();
      await this.publishNullFix(fix.ts, span.context);
      // After both lanes, so a session the resync exchange just restored is used from the next
      // tick rather than this one — and so a slow driver pass never delays the fix itself.
      await this.runResyncDriver();
      span.setStatus('ok');
      return seq;
    } catch (err) {
      span.recordError(err);
      throw err;
    } finally {
      span.end();
    }
  }

  /**
   * Drive §4.6 recovery for every friend whose session has stopped working.
   *
   * The schedule cannot heal itself: a desynced session stays desynced until *something* notices
   * and runs the resync exchange. This is that something. One pass per publish tick, which is the
   * right cadence because the exchange completes across two ticks (each side publishes its half,
   * then applies the other's) and the cost when nothing is wrong is one cheap native call per
   * friend.
   *
   * Deliberately not a retry loop. Recovery that keeps recovering is not recovering, so past
   * `RESYNC_ATTEMPT_LIMIT` the verdict becomes `recovery-failed` and we stop — the honest move at
   * that point is to send the two humans back to an in-person bump, not to keep churning sessions
   * on their behalf.
   */
  private async runResyncDriver(): Promise<void> {
    const mod = this.mod;
    if (!mod || this.resyncInFlight) return;
    // Absent on iOS binaries built before the §4.6 API (Swift bindings regenerate only on macOS).
    if (typeof mod.isDesynced !== 'function' || typeof mod.pollResync !== 'function') return;

    this.resyncInFlight = true;
    const verdicts = new Map<string, SessionHealth>();
    let anyRecovered = false;
    try {
      for (const friend of pool.friendList(this.state)) {
        const desynced = await mod.isDesynced(friend.endpointId).catch(() => false);
        if (!desynced) {
          verdicts.set(friend.endpointId, 'ok');
          continue;
        }
        const attempts =
          typeof mod.resyncCount === 'function'
            ? await mod.resyncCount(friend.endpointId).catch(() => 0)
            : 0;
        if (attempts >= RESYNC_ATTEMPT_LIMIT) {
          verdicts.set(friend.endpointId, 'recovery-failed');
          getTelemetry().log(
            'warn',
            `resync has run ${attempts}× with ${friend.endpointId.slice(0, 10)} without sticking; ` +
              'asking the humans to re-pair instead',
            { 'sc.peer': friend.endpointId.slice(0, 10), 'sc.resync_count': attempts }
          );
          continue;
        }
        // `pollResync` publishes our half first when we have not, so a single call from each side
        // completes the exchange — which matters because the side that noticed the desync and the
        // side that caused it are usually not the same one.
        const applied = await mod
          .pollResync(friend.endpointId, friend.recvPublic)
          .catch(() => false);
        verdicts.set(friend.endpointId, applied ? 'ok' : 'desynced');
        if (applied) {
          anyRecovered = true;
          getTelemetry().log('info', `resynced with ${friend.endpointId.slice(0, 10)}`, {
            'sc.peer': friend.endpointId.slice(0, 10),
          });
        }
      }

      // Drop our resync ephemeral once nobody is still mid-exchange. Holding it costs a private
      // key sitting in memory for no reason, and the next desync mints a fresh one anyway.
      const stillRecovering = [...verdicts.values()].some((v) => v === 'desynced');
      if (anyRecovered && !stillRecovering && typeof mod.clearResync === 'function') {
        await mod.clearResync().catch(() => {});
      }
    } finally {
      this.resyncInFlight = false;
      this.sessionVerdicts = verdicts;
      this.sessionsCheckedAt = Date.now();
      this.emit();
    }
  }

  /**
   * Record which friends a ratcheted publish left out, and why (FORWARD-SECRECY.md §4.5).
   *
   * A short wrap list is not a partial success — the friends named here did not receive this fix,
   * and nothing else in the system will notice. Two of the reasons are states a *human* has to
   * resolve, so they are held on the friend and surfaced in the UI rather than only logged:
   *
   * - `no_session` — no ratchet session, because the pair predates envelope v3 or the session was
   *   forgotten. Only an in-person re-pair fixes this; sessions are rooted by the SAS bump alone.
   * - `lapsed` — they have not contributed a ratchet key within `T_lapse`, which usually means
   *   their device has not run the app for a day. Distinct from revoked, and distinct from stale.
   *
   * The other two are transient — `no_sending_chain` clears on the next tick once the initiator's
   * first envelope lands, and `state_unavailable` is a storage failure that §4.6 recovery handles
   * — so they are telemetered but never shown.
   */
  private noteDroppedRecipients(dropped: string[], span: Span): void {
    if (dropped.length === 0) {
      if (this.droppedRecipients.size > 0) {
        this.droppedRecipients.clear();
        this.emit();
      }
      return;
    }
    const next = new Map<string, RatchetDropReason>();
    for (const entry of dropped) {
      const sep = entry.lastIndexOf(':');
      if (sep <= 0) continue;
      const endpointId = entry.slice(0, sep);
      const reason = entry.slice(sep + 1) as RatchetDropReason;
      const actionable = reason === 'no_session' || reason === 'lapsed';
      if (actionable) next.set(endpointId, reason);
      // `no_sending_chain` is a responder waiting for the initiator's first envelope and clears
      // itself next tick, so it stays at debug; everything else means a friend missed this fix.
      getTelemetry().log(
        (reason as string) === 'no_sending_chain' ? 'debug' : 'warn',
        `fix not delivered to ${endpointId.slice(0, 10)}: ${reason}`,
        { 'sc.peer': endpointId.slice(0, 10), 'sc.drop_reason': reason }
      );
    }
    span.addEvent('ratchet.recipients_dropped', { count: dropped.length });
    this.droppedRecipients = next;
    // Emit rather than coalesce: this is once-per-tick, and "your friend is not receiving your
    // location" is exactly the kind of change a 250 ms debounce should not sit on.
    this.emit();
  }

  /**
   * Publish the tick's **watcher** envelope: a null fix — no position, an empty padded payload —
   * wrapped for every friend we are NOT sharing with (FORWARD-SECRECY.md §4.1).
   *
   * Symmetric lanes: a one-directional watcher edge still carries an envelope from us on the same
   * cadence a sharer's does, so the relationship runs the protocol in both directions and the
   * stash — which sees constant-length ciphertext either way — cannot tell which edges are which.
   * Ratcheted since §4.2 landed, and that is what makes the symmetry real rather than cosmetic:
   * this envelope carries our ratchet contribution to those friends, which is what keeps a
   * watch-only edge from lapsing at `T_lapse`.
   *
   * Best effort by design: the real fix has already been published and its `seq` returned, and a
   * watcher edge carries no position, so a failure here must not fail the tick or make the outbox
   * retain (and re-publish) a fix that already went out. It is a distinct `seq` from the real fix
   * — two envelopes, never the same `(author, seq)` — and lands in its own durable slot, so the
   * two lanes cannot supersede each other.
   */
  private async publishNullFix(ts: number, parent?: SpanContext): Promise<void> {
    const mod = this.mod;
    const subId = this.mySubId;
    if (!mod || !subId) return;
    const watchers = pool.watcherEndpoints(this.state);
    if (watchers.length === 0) return;
    // Absent on iOS binaries built before this API (Swift bindings regenerate only on macOS).
    if (typeof mod.publishNull !== 'function') return;

    const span = getTelemetry().startSpan('publish.null', {
      parent,
      attributes: {
        'sc.author': this.keys ? this.keys.endpointId.slice(0, 10) : undefined,
        recipients: watchers.length,
        payload_type: 'null-fix',
        payload_ts: ts,
      },
    });
    try {
      const seq = await this.nextSeq();
      span.setAttribute('sc.seq', seq);
      const traceparent = getTelemetry().enabled ? traceparentFor(span.context) : null;
      const liveDropped = droppedFrom(await mod.publishNull(subId, seq, ts, watchers, traceparent));
      span.addEvent('gossip.publish.completed', { dropped: liveDropped.length });
      if (typeof mod.docsWriteNull === 'function') {
        const dropped = droppedFrom(await mod.docsWriteNull(subId, seq, ts, watchers, traceparent));
        this.noteDroppedRecipients(dropped, span);
        span.addEvent('docs.write.completed', { dropped: dropped.length });
      }
      span.setStatus('ok');
    } catch (err) {
      // Never rethrow: see the doc comment — the real fix of this tick is already on the wire.
      const reason = err instanceof Error ? err.message : String(err);
      span.recordError(err);
      getTelemetry().log(
        'warn',
        `null fix publish failed (watcher edges miss this tick): ${reason}`
      );
    } finally {
      span.end();
    }
  }

  /**
   * Capture and publish a fresh GPS fix immediately, bypassing the motion/battery sampling gate.
   * This is intentionally a developer diagnostic path: the normal publish span, durable mirror,
   * and local trail update still run so the resulting ping can be followed end to end.
   */
  async forceLocationPush(
    fix: LocationFix,
    trigger: 'manual' | 'scheduled' = 'manual'
  ): Promise<number> {
    const span = getTelemetry().startSpan('debug.location.push', {
      attributes: { trigger },
    });
    try {
      if (!this.isReady()) throw new Error('Friend sync is not ready to publish a location.');
      this.recordLocalFix(fix);
      const seq = await this.publishFix(fix, span.context);
      span.setAttribute('sc.seq', seq);
      // Push too, or this diagnostic lies: `publishFix` alone leaves the envelope in the local
      // replica, so the ping it claims you can "follow end to end" would stop at this device and
      // reproduce the very bug you'd be using it to chase.
      await this.pushTrail(span.context);
      span.setStatus('ok');
      return seq;
    } catch (error) {
      span.recordError(error);
      throw error;
    } finally {
      span.end();
    }
  }

  /**
   * Recover envelopes missed while offline. Triggers range reconciliation, then reads the durable
   * replica into the trail cache — reconciliation can land entries silently (at friend-import or via
   * live sync) without firing backfill events, so reading the replica afterwards is what actually
   * surfaces recovered fixes to the UI.
   */
  async syncTrail(sinceTs = 0, parent?: SpanContext): Promise<void> {
    if (!this.mod) return;
    const span = getTelemetry().startSpan('trail.sync.app', {
      parent,
      attributes: { since_ts: sinceTs, stash: this.stashEnabled() },
    });
    try {
      await this.mod.syncLatest(
        this.stashEnabled() ? this.stashTicket : null,
        getTelemetry().enabled ? traceparentFor(span.context) : null
      );
      span.setStatus('ok');
    } catch (err) {
      // Best effort — the durable path may be unavailable (e.g. web without docs) — but when it
      // fails the user simply won't see friends' missed fixes, so surface it as a log too.
      const reason = err instanceof Error ? err.message : String(err);
      span.addEvent('native.sync.failed', { reason });
      getTelemetry().log('warn', `trail sync failed (backfill from stash/peers): ${reason}`, {
        since_ts: sinceTs,
        stash: this.stashEnabled(),
      });
      span.setStatus('error', reason);
    }
    const recovered = await this.refreshTrailFromReplica(sinceTs);
    span.setAttribute('recovered', recovered);
    span.end();
    this.lastSyncRecovered = recovered;
    this.notifyTrailChanged();
    this.emit();
  }

  /**
   * Push our own durable trail to the stash. **Call this after publishing**, or the fixes stay on
   * this device: `docsWrite` writes the local replica, and iroh-docs only broadcasts a local insert
   * for namespaces `start_sync` has marked as syncing — which nothing in a publish-only context
   * does. Without it an offline friend has nothing to reconcile from, which is invisible while both
   * phones are online (live gossip covers it) and total when they aren't.
   *
   * Best-effort and cheap to repeat: once the namespace is syncing, later writes broadcast on their
   * own for the lifetime of the process. No-op when the stash is off (peer-only reconciliation) or
   * when running against an older iOS binary whose bindings predate `pushTrail`.
   */
  async pushTrail(parent?: SpanContext): Promise<void> {
    if (!this.mod) return;
    if (!this.stashEnabled()) return;
    // iOS bindings only regenerate on macOS; guard rather than crash on a stale binary.
    if (typeof this.mod.pushTrail !== 'function') return;
    const span = getTelemetry().startSpan('trail.push.app', {
      parent,
      attributes: {
        'sc.author': this.keys ? this.keys.endpointId.slice(0, 10) : undefined,
        stash: true,
      },
    });
    try {
      await this.mod.pushTrail(
        this.stashTicket,
        getTelemetry().enabled ? traceparentFor(span.context) : null
      );
      span.setStatus('ok');
    } catch (err) {
      // A failure means these fixes only reach friends who are online now — exactly the gap the
      // stash exists to close — so log it, don't swallow it silently.
      const reason = err instanceof Error ? err.message : String(err);
      span.addEvent('native.push.failed', { reason });
      getTelemetry().log(
        'warn',
        `trail push failed (fixes not mirrored to the stash; offline friends won't see them): ${reason}`
      );
      span.setStatus('error', reason);
    } finally {
      span.end();
    }
  }

  /**
   * Read every author's current decrypted fix out of the durable replica and merge it into the
   * local store. Returns how many FRIEND fixes were newly stored.
   *
   * Two things keep this cheap, and both matter — live mode runs one of these every
   * {@link LIVE_WATCH_PULL_INTERVAL_MS}:
   *
   * - there is nothing to collapse. Each namespace holds a single overwritten slot, so a friend
   *   who has been away for a week reconciles into exactly one entry, not a week of them. This is
   *   structural now rather than a batch the app trims after the fact;
   * - {@link replicaWatermarks} skips authors whose slot we have already ingested, so a repeat
   *   sync neither re-writes SQLite nor fans out a redundant repaint.
   */
  private async refreshTrailFromReplica(sinceTs: number): Promise<number> {
    if (!this.mod) return 0;
    const selfId = this.keys?.endpointId;
    const known = new Set(pool.friendList(this.state).map((f) => f.endpointId));

    // One read for the whole replica: every namespace holds a single overwritten slot, so there is
    // no per-author range to walk and nothing to collapse. The watermark is kept only to skip
    // re-storing a fix we have already seen — it is no longer a read bound.
    const events = await this.mod.readLatest().catch(() => [] as NativeRatchetEvent[]);

    let recoveredFriendFixes = 0;
    for (const nf of events) {
      if (known.has(nf.author)) {
        this.recordRatchetActivity(
          nf.author,
          nf.kind === 'null' ? 'null' : 'fix',
          nf.seq,
          'durable'
        );
      }
      if (!nf.fix) continue;
      const fix = {
        lat: nf.fix.lat,
        lon: nf.fix.lon,
        accuracyM: nf.fix.accuracyM,
        headingDeg: nf.fix.headingDeg,
        ts: nf.fix.ts,
      };
      // `sinceTs` is the caller's inclusive lower bound; the watermark is what we have already
      // ingested. Compared on `(ts, seq)` so a republish at the same timestamp is not mistaken for
      // the entry we already hold — the store is last-write-wins regardless, but skipping here is
      // what stops live mode re-writing and re-rendering the same slot every 8 seconds.
      if (nf.fix.ts < sinceTs) continue;
      const seen = this.replicaWatermarks.get(nf.author);
      if (seen && (nf.fix.ts < seen.ts || (nf.fix.ts === seen.ts && nf.seq <= seen.seq))) continue;

      if (selfId && nf.author === selfId) {
        await this.trail.appendOwn(fix, nf.seq);
      } else if (known.has(nf.author)) {
        await this.trail.recordFriendLatest({
          author: nf.author,
          seq: nf.seq,
          fix,
          receivedAt: Date.now(),
          backfill: true,
        });
        recoveredFriendFixes += 1;
      } else {
        // An author we no longer pool with. Their slot is still replicated until the namespace is
        // dropped; storing it would resurrect a removed friend's dot.
        continue;
      }
      this.replicaWatermarks.set(nf.author, { ts: nf.fix.ts, seq: nf.seq });
    }
    return recoveredFriendFixes;
  }

  /**
   * Our OWN retained trail, ascending by seq, at or after `sinceTs`. This is the only history
   * there is: a friend has a current fix and nothing behind it (FORWARD-SECRECY.md §4.4), which
   * is why the two reads are separate methods rather than one author-keyed query.
   */
  selfTrail(sinceTs = 0): Promise<TrailPoint[]> {
    return this.trail.selfTrail(sinceTs);
  }

  /** Every friend's current fix — at most one per friend, and never any older one. */
  friendLatest(): Promise<TrailPoint[]> {
    return this.trail.friendLatest();
  }

  /**
   * Start the background location service: real GPS (foreground + OS background), gated by the
   * battery-aware sampling policy, feeding fixes through a durable outbox into {@link publishFix}.
   * Native-only. See docs/social/ARCHITECTURE.md §9.
   */
  async startBackground(config?: Partial<BackgroundStartConfig>): Promise<BackgroundAccess> {
    if (Platform.OS === 'web') {
      throw new Error('Background location sharing is not supported on web.');
    }
    if (!this.mod) {
      throw new Error('Background sharing needs the native module (custom dev client).');
    }
    if (this.backgroundSharing) return this.backgroundAccess;

    try {
      const [
        { createLocationEngine },
        { createSamplingPolicy },
        { BackgroundLocationProvider: Provider },
        { backgroundOutbox, registerActiveBackgroundFixHandler, registerActiveRefreshHandler },
        { createBatterySource },
        { createCadenceController, cfgFromDecision },
      ] = await Promise.all([
        import('./background/location-engine'),
        import('./background/sampling-policy'),
        import('./background/background-provider'),
        import('./background/register-task'),
        import('./background/battery-source'),
        import('./background/cadence-controller'),
      ]);

      const battery = createBatterySource();
      // Launch on the user's grid, not the default — otherwise a phone restarting at 15 min would
      // publish at 5 min until they next opened settings.
      this.shareIntervalMs = await loadShareIntervalMs(this.kv);
      const policy = createSamplingPolicy({ intervalMs: this.shareIntervalMs });
      this.engine = createLocationEngine({
        publisher: this,
        outbox: backgroundOutbox,
        trail: this.trail,
        policy,
        // Real device power (charge level, charging state, Low-Power Mode) drives the policy's
        // battery-aware backoff — without this reader the engine assumes a perpetually full battery.
        battery: () => battery.read(),
      });
      await this.engine.start();
      this.bgTaskHandlerStop = registerActiveBackgroundFixHandler(async (fix, parent) => {
        await this.ingestAndTrackLocal(fix, parent);
      });

      // Route the periodic RECEIVE-side backfill (WorkManager / BGTaskScheduler) to THIS live
      // runtime rather than a headless node. On Android this runtime stays alive while backgrounded
      // (the location foreground service), so the periodic task must reuse this node — spinning up a
      // second one calls createNode → clearRuntime() and tears this node's subscriptions down,
      // silently stopping send + live receive until relaunch.
      // Drain BEFORE syncing: `syncTrail` is the only thing that pushes our own namespace to the
      // stash, so flushing after it would leave everything this wake published stranded until the
      // next OS wake (~15 min at best, and iOS may skip many).
      this.bgRefreshHandlerStop = registerActiveRefreshHandler(async (parent?: SpanContext) => {
        // Heartbeat first: this OS wake may be the only chance a stationary phone gets to fill the
        // slots that elapsed while it was frozen, and the fills have to be in the outbox before the
        // drain below or they wait for the next wake.
        await this.engine?.heartbeat(parent);
        await this.engine?.flush(parent);
        await this.syncTrail(0, parent);
      });

      this.bgProvider = new Provider();
      const notification = {
        title: 'streetCryptid',
        body: "Keeping your friends' map current.",
        color: '#C6791A',
      };
      // Arm the OS from a *real* battery read, so a phone launching in Low-Power Mode starts at the
      // conserving accuracy tier instead of arming high and being re-armed on the first power event.
      // (The cadence is identical either way — battery never moves it.)
      const initialDecision = policy.decide({ battery: await battery.read() });
      const initialCfg = {
        ...cfgFromDecision(initialDecision, notification),
        ...config,
      };
      const permissions = await this.bgProvider.startBackground(initialCfg);
      this.backgroundAccess = permissions.background ? 'full' : 'foreground';

      // After the initial arm, the cadence controller re-programs the OS whenever the decision
      // materially changes (motion class, battery, Low-Power Mode) and re-evaluates on power events —
      // so sampling actually follows the policy instead of staying pinned at the first cadence.
      this.bgCadenceStop = createCadenceController({
        engine: this.engine,
        provider: this.bgProvider,
        battery,
        notification,
        overrides: config,
        seed: initialCfg,
        onError: (error) => console.warn('[background-location] cadence re-arm failed', error),
      }).start();

      const firstFix = await this.bgProvider.getCurrent();
      await this.ingestAndTrackLocal(firstFix);
      // The TaskManager location task delivers in foreground too. A second watch processed every
      // iOS fix twice and kept another CLLocationManager running for no additional information.

      // Fill due slots while the runtime remains alive. iOS may suspend this timer in the background.
      this.armHeartbeat(this.shareIntervalMs);

      // Live-mode requests are only actionable while we are actually sampling, so the poll's
      // lifetime is background sharing's (§9c). Sharing off ⇒ nothing to make live ⇒ nothing to poll.
      this.startLiveRequestPolling();

      this.bgLifecycleStop = createAppLifecycleController({
        onForeground: () => {
          void this.engine?.flush();
          void this.syncTrail(0);
          // Re-center the revive fence on wherever we are now. A stale fence still works (being far
          // outside it only makes the exit fire sooner), but keeping it current stops a user who
          // never leaves a 200 m radius from having a tripwire they can't trip.
          const fix = this.engine?.getState().lastAcceptedFix;
          if (fix) {
            void import('./background/revive-task')
              .then(({ armReviveFence }) => armReviveFence(fix))
              .catch(() => undefined);
          }
        },
        onBackground: () => {
          // OS keep-alive (Android foreground service / iOS background location) covers this.
        },
      }).start();

      this.backgroundSharing = true;

      // Periodic RECEIVE-side backfill: an OS-scheduled task (~15 min) wakes a headless node to pull
      // friends' fixes that arrived while we were backgrounded — the SEND task only fires on movement
      // and never pulls. Best-effort and inert on builds without expo-background-task; scheduling it
      // must never fail startBackground.
      try {
        const { isBackgroundRefreshAvailable, scheduleBackgroundRefresh } =
          await import('./background/refresh-task');
        if (isBackgroundRefreshAvailable()) await scheduleBackgroundRefresh();
      } catch (error) {
        console.warn('[background-refresh] schedule failed', error);
      }

      // Record the INTENT last, once everything is actually up. A headless wake compares this against
      // the live OS state to decide whether we were killed and should re-arm — see
      // `ensureSharingArmedHeadless`. Writing it earlier would let a start that then threw leave
      // behind an intent the self-heal would keep trying to honour.
      await saveSharingEnabled(this.kv, true);
      // Arm the revive fence around where we are now. On iOS it is the only mechanism that
      // relaunches a terminated app; on Android it cannot do that, but a geofence event is a
      // documented exemption to the ban on starting a foreground service from the background, which
      // is the only way the self-heal can legally re-arm. See `revive-task.ts`.
      try {
        const { armReviveFence } = await import('./background/revive-task');
        // The one call that bypasses the re-arm floor: sharing is starting and there may be no
        // fence standing at all, so "keep whatever is already armed" is not a safe outcome here.
        await armReviveFence(firstFix, { force: true });
      } catch (error) {
        console.warn('[revive-fence] arm failed', error);
      }

      this.emit();
      return this.backgroundAccess;
    } catch (err) {
      // Partial start (e.g. background permission denied after the engine/watch were set up):
      // tear down whatever was created so a retry doesn't leak the engine or the GPS watch.
      await this.stopBackground();
      throw err;
    }
  }

  /**
   * Change how often location is published. Read the current value from
   * {@link SharingSnapshot.shareIntervalMs}. Persists the choice, re-grids the engine's slot
   * boundaries, and re-arms the OS (via the cadence controller, which sees the changed interval on
   * the engine's next state emission). Safe to call before the background service is running — the
   * value is stored and picked up by {@link startBackground}.
   *
   * Values outside `SHARE_INTERVAL_OPTIONS_MS` are ignored: off-grid intervals would break the
   * wall-clock slot alignment the uniform cadence depends on.
   */
  async setShareInterval(intervalMs: number): Promise<void> {
    if (!SHARE_INTERVAL_OPTIONS_MS.some((option) => option === intervalMs)) return;
    if (intervalMs === this.shareIntervalMs) return;
    this.shareIntervalMs = intervalMs;
    await saveShareIntervalMs(this.kv, intervalMs);
    await this.engine?.setIntervalMs(intervalMs);
    if (this.heartbeatTimer) this.armHeartbeat(intervalMs);
    this.emit();
  }

  /**
   * (Re)arm the heartbeat timer at `intervalMs`. Replaces any running timer, so it is safe to call
   * on every cadence change.
   *
   * The interval is not always the share interval: live mode needs its own, much shorter, tick.
   * With live mode's 25 m OS distance filter a stationary phone is delivered no fixes at all, so
   * the live keepalive can only come from a timer — and a 5-minute one cannot deliver a 30-second
   * keepalive. See `LocationEngine.heartbeat`.
   */
  private armHeartbeat(intervalMs: number): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      void this.engine?.heartbeat();
    }, intervalMs);
    (this.heartbeatTimer as unknown as { unref?: () => void }).unref?.();
  }

  /** Stop the background location service (leaves queued fixes in the outbox). Idempotent. */
  async stopBackground(): Promise<void> {
    // Clear the intent FIRST, and unconditionally. If this ran at the end, an exception partway
    // through teardown would leave the flag set and the next headless wake would dutifully re-arm
    // sharing the user just switched off.
    try {
      await saveSharingEnabled(this.kv, false);
    } catch {
      // ignore — a KV failure must not block teardown
    }
    try {
      const { disarmReviveFence } = await import('./background/revive-task');
      await disarmReviveFence();
    } catch {
      // ignore — best-effort; the fence is inert once the intent flag is clear
    }
    if (this.liveTrackingTimer) {
      clearTimeout(this.liveTrackingTimer);
      this.liveTrackingTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.stopLiveRequestPolling();
    // Sharing off ends any live session outright: there is nothing left to make live, and leaving
    // stale watchers behind would have the UI claim someone is watching a phone that stopped.
    this.watcherSessions = [];
    const stopCadence = this.bgCadenceStop;
    this.bgCadenceStop = null;
    this.bgTaskHandlerStop?.();
    this.bgTaskHandlerStop = null;
    this.bgRefreshHandlerStop?.();
    this.bgRefreshHandlerStop = null;
    this.bgLifecycleStop?.();
    this.bgLifecycleStop = null;
    try {
      await stopCadence?.();
    } catch {
      // ignore
    }
    try {
      await this.bgProvider?.stopBackground();
    } catch {
      // ignore
    }
    try {
      await this.engine?.stop();
    } catch {
      // ignore
    }
    try {
      const { cancelBackgroundRefresh } = await import('./background/refresh-task');
      await cancelBackgroundRefresh();
    } catch {
      // ignore — cancellation is best-effort
    }
    this.bgProvider = null;
    this.engine = null;
    this.backgroundSharing = false;
    this.backgroundAccess = 'unknown';
    this.emit();
  }

  /**
   * Turn on real-time live tracking for a bounded window (default 2 min), after which it auto-reverts
   * to the ambient cadence. The background service normally samples calmly to save battery; this is
   * the on-demand escape hatch for the real-time case — a friend actively watching your location —
   * so the app never pays real-time GPS cost around the clock. `on: false` (or a fresh call) cancels
   * any active window. No-op until the background service is running; the cadence controller picks
   * up the engine's new decision and re-programs the OS.
   *
   * Prefer {@link applyWatcherSessions} for the request-driven path — it derives the window from the
   * active watchers so two overlapping watchers cannot cut each other short.
   */
  async setLiveTracking(on: boolean, ttlMs = 120_000): Promise<void> {
    if (this.liveTrackingTimer) {
      clearTimeout(this.liveTrackingTimer);
      this.liveTrackingTimer = null;
    }
    await this.engine?.setLiveMode(on);
    // The heartbeat carries live mode's keepalive, and the share interval is far too slow for it.
    // Only touch the timer when one is actually running — live tracking is a no-op until the
    // background service has started, and arming a heartbeat here would resurrect a stopped one.
    if (this.heartbeatTimer) {
      this.armHeartbeat(on ? DEFAULT_SAMPLING_CONFIG.liveMaxQuietMs : this.shareIntervalMs);
    }
    if (on && ttlMs > 0) {
      const timer = setTimeout(() => {
        this.liveTrackingTimer = null;
        void this.engine?.setLiveMode(false);
        if (this.heartbeatTimer) this.armHeartbeat(this.shareIntervalMs);
        // Sessions have lapsed by construction; drop them so the UI stops claiming we are live.
        this.watcherSessions = activeWatchers(this.watcherSessions, Date.now());
        this.emit();
      }, ttlMs);
      (timer as unknown as { unref?: () => void }).unref?.();
      this.liveTrackingTimer = timer;
    }
  }

  // ── Live-mode request channel (ARCHITECTURE §9c) ─────────────────────────────────────────

  /**
   * Ask `endpointId` to switch to the real-time cadence, by writing an encrypted control message
   * into OUR namespace (which they replicate) and pushing it. They pick it up on their next poll,
   * so expect minutes, not seconds — there is deliberately no push wake (§10).
   *
   * Wrapped only for that friend, so nobody else — including the stash — can tell a request was
   * even sent, let alone to whom. Requires that they share with us: watching someone who does not
   * share their location is meaningless, and we surface that as a failure rather than a silent wait.
   */
  async requestLive(endpointId: string, ttlMs = LIVE_TTL_DEFAULT_MS): Promise<void> {
    const friend = this.state.friends[endpointId];
    if (!friend) throw new Error('live: not a friend');
    if (!this.mod) throw new Error('live: node not ready');
    if (typeof this.mod.docsWriteControl !== 'function') {
      // iOS bindings predating the control API — see `just bindgen-ios`.
      throw new Error('live: this build cannot send live requests yet');
    }
    const span = getTelemetry().startSpan('live.request.sent', {
      attributes: { 'sc.peer': endpointId.slice(0, 10), ttl_ms: clampLiveTtl(ttlMs) },
    });
    try {
      const nonce = await mintNonce(this.randomBytes);
      const msg = buildLiveRequest(Date.now(), ttlMs, nonce);
      await this.mod.docsWriteControl(msg, [friend.recvPublic]);
      // docsWriteControl only touches the LOCAL replica — same rule as docsWrite. Without this the
      // request never leaves the phone and the friend polls forever. See §9 "push-to-stash".
      //
      // NOTE: `pushTrail` no-ops when the stash is off, so live requests effectively REQUIRE the
      // stash. That is inherent, not incidental: without it delivery needs both phones online and
      // reconciling at the same moment, which is exactly what the stash exists to stop relying on.
      await this.pushTrail(span.context);
      this.sentRequestNonces.set(endpointId, nonce);
      // Start pulling immediately. The subject won't speed up until its next poll (up to
      // LIVE_REQUEST_POLL_INTERVAL_MS away), but its ambient fixes still need collecting in the
      // meantime, and this way the window is covered end to end rather than from first-arrival.
      this.watchingSessions.set(endpointId, Date.now() + clampLiveTtl(ttlMs));
      this.startLiveWatchPull();
      span.setStatus('ok');
      this.emit();
    } catch (err) {
      span.recordError(err);
      throw err;
    } finally {
      span.end();
    }
  }

  /**
   * Withdraw an outstanding live request. Supersedes it in our single control slot, so a friend who
   * has not polled yet never sees the request at all. Best-effort: if they already armed, they stop
   * on their next poll (or when the window lapses).
   */
  async cancelLiveRequest(endpointId: string): Promise<void> {
    const friend = this.state.friends[endpointId];
    if (!friend || !this.mod || typeof this.mod.docsWriteControl !== 'function') return;
    const nonce = await mintNonce(this.randomBytes);
    try {
      await this.mod.docsWriteControl(buildLiveCancel(Date.now(), nonce), [friend.recvPublic]);
      await this.pushTrail();
    } catch {
      /* best-effort — the window lapses on its own regardless */
    }
    this.sentRequestNonces.delete(endpointId);
    this.watchingSessions.delete(endpointId);
    this.stopLiveWatchPullIfIdle();
    this.emit();
  }

  /**
   * Withdraw every outstanding live request we sent. Called when we background: a watcher who is not
   * looking at the screen has no use for a friend's real-time GPS, and leaving the request standing
   * would keep their phone at the live cadence for the rest of the TTL for nobody's benefit.
   *
   * Best-effort and inherently racy against process death — if we are *killed* rather than
   * backgrounded, nothing is sent and the subject's TTL is the only thing that stops it. That is why
   * the TTL remains the real bound, and why a cancel that fails here is not worth surfacing.
   */
  private async cancelAllLiveRequests(): Promise<void> {
    const outstanding = [...this.sentRequestNonces.keys()];
    if (outstanding.length === 0) return;
    await Promise.allSettled(outstanding.map((id) => this.cancelLiveRequest(id)));
  }

  /**
   * Watch app state for the WATCHER half of live mode (§9c). Deliberately separate from the
   * lifecycle controller `startBackground` installs: watching and sharing are independent — you can
   * watch a friend without sharing your own location — so tying this to the background service
   * would leave requests uncancelled for exactly the users who never turned sharing on.
   */
  private startWatcherLifecycle(): void {
    if (this.watcherLifecycleStop) return;
    this.watcherLifecycleStop = createAppLifecycleController({
      onForeground: () => {
        // Nothing to resume: a live window the user walked away from is over, by design. They ask
        // again if they still want it.
      },
      onBackground: () => {
        void this.cancelAllLiveRequests();
        this.watchingSessions.clear();
        this.stopLiveWatchPullIfIdle();
      },
    }).start();
  }

  /**
   * Run the watcher-side pull while any live session is active. Idempotent — safe to call on every
   * request.
   */
  private startLiveWatchPull(): void {
    if (this.liveWatchPullTimer) return;
    this.liveWatchPullTimer = setInterval(() => {
      void this.runLiveWatchPull();
    }, LIVE_WATCH_PULL_INTERVAL_MS);
    (this.liveWatchPullTimer as unknown as { unref?: () => void }).unref?.();
  }

  /** Stop the pull once no live session remains, so it can never outlive the windows it serves. */
  private stopLiveWatchPullIfIdle(): void {
    const now = Date.now();
    for (const [id, expiresAt] of this.watchingSessions) {
      if (expiresAt <= now) this.watchingSessions.delete(id);
    }
    if (this.watchingSessions.size > 0 || !this.liveWatchPullTimer) return;
    clearInterval(this.liveWatchPullTimer);
    this.liveWatchPullTimer = null;
  }

  /** One pull tick. Serialized: a slow reconciliation must not overlap the next tick. */
  private async runLiveWatchPull(): Promise<void> {
    this.stopLiveWatchPullIfIdle();
    if (this.watchingSessions.size === 0) return;
    if (this.liveWatchPullInFlight) return this.liveWatchPullInFlight;
    this.liveWatchPullInFlight = this.syncTrail(0)
      .catch(() => {
        /* a missed tick is recovered by the next one — never surface transient sync failures */
      })
      .finally(() => {
        this.liveWatchPullInFlight = null;
      });
    return this.liveWatchPullInFlight;
  }

  /** Stop `endpointId`'s live session immediately (the user's "stop" action). */
  async stopWatcher(endpointId: string): Promise<void> {
    this.watcherSessions = disarmWatcher(this.watcherSessions, endpointId, Date.now());
    await this.applyWatcherSessions();
  }

  /**
   * Reconcile live tracking with the currently-active watcher sessions: live until the LATEST
   * expiry across them, ambient when there are none. Called after anything changes the set, so
   * overlapping watchers extend rather than truncate each other.
   */
  private async applyWatcherSessions(): Promise<void> {
    const now = Date.now();
    this.watcherSessions = activeWatchers(this.watcherSessions, now);
    const until = liveUntilFrom(this.watcherSessions, now);
    if (until === null) {
      await this.setLiveTracking(false);
    } else {
      await this.setLiveTracking(true, until - now);
    }
    this.emit();
  }

  /**
   * Poll every friend's control slot for live-mode requests. Reconciles first — a request written
   * by a friend is only visible to us once we have pulled their namespace.
   *
   * Serialized: a slow reconciliation must not overlap the next tick.
   */
  private async pollLiveRequestsOnce(): Promise<void> {
    if (this.liveRequestPollInFlight) return this.liveRequestPollInFlight;
    this.liveRequestPollInFlight = this.runLiveRequestPoll().finally(() => {
      this.liveRequestPollInFlight = null;
    });
    return this.liveRequestPollInFlight;
  }

  private async runLiveRequestPoll(): Promise<void> {
    const mod = this.mod;
    if (!mod || typeof mod.readControl !== 'function') return;
    const friends = pool.friendList(this.state);
    if (friends.length === 0) return;

    // Pull first: their control entry reaches us through the same reconciliation as their fixes.
    try {
      await this.syncTrail(0);
    } catch {
      /* an unreachable stash/peer just means we see requests on a later tick */
    }

    let changed = false;
    for (const friend of friends) {
      let messages: NativeControlMsg[];
      try {
        messages = await mod.readControl(friend.endpointId);
      } catch {
        continue;
      }
      for (const msg of messages) {
        const now = Date.now();
        const verdict = evaluateControlMsg(msg, {
          now,
          isSharing: pool.isSharingWith(this.state, friend.endpointId),
          handled: this.handledNonces,
        });
        if (verdict.action === 'ignore') {
          // Only remember decisions about messages we could have acted on. Recording a `stale` or
          // `not-sharing` nonce would burn it, so a later legitimate re-send of the same message
          // (after re-enabling sharing, say) would be silently dropped as a duplicate.
          if (verdict.reason === 'duplicate') continue;
          const dropped = getTelemetry().startSpan('live.request.ignored', {
            attributes: {
              'sc.peer': friend.endpointId.slice(0, 10),
              'sc.drop_reason': verdict.reason,
            },
          });
          dropped.end();
          continue;
        }

        this.handledNonces = markHandled(this.handledNonces, msg.nonce, now);
        await saveHandledNonces(this.kv, this.handledNonces);
        changed = true;

        const span = getTelemetry().startSpan(
          verdict.action === 'arm' ? 'live.armed' : 'live.cancelled',
          { attributes: { 'sc.peer': friend.endpointId.slice(0, 10) } }
        );
        if (verdict.action === 'arm') {
          span.setAttribute('ttl_ms', verdict.ttlMs);
          this.watcherSessions = armWatcher(
            this.watcherSessions,
            friend.endpointId,
            now + verdict.ttlMs,
            now
          );
        } else {
          this.watcherSessions = disarmWatcher(this.watcherSessions, friend.endpointId, now);
        }
        span.end();
      }
    }
    if (changed) await this.applyWatcherSessions();
  }

  /** Start the live-request poll. Idempotent; runs only while background sharing is on. */
  private startLiveRequestPolling(): void {
    if (this.liveRequestPollTimer) return;
    this.liveRequestPollTimer = setInterval(() => {
      void this.pollLiveRequestsOnce();
    }, LIVE_REQUEST_POLL_INTERVAL_MS);
    (this.liveRequestPollTimer as unknown as { unref?: () => void }).unref?.();
    // Check immediately too, so switching sharing on picks up a request already waiting.
    void this.pollLiveRequestsOnce();
  }

  private stopLiveRequestPolling(): void {
    if (!this.liveRequestPollTimer) return;
    clearInterval(this.liveRequestPollTimer);
    this.liveRequestPollTimer = null;
  }

  shutdown(): void {
    void this.shutdownAsync();
  }

  shutdownAsync(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = this.performShutdown();
    return this.shutdownPromise;
  }

  private async performShutdown(): Promise<void> {
    // Hand the node back first: from here on we are tearing it down, so a headless session waking
    // mid-teardown is free to build its own. Only the mounted service ever held the claim.
    if (this.ownsNativeRuntime) {
      this.ownsNativeRuntime = false;
      releaseNativeRuntime();
    }
    // Stop callbacks synchronously before awaiting native teardown.
    this.stopPairingPolling();
    this.stopBumpPolling();
    this.stopLiveRequestPolling();
    this.watcherLifecycleStop?.();
    this.watcherLifecycleStop = null;
    this.watchingSessions.clear();
    if (this.liveWatchPullTimer) {
      clearInterval(this.liveWatchPullTimer);
      this.liveWatchPullTimer = null;
    }
    if (this.trailChangeTimer) {
      clearTimeout(this.trailChangeTimer);
      this.trailChangeTimer = null;
    }
    if (this.liveTrackingTimer) {
      clearTimeout(this.liveTrackingTimer);
      this.liveTrackingTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.bgTaskHandlerStop?.();
    this.bgTaskHandlerStop = null;
    this.bgRefreshHandlerStop?.();
    this.bgRefreshHandlerStop = null;
    this.bgLifecycleStop?.();
    this.bgLifecycleStop = null;
    this.fixSub?.remove();
    this.fixSub = null;
    this.opaqueSub?.remove();
    this.opaqueSub = null;
    const mod = this.mod;
    const subscriptionIds = [...(this.mySubId ? [this.mySubId] : []), ...this.friendSubs.values()];
    this.mod = null;
    this.status = 'stopped';
    this.friendSubs.clear();
    this.mySubId = null;
    this.snapshotListeners.clear();
    this.fixListeners.clear();
    this.localFixListeners.clear();
    this.trailChangeListeners.clear();
    this.errorListeners.clear();

    const work: Promise<unknown>[] = [this.stopBackground()];
    if (mod) {
      work.push(
        (async () => {
          await Promise.allSettled(
            subscriptionIds.map((subscriptionId) => mod.unsubscribe(subscriptionId))
          );
          await mod.shutdown();
        })()
      );
    }
    await Promise.allSettled(work);
  }

  /** Restore the persisted pool and re-establish subscriptions so sharing resumes after a reload. */
  private async restorePool(subscribeToFriends = true): Promise<void> {
    const persisted = await loadPool(this.kv);
    if (!persisted) return;
    this.state = persisted;
    if (subscribeToFriends) {
      for (const friend of pool.friendList(this.state)) {
        try {
          await this.subscribeToFriend(friend);
        } catch {
          // A single bad card shouldn't block restoring the rest.
        }
      }
    } else {
      // Headless: no gossip subscriptions (nothing is listening), but we still MUST re-open the
      // friends' trail namespaces. Native `syncTrail` reconciles the namespaces in its handle
      // cache, and a fresh process starts with only our own in it — so without this the periodic
      // backfill silently syncs nothing but our own trail and can never recover a friend's fixes.
      await this.importFriendTrails();
    }
    // Any friend at all, not just the ones we share position with: watcher edges publish null
    // fixes on the same cadence (FORWARD-SECRECY.md §4.1), and that needs our own topic open.
    if (pool.friendList(this.state).length > 0) {
      try {
        await this.ensureMySubscription();
      } catch {
        // ignore
      }
    }
  }

  /**
   * Re-import every friend's docs read-ticket so their trail namespace is open in the native
   * handle cache. Idempotent (iroh-docs re-imports the capability for a namespace it already has)
   * and cheap — it's the replication half of a grant, with no gossip membership.
   */
  private async importFriendTrails(): Promise<void> {
    if (!this.mod) return;
    const span = getTelemetry().startSpan('trail.rehydrate');
    // Devices that ran a build which retained friends' history are still carrying it (980 points
    // for a single friend on the device this was diagnosed from). That is no longer collapsed
    // here: the schema migration in `persistence.ts` drops the whole legacy `trail` table on first
    // open, which erases those rows outright instead of pruning around them — the difference
    // FORWARD-SECRECY.md §5.3 turns on.
    let imported = 0;
    for (const friend of pool.friendList(this.state)) {
      if (!friend.docTicket) continue;
      try {
        await this.mod.importDocTicket(friend.docTicket);
        imported += 1;
      } catch {
        // Non-fatal: only this friend's offline recovery is affected.
      }
    }
    span.setAttributes({ friends: pool.friendList(this.state).length, imported });
    span.end();
  }

  /** Persist the current pool (fire-and-forget; best-effort). */
  private persistPool(): void {
    void savePool(this.kv, this.state);
  }

  private async nextSeq(): Promise<number> {
    this.seq += 1;
    // Persist BEFORE the caller puts this seq on the wire, so a kill mid-publish can't reuse it
    // (a lagging persisted seq would collide `author/seq` docs keys for a rejoining peer).
    await saveSeq(this.seq);
    return this.seq;
  }

  private async safeDocTicket(): Promise<string | null> {
    try {
      const t = await this.mod?.docTicket();
      return t ? t : null;
    } catch {
      return null;
    }
  }

  private async subscribeToFriend(card: Friend): Promise<void> {
    if (!this.mod || this.friendSubs.has(card.endpointId)) return;
    const topic = await this.mod.deriveTopic(card.endpointId);
    const subId = await this.mod.subscribe(topic, [card.ticket, ...this.stashBootstrap()]);
    this.friendSubs.set(card.endpointId, subId);
    // Replicate their durable trail namespace so syncTrail can recover fixes we missed (§6).
    if (card.docTicket) {
      try {
        await this.mod.importDocTicket(card.docTicket);
      } catch {
        // Non-fatal: live gossip still works; only offline recovery of their trail is affected.
      }
      // Also grant the stash replication of their trail so we can catch up while both are offline.
      // No push token — see `syncStashGrants`.
      if (this.stashEnabled()) {
        void this.stash.registerNamespace({ readTicket: card.docTicket }).catch(() => {
          /* best-effort */
        });
      }
    }
    // Replicate + live-sync their profile namespace so identity updates land automatically (§3).
    if (card.profileTicket) {
      try {
        await this.mod.importProfileTicket(card.profileTicket);
      } catch {
        // Non-fatal: we keep whatever profile fields the card already carried.
      }
    }
  }

  /** (Re)subscribe our own topic so the swarm includes everyone we share with. */
  private async ensureMySubscription(): Promise<void> {
    if (!this.mod || !this.keys) return;
    const bootstrap = [
      ...pool.recipients(this.state).map((f) => f.ticket),
      ...this.stashBootstrap(),
    ];
    const signature = bootstrap.slice().sort().join('|');
    if (this.mySubId && signature === this.mySubRecipients) return;

    if (this.mySubId) {
      await this.mod.unsubscribe(this.mySubId);
      this.mySubId = null;
    }
    const topic = await this.mod.deriveTopic(this.keys.endpointId);
    this.mySubId = await this.mod.subscribe(topic, bootstrap);
    this.mySubRecipients = signature;
  }

  private handleFix(event: OnFixEvent): void {
    const telemetry = getTelemetry();
    // App-level delivery marker: the native `gossip.receive` span says the envelope arrived and
    // decrypted; this one says the app actually surfaced it (or that a non-friend/removing gate
    // ate it — the last place a ping can silently die).
    const known = !!this.state.friends[event.author] && !this.removingFriends.has(event.author);
    const span = telemetry.startSpan('fix.received.app', {
      attributes: {
        'sc.author': event.author.slice(0, 10),
        'sc.seq': event.seq,
        payload_type: 'location-fix',
        payload_ts: event.fix.ts,
        payload_accuracy_m: event.fix.accuracyM,
        payload_heading_deg: event.fix.headingDeg,
        transport_path: event.via ?? (event.backfill ? 'durable-trail' : 'live-gossip'),
        ...(known ? {} : { 'sc.drop_reason': 'unknown-or-removing-author' }),
      },
    });
    span.end();
    if (!this.state.friends[event.author] || this.removingFriends.has(event.author)) return;
    this.recordRatchetActivity(event.author, 'fix', event.seq, event.backfill ? 'durable' : 'live');

    const fix: IncomingFix = {
      author: event.author,
      seq: event.seq,
      fix: {
        lat: event.fix.lat,
        lon: event.fix.lon,
        accuracyM: event.fix.accuracyM,
        headingDeg: event.fix.headingDeg,
        ts: event.fix.ts,
      },
      receivedAt: Date.now(),
      ...(event.backfill ? { backfill: true } : {}),
      ...(event.via ? { via: event.via } : {}),
    };
    void this.trail
      .recordFriendLatest(fix)
      .then(() => this.notifyTrailChanged())
      .catch((error: unknown) => this.reportError(error));
    this.fixListeners.forEach((l) => l(fix));
  }

  private handleOpaque(event: OnOpaqueEvent): void {
    if (event.kind !== 'null' || !event.author || event.seq <= 0) return;
    if (!this.state.friends[event.author] || this.removingFriends.has(event.author)) return;
    this.recordRatchetActivity(event.author, 'null', event.seq, 'live');
  }

  private recordRatchetActivity(
    author: string,
    kind: RatchetAckKind,
    seq: number,
    source: RatchetAckSource
  ): void {
    const current = this.ratchetActivity[author] ?? { fix: null, null: null };
    const previous = current[kind];
    if (previous && seq <= previous.seq) return;
    const receivedAt = Date.now();
    this.ratchetActivity = {
      ...this.ratchetActivity,
      [author]: {
        ...current,
        [kind]: { seq, receivedAt, source },
      },
    };
    recordEventLog({
      timestamp: receivedAt,
      level: 'debug',
      category: 'ratchet',
      action: `ratchet.ack.${kind}`,
      summary: `${kind} ack from ${author.slice(0, 10)} at seq ${seq}`,
      status: 'ok',
      transport: source,
      details: { peer: author.slice(0, 10), seq, kind, source },
    });
    getTelemetry().log('debug', `ratchet ${kind} response received`, {
      'sc.peer': author.slice(0, 10),
      'sc.seq': seq,
      'sc.lane': kind,
      source,
    });
    void saveRatchetActivity(this.kv, this.ratchetActivity);
    this.emit();
  }

  /**
   * Feed a raw provider fix to the engine, then move the local own-position dot to whatever the
   * engine actually *accepted*.
   *
   * The dot deliberately follows the engine rather than the raw fix: the confidence gate exists
   * because Android sometimes reports a position kilometres away, and rendering that before
   * discarding it would throw the user's own marker across town for a frame. On rejection this
   * re-affirms the last good position instead.
   */
  private async ingestAndTrackLocal(fix: LocationFix, parent?: SpanContext): Promise<void> {
    await this.engine?.ingest(fix, parent);
    const accepted = this.engine?.getState().lastAcceptedFix ?? null;
    if (accepted && accepted !== this.latestLocalFix) this.recordLocalFix(accepted);
  }

  private recordLocalFix(fix: LocationFix): void {
    if (this.latestLocalFix && fix.ts < this.latestLocalFix.ts) return;
    this.latestLocalFix = fix;
    this.localFixListeners.forEach((listener) => listener(fix));
  }

  /**
   * Announce that the retained trail changed, coalescing bursts into a single fan-out.
   * See {@link TRAIL_CHANGE_COALESCE_MS} for why this must never be per-fix.
   */
  private notifyTrailChanged(): void {
    if (this.trailChangeTimer) return;
    const timer = setTimeout(() => {
      this.trailChangeTimer = null;
      this.trailChangeListeners.forEach((listener) => listener());
    }, TRAIL_CHANGE_COALESCE_MS);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.trailChangeTimer = timer;
  }

  private reportError(error: unknown): void {
    const message = errorMessage(error);
    this.errorListeners.forEach((listener) => listener(message));
  }

  private setStatus(status: string): void {
    this.status = status;
    this.emit();
  }

  private snapshot(): SharingSnapshot {
    const card = this.selfCard();
    return {
      ready: this.status === 'ready',
      status: this.status,
      self: card
        ? {
            endpointId: card.endpointId,
            handle: card.handle,
            sigil: card.sigil,
            recvPublic: card.recvPublic,
            ...(card.cryptidName ? { cryptidName: card.cryptidName } : {}),
            ...(card.color ? { color: card.color } : {}),
          }
        : null,
      selfLink: card ? encodeContactCard(card) : null,
      friends: pool.friendList(this.state),
      sharingWith: [...this.state.sharingWith],
      backgroundSharing: this.backgroundSharing,
      backgroundAccess: this.backgroundAccess,
      lastSyncRecovered: this.lastSyncRecovered,
      stash: this.stashState(),
      transportDiagnostics: {
        snapshot: this.transportDiagnostics,
        updatedAt: this.transportDiagnosticsUpdatedAt,
        error: this.transportDiagnosticsError,
      },
      transports: this.transportState(),
      shareIntervalMs: this.shareIntervalMs,
      pairing: this.pairingSnapshot(),
      live: this.liveSnapshot(),
      sessions: this.sessionHealthSnapshot(),
      ratchetActivity: { ...this.ratchetActivity },
    };
  }

  /**
   * Per-friend forward-secrecy health for the UI (§4.5).
   *
   * Merges the two things that know something is wrong and would otherwise each be half a story:
   * the drop reasons the last publish reported (we cannot reach them) and the desync verdicts the
   * driver collected (we cannot open theirs). A friend can be in both, and the more actionable one
   * wins — being told to re-pair is useful, being told recovery is in progress is not.
   */
  private sessionHealthSnapshot(): SessionHealthSnapshot {
    const byFriend: Record<string, SessionHealth> = {};
    for (const [endpointId, verdict] of this.sessionVerdicts) {
      if (verdict !== 'ok') byFriend[endpointId] = verdict;
    }
    for (const [endpointId, reason] of this.droppedRecipients) {
      // `needs-repair` is terminal until a human acts, so it outranks any recovery state.
      byFriend[endpointId] = reason === 'no_session' ? 'needs-repair' : 'lapsed';
    }
    return { byFriend, lastCheckedAt: this.sessionsCheckedAt };
  }

  private liveSnapshot(): LiveSnapshot {
    const now = Date.now();
    const active = activeWatchers(this.watcherSessions, now);
    return {
      watchers: active.map((s) => ({ author: s.author, expiresAt: s.expiresAt })),
      liveUntil: liveUntilFrom(this.watcherSessions, now),
      watching: [...this.sentRequestNonces.keys()],
    };
  }

  private pairingSnapshot(): PairingSnapshot {
    return {
      available: Platform.OS !== 'web' && this.mod !== null,
      ready: this.pairingReadyFlag,
      capabilities: this.bleCaps,
      nearbyPeers: [...this.nearbyPeers],
      sessions: [...this.pairSessions],
      pendingRequests: [...this.pendingPairRequests],
      verifications: [...this.verifications],
      bump: {
        stage: this.isBumpActive() ? this.bumpStage : 'idle',
        expiresAt: this.isBumpActive() ? this.bumpUntil : null,
        rssi: this.bumpRssi,
        peerCount: this.bumpPeerCount,
        error: this.bumpError,
      },
      discoveredFriend: this.discoveredFriend,
      inviteLink: this.inviteLink,
      inviteCode: this.inviteCode,
      mailboxAvailable: this.mailbox.configured,
      activity: this.pairingActivity,
    };
  }

  private setPairingActivity(activity: string): void {
    this.pairingActivity = activity;
    this.emit();
  }

  private async safePublishProfile(): Promise<number> {
    try {
      const epoch = await this.mod?.publishProfile(
        this.handle,
        this.cryptidName,
        this.sigil,
        this.color
      );
      return typeof epoch === 'number' ? epoch : 0;
    } catch {
      return 0;
    }
  }

  private async safeProfileTicket(): Promise<string | null> {
    try {
      const t = await this.mod?.profileTicket();
      return t ? t : null;
    } catch {
      return null;
    }
  }

  /**
   * After restore, read each friend's current profile (from their imported ticket) and merge it.
   * The tickets themselves are re-imported by {@link subscribeToFriend} during `restorePool`, so
   * the live watcher is already re-armed by the time this runs; this only picks up what the local
   * replica holds. Friends still missing a profile are retried by {@link backfillMissingProfiles}.
   */
  private async importFriendProfiles(): Promise<void> {
    if (!this.mod) return;
    for (const friend of pool.friendList(this.state)) {
      if (!friend.profileTicket) continue;
      const profile = await this.mod.readProfile(friend.endpointId).catch(() => null);
      if (profile) this.applyProfile(profile);
    }
  }

  /**
   * Re-arm replication for friends who still have no verified profile, then re-read.
   *
   * Paced by {@link PROFILE_BACKFILL_INTERVAL_MS} and capped at
   * {@link PROFILE_BACKFILL_MAX_ATTEMPTS} per friend, so a peer who published nothing costs a
   * handful of dials rather than a permanent retry loop. `profileEpoch` is the honest "we merged a
   * real profile" marker — {@link mergeProfileIntoFriend} sets it and nothing else does.
   */
  private async backfillMissingProfiles(): Promise<void> {
    const mod = this.mod;
    if (!mod) return;
    const now = Date.now();
    if (now - this.lastProfileBackfillAt < PROFILE_BACKFILL_INTERVAL_MS) return;
    this.lastProfileBackfillAt = now;

    for (const friend of pool.friendList(this.state)) {
      if (!friend.profileTicket || friend.profileEpoch !== undefined) continue;
      const attempts = this.profileBackfillAttempts.get(friend.endpointId) ?? 0;
      if (attempts >= PROFILE_BACKFILL_MAX_ATTEMPTS) continue;
      this.profileBackfillAttempts.set(friend.endpointId, attempts + 1);
      await mod.importProfileTicket(friend.profileTicket).catch(() => undefined);
      const profile = await mod.readProfile(friend.endpointId).catch(() => null);
      if (profile) this.applyProfile(profile);
    }
  }

  /** Merge a verified profile into a known friend (monotonic by epoch); persist + emit if changed. */
  private applyProfile(profile: ProfileView): void {
    const next = pool.applyProfile(this.state, profile);
    if (next === this.state) {
      // Hold a profile whose friend hasn't landed yet — the pair `ready` event can trail the
      // profile watcher by a poll, and each native queue is drained exactly once.
      if (!this.state.friends[profile.endpointId]) {
        const held = this.pendingProfiles.get(profile.endpointId);
        if (!held || profile.epoch > held.epoch) {
          this.pendingProfiles.set(profile.endpointId, profile);
        }
      }
      return;
    }
    this.pendingProfiles.delete(profile.endpointId);
    this.state = next;
    if (this.discoveredFriend?.endpointId === profile.endpointId) {
      this.discoveredFriend = mergeProfileIntoFriend(this.discoveredFriend, profile);
    }
    this.persistPool();
    this.emit();
  }

  // ── Pairing / discovery polling — ARCHITECTURE.md §2, §4 ────────────────────────────────────

  /** Start the bounded pairing/discovery poll loop (idempotent; native only). */
  private startPairingPolling(): void {
    if (this.pollTimer || !this.mod) return;
    const timer = setInterval(() => {
      void this.pollPairingOnce();
    }, PAIRING_POLL_INTERVAL_MS);
    this.pollTimer = timer;
    // Don't keep the Node event loop (jest / tooling) alive on our account; no-op in RN/Hermes.
    (timer as unknown as { unref?: () => void }).unref?.();
  }

  private stopPairingPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private startBumpPolling(): void {
    if (this.bumpTimer) return;
    const timer = setInterval(() => {
      if (!this.isBumpActive()) {
        this.stopBumpPolling(false);
        if (this.pairingReadyFlag) void this.setPairingReady(false);
        if (!this.discoveredFriend) this.setPairingActivity('bump idle');
        return;
      }
      void this.pollPairingOnce();
    }, BUMP_POLL_INTERVAL_MS);
    this.bumpTimer = timer;
    (timer as unknown as { unref?: () => void }).unref?.();
  }

  private stopBumpPolling(invalidateAttempt = true): void {
    if (invalidateAttempt) this.bumpGeneration += 1;
    if (this.bumpTimer) {
      clearInterval(this.bumpTimer);
      this.bumpTimer = null;
    }
    this.bumpUntil = 0;
    this.bumpStage = 'idle';
    this.bumpRssi = null;
    this.bumpPeerCount = 0;
    this.bumpError = null;
    this.emit();
  }

  private isBumpActive(): boolean {
    return this.bumpUntil > Date.now();
  }

  /**
   * Drain the pairing + profile + discovery queues once. Any failure surfaces through the service
   * error path (deduped so a persistently-failing poll can't spam listeners) and never throws.
   */
  private pollPairingOnce(): Promise<void> {
    if (!this.mod) return Promise.resolve();
    if (this.pollInFlight) return this.pollInFlight;
    this.pollInFlight = this.doPollPairingOnce().finally(() => {
      this.pollInFlight = null;
    });
    return this.pollInFlight;
  }

  private async doPollPairingOnce(): Promise<void> {
    const mod = this.mod;
    if (!mod) return;
    const span = getTelemetry().startSpan('pairing.poll');
    try {
      const [pairEvents, profileEvents, sessions, peers, caps] = await Promise.all([
        mod.pollPairEvents(),
        mod.pollProfileEvents(),
        mod.listPairSessions(),
        mod.nearbyBlePeers(),
        mod.bleCapabilities(),
      ]);

      this.pairSessions = sessions;
      this.nearbyPeers = peers;
      this.bleCaps = caps;
      this.pairingReadyFlag = caps.pairingReady;
      span.setAttributes({
        pair_events: pairEvents.length,
        profile_events: profileEvents.length,
        sessions: sessions.length,
        ble_peers: peers.length,
        pairing_ready: caps.pairingReady,
      });
      await this.pollTransportDiagnosticsOnce();
      // Pair events FIRST: `pool.applyProfile` is a no-op for an endpoint that isn't a friend yet,
      // and both queues are drained together above, so applying profiles first threw away the
      // persona of anyone whose `ready` was sitting in the very same batch.
      for (const event of pairEvents) await this.handlePairEvent(event);
      // Ready is a drained, one-shot native event. A transient bridge/result failure must not lose
      // the completed friendship forever, so recover any unhandled Complete session snapshots too.
      await this.reconcileCompletedPairs(sessions);
      for (const profile of profileEvents) this.applyProfile(profile);
      await this.backfillMissingProfiles();
      // Reconcile the SAS verification model AFTER handling events, from BOTH the polled session
      // list and this poll's events: `listPairSessions()` is fetched in parallel with the event
      // queue, so a just-emitted `verifying` transition may not appear in `sessions` yet. Merging
      // the two recovers it (and any transition missed while suspended) without a lost/late gate.
      await this.reconcileVerifications(sessions, pairEvents);
      const liveSessions = new Set(sessions.map((session) => session.sessionId));
      const justRequested = new Set(
        pairEvents
          .filter((event) => event.kind === 'pendingRequest')
          .map((event) => event.sessionId)
      );
      this.pendingPairRequests = this.pendingPairRequests.filter(
        (request) => liveSessions.has(request.sessionId) || justRequested.has(request.sessionId)
      );
      if (this.lastPollErrorSig !== null) {
        // A prior poll surfaced an error (typically transient — e.g. the native node was still
        // coming up). Now that polling recovered, clear the surfaced error so the UI's sticky
        // "needs attention" banner dismisses itself instead of lingering after we've healed.
        this.lastPollErrorSig = null;
        this.errorListeners.forEach((listener) => listener(''));
      }
      this.emitIfPairingChanged();
      span.setStatus('ok');
    } catch (err) {
      span.recordError(err);
      this.reportPollError(err);
    } finally {
      span.end();
    }
  }

  /** @internal Number of polls that observed a real transport change. Test-only accessor. */
  get transportDiagnosticsChangeCountForTesting(): number {
    return this.transportDiagnosticsChangeCount;
  }

  private pollTransportDiagnosticsOnce(): Promise<void> {
    if (this.transportDiagnosticsInFlight) return this.transportDiagnosticsInFlight;
    this.transportDiagnosticsInFlight = this.doPollTransportDiagnosticsOnce().finally(() => {
      this.transportDiagnosticsInFlight = null;
    });
    return this.transportDiagnosticsInFlight;
  }

  private async doPollTransportDiagnosticsOnce(): Promise<void> {
    const mod = this.mod;
    if (!mod) return;
    if (typeof mod.transportDiagnostics !== 'function') {
      this.transportDiagnosticsError =
        'This native build does not expose endpoint transport diagnostics.';
      recordEventLog({
        category: 'transport',
        action: 'transport.poll',
        summary: this.transportDiagnosticsError,
        status: 'error',
        transport: 'iroh',
      });
      return;
    }
    try {
      const peerEndpointIds = pool.friendList(this.state).map((friend) => friend.endpointId);
      const previous = this.transportDiagnostics;
      const current = await mod.transportDiagnostics(peerEndpointIds);
      this.transportDiagnostics = current;
      this.transportDiagnosticsUpdatedAt = Date.now();
      this.transportDiagnosticsError = null;
      const changed = stableStringify(previous) !== stableStringify(current);
      if (changed) this.transportDiagnosticsChangeCount += 1;
      const activePaths = current.peers.flatMap((peer) =>
        peer.addresses.filter((address) => address.active).map((address) => address.kind)
      );
      recordEventLog({
        timestamp: this.transportDiagnosticsUpdatedAt,
        level: changed ? 'info' : 'debug',
        category: 'transport',
        action: changed ? 'transport.status.changed' : 'transport.poll',
        summary: `${current.peers.length} peer(s), ${activePaths.length} active path(s)`,
        status: 'ok',
        transport: activePaths.length > 0 ? [...new Set(activePaths)].join(', ') : 'iroh',
        details: {
          requested_peers: peerEndpointIds,
          changed,
          active_paths: activePaths,
          diagnostics: current,
          previous: changed ? previous : undefined,
        },
      });
    } catch (error) {
      this.transportDiagnosticsError = errorMessage(error);
      recordEventLog({
        category: 'transport',
        action: 'transport.poll',
        summary: `Transport poll failed: ${this.transportDiagnosticsError}`,
        status: 'error',
        transport: 'iroh',
        details: { error: this.transportDiagnosticsError },
      });
    }
  }

  private async handlePairEvent(event: PairEvent): Promise<void> {
    switch (event.kind) {
      case 'pendingRequest': {
        // Sessions we initiated (or nearby ones we've picked up) advance to the SAS gate on their
        // own; only surface unsolicited peer-initiated requests as a pending prompt.
        if (this.initiatedRoutes.has(event.sessionId)) return;
        if (event.nearby && this.isBumpActive()) {
          this.trackNearbyRequest(event);
          return;
        }
        if (!this.pendingPairRequests.some((e) => e.sessionId === event.sessionId)) {
          this.pendingPairRequests = [...this.pendingPairRequests, event];
          this.setPairingActivity('pair request');
        }
        return;
      }
      case 'verifying':
        // The SAS visual gate is live. It's no longer a plain pending request — reconciliation
        // (run after this loop) fetches the challenge and upserts it into `verifications`.
        this.pendingPairRequests = this.pendingPairRequests.filter(
          (e) => e.sessionId !== event.sessionId
        );
        if (event.nearby) {
          this.stopBumpPolling(false);
          if (this.pairingReadyFlag) void this.setPairingReady(false);
        }
        this.setPairingActivity(event.nearby ? 'signals are locking' : 'verify to connect');
        return;
      case 'peerResponded':
        this.setPairingActivity(event.nearby ? 'signals are locking' : 'peer responded');
        return;
      case 'ready':
        await this.onPairReady(event);
        return;
      case 'rejected':
      case 'failed':
        this.pendingPairRequests = this.pendingPairRequests.filter(
          (e) => e.sessionId !== event.sessionId
        );
        this.verifications = this.verifications.filter((v) => v.sessionId !== event.sessionId);
        this.initiatedRoutes.delete(event.sessionId);
        if (event.nearby) {
          this.stopBumpPolling(false);
          if (this.pairingReadyFlag) void this.setPairingReady(false);
        }
        this.setPairingActivity(event.kind === 'rejected' ? 'pair rejected' : 'pair failed');
        return;
    }
  }

  private async reconcileCompletedPairs(sessions: PairStateRecord[]): Promise<void> {
    for (const session of sessions) {
      if (session.state !== 'complete' || this.handledPairSessions.has(session.sessionId)) continue;
      await this.onPairReady({
        kind: 'ready',
        sessionId: session.sessionId,
        peerEndpointId: session.peerEndpointId,
        nearby: session.nearby,
      });
    }
  }

  /**
   * Note an inbound nearby request seen during an armed Bump window: tag its route so the eventual friend
   * is `nearby`, and drop it from the pending list. It is NOT auto-accepted — the handshake
   * advances to the SAS `verifying` gate, which the user then clears.
   */
  private trackNearbyRequest(event: PairEvent): void {
    this.initiatedRoutes.set(event.sessionId, 'nearby');
    this.pendingPairRequests = this.pendingPairRequests.filter(
      (request) => request.sessionId !== event.sessionId
    );
    this.setPairingActivity('signals are locking');
  }

  /**
   * Rebuild the live SAS verification list from BOTH the polled session records and this poll's
   * events. Candidates are sessions in any live SAS phase (`verifying`, `localAccepted`, or
   * `peerAccepted`) plus any freshly emitted `verifying` events not yet reflected in that list.
   * Keeping the accepted phases is essential: the person who acts second must retain their
   * controls, while the person who acts first sees the waiting state. Sessions that reached a
   * terminal state this poll are excluded. The native challenge is fetched only for live
   * candidates and is authoritative: a missing/expired challenge clears the entry (we never fall
   * back to pairing without one). Challenge-fetch errors are NOT swallowed — they propagate to the
   * poll's error path so a broken gate is surfaced rather than hidden.
   */
  private async reconcileVerifications(
    sessions: PairStateRecord[],
    events: PairEvent[]
  ): Promise<void> {
    const mod = this.mod;
    if (!mod) return;

    const terminalStates = ['complete', 'rejected', 'failed'];
    const activeSasStates = new Set(['verifying', 'localAccepted', 'peerAccepted']);
    const terminal = new Set<string>(
      sessions.filter((s) => terminalStates.includes(s.state)).map((s) => s.sessionId)
    );
    for (const e of events) {
      if (e.kind === 'ready' || e.kind === 'rejected' || e.kind === 'failed') {
        terminal.add(e.sessionId);
      }
    }

    // Deterministic insertion order: session-list candidates first, then event-only recoveries.
    const candidates = new Map<string, PairStateRecord>();
    for (const s of sessions) {
      if (activeSasStates.has(s.state) && !terminal.has(s.sessionId)) {
        candidates.set(s.sessionId, s);
      }
    }
    for (const e of events) {
      if (e.kind !== 'verifying' || terminal.has(e.sessionId) || candidates.has(e.sessionId)) {
        continue;
      }
      const known = sessions.find((s) => s.sessionId === e.sessionId);
      candidates.set(e.sessionId, {
        sessionId: e.sessionId,
        peerEndpointId: e.peerEndpointId,
        state: 'verifying',
        localAccepted: known?.localAccepted ?? false,
        peerAccepted: known?.peerAccepted ?? false,
        initiator: known?.initiator ?? this.initiatedRoutes.has(e.sessionId),
        nearby: e.nearby,
        sasVerified: known?.sasVerified ?? true,
        localSasConfirmed: known?.localSasConfirmed ?? false,
      });
    }

    const next = new Map<string, PairingVerification>();
    for (const session of candidates.values()) {
      const challenge: SasChallenge | null = await mod.pairSasChallenge(session.sessionId);
      // A live `verifying` session with no challenge means the gate expired or was decided — drop
      // it rather than silently falling back to a challenge-less pairing.
      if (!challenge) continue;
      next.set(session.sessionId, {
        sessionId: session.sessionId,
        peerEndpointId: session.peerEndpointId,
        nearby: session.nearby,
        role: challenge.role,
        targetIndex: challenge.targetIndex,
        optionIndices: [...challenge.optionIndices],
        deadlineMs: challenge.deadlineMs,
        localConfirmed: session.localSasConfirmed ?? false,
        peerVerified: session.sasVerified ?? false,
      });
    }
    this.verifications = [...next.values()];

    // A session that is now verifying or terminal is no longer a plain pending request.
    const resolved = new Set<string>([...next.keys(), ...terminal]);
    if (resolved.size) {
      this.pendingPairRequests = this.pendingPairRequests.filter((r) => !resolved.has(r.sessionId));
    }
  }

  private async initiateNearbyPair(endpointId: string): Promise<string> {
    if (!this.mod) throw new Error('pairNearby: native module not bound');
    const sessionId = await this.mod.initiatePairNearby(endpointId);
    this.initiatedRoutes.set(sessionId, 'nearby');
    this.setPairingActivity('signal found');
    return sessionId;
  }

  /**
   * A bilateral pair completed: fetch the result, create/upsert a Friend keyed by the peer endpoint
   * id, begin reciprocal location sharing, subscribe + import via the normal
   * friend path, persist, and emit. Uses the verified profile when present;
   * otherwise a safe placeholder that a later profile event replaces.
   */
  private async onPairReady(event: PairEvent): Promise<void> {
    if (!this.mod || this.handledPairSessions.has(event.sessionId)) return;
    const result = await this.mod.pairResult(event.sessionId);
    if (!result) return;
    if (result.peerEndpointId !== event.peerEndpointId) {
      throw new Error('Completed pairing result does not match the authenticated peer.');
    }
    if (this.removingFriends.has(result.peerEndpointId)) {
      this.pendingPairRequests = this.pendingPairRequests.filter(
        (request) => request.sessionId !== event.sessionId
      );
      this.verifications = this.verifications.filter((v) => v.sessionId !== event.sessionId);
      this.initiatedRoutes.delete(event.sessionId);
      this.handledPairSessions.add(event.sessionId);
      return;
    }

    const method = this.initiatedRoutes.get(event.sessionId);
    let friend = this.placeholderFriend(result, method);
    if (result.peerProfile) friend = mergeProfileIntoFriend(friend, result.peerProfile);
    // A profile that replicated before this `ready` landed was parked rather than dropped; it is
    // the only copy we'll get without another sync, so claim it now that the friend exists.
    const held = this.pendingProfiles.get(result.peerEndpointId);
    if (held) {
      this.pendingProfiles.delete(result.peerEndpointId);
      friend = mergeProfileIntoFriend(friend, held);
    }

    this.state = pool.shareWith(pool.addFriend(this.state, friend), friend.endpointId);
    try {
      await this.subscribeToFriend(friend);
    } catch {
      // A failed subscribe shouldn't drop the newly paired friend from the pool.
    }
    try {
      await this.ensureMySubscription();
    } catch {
      // The persisted sharing grant will retry when the service restarts.
    }

    this.pendingPairRequests = this.pendingPairRequests.filter(
      (e) => e.sessionId !== event.sessionId
    );
    this.verifications = this.verifications.filter((v) => v.sessionId !== event.sessionId);
    this.initiatedRoutes.delete(event.sessionId);
    this.discoveredFriend = friend;
    this.stopBumpPolling(false);
    if (this.pairingReadyFlag) void this.setPairingReady(false);
    this.persistPool();
    void this.syncTrail(0);
    this.setPairingActivity('cryptid discovered');
    this.handledPairSessions.add(event.sessionId);
  }

  /** Build a Friend from a pair result with a safe placeholder identity (no verified profile yet). */
  private placeholderFriend(result: PairResult, method: PairingMethod | undefined): Friend {
    const existing = this.state.friends[result.peerEndpointId];
    return {
      endpointId: result.peerEndpointId,
      handle: existing?.handle ?? `@${result.peerEndpointId.slice(0, 8)}`,
      sigil: existing?.sigil ?? 'unknown',
      recvPublic: result.peerRecvPub,
      ticket: result.peerEndpointTicket,
      ...(existing?.cryptidName ? { cryptidName: existing.cryptidName } : {}),
      ...(existing?.color ? { color: existing.color } : {}),
      ...(result.peerTrailTicket ? { docTicket: result.peerTrailTicket } : {}),
      ...(result.peerProfileTicket ? { profileTicket: result.peerProfileTicket } : {}),
      ...(existing?.profileEpoch !== undefined ? { profileEpoch: existing.profileEpoch } : {}),
      pairedAt: Date.now(),
      ...(method ? { pairingMethod: method } : {}),
    };
  }

  private reportPollError(err: unknown): void {
    const message = errorMessage(err);
    // Dedupe identical, back-to-back poll errors so a persistently-failing queue can't spam the UI.
    if (message === this.lastPollErrorSig) return;
    this.lastPollErrorSig = message;
    this.errorListeners.forEach((l) => l(message));
  }

  private emitIfPairingChanged(): void {
    const sig = JSON.stringify(this.pairingSnapshot());
    if (sig === this.lastPairingSig) return;
    this.lastPairingSig = sig;
    this.emit();
  }

  private emit(): void {
    const snapshot = this.snapshot();
    this.lastPairingSig = JSON.stringify(snapshot.pairing);
    this.snapshotListeners.forEach((l) => l(snapshot));
  }
}
