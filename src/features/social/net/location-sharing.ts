import { Platform } from 'react-native';

import {
  getIrohLocation,
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
} from 'iroh-location';

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
  savePool,
} from './persistence';
import { loadKeys, saveKeys } from './secure-keys';
import { loadSeq, saveSeq } from './state-store';

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
  /** True during the short mutual-consent window opened by a rub gesture. */
  gestureActive: boolean;
  /** When the active rub-consent window expires, or null while idle. */
  gestureExpiresAt: number | null;
  /** The friend most recently completed through pairing, until the reveal is acknowledged/rejected. */
  discoveredFriend: Friend | null;
  /** The most recently minted invite link (`streetcryptid://social?token=…`), if any. */
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
const NEARBY_GESTURE_POLL_INTERVAL_MS = 300;
export const NEARBY_GESTURE_WINDOW_MS = 9000;

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
  private nearbyGestureUntil = 0;
  private nearbyGestureTimer: ReturnType<typeof setInterval> | null = null;
  private readonly nearbyPairAttempts = new Set<string>();
  private discoveredFriend: Friend | null = null;
  private inviteLink: string | null = null;
  private inviteCode: string | null = null;
  private readonly mailbox: PairingMailbox;
  private pairingActivity = '';
  /** Sessions WE initiated, keyed by session id → the route (for auto-accept + method tagging). */
  private readonly initiatedRoutes = new Map<string, PairingMethod>();
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
  private bgLifecycleStop: (() => void) | null = null;
  private backgroundSharing = false;
  private backgroundAccess: BackgroundAccess = 'unknown';
  private latestLocalFix: LocationFix | null = null;
  private shutdownPromise: Promise<void> | null = null;

  /**
   * @param deps.mailbox Pairing mailbox transport for the short-code path (see
   *   {@link createPairCode} / {@link pairFromInput}). Defaults to the HTTP client built from
   *   `EXPO_PUBLIC_PAIR_MAILBOX_URL`; tests can inject a fake.
   */
  constructor(deps: { mailbox?: PairingMailbox } = {}) {
    this.mailbox = deps.mailbox ?? createDefaultPairingMailbox();
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
    if (interactive) {
      await this.importFriendProfiles();
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
    if (this.isNearbyGestureActive()) this.nearbyPairAttempts.add(endpointId);
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

  // ── Bilateral pairing (`streetcryptid/pair/1`) — ARCHITECTURE.md §4 ─────────────────────────

  /** Toggle whether we accept invite-less nearby (BLE) pairing Hellos. */
  async setPairingReady(ready: boolean): Promise<void> {
    if (!this.isReady() || !this.mod) return;
    await this.mod.setPairingReady(ready);
    this.pairingReadyFlag = ready;
    this.setPairingActivity(ready ? 'nearby pairing on' : 'nearby pairing off');
  }

  /**
   * Opens a short local consent window for buttonless nearby pairing. Two phones pair
   * automatically only when both detect the gesture: an outbound nearby session auto-accepts our
   * side, while an inbound nearby request auto-accepts only while this window is active.
   */
  async beginNearbyGesture(windowMs = NEARBY_GESTURE_WINDOW_MS): Promise<void> {
    if (!this.mod || this.discoveredFriend) return;
    this.nearbyGestureUntil = Date.now() + Math.max(2000, windowMs);
    this.setPairingActivity('feeling for a signal');
    this.startNearbyGesturePolling();

    for (const request of this.pendingPairRequests.filter((event) => event.nearby)) {
      await this.acceptNearbyRequest(request);
    }
    await this.pollPairingOnce();
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
   * Mint a one-shot invite and return its shareable `streetcryptid://social?token=…` link.
   * The link is also retained in the pairing snapshot as the current invite.
   */
  async createPairInvite(ttlSecs: number): Promise<string> {
    if (!this.mod) throw new Error('createPairInvite: native module not bound');
    const invite = await this.mod.createPairInvite(ttlSecs);
    this.inviteLink = encodePairLink(invite.token);
    this.setPairingActivity('invite created');
    return this.inviteLink;
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
  }

  /**
   * Begin an invite-based pair from a short mailbox pairing code, an app pair link
   * (`streetcryptid://social?token=…`), or a raw `scpair1:` token, auto-accepting OUR (initiating)
   * side. The peer's side stays pending until they accept. Returns the session id. Tags the
   * eventual friend `code` (short code or raw token) or `invite` (app link). A short code is
   * recognized *before* pair-link parsing; its mailbox GET is one-time, so a failed or already-
   * redeemed code surfaces its precise error rather than falling back to anything else.
   */
  async pairFromInput(input: string): Promise<string> {
    if (!this.mod) throw new Error('pairFromInput: native module not bound');
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
    await this.mod.respondPair(sessionId, true);
    this.setPairingActivity('pairing…');
    await this.refreshPairing();
    return sessionId;
  }

  /**
   * Redeem a short mailbox pairing code: derive the lookup id from the code's secret, one-time GET
   * the sealed capsule, decrypt it locally into the opaque invite token, then initiate + auto-
   * accept our side exactly like {@link pairFromInput}. Never falls back silently — mailbox and
   * decryption failures propagate as-is.
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
    await this.mod.respondPair(sessionId, true);
    this.setPairingActivity('pairing…');
    await this.refreshPairing();
    return sessionId;
  }

  /**
   * Begin an invite-less nearby pair with a BLE-discovered peer, auto-accepting OUR side. The peer's
   * side stays pending until they accept. Returns the session id; tags the eventual friend `nearby`.
   */
  async pairNearby(endpointId: string): Promise<string> {
    const sessionId = await this.initiateNearbyPair(endpointId);
    await this.refreshPairing();
    return sessionId;
  }

  /** Accept or reject a pending incoming pair request. */
  async respondPair(sessionId: string, accept: boolean): Promise<void> {
    if (!this.mod) return;
    await this.mod.respondPair(sessionId, accept);
    this.pendingPairRequests = this.pendingPairRequests.filter((e) => e.sessionId !== sessionId);
    this.setPairingActivity(accept ? 'accepted request' : 'rejected request');
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
  async publishFix(fix: LocationFix): Promise<number> {
    if (!this.mod) throw new Error('publishFix: native module not bound');
    await this.ensureMySubscription();
    if (!this.mySubId) throw new Error('publishFix: no active subscription');
    const seq = await this.nextSeq();
    const native: NativeLocationFix = {
      lat: fix.lat,
      lon: fix.lon,
      accuracyM: fix.accuracyM,
      headingDeg: fix.headingDeg,
      ts: fix.ts,
    };
    const recipients = pool.recipientRecvKeys(this.state);
    await this.mod.publish(this.mySubId, seq, 0, native, recipients);
    try {
      // Durable mirror: same sealed bytes, so per-recipient revocation carries over (ARCHITECTURE §6).
      await this.mod.docsWrite(this.mySubId, seq, 0, native, recipients);
    } catch {
      // Best effort; the live path already delivered. A later syncTrail can reconcile.
    }
    await this.trail.appendOwn(fix, seq);
    this.notifyTrailChanged();
    return seq;
  }

  /**
   * Recover envelopes missed while offline. Triggers range reconciliation, then reads the durable
   * replica into the trail cache — reconciliation can land entries silently (at friend-import or via
   * live sync) without firing backfill events, so reading the replica afterwards is what actually
   * surfaces recovered fixes to the UI.
   */
  async syncTrail(sinceTs = 0): Promise<void> {
    if (!this.mod) return;
    try {
      await this.mod.syncTrail(sinceTs);
    } catch {
      // Best effort — the durable path may be unavailable (e.g. web without docs).
    }
    const recovered = await this.refreshTrailFromReplica(sinceTs);
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

  /** The ascending-by-seq trail for one author within the rolling window (recovery buffer). */
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
        { backgroundOutbox, registerActiveBackgroundFixHandler },
      ] = await Promise.all([
        import('./background/location-engine'),
        import('./background/sampling-policy'),
        import('./background/background-provider'),
        import('./background/lifecycle'),
        import('./background/register-task'),
      ]);

      const policy = createSamplingPolicy();
      this.engine = createLocationEngine({
        publisher: this,
        outbox: backgroundOutbox,
        trail: this.trail,
        policy,
      });
      await this.engine.start();
      this.bgTaskHandlerStop = registerActiveBackgroundFixHandler(async (fix) => {
        this.recordLocalFix(fix);
        await this.engine?.ingest(fix);
      });

      this.bgProvider = new Provider();
      const d = policy.decide({
        motion: 'walking',
        battery: { level: 1, charging: false, lowPower: false },
      });
      const permissions = await this.bgProvider.startBackground({
        accuracy: d.accuracy,
        timeIntervalMs: d.timeIntervalMs,
        distanceIntervalM: d.distanceIntervalM,
        deferredUpdatesIntervalMs: d.deferredUpdatesIntervalMs,
        notificationTitle: 'streetCryptid',
        notificationBody: "Keeping your friends' map current.",
        ...config,
      });
      this.backgroundAccess = permissions.background ? 'full' : 'foreground';
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
    this.bgUnwatch?.();
    this.bgUnwatch = null;
    this.bgTaskHandlerStop?.();
    this.bgTaskHandlerStop = null;
    this.bgLifecycleStop?.();
    this.bgLifecycleStop = null;
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
    this.bgProvider = null;
    this.engine = null;
    this.backgroundSharing = false;
    this.backgroundAccess = 'unknown';
    this.emit();
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
    this.stopNearbyGesturePolling();
    this.bgUnwatch?.();
    this.bgUnwatch = null;
    this.bgTaskHandlerStop?.();
    this.bgTaskHandlerStop = null;
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
    const subId = await this.mod.subscribe(topic, [card.ticket]);
    this.friendSubs.set(card.endpointId, subId);
    // Replicate their durable trail namespace so syncTrail can recover fixes we missed (§6).
    if (card.docTicket) {
      try {
        await this.mod.importDocTicket(card.docTicket);
      } catch {
        // Non-fatal: live gossip still works; only offline recovery of their trail is affected.
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
    const bootstrap = pool.recipients(this.state).map((f) => f.ticket);
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
      gestureActive: this.isNearbyGestureActive(),
      gestureExpiresAt: this.isNearbyGestureActive() ? this.nearbyGestureUntil : null,
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

  private startNearbyGesturePolling(): void {
    if (this.nearbyGestureTimer) return;
    const timer = setInterval(() => {
      if (!this.isNearbyGestureActive()) {
        this.stopNearbyGesturePolling();
        if (!this.discoveredFriend) this.setPairingActivity('listening');
        return;
      }
      void this.pollPairingOnce();
    }, NEARBY_GESTURE_POLL_INTERVAL_MS);
    this.nearbyGestureTimer = timer;
    (timer as unknown as { unref?: () => void }).unref?.();
  }

  private stopNearbyGesturePolling(): void {
    if (this.nearbyGestureTimer) {
      clearInterval(this.nearbyGestureTimer);
      this.nearbyGestureTimer = null;
    }
    this.nearbyGestureUntil = 0;
    this.nearbyPairAttempts.clear();
  }

  private isNearbyGestureActive(): boolean {
    return this.nearbyGestureUntil > Date.now();
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
      await this.maybeInitiateNearbyPair();
      this.lastPollErrorSig = null;
      this.emitIfPairingChanged();
    } catch (err) {
      this.reportPollError(err);
    }
  }

  private async handlePairEvent(event: PairEvent): Promise<void> {
    switch (event.kind) {
      case 'pendingRequest': {
        // Our own initiated sessions were already auto-accepted; only surface peer-initiated ones.
        if (this.initiatedRoutes.has(event.sessionId)) return;
        if (event.nearby && this.isNearbyGestureActive()) {
          await this.acceptNearbyRequest(event);
          return;
        }
        if (!this.pendingPairRequests.some((e) => e.sessionId === event.sessionId)) {
          this.pendingPairRequests = [...this.pendingPairRequests, event];
          this.setPairingActivity('pair request');
        }
        return;
      }
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
        this.initiatedRoutes.delete(event.sessionId);
        if (event.nearby) this.stopNearbyGesturePolling();
        this.setPairingActivity(event.kind === 'rejected' ? 'pair rejected' : 'pair failed');
        return;
    }
  }

  private async acceptNearbyRequest(event: PairEvent): Promise<void> {
    if (!this.mod) return;
    this.initiatedRoutes.set(event.sessionId, 'nearby');
    this.pendingPairRequests = this.pendingPairRequests.filter(
      (request) => request.sessionId !== event.sessionId
    );
    await this.mod.respondPair(event.sessionId, true);
    this.setPairingActivity('contact confirmed');
  }

  private async maybeInitiateNearbyPair(): Promise<void> {
    if (!this.mod || !this.isNearbyGestureActive()) return;
    const activeNearby = this.pairSessions.some(
      (session) => session.nearby && !['complete', 'rejected', 'failed'].includes(session.state)
    );
    if (activeNearby) return;

    const candidates = this.nearbyPeers
      .map((peer) => ({ peer, endpointId: peer.verifiedEndpointId ?? peer.endpointHint }))
      .filter(
        (candidate): candidate is { peer: BlePeer; endpointId: string } =>
          candidate.endpointId !== null &&
          this.state.friends[candidate.endpointId] === undefined &&
          !this.nearbyPairAttempts.has(candidate.endpointId)
      );
    if (candidates.length !== 1) {
      if (candidates.length > 1) this.setPairingActivity('multiple signals nearby');
      return;
    }

    const endpointId = candidates[0].endpointId;
    this.nearbyPairAttempts.add(endpointId);
    try {
      await this.initiateNearbyPair(endpointId);
    } catch (error) {
      this.nearbyPairAttempts.delete(endpointId);
      throw error;
    }
  }

  private async initiateNearbyPair(endpointId: string): Promise<string> {
    if (!this.mod) throw new Error('pairNearby: native module not bound');
    const sessionId = await this.mod.initiatePairNearby(endpointId);
    this.initiatedRoutes.set(sessionId, 'nearby');
    await this.mod.respondPair(sessionId, true);
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
    if (!this.mod) return;
    const result = await this.mod.pairResult(event.sessionId).catch(() => null);
    if (!result) return;
    if (this.removingFriends.has(result.peerEndpointId)) {
      this.pendingPairRequests = this.pendingPairRequests.filter(
        (request) => request.sessionId !== event.sessionId
      );
      this.initiatedRoutes.delete(event.sessionId);
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
    this.initiatedRoutes.delete(event.sessionId);
    this.discoveredFriend = friend;
    this.stopNearbyGesturePolling();
    this.persistPool();
    void this.syncTrail(0);
    this.setPairingActivity('cryptid discovered');
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
