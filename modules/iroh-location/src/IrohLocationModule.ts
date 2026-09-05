import { NativeModule, requireNativeModule } from 'expo-modules-core';

import { requireIrohRelayRuntimeConfig } from './relay-config';
import type {
  NativeIngestOutcome,
  IrohLocationEvents,
  IrohLocationApi,
  BleCapabilities,
  BlePeer,
  BluetoothRadioState,
  BumpResolution,
  NativeControlMsg,
  NativeRatchetEvent,
  NativeLocationFix,
  NodeKeys,
  PairEvent,
  PairInvite,
  PairInviteWithToken,
  PairResult,
  PairStateRecord,
  ProfileView,
  RatchetDropped,
  SasChallenge,
  TrailReplicaAuthor,
  TransportDiagnostics,
  TransportConfig,
} from './IrohLocation.types';

/**
 * Typed handle to the native `IrohLocation` Expo module. The methods are implemented in
 * Swift/Kotlin (see `modules/iroh-location/ios` + `android`), which bridge into the
 * UniFFI-generated bindings for the Rust `iroh-location` crate.
 *
 * This is a `declare class` — the runtime object is provided by `requireNativeModule`.
 */
export declare class IrohLocationNativeModule
  extends NativeModule<IrohLocationEvents>
  implements IrohLocationApi
{
  createNode(identitySecretHex: string | null, recvSecretHex: string | null): Promise<NodeKeys>;
  start(config?: TransportConfig): Promise<void>;
  shutdown(): Promise<void>;
  ticket(): Promise<string>;
  deriveTopic(authorEndpointIdHex: string): Promise<string>;
  subscribe(topicHex: string, bootstrapTickets: string[]): Promise<string>;
  publish(
    subscriptionId: string,
    seq: number,
    fix: NativeLocationFix,
    recipientEndpointsHex: string[],
    traceparent?: string | null
  ): Promise<RatchetDropped[]>;
  unsubscribe(subscriptionId: string): Promise<void>;
  docsWrite(
    subscriptionId: string,
    seq: number,
    fix: NativeLocationFix,
    recipientEndpointsHex: string[],
    traceparent?: string | null
  ): Promise<RatchetDropped[]>;
  /**
   * Advance and return this device's next publish sequence number.
   *
   * The counter is persisted natively **before** this resolves, because the value goes straight
   * onto the wire as half of an `author/seq` docs key and two envelopes under one key is a payload
   * lost to last-write-wins. It lives in native rather than JS because expo-task-manager hands
   * every headless callback a fresh JS context: each got its own copy of the module, its own
   * cached counter, and its own belief that it was the only writer. No JS-side guard can close
   * that — the guard would be duplicated along with the thing it guards.
   *
   * OPTIONAL: absent on binaries built before this API, so callers must guard with
   * `typeof mod.nextSeq === 'function'` and fall back to the old `state-store.ts` path.
   */
  nextSeq?(): Promise<number>;
  /**
   * Remember the transport settings natively, so a background wake can `start` without JS.
   *
   * The relay URLs and token are build-time `EXPO_PUBLIC_*` constants inlined into the JS bundle, so
   * a device only learns them by being told. Push on every launch and whenever a toggle changes.
   * OPTIONAL: absent on binaries built before the native drain path.
   */
  setTransportConfig?(config?: TransportConfig): Promise<void>;
  /**
   * Run one captured fix through the native gate → outbox → seal → send pipeline.
   *
   * The same call the background runtime makes, exposed so the mounted app can exercise the exact
   * path a wake takes rather than a parallel implementation of it. OPTIONAL.
   */
  ingestFix?(
    subscriptionId: string,
    fix: NativeLocationFix,
    battery: { level: number; charging: boolean; lowPower: boolean },
    intervalMs: number
  ): Promise<NativeIngestOutcome>;
  /**
   * Start the native background publish path — a foreground service on Android, Core Location on
   * iOS. Only the sharing toggle should call these: a service the user did not ask for is a
   * persistent notification they cannot explain. OPTIONAL.
   */
  /**
   * Ask for the notification permission the Android foreground service's ongoing notification
   * needs (API 33+). Resolves to whether it is granted; a no-op `true` on iOS and on older Android.
   *
   * Callers should start the service regardless of the answer — Android does not refuse to run a
   * foreground service over this, so a denial costs the user's ability to SEE that sharing is
   * running, not sharing itself. OPTIONAL.
   */
  ensureNotificationPermission?(): Promise<boolean>;
  /**
   * Publish the slots that have come due without a new fix, reusing the last known position.
   *
   * The counterpart to {@link ingestFix}, driven on a timer by the mounted app: neither platform
   * gives a background process a reliable one, and the cadence has to stay uniform whether or not
   * the phone is moving — it is the one property of a sealed envelope the stash can read. Resolves
   * with `enqueued: 0` when the current slot is already covered, which is the common case. OPTIONAL.
   */
  heartbeatFix?(
    subscriptionId: string,
    battery: { level: number; charging: boolean; lowPower: boolean },
    intervalMs: number
  ): Promise<NativeIngestOutcome>;
  /**
   * Re-program the native background runtime from the sampling policy's decision.
   *
   * The cadence controller drives this. `intervalMs` is the publish slot the native gate enforces;
   * `distanceM` and `accuracy` are what we ask the OS for. iOS ignores any time interval, so the
   * distance filter is the only hardware-facing control there — see `sampling-policy.ts`. OPTIONAL.
   */
  setBackgroundCadence?(intervalMs: number, distanceM: number, accuracy: string): void;
  /**
   * Whether the native background runtime is currently receiving locations.
   *
   * Distinct from "sharing is enabled": the gap between what the user asked for and what the OS is
   * actually handing us is the entire background failure this path exists to close. OPTIONAL.
   */
  nativeBackgroundRunning?(): boolean;
  /**
   * What the native runtime is doing and why — `{ running, state, wake_reason, auth_status,
   * precise, anchor_armed, fence_registered, slc_available, candidate_pending,
   * candidate_fence_armed, last_wake_age_ms?, candidate_age_ms?, anchor_age_ms? }`.
   *
   * `device.health` flattens this under `location.*`. On iOS a parked phone emits nothing by
   * construction, so "which state is it in and when did it last run" is the only way to tell it
   * apart from a phone that has stopped waking at all. OPTIONAL.
   */
  nativeBackgroundState?(): Record<string, unknown>;
  /**
   * Whether Core Location grants background updates right now, read live from the delegate.
   *
   * Distinct from `expo-location`'s request round-trip, which on a fresh install returns before the
   * authorization delegate has settled — latching that answer left a phone holding `authorizedAlways`
   * reporting `access=foreground` for an evening. OPTIONAL.
   */
  nativeBackgroundAuthorized?(): boolean;
  startNativeBackground?(): void;
  stopNativeBackground?(): void;
  /**
   * Give the native runtime back its autonomy because THIS JS runtime is going away.
   *
   * Not {@link stopNativeBackground}: that one is the user switching sharing off and disarms
   * everything, and on iOS "everything" includes SLC, the stop-anchor fence and the persisted
   * anchor — the only three mechanisms that can bring a terminated app back. A process teardown
   * that removes them leaves a phone which cannot wake until its owner opens the app, which is the
   * opposite of what a teardown is allowed to mean. The JS side already draws this distinction for
   * the sharing intent and the revive fence; this is the native half of it.
   *
   * Both platforms drop the capture handoff and keep the mechanism: iOS releases its node handle so
   * it rebuilds against the stores this session is about to close, Android keeps its foreground
   * service running.
   *
   * OPTIONAL: absent on binaries built before the native drain path.
   */
  releaseNativeBackground?(): void;
  /**
   * Mirror this device's identity into the native store the background drain path reads.
   *
   * The background node is built with no JS context alive, so it cannot be handed the identity the
   * way {@link createNode} is — it fetches it through the native `DeviceSecrets` port. This is what
   * puts it there.
   *
   * Call on EVERY launch, not only when the store looks empty: an existing entry can hold a
   * *different* identity (iOS Keychain items survive an app uninstall), and a background node built
   * on a stale one would publish under an endpoint none of the user's friends have paired with.
   * One keystore write per launch is what makes the two provably agree.
   *
   * OPTIONAL: absent on binaries built before the native drain path.
   */
  saveDeviceSecrets?(identityHex: string, recvHex: string): Promise<void>;
  /**
   * Whether the native identity store holds both halves. Diagnostic only — it says something is
   * stored, never that it matches the identity this session is using, which is why
   * {@link saveDeviceSecrets} is unconditional. OPTIONAL.
   */
  deviceSecretsProvisioned?(): boolean;
  /** Fixes captured but not yet sealed, in the native queue. OPTIONAL. */
  outboxPending?(): Promise<number>;
  /** Drop every queued fix (sign-out, or sharing off for good). OPTIONAL. */
  clearOutbox?(): Promise<void>;
  /**
   * Replace the set of friends this device seals location envelopes for.
   *
   * Both lists, one call: a friend belongs to exactly one of them and they change together, so two
   * setters would leave a window where someone is in both or in neither. "Neither" silently stops
   * their ratchet contribution and lapses the edge (FORWARD-SECRECY.md §4.1).
   *
   * Persisted natively so an OS location callback can read them with no JS context alive. Push on
   * every pool change. A momentarily stale list is safe in the only direction it can be stale: the
   * ratchet session remains the authority on who can decrypt, and these lists only narrow who we
   * attempt to seal for.
   *
   * OPTIONAL: absent on binaries built before the native drain path.
   */
  setSharingRecipients?(
    recipientEndpointsHex: string[],
    watcherEndpointsHex: string[]
  ): Promise<void>;
  /**
   * Who the native drain path will seal for RIGHT NOW, read back from its durable store.
   *
   * The counterpart to {@link setSharingRecipients}, and the only way to see the two sides
   * disagree. Every JS-side reading of "who am I sharing with" comes from the pool in
   * `AsyncStorage`; the native publish path reads none of that, and on 2026-09-03 the two had
   * diverged for a full day — pool of one, native list empty, 91 envelopes sealed for nobody, and
   * `device.health` reporting the healthy number the whole time. `sharing.native_recipients` is
   * this one.
   *
   * OPTIONAL: absent on binaries built before the native drain path.
   */
  sharingRecipients?(): Promise<string[]>;
  /**
   * Record where a drained envelope must be SENT for it to leave this device.
   *
   * The companion to {@link setSharingRecipients}: that call says who to seal for, this one says
   * who to hand the sealed bytes to. A device that knows the first but not the second publishes
   * into its own local replica and reports success — `docsWrite` is local-only, and iroh-docs
   * broadcasts a local insert solely for namespaces the live engine has marked as syncing, which a
   * publish-only context never does. Two phones spent 2026-08-31 in exactly that state.
   *
   * Persisted natively because the caller that most needs it is an OS location callback with no JS
   * context alive to supply it. Push on every pool change and every stash opt-in change, alongside
   * {@link setSharingRecipients}.
   *
   * `peerTickets` must mirror `durablePeerTickets()` — stash first when opted into, then every pool
   * member — because whichever path publishes has to reach the same set. An empty list is a valid
   * configuration (stash off, no friends yet), not an unset one: the drain simply has no push to
   * make. `stashBaseUrl` is omitted when the user has opted out, which is deliberately distinct
   * from the stash merely not being built into this bundle.
   *
   * OPTIONAL: absent on binaries built before the native push path.
   */
  setDeliveryConfig?(
    peerTickets: string[],
    stashBaseUrl: string | null,
    stashPsk: string | null
  ): Promise<void>;
  /**
   * Enrol this device as a blind carrier for the given mutual friends' trail namespaces, and
   * name the mutuals our own trail may be handed to. Both directions in one call, because
   * mutual relay is symmetric by construction: you only carry for someone who carries for you.
   *
   * `mutualTickets` are read-tickets, exactly as the stash is granted — replication of sealed
   * envelopes, never decryption. A carrier can see WHICH namespaces it holds, which is the
   * metadata cost the picker states out loud ("mutual friends can tell that you are all
   * friends"); it can never open one.
   *
   * An empty list means "carry for nobody", which is how the mode is switched off. Distinct
   * from the method being absent, which means this binary cannot do it at all.
   *
   * OPTIONAL, and the presence of this export is what `DeliveryAvailability.mutualSupported`
   * tests — a phone can be running an older binary than the JS bundle.
   */
  setMutualRelayConfig?(mutualTickets: string[]): Promise<void>;
  /**
   * When the native drain last accepted a fix, published, and pushed (ms since epoch, or null).
   *
   * `device.health` turns these into `last_*_age_ms`. They are read from native rather than from
   * the JS watermark row because the drain moved into Rust and the row is only written by callers
   * that path bypasses: on 2026-08-31 a phone that had published 37 envelopes that afternoon
   * reported a publish age of 672 minutes and read as eleven hours dead.
   *
   * Three separate answers on purpose — accepted-but-not-published is a gate or battery decision,
   * published-but-not-pushed is a phone talking to its own replica, and one "last seen" number
   * would hide both.
   *
   * OPTIONAL: absent on binaries built before the native push path.
   */
  publishWatermarks?(): Promise<{
    lastAcceptedAt: number | null;
    lastPublishedAt: number | null;
    lastPushedAt: number | null;
  }>;
  /** The last sequence number handed out, without advancing. OPTIONAL, as {@link nextSeq}. */
  currentSeq?(): Promise<number>;
  /**
   * Raise the native counter to at least `floor`; resolves to whether it moved.
   *
   * Monotone, so it is safe to call repeatedly: this is both the one-time migration of the old
   * SecureStore value and the recovery path for an unreadable counter file. Raising can only skip
   * values, never re-issue them. OPTIONAL, as {@link nextSeq}.
   */
  seedSeq?(floor: number): Promise<boolean>;
  /**
   * Broadcast a **null fix**: an envelope with an empty padded payload, wrapped for the friends we
   * do NOT share position with (FORWARD-SECRECY.md §4.1). Same signing, AAD, and ciphertext length
   * as {@link publish} — only the tick timestamp, no coordinates.
   *
   * Optional for compatibility with installed iOS binaries built before the null-fix API (Swift
   * bindings regenerate only on macOS, `just bindgen-ios`). Guard with `typeof … === 'function'`.
   */
  publishNull?(
    subscriptionId: string,
    seq: number,
    ts: number,
    watcherEndpointsHex: string[],
    traceparent?: string | null
  ): Promise<RatchetDropped[]>;
  /**
   * Durable mirror of {@link publishNull}. Writes to a **separate** last-write-wins slot from the
   * fix lane, because a tick's two envelopes are wrapped for disjoint recipient sets and would
   * otherwise supersede each other. Optional for the same reason as {@link publishNull}.
   */
  docsWriteNull?(
    subscriptionId: string,
    seq: number,
    ts: number,
    watcherEndpointsHex: string[],
    traceparent?: string | null
  ): Promise<RatchetDropped[]>;
  /**
   * §4.6 recovery. Optional for the same reason as the other recent additions: iOS Swift bindings
   * regenerate only on macOS, so an installed binary may predate these exports.
   */
  isDesynced?(peerEndpointHex: string): Promise<boolean>;
  resyncCount?(peerEndpointHex: string): Promise<number>;
  publishResync?(recipientRecvPubsHex: string[]): Promise<string>;
  pollResync?(peerEndpointHex: string, peerRecvPubHex: string): Promise<boolean>;
  clearResync?(): Promise<void>;
  forgetSession?(peerEndpointHex: string): Promise<void>;
  syncLatest(peerTickets: string[], traceparent?: string | null): Promise<void>;
  /** Optional for compatibility with installed iOS binaries built before the push API. */
  pushTrail?(peerTickets: string[], traceparent?: string | null): Promise<void>;
  uploadTrailContent?(baseUrl: string, psk: string | null): Promise<number>;
  /** Optional for compatibility with installed iOS binaries built before the control API. */
  docsWriteControl?(msg: NativeControlMsg, recipientsHex: string[]): Promise<void>;
  /** Optional for compatibility with installed iOS binaries built before the control API. */
  readControl?(author: string): Promise<NativeControlMsg[]>;
  readLatest(): Promise<NativeRatchetEvent[]>;
  pruneTrail(olderThanTs: number): Promise<void>;
  docTicket(): Promise<string>;
  importDocTicket(ticket: string): Promise<void>;

  // Optional for compatibility with installed iOS binaries built before the telemetry API.
  configureTelemetry?(endpoint: string, instanceId: string): Promise<boolean>;
  flushTelemetry?(): Promise<void>;

  // Native MVT map-tile decoder (see modules/iroh-location/rust/src/mvt.rs). Runs
  // off the JS thread; returns a flat SCG1 geometry buffer. Optional: present on
  // Android dev-client/release builds and on iOS after `just bindgen-ios`; absent
  // in Expo Go / older binaries. Guard with `typeof … === 'function'`.
  decodeMvtBundle?(bundle: Uint8Array): Promise<Uint8Array>;
  decodeMvtTile?(bytes: Uint8Array, z: number, x: number, y: number): Promise<Uint8Array>;
  h3CellsForPolygon?(coordinates: number[], resolution: number): Promise<string[]>;

  publishProfile(
    handle: string,
    cryptidName: string,
    sigil: string,
    color: string
  ): Promise<number>;
  profileTicket(): Promise<string>;
  importProfileTicket(ticket: string): Promise<void>;
  readProfile(endpointIdHex: string): Promise<ProfileView | null>;
  pollProfileEvents(): Promise<ProfileView[]>;

  setPairingReady(ready: boolean): Promise<void>;
  pairingReady(): Promise<boolean>;
  createPairInvite(ttlSecs: number): Promise<PairInviteWithToken>;
  initiatePair(invite: PairInvite): Promise<string>;
  initiatePairByToken(token: string): Promise<string>;
  initiatePairNearby(peerEndpointIdHex: string): Promise<string>;
  respondPair(sessionIdHex: string, accept: boolean): Promise<void>;
  pairSasChallenge(sessionIdHex: string): Promise<SasChallenge | null>;
  submitPairChoice(sessionIdHex: string, chosenIndex: number): Promise<void>;
  confirmPairDisplay(sessionIdHex: string, matched: boolean): Promise<void>;
  cancelPair(sessionIdHex: string): Promise<void>;
  pollPairEvents(): Promise<PairEvent[]>;
  pairState(sessionIdHex: string): Promise<PairStateRecord | null>;
  listPairSessions(): Promise<PairStateRecord[]>;
  pairResult(sessionIdHex: string): Promise<PairResult | null>;
  encodePairInvite(invite: PairInvite): Promise<string>;
  decodePairInvite(token: string): Promise<PairInvite>;
  transportDiagnostics(peerEndpointIdsHex: string[]): Promise<TransportDiagnostics>;
  /** Optional for compatibility with installed iOS binaries built before the replica query. */
  trailReplicaStatus?(): Promise<TrailReplicaAuthor[]>;

  bleAvailable(): Promise<boolean>;
  bleCapabilities(): Promise<BleCapabilities>;
  nearbyBlePeers(): Promise<BlePeer[]>;
  resolveBumpPeer(timeoutMs: number): Promise<BumpResolution>;
  bleHasScanHint(endpointIdHex: string): Promise<boolean>;
  /**
   * Power/authorization state of the Bluetooth radio, independent of the BLE transport.
   * Optional for compatibility with installed binaries built before the radio probe.
   */
  bluetoothRadioState?(): Promise<BluetoothRadioState>;
}

/**
 * The module as the native side actually declares it, before {@link withRelayConfig} fills in the
 * relay URLs and token. Both transport entry points take them explicitly here and neither does
 * above, which is the whole job of the wrapper.
 */
type RawIrohLocationNativeModule = Omit<
  IrohLocationNativeModule,
  'start' | 'setTransportConfig'
> & {
  start(
    relayUrls: string[],
    relayAuthToken: string,
    relayEnabled: boolean,
    ipEnabled: boolean,
    bleEnabled: boolean
  ): Promise<void>;
  setTransportConfig?(
    relayUrls: string[],
    relayAuthToken: string,
    relayEnabled: boolean,
    ipEnabled: boolean,
    bleEnabled: boolean
  ): Promise<void>;
};

const DEFAULT_TRANSPORT_CONFIG: TransportConfig = { relay: true, ip: true, ble: true };

let cached: IrohLocationNativeModule | null | undefined;

function withRelayConfig(raw: RawIrohLocationNativeModule): IrohLocationNativeModule {
  const start = raw.start.bind(raw);

  return new Proxy(raw, {
    get(target, property) {
      if (property === 'start') {
        return async (config: TransportConfig = DEFAULT_TRANSPORT_CONFIG) => {
          const { relayUrls, authToken } = requireIrohRelayRuntimeConfig();
          await start(relayUrls, authToken, config.relay, config.ip, config.ble);
        };
      }

      // Same treatment, same reason: the relay URLs and token are this bundle's build-time
      // constants, so callers pass only the toggles and never have to know where the rest lives.
      if (property === 'setTransportConfig') {
        const native = target.setTransportConfig?.bind(target);
        // Left undefined on a binary that predates the native drain path, so the callers'
        // `typeof mod.setTransportConfig === 'function'` guard still reports the truth rather than
        // finding this wrapper and failing inside it.
        if (!native) return undefined;
        return async (config: TransportConfig = DEFAULT_TRANSPORT_CONFIG) => {
          const { relayUrls, authToken } = requireIrohRelayRuntimeConfig();
          await native(relayUrls, authToken, config.relay, config.ip, config.ble);
        };
      }

      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as unknown as IrohLocationNativeModule;
}

/** Returns the native module, or `null` when it isn't available (web / Expo Go). */
export function tryGetIrohLocation(): IrohLocationNativeModule | null {
  if (cached !== undefined) return cached;
  try {
    const raw = requireNativeModule<RawIrohLocationNativeModule>('IrohLocation');
    cached = withRelayConfig(raw);
  } catch {
    cached = null;
  }
  return cached;
}

/** Returns the native module or throws a friendly error explaining why it's missing. */
export function getIrohLocation(): IrohLocationNativeModule {
  const mod = tryGetIrohLocation();
  if (!mod) {
    throw new Error(
      'IrohLocation native module unavailable. It requires a custom dev client build ' +
        '(run `expo prebuild` + a native build); it is not present in Expo Go or on web.'
    );
  }
  return mod;
}
