import { Platform } from 'react-native';

import {
  getIrohLocation,
  getStashConfig,
  tryGetIrohLocation,
  type BleCapabilities,
  type BlePeer,
  type IrohLocationNativeModule,
  type NativeLocationFix,
  type NodeKeys,
  type OnFixEvent,
  type OnSyncEvent,
  type PairEvent,
  type PairResult,
  type PairStateRecord,
  type ProfileView,
  type SasChallenge,
  type SasRole,
} from 'iroh-location';

import {
  getOtelConfig,
  getTelemetry,
  parseTraceparent,
  traceparentFor,
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
  SelfIdentity,
} from '../core/types';
import type { BackgroundLocationProvider } from './background/background-provider';
import type { BackgroundStartConfig } from './background/background-task';
import type { FixPublisher, LocationEngine } from './background/location-engine';
import {
  createTrailStore,
  SELF_AUTHOR,
  type TrailPoint,
  type TrailStore,
} from './background/trail-store';
import type { PersistentKV } from './background/fix-outbox';
import {
  clampMailboxTtlSeconds,
  createDefaultPairingMailbox,
  type PairingMailbox,
} from './pairing-mailbox';
import {
  createPersistentKV,
  createPersistentTrailStorage,
  loadPool,
  loadRelayOnly,
  loadStashOptIn,
  savePool,
  saveRelayOnly,
  saveStashOptIn,
} from './persistence';
import { createDefaultStashClient, type StashClient } from './stash-client';
import {
  createDefaultPushTokenProvider,
  type DevicePushToken,
  type PushTokenProvider,
  type TrailSyncPush,
} from './push-token-provider';
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
  /**
   * Transport preferences: whether the user forced relay-only, and whether that's actually
   * enforced at the native endpoint yet (Phase 2). In Phase 1 `enforced` is always false — the
   * flag is recorded and reflected in the diagnostic but does not yet re-bind the endpoint.
   */
  transports: { relayOnly: boolean; relayOnlyEnforced: boolean };
  /** Bilateral-pairing / nearby-discovery state. */
  pairing: PairingSnapshot;
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
const BUMP_POLL_INTERVAL_MS = 300;
const BUMP_RESOLVE_TIMEOUT_MS = 12_000;
export const BUMP_WINDOW_MS = 15_000;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
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

  private mySubId: string | null = null;
  private mySubRecipients = '';
  private readonly friendSubs = new Map<string, string>();
  private readonly removingFriends = new Set<string>();
  private seq = 0;

  private readonly snapshotListeners = new Set<SnapshotListener>();
  private readonly fixListeners = new Set<FixListener>();
  private readonly localFixListeners = new Set<LocalFixListener>();
  private readonly trailChangeListeners = new Set<TrailChangeListener>();
  private readonly errorListeners = new Set<ErrorListener>();
  private fixSub: Removable | null = null;
  private syncSub: Removable | null = null;

  // Bilateral pairing / nearby discovery runtime.
  private pairingReadyFlag = false;
  private bleCaps: BleCapabilities | null = null;
  private nearbyPeers: BlePeer[] = [];
  private pairSessions: PairStateRecord[] = [];
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
  /**
   * User forced relay-only transport (persisted). Defaults false. Phase 1 records intent only;
   * native enforcement (skip BLE/nearby/mDNS + relay-only mode) lands in Phase 2. Never enforced
   * on web (no native endpoint to re-bind).
   */
  private relayOnly = false;
  /** Native push-token source for stash wake-ups. */
  private readonly pushTokens: PushTokenProvider;
  /** Cached device push token (undefined = not yet attempted; null = unavailable/denied). */
  private cachedPushToken: DevicePushToken | null | undefined;
  /** Whether the stash background-sync handler has been registered (once). */
  private stashBackgroundSyncRegistered = false;
  private pairingActivity = '';
  /** Sessions we initiated, keyed by session id to preserve the pairing method through completion. */
  private readonly initiatedRoutes = new Map<string, PairingMethod>();
  /** Complete sessions already materialized locally, including discoveries the user dismissed. */
  private readonly handledPairSessions = new Set<string>();
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
  private bgUnwatch: (() => void) | null = null;
  private bgTaskHandlerStop: (() => void) | null = null;
  private bgBackfillHandlerStop: (() => void) | null = null;
  private bgLifecycleStop: (() => void) | null = null;
  private bgCadenceStop: (() => Promise<void>) | null = null;
  /** Auto-revert timer for a bounded live-tracking window; null when ambient. */
  private liveTrackingTimer: ReturnType<typeof setTimeout> | null = null;
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
    deps: { mailbox?: PairingMailbox; stash?: StashClient; pushTokens?: PushTokenProvider } = {}
  ) {
    this.mailbox = deps.mailbox ?? createDefaultPairingMailbox();
    this.stash = deps.stash ?? createDefaultStashClient();
    this.pushTokens = deps.pushTokens ?? createDefaultPushTokenProvider();
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

  /** Current relay-only preference + whether it's enforced natively yet (Phase 2). */
  relayOnlyState(): { relayOnly: boolean; relayOnlyEnforced: boolean } {
    // Phase 1: never enforced (no native re-bind wired yet).
    return { relayOnly: this.relayOnly, relayOnlyEnforced: false };
  }

  /**
   * Force (or unforce) relay-only transport. Phase 1 persists the choice and reflects it in the
   * diagnostic; the native endpoint is not yet re-bound, so BLE/nearby/direct/LAN keep running
   * until Phase 2 wires enforcement (a node restart). Idempotent.
   */
  async setRelayOnly(relayOnly: boolean): Promise<void> {
    if (this.relayOnly === relayOnly) return;
    this.relayOnly = relayOnly;
    await saveRelayOnly(this.kv, relayOnly);
    this.emit();
  }

  /**
   * Opt in/out of offline delivery via the stash. Persists the choice; on opt-in, grants the stash
   * replication of our own + friends' trail namespaces and folds its ticket into our subscription.
   */
  async setStashOptIn(optedIn: boolean): Promise<void> {
    this.stashOptIn = optedIn;
    await saveStashOptIn(this.kv, optedIn);
    if (optedIn) {
      this.registerStashBackgroundSync();
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

  /** Lazily acquire (once) this device's native push token for stash wake-ups. */
  private async ensurePushToken(): Promise<DevicePushToken | null> {
    if (this.cachedPushToken !== undefined) return this.cachedPushToken;
    try {
      this.cachedPushToken = await this.pushTokens.acquire();
    } catch {
      this.cachedPushToken = null;
    }
    return this.cachedPushToken;
  }

  /** Register (once) the handler that runs a trail sync when a `trail-sync` push arrives. */
  private registerStashBackgroundSync(): void {
    if (this.stashBackgroundSyncRegistered) return;
    this.stashBackgroundSyncRegistered = true;
    this.pushTokens.registerBackgroundSync((push?: TrailSyncPush) => {
      // Dev telemetry: the push payload carries the stash's traceparent, so this wake span LINKS
      // to the exact `stash.wake.push` that woke us — the stash→device half of a ping's journey.
      const link = parseTraceparent(push?.traceparent);
      const span = getTelemetry().startSpan('push.wake', {
        links: link ? [link] : [],
        attributes: { 'sc.namespace': push?.ns ? push.ns.slice(0, 10) : undefined },
      });
      void this.syncTrail(0, span.context)
        .then(
          () => {
            span.setAttribute('recovered', this.lastSyncRecovered ?? undefined);
            span.setStatus('ok');
          },
          (err: unknown) => span.recordError(err)
        )
        .finally(() => span.end());
    });
  }

  /**
   * Grant the stash replication of our own + every friend's trail namespace (best-effort). The
   * stash is ciphertext-blind, so this only lets it hold + reconcile sealed envelopes, never read
   * them. We subscribe our push token to *friends'* namespaces (so the stash wakes us when they
   * post), but not our own (waking ourselves is pointless). A failure just degrades offline
   * delivery to peer-only reconciliation.
   */
  private async syncStashGrants(): Promise<void> {
    if (!this.stashEnabled()) return;
    const push = await this.ensurePushToken();
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
      tasks.push(
        this.stash
          .registerNamespace({ readTicket, pushToken: push?.token, platform: push?.platform })
          .catch(swallow)
      );
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
    this.keys = await this.mod.createNode(persisted.identitySecret, persisted.recvSecret);
    await saveKeys({
      identitySecret: this.keys.identitySecret,
      recvSecret: this.keys.recvSecret,
    });
    this.configureDevTelemetry();
    // Restore the monotonic seq before anything can publish, so we never hand out a reused seq.
    this.seq = await loadSeq();
    await this.mod.start();
    if (interactive) {
      this.ticketStr = await this.mod.ticket();
      this.docTicketStr = await this.safeDocTicket();
      // Publish our profile so friends can replicate it; web reports epoch 0 (no capability).
      this.profileEpoch = await this.safePublishProfile();
      this.profileTicketStr = await this.safeProfileTicket();
      this.fixSub = this.mod.addListener('onFix', (event: OnFixEvent) => this.handleFix(event));
      this.syncSub = this.mod.addListener('onSync', (event: OnSyncEvent) => this.handleSync(event));
    }

    await this.restorePool(interactive);
    this.stashOptIn = await loadStashOptIn(this.kv);
    this.relayOnly = await loadRelayOnly(this.kv);
    if (interactive) {
      await this.importFriendProfiles();
      if (this.stashEnabled()) this.registerStashBackgroundSync();
      await this.syncStashGrants();
      this.startPairingPolling();
      await this.pollPairingOnce();
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
    this.emit();

    const cleanup: Promise<void>[] = [];
    if (mod && friendSubId) {
      cleanup.push(mod.unsubscribe(friendSubId));
    }
    if (wasSharing) cleanup.push(this.ensureMySubscription());
    cleanup.push(
      this.trail.removeAuthor(endpointId).then(() => {
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
    this.syncSub?.remove();
    this.syncSub = null;

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
    await mod.start();
    this.ticketStr = await mod.ticket();
    this.docTicketStr = await this.safeDocTicket();
    this.profileEpoch = await this.safePublishProfile();
    this.profileTicketStr = await this.safeProfileTicket();
    this.fixSub = mod.addListener('onFix', (event: OnFixEvent) => this.handleFix(event));
    this.syncSub = mod.addListener('onSync', (event: OnSyncEvent) => this.handleSync(event));

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
    const span = getTelemetry().startSpan('publish.fix', {
      parent,
      attributes: { 'sc.author': this.keys ? this.keys.endpointId.slice(0, 10) : undefined },
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
      const recipients = pool.recipientRecvKeys(this.state);
      span.setAttribute('recipients', recipients.length);
      const traceparent = getTelemetry().enabled ? traceparentFor(span.context) : null;
      await this.mod.publish(this.mySubId, seq, 0, native, recipients, traceparent);
      try {
        // Durable mirror: same sealed bytes, so per-recipient revocation carries over (ARCHITECTURE §6).
        await this.mod.docsWrite(this.mySubId, seq, 0, native, recipients, traceparent);
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
      await this.mod.syncTrail(
        sinceTs,
        this.stashEnabled() ? this.stashTicket : null,
        getTelemetry().enabled ? traceparentFor(span.context) : null
      );
    } catch (err) {
      // Best effort — the durable path may be unavailable (e.g. web without docs) — but when it
      // fails the user simply won't see friends' missed fixes, so surface it as a log too.
      const reason = err instanceof Error ? err.message : String(err);
      span.addEvent('native.sync.failed', { reason });
      getTelemetry().log('warn', `trail sync failed (backfill from stash/peers): ${reason}`, {
        since_ts: sinceTs,
        stash: this.stashEnabled(),
      });
    }
    const recovered = await this.refreshTrailFromReplica(sinceTs);
    span.setAttribute('recovered', recovered);
    span.end();
    this.lastSyncRecovered = recovered;
    this.notifyTrailChanged();
    this.emit();
  }

  /**
   * Read decrypted fixes for self + friends out of the durable replica and merge them into the
   * trail cache (idempotent — upsert by author/seq). Returns how many friend fixes are present.
   */
  private async refreshTrailFromReplica(sinceTs: number): Promise<number> {
    if (!this.mod) return 0;
    const selfId = this.keys?.endpointId;
    const authors = new Set<string>();
    if (selfId) authors.add(selfId);
    for (const f of pool.friendList(this.state)) authors.add(f.endpointId);

    let recoveredFriendFixes = 0;
    for (const author of authors) {
      const fixes = await this.mod.readTrail(author, sinceTs).catch(() => []);
      for (const nf of fixes) {
        const fix: LocationFix = {
          lat: nf.fix.lat,
          lon: nf.fix.lon,
          accuracyM: nf.fix.accuracyM,
          headingDeg: nf.fix.headingDeg,
          ts: nf.fix.ts,
        };
        if (selfId && nf.author === selfId) {
          await this.trail.appendOwn(fix, nf.seq);
        } else {
          await this.trail.appendFriend({
            author: nf.author,
            seq: nf.seq,
            fix,
            receivedAt: Date.now(),
            backfill: true,
          });
          recoveredFriendFixes += 1;
        }
      }
    }
    return recoveredFriendFixes;
  }

  /** The latest trail point per author (self + friends). */
  trailLatest(): Promise<TrailPoint[]> {
    return this.trail.latestPerAuthor();
  }

  /** The ascending-by-seq trail for one author at or after `sinceTs`. */
  trailFor(author: string, sinceTs = 0): Promise<TrailPoint[]> {
    return this.trail.rangeFor(author, sinceTs);
  }

  /** All known authors' retained trails, ordered chronologically for the UI. */
  async trailAll(sinceTs = 0): Promise<TrailPoint[]> {
    const authors = [
      SELF_AUTHOR,
      ...pool.friendList(this.state).map((friend) => friend.endpointId),
    ];
    const ranges = await Promise.all(authors.map((author) => this.trail.rangeFor(author, sinceTs)));
    return ranges.flat().sort((a, b) => a.fix.ts - b.fix.ts || a.seq - b.seq);
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
        { createAppLifecycleController },
        { backgroundOutbox, registerActiveBackgroundFixHandler, registerActiveBackfillHandler },
        { createBatterySource },
        { createCadenceController, cfgFromDecision },
      ] = await Promise.all([
        import('./background/location-engine'),
        import('./background/sampling-policy'),
        import('./background/background-provider'),
        import('./background/lifecycle'),
        import('./background/register-task'),
        import('./background/battery-source'),
        import('./background/cadence-controller'),
      ]);

      const battery = createBatterySource();
      const policy = createSamplingPolicy();
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
        this.recordLocalFix(fix);
        await this.engine?.ingest(fix, parent);
      });

      // Route the periodic RECEIVE-side backfill (WorkManager / BGTaskScheduler) to THIS live
      // runtime rather than a headless node. On Android this runtime stays alive while backgrounded
      // (the location foreground service), so the periodic task must reuse this node — spinning up a
      // second one calls createNode → clearRuntime() and tears this node's subscriptions down,
      // silently stopping send + live receive until relaunch.
      this.bgBackfillHandlerStop = registerActiveBackfillHandler(async (parent) => {
        await this.syncTrail(0, parent);
        await this.engine?.flush(parent);
      });

      this.bgProvider = new Provider();
      const notification = {
        title: 'streetCryptid',
        body: "Keeping your friends' map current.",
        color: '#C6791A',
      };
      // Arm the OS from a *real* battery read (motion is unknown until fixes flow), so a phone that
      // launches in Low-Power Mode starts backed off rather than at full cadence.
      const initialDecision = policy.decide({ motion: 'unknown', battery: await battery.read() });
      const initialCfg = {
        ...cfgFromDecision(initialDecision, 'unknown', notification),
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
      this.recordLocalFix(firstFix);
      await this.engine.ingest(firstFix);
      this.bgUnwatch = await this.bgProvider.watch((fix) => {
        this.recordLocalFix(fix);
        void this.engine?.ingest(fix);
      });

      this.bgLifecycleStop = createAppLifecycleController({
        onForeground: () => {
          void this.engine?.flush();
          void this.syncTrail(0);
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
        const { isBackgroundBackfillAvailable, scheduleBackgroundBackfill } =
          await import('./background/backfill-task');
        if (isBackgroundBackfillAvailable()) await scheduleBackgroundBackfill();
      } catch (error) {
        console.warn('[background-backfill] schedule failed', error);
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

  /** Stop the background location service (leaves queued fixes in the outbox). Idempotent. */
  async stopBackground(): Promise<void> {
    if (this.liveTrackingTimer) {
      clearTimeout(this.liveTrackingTimer);
      this.liveTrackingTimer = null;
    }
    const stopCadence = this.bgCadenceStop;
    this.bgCadenceStop = null;
    this.bgUnwatch?.();
    this.bgUnwatch = null;
    this.bgTaskHandlerStop?.();
    this.bgTaskHandlerStop = null;
    this.bgBackfillHandlerStop?.();
    this.bgBackfillHandlerStop = null;
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
      const { cancelBackgroundBackfill } = await import('./background/backfill-task');
      await cancelBackgroundBackfill();
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
   * the on-demand escape hatch for the real-time case — e.g. a future "a friend is actively watching
   * your location" signal — so the app never pays real-time GPS cost around the clock. `on: false`
   * (or a fresh call) cancels any active window. No-op until the background service is running; the
   * cadence controller picks up the engine's new decision and re-programs the OS.
   */
  async setLiveTracking(on: boolean, ttlMs = 120_000): Promise<void> {
    if (this.liveTrackingTimer) {
      clearTimeout(this.liveTrackingTimer);
      this.liveTrackingTimer = null;
    }
    await this.engine?.setLiveMode(on);
    if (on && ttlMs > 0) {
      const timer = setTimeout(() => {
        this.liveTrackingTimer = null;
        void this.engine?.setLiveMode(false);
      }, ttlMs);
      (timer as unknown as { unref?: () => void }).unref?.();
      this.liveTrackingTimer = timer;
    }
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
    // Stop callbacks synchronously before awaiting native teardown.
    this.stopPairingPolling();
    this.stopBumpPolling();
    if (this.liveTrackingTimer) {
      clearTimeout(this.liveTrackingTimer);
      this.liveTrackingTimer = null;
    }
    this.bgUnwatch?.();
    this.bgUnwatch = null;
    this.bgTaskHandlerStop?.();
    this.bgTaskHandlerStop = null;
    this.bgBackfillHandlerStop?.();
    this.bgBackfillHandlerStop = null;
    this.bgLifecycleStop?.();
    this.bgLifecycleStop = null;
    this.fixSub?.remove();
    this.fixSub = null;
    this.syncSub?.remove();
    this.syncSub = null;
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
    }
    if (this.state.sharingWith.length > 0) {
      try {
        await this.ensureMySubscription();
      } catch {
        // ignore
      }
    }
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
      // Also grant the stash replication of their trail so we can catch up while both are offline,
      // and subscribe our push token so it wakes us when this friend posts.
      if (this.stashEnabled()) {
        const push = await this.ensurePushToken();
        void this.stash
          .registerNamespace({
            readTicket: card.docTicket,
            pushToken: push?.token,
            platform: push?.platform,
          })
          .catch(() => {
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
    if (telemetry.enabled) {
      // App-level delivery marker: the native `gossip.receive`/`trail.backfill` span says the
      // envelope arrived and decrypted; this one says the app actually surfaced it (or that a
      // non-friend/removing gate ate it — the last place a ping can silently die).
      const known = !!this.state.friends[event.author] && !this.removingFriends.has(event.author);
      const span = telemetry.startSpan('fix.received.app', {
        attributes: {
          'sc.author': event.author.slice(0, 10),
          'sc.seq': event.seq,
          backfill: !!event.backfill,
          ...(known ? {} : { 'sc.drop_reason': 'unknown-or-removing-author' }),
        },
      });
      span.end();
    }
    if (!this.state.friends[event.author] || this.removingFriends.has(event.author)) return;

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
    };
    void this.trail
      .appendFriend(fix)
      .then(() => this.notifyTrailChanged())
      .catch((error: unknown) => this.reportError(error));
    this.fixListeners.forEach((l) => l(fix));
  }

  private recordLocalFix(fix: LocationFix): void {
    if (this.latestLocalFix && fix.ts < this.latestLocalFix.ts) return;
    this.latestLocalFix = fix;
    this.localFixListeners.forEach((listener) => listener(fix));
  }

  private notifyTrailChanged(): void {
    this.trailChangeListeners.forEach((listener) => listener());
  }

  private reportError(error: unknown): void {
    const message = errorMessage(error);
    this.errorListeners.forEach((listener) => listener(message));
  }

  private handleSync(event: OnSyncEvent): void {
    if (event.status === 'completed') {
      this.lastSyncRecovered = event.recovered ?? 0;
      this.emit();
    }
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
      transports: this.relayOnlyState(),
      pairing: this.pairingSnapshot(),
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

  /** After restore, read each friend's current profile (from their imported ticket) and merge it. */
  private async importFriendProfiles(): Promise<void> {
    if (!this.mod) return;
    for (const friend of pool.friendList(this.state)) {
      if (!friend.profileTicket) continue;
      const profile = await this.mod.readProfile(friend.endpointId).catch(() => null);
      if (profile) this.applyProfile(profile);
    }
  }

  /** Merge a verified profile into a known friend (monotonic by epoch); persist + emit if changed. */
  private applyProfile(profile: ProfileView): void {
    const next = pool.applyProfile(this.state, profile);
    if (next === this.state) return;
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
      for (const profile of profileEvents) this.applyProfile(profile);
      for (const event of pairEvents) await this.handlePairEvent(event);
      // Ready is a drained, one-shot native event. A transient bridge/result failure must not lose
      // the completed friendship forever, so recover any unhandled Complete session snapshots too.
      await this.reconcileCompletedPairs(sessions);
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
    } catch (err) {
      this.reportPollError(err);
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
