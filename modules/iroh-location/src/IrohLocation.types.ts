/**
 * JS-facing type contract for the native `IrohLocation` Expo module. These types must
 * match what the Swift/Kotlin `IrohLocationModule` exposes (see the ios/ + android/
 * sources). Keys cross the bridge as lowercase hex strings.
 */

/** A repeater this phone just claimed, and the roster it joined. Lowercase hex ids. */
export interface NativeRepeaterClaim {
  rosterId: string;
  repeaterId: string;
}

/** One roster this phone knows. Mirrors Rust's `RepeaterRoster`; ids are lowercase hex. */
export interface NativeRepeaterRoster {
  rosterId: string;
  /** The owner's endpoint id: a phone, and so possibly a friend. */
  owner: string;
  /** This phone owns it. */
  mine: boolean;
  /** Anyone may enrol, rather than only whoever an inviter invited. */
  open: boolean;
  /** It carries this phone's own trail: the one opt-in there is. */
  carriesMe: boolean;
  /** Endpoint ids of the machines in it. */
  repeaters: string[];
  /** How many people's trails it carries. */
  carried: number;
  /**
   * Whose trails it carries (endpoint ids). Optional: absent from binaries built before it, which
   * report only the count.
   */
  members?: string[];
  /**
   * Friends whose repeater cards list this roster and who are in it (endpoint ids). Optional, as
   * above: absent from binaries built before the cards.
   */
  vouchers?: string[];
  /** Enrolling would be accepted, as far as this phone can tell: open, or an invite naming us. */
  canEnrol?: boolean;
}

/** What one {@link IrohLocationApi.pushTelemetryNow} did. Mirrors Rust's `TelemetryPush`. */
export interface NativeTelemetryPush {
  /** An exporter is configured; `false` in a build without telemetry. */
  configured: boolean;
  /** Spooled batches (traces and logs) the collector took during this push. */
  delivered: number;
  /** Spooled batches given up on during this push: refused, or too old to send. */
  dropped: number;
  /** The collector answered every send; `false` means the rest is still queued. */
  reachable: boolean;
  remainingBatches: number;
  remainingBytes: number;
}

/** A raw location fix as it crosses the native bridge. */
/** What one {@link IrohLocationModule.ingestFix} call did. Mirrors Rust's `IngestOutcome`. */
export interface NativeIngestOutcome {
  /** The fix passed the confidence gate and became this device's position. */
  accepted: boolean;
  /** Why it did not, when it did not. A rejection still lets the heartbeat republish. */
  rejection: string | null;
  /** Envelopes queued for this wake — one per interval slot that had come due. */
  enqueued: number;
  /** Envelopes that actually reached the wire; fewer means the wake ran out of time or network. */
  published: number;
  /**
   * Of those, envelopes at least one friend can open. Fewer than `published` means recipients were
   * dropped from the wrap set (a lapsed or missing session). OPTIONAL: absent on older binaries.
   */
  reached?: number;
  /** Depth of the native queue afterwards. */
  pending: number;
  /** Slots the backfill cap declined to fill. */
  slotsSkipped: number;
  /** Oldest fixes the queue bound discarded. Non-zero means hours of failed publishing. */
  overflowDropped: number;
  /** Publishing is suspended on critical battery — distinct from "nothing was due". */
  suspended: boolean;
}

export interface NativeLocationFix {
  lat: number;
  lon: number;
  accuracyM: number;
  headingDeg: number;
  /** ms since epoch — when the POSITION was measured. Does not advance on a heartbeat. */
  ts: number;
  /**
   * One of `FIX_STATE_*` (declared in `features/social/core/types.ts`, mirroring `rust/src/lib.rs`,
   * which is the source of truth). Absent ⇒ the sender predates the field, so fall back to age.
   *
   * Present only on RECEIVED fixes: it is stamped at seal time, so a capture never carries one.
   */
  state?: number;
  /**
   * Seconds between {@link ts} and the moment the sender sealed this envelope.
   *
   * The second clock, and the one that means "their phone was alive". `ts + publishedDeltaS * 1000`
   * is the last moment we can prove the sending process ran; {@link ts} only says when the position
   * under it was measured. A parked phone republishes an hours-old position from a live process,
   * which is why one number could never separate "stopped moving" from "stopped running".
   */
  publishedDeltaS?: number;
}

/** Key material returned by `createNode`; persist the secrets in the OS secure store. */
export interface NodeKeys {
  /** ed25519 EndpointId (also the envelope `author`). */
  endpointId: string;
  /** ed25519 identity secret — persist securely. */
  identitySecret: string;
  /** X25519 receiving secret — persist securely. */
  recvSecret: string;
  /** X25519 receiving public key — share with friends so they can wrap fixes for you. */
  recvPublic: string;
}

/** Native endpoint transports enabled for a debug session. */
/**
 * Who holds the process's node, as the Rust `NodeHost` sees it. Counters are since process start.
 * See `modules/iroh-location/rust/src/host.rs` for what each one means.
 */
export interface NodeHostSnapshot {
  generation: number;
  hasNode: boolean;
  appLeases: number;
  background: boolean;
  builds: number;
  adoptions: number;
  replacements: number;
  restarts: number;
  shutdowns: number;
  shutdownFailures: number;
  shutdownTimeouts: number;
  /** Rebuilds because the phone reached nobody. Absent on binaries from before `isolation.rs`. */
  heals?: number;
}

/**
 * Whether this phone currently reaches nobody — every dial, the stash's included, unanswered — and
 * what has been done about it. Mirrors `IsolationStatus` in `modules/iroh-location/rust/src/isolation.rs`.
 */
export interface IsolationStatus {
  isolated: boolean;
  /** When the silent streak that made it isolated began (epoch ms). */
  isolatedSinceMs?: number;
  silentPasses: number;
  /** When anyone last answered (epoch ms), this process. */
  lastAnswerMs?: number;
  networkChanges: number;
  rebuilds: number;
  /** The mounted app should heal now, through `rebindNode('isolated')`. */
  rebuildDue: boolean;
  lastRebuildMs?: number;
  episodes: number;
  recoveries: number;
}

export interface TransportConfig {
  relay: boolean;
  ip: boolean;
  ble: boolean;
}

/**
 * Where the native drain path sends a published envelope so it leaves the phone.
 *
 * Mirrors `delivery.rs`. Crosses the bridge flattened into positional arguments (see
 * `setDeliveryConfig`), as `TransportConfig` does; this shape is what the app assembles before the
 * call, and it must agree with `durablePeerTickets()` in `location-sharing.ts`.
 */
export interface DeliveryConfig {
  /** Stash ticket first when opted into, then every pool member. Empty is valid. */
  peerTickets: string[];
  /** Stash content API base URL, omitted when the user has opted out of durable delivery. */
  stashBaseUrl?: string | null;
  /** Pre-shared key for that API, when the deployment requires one. */
  stashPsk?: string | null;
}

/**
 * Recipients left out of a ratcheted publish, as `"<endpointIdHex>:<reason>"`.
 *
 * A short wrap list is never silently fine: a friend in here did **not** receive that fix. The
 * reasons come from `DropReason` in `sessions.rs`:
 *
 * - `no_session` — never bootstrapped, or the session was forgotten. Needs an in-person re-pair;
 *   sessions are only ever rooted by the SAS bump (FORWARD-SECRECY.md §4.2).
 * - `lapsed` — no fresh ratchet key from them within `T_lapse` (24 h). Structurally identical to
 *   a revocation until they open the app and publish again (§4.5).
 * - `no_sending_chain` — a responder that has not yet received the initiator's first envelope.
 *   Resolves itself on the next tick; not worth surfacing to a human.
 * - `state_unavailable` — their session state could not be read or persisted. Recoverable via
 *   the §4.6 restart the native drain runs, which `isDesynced` will also be reporting.
 */
export type RatchetDropped = string;

/** A decrypted v3 envelope from the durable replica, including the position-less null lane. */
export interface NativeRatchetEvent {
  author: string;
  seq: number;
  /** Sender timestamp from the signed envelope header. */
  ts?: number;
  /** Absent on installed native binaries from before null-lane activity was surfaced. */
  kind?: 'fix' | 'null';
  fix?: NativeLocationFix;
  /**
   * Hex EndpointId of the peer that served this author's entry in the reconciliation that just
   * ran. Absent when the entry was already in the replica (read back rather than delivered), and
   * on binaries built before per-entry attribution.
   */
  viaPeer?: string;
}

// ── Profiles (docs/social/ARCHITECTURE.md §3) ───────────────────────────────────────────────

/**
 * A verified cryptid profile as surfaced to the app. Already signature- and endpoint-verified
 * by the native layer, so it can be rendered directly. Byte fields cross the bridge as lowercase
 * hex strings; `epoch`/`ts` are ms-since-epoch numbers.
 */
export interface ProfileView {
  /** ed25519 EndpointId (hex) of the profile owner. */
  endpointId: string;
  /** Monotonic, wall-clock-anchored publish epoch (ms). */
  epoch: number;
  handle: string;
  cryptidName: string;
  sigil: string;
  color: string;
  /** X25519 receiving public key (hex) — used to wrap fixes for this cryptid. */
  recvPub: string;
  /** Publish timestamp (ms since epoch). */
  ts: number;
}

// ── Bilateral pairing (`streetcryptid/pair/4`) — ARCHITECTURE.md §4 ──────────────────────────

/**
 * An out-of-band pairing invite carrying only immutable bootstrap material. Byte fields are
 * lowercase hex; `expiresAtMs` is ms since epoch. Share via {@link PairInviteWithToken.token}.
 */
export interface PairInvite {
  /** Invite wire-format version. */
  version: number;
  /** Random invite id (hex, 16 bytes). */
  inviteId: string;
  /** Invite secret (hex, 16 bytes). */
  secret: string;
  /** Inviter ed25519 EndpointId (hex). */
  endpointId: string;
  /** Inviter endpoint ticket (dial hint). */
  endpointTicket: string;
  /** Invite expiry (ms since epoch). */
  expiresAtMs: number;
}

/** A freshly minted invite plus its opaque, shareable `scpair2:<base64url>` token (QR / deep link). */
export interface PairInviteWithToken extends PairInvite {
  /** Opaque encoded token (`scpair2:<base64url>`) for QR codes / links. */
  token: string;
}

/**
 * Coarse pairing session phase (UI-facing). `verifying` means the SAS nonces are revealed and
 * verified and BOTH humans must clear the visual gate before any accept — no {@link PairResult}
 * is reachable from `verifying` without confirming the challenge first.
 */
export type PairStateValue =
  | 'handshaking'
  | 'pending'
  | 'verifying'
  | 'localAccepted'
  | 'peerAccepted'
  | 'complete'
  | 'rejected'
  | 'failed';

/** The deterministic SAS role for this side, derived from the pairing transcript. */
export type SasRole = 'displayer' | 'picker';

/**
 * The per-session Short Authentication String challenge shown while a pair is `verifying`. The
 * `displayer` shows the `targetIndex` figure and confirms the other human matched it; the `picker`
 * must choose the matching figure among `optionIndices`. `targetIndex` never crosses the wire.
 */
export interface SasChallenge {
  role: SasRole;
  /** Correct figure index (displayer shows it; picker must match it). */
  targetIndex: number;
  /** The picker's shuffled figure indices (includes the target). Never empty. */
  optionIndices: number[];
  /** Absolute wall-clock deadline (ms since epoch). Actions after this are terminal. */
  deadlineMs: number;
}

/** A snapshot of a pairing session's state. Byte fields are lowercase hex. */
export interface PairStateRecord {
  sessionId: string;
  peerEndpointId: string;
  state: PairStateValue;
  localAccepted: boolean;
  peerAccepted: boolean;
  initiator: boolean;
  /**
   * Whether this session is an invite-less nearby pair (vs invite-based). Fixed at session
   * creation and unaffected by later accept/reject decisions.
   */
  nearby: boolean;
  /** Whether the peer's SAS reveal verified (the visual gate is ready/underway). */
  sasVerified: boolean;
  /** Whether this side's human cleared the SAS gate (required before any local accept). */
  localSasConfirmed: boolean;
}

/** The kind of a polled pairing event. */
export type PairEventKind =
  /** A peer wants to pair (or our outbound Hello landed) — prompt the user. */
  | 'pendingRequest'
  /** The SAS visual gate is ready — fetch {@link SasChallenge} via `pairSasChallenge` and show it. */
  | 'verifying'
  /** The peer sent their accept/reject. */
  | 'peerResponded'
  /** Both sides accepted — call `pairResult`. */
  | 'ready'
  /** The session was rejected by either side. */
  | 'rejected'
  /** The session failed (SAS mismatch/cancel/timeout or a protocol error). */
  | 'failed';

/** A polled pairing event (node-level queue; see {@link IrohLocationApi.pollPairEvents}). */
export interface PairEvent {
  kind: PairEventKind;
  sessionId: string;
  peerEndpointId: string;
  /**
   * Whether this session is an invite-less nearby pair (vs invite-based). Fixed at session
   * creation and unaffected by later accept/reject decisions.
   */
  nearby: boolean;
}

/**
 * The result of a completed (bilaterally-accepted) pair — everything needed to treat the peer as
 * a friend. Byte fields are lowercase hex; `peerProfile` is `null` until the peer's profile has
 * replicated.
 */
export interface PairResult {
  sessionId: string;
  peerEndpointId: string;
  peerRecvPub: string;
  peerEndpointTicket: string;
  peerProfileTicket: string;
  peerTrailTicket: string;
  peerProfile: ProfileView | null;
}

// ── BLE status (Android/Apple only; honest stub elsewhere) — ARCHITECTURE.md §2 ─────────────

/** Honest BLE capability report combined with the app-level pairing-ready gate. */
export interface BleCapabilities {
  /** A BLE transport is wired into this node's endpoint on this platform. */
  available: boolean;
  /** The app can explicitly refresh the shared scan for foreground Bump resolution. */
  activeScanToggle: boolean;
  /** Fresh Bump advertisements include RSSI. */
  rssi: boolean;
  /** The shared scanner can be restarted for a fresh Bump pass. */
  discoveryRefresh: boolean;
  /** App-level acceptance gate for invite-less nearby pairing. */
  pairingReady: boolean;
}

/**
 * Power/authorization state of the Bluetooth radio itself, reported independently of whether the
 * BLE transport managed to attach. {@link BleCapabilities.available} collapses "radio off",
 * "permission missing" and "no BLE hardware" into one flag; this separates the two the user can
 * fix. `unknown` means the platform could not be asked (host builds, web, an old native binary).
 */
export type BluetoothRadioState =
  'unknown' | 'unsupported' | 'unauthorized' | 'poweredOff' | 'poweredOn';

export type TransportAddressKind = 'relay' | 'ip' | 'custom';

/** One local or remote endpoint address from iroh's live path table. */
export interface TransportAddressDiagnostic {
  kind: TransportAddressKind;
  address: string;
  /** Remote path usage; null for local advertised addresses. */
  active: boolean | null;
}

/** Iroh's retained address/path knowledge for one requested peer. */
export interface PeerTransportDiagnostic {
  endpointId: string;
  known: boolean;
  addresses: TransportAddressDiagnostic[];
}

/** Point-in-time endpoint transport snapshot. */
export interface TransportDiagnostics {
  localAddresses: TransportAddressDiagnostic[];
  peers: PeerTransportDiagnostic[];
}

/**
 * One author's fix slot as it exists in the LOCAL durable replica — what this device could hand
 * to a peer that asks.
 *
 * Deliberately NOT the same question as "have we seen this author's fix": app storage
 * (`friend_latest`) keeps a fix after the replica has superseded or pruned it, and only the replica
 * is served to a peer that reconciles with us. So only this answers "can this device relay author X".
 *
 * No location data: presence, not payload. `seq` / `fixTs` come from the envelope's signed
 * plaintext header, so nothing here needs a decrypt.
 */
export interface TrailReplicaAuthor {
  /** The author's EndpointId (hex). */
  author: string;
  /** The envelope's `seq`. `0` when `hasContent` is false. */
  seq: number;
  /** When the author took the fix, not when we stored it. `0` when `hasContent` is false. */
  fixTs: number;
  /**
   * Whether we hold a readable signed envelope, and not merely a docs record pointing at a blob
   * that never landed. False means there is nothing to serve — a different failure from "the
   * transfer broke".
   */
  hasContent: boolean;
}

/** A nearby BLE peer surfaced by the transport snapshot (no RSSI — the crate discards it). */
export interface BlePeer {
  deviceId: string;
  phase: string;
  /** Verified ed25519 EndpointId (hex), or `null` before verification. */
  verifiedEndpointId: string | null;
  /**
   * UNTRUSTED dial hint: the peer's full 32-byte EndpointId (hex) read from its identity
   * characteristic, or `null` until a probe succeeds. Sufficient only to *attempt*
   * `Endpoint.connect` — iroh TLS and the signed pair protocol still verify the real identity, so
   * this must never be treated as verified. Distinct from {@link verifiedEndpointId}.
   */
  endpointHint: string | null;
  consecutiveFailures: number;
  /** How the peer was reached (e.g. `ble` / `ip`), or `null` if unknown. */
  connectPath: string | null;
}

export type BumpResolutionStatus =
  'resolved' | 'unavailable' | 'noPeers' | 'ambiguous' | 'probeFailed';

/** Result of one explicit, foreground Bump discovery attempt. */
export interface BumpResolution {
  status: BumpResolutionStatus;
  endpointId: string | null;
  deviceId: string | null;
  rssi: number | null;
  peerCount: number;
  detail: string;
}

/** Event map for the native module's EventEmitter. */

/**
 * A capture handed up by the native background runtime because it could not own the node itself.
 *
 * The writer claim in `durable.rs` is process-wide, so while the app is mounted it holds the stores
 * and the native runtime — same process, same storage roots — is locked out of them. It captures
 * anyway and sends this; the mounted runtime is the only thing that can publish it. `kind` is
 * `fix` for a real position and `heartbeat` for a tick from the parked coarse stream, which carries
 * no position worth gating.
 */
export interface OnNativeFixEvent {
  kind: 'fix' | 'heartbeat';
  /** Why the native runtime was executing: `movement` | `periodic` | `geofence_exit` | `moving_fence` | ... */
  reason: string;
  /** The runtime's motion state at capture: `moving` | `stopped`. */
  state: string;
  battery: { level: number; charging: boolean; lowPower: boolean };
  /** Absent when `kind` is `heartbeat`. */
  fix?: NativeLocationFix;
  /**
   * On a `heartbeat`: what the runtime can prove about motion — `true` a confirmed stop, `false`
   * a stop just left. Absent when it has no evidence either way, or from a binary that predates
   * the field. Forwarded to {@link IrohLocationModule.heartbeatFix} unchanged.
   */
  parked?: boolean;
}

/**
 * The native runtime pulled friends' fixes into the replica while a mounted app was off screen
 * (iOS only). Sent only when the pull brought something, so the app can re-read the replica it
 * already holds — no network on this side.
 */
export interface OnFriendsPulledEvent {
  /** The wake the pull rode: `movement` | `periodic` | `refresh` | ... */
  trigger: string;
  /** Entries that landed in the replica. */
  entries: number;
  elapsedMs: number;
}

/**
 * Friends whose fix or null slot just became readable in the local replica — by a friend's live
 * push, a pull from the stash, or a sync a friend opened to us; the replica does not say which.
 *
 * Authors only, never payload: read them back with `readLatest`. Emitted only between
 * `watchReplica` and `unwatchReplica`, and only for namespaces this device imported as a friend's.
 */
export interface OnReplicaChangedEvent {
  /** Lowercase hex endpoint ids, one per author, deduplicated within the batch. */
  authors: string[];
}

export type IrohLocationEvents = {
  onReplicaChanged: (event: OnReplicaChangedEvent) => void;
  onNativeFix: (event: OnNativeFixEvent) => void;
  onFriendsPulled: (event: OnFriendsPulledEvent) => void;
};

/** The callable surface of the native module. */
export interface IrohLocationApi {
  /**
   * Create (or restore) the device node. Pass `null` to generate fresh keys; then
   * persist the returned secrets. Returns the stable ids + key material.
   */
  createNode(identitySecretHex: string | null, recvSecretHex: string | null): Promise<NodeKeys>;
  /**
   * Bind the iroh endpoint and open the docs/blobs stores and every namespace in the book, each
   * joined to iroh-docs' live sync. Idempotent.
   */
  start(config?: TransportConfig): Promise<void>;
  /** Release this JS context's lease on the node; the last holder out shuts it down. */
  shutdown(): Promise<void>;
  /** A shareable endpoint ticket (dialing info) for the contact card / bootstrap. */
  ticket(): Promise<string>;
  /**
   * Emit `onReplicaChanged` whenever a friend's fix or null slot becomes readable in the replica.
   *
   * Replication runs whether or not anyone watches; this only saves JS from polling the replica
   * to notice. The module keeps the watch across node restarts and replacements, and the host
   * drops it when the last app lease goes. OPTIONAL: guard with `typeof`.
   */
  watchReplica?(): void;
  /** Stop `onReplicaChanged`. OPTIONAL, as {@link watchReplica}. */
  unwatchReplica?(): void;
  /**
   * Remember the transport settings natively, so a background wake can `start` without JS.
   *
   * Takes the same toggles as {@link start}: the relay URLs and token are this bundle's build-time
   * `EXPO_PUBLIC_*` constants and are filled in by the module, so a device only learns them by
   * being told. Push on every launch and whenever a toggle changes.
   * OPTIONAL: absent on binaries built before the native drain path.
   */
  setTransportConfig?(config?: TransportConfig): Promise<void>;
  /**
   * Run one captured fix through the native gate → outbox → seal → own docs namespace → push.
   *
   * The ONLY way a position leaves this device, and the same call the background runtimes make,
   * so the mounted app exercises the exact path a wake takes.
   */
  ingestFix(
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
   * with `enqueued: 0` when the current slot is already covered, which is the common case.
   *
   * `parked` is what the caller can prove about motion, and decides the envelope's `fix_state`:
   * `true` a confirmed stop, `false` a stop just left, `null` no evidence either way — which is
   * what the mounted timer has, and why it must not claim `parked` (see `publish::Motion`).
   */
  heartbeatFix(
    battery: { level: number; charging: boolean; lowPower: boolean },
    intervalMs: number,
    parked: boolean | null
  ): Promise<NativeIngestOutcome>;
  /**
   * Seal the last known position once, because the recipient set has just grown.
   *
   * A sealed envelope is readable only by the recipients it was sealed for, so a friend who has
   * just paired cannot open anything published before they existed — their first sight of you is
   * otherwise the next scheduled publish, which on a parked iPhone is p90 92 minutes. Fills no
   * slot and does not move the cadence; see `DrainEngine::publish_introduction`. Resolves with
   * `enqueued: 0` on a device that has never captured a position.
   */
  publishIntroduction(): Promise<NativeIngestOutcome>;
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
   * Android: whether the app is exempt from battery optimisation ("Unrestricted"), the state in
   * which the foreground service may be restarted from the background. ANDROID ONLY, OPTIONAL.
   */
  batteryOptimizationExempt?(): boolean;
  /**
   * Android: show the system prompt for that exemption. Returns whether a prompt was shown.
   * ANDROID ONLY, OPTIONAL.
   */
  requestBatteryOptimizationExemption?(): boolean;
  /**
   * What the native runtime is doing and why — `{ running, state, wake_reason, auth_status,
   * precise, anchor_armed, fence_registered, slc_available, candidate_pending,
   * candidate_fence_armed, moving_fence_armed, last_wake_age_ms?, candidate_age_ms?, anchor_age_ms?,
   * stop_via?, last_visit_age_ms? }`.
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
  /**
   * How much of its iOS background execution budget this app has been spending.
   *
   * The denominator every other claim about the background budget was missing. Until this existed,
   * "iOS took our execution away" could only be inferred from silence — a gap between
   * `device.health` records, a MetricKit CPU exception delivered on the launch AFTER the one that
   * offended. `cpu_ms_max` approaching 48000 is not "high": it is `MXCPUExceptionDiagnostic`'s
   * threshold, the constant every one of the 41 diagnostics in that 7-day window reported.
   *
   * `bg_launches` climbing while `js_boots` tracks it means a background launch is still paying
   * for the whole React Native bundle.
   *
   * Read-only — {@link resetBackgroundWakeStats} is separate so two health records in the same
   * minute cannot each take half the counts. iOS only. OPTIONAL.
   */
  takeBackgroundWakeStats?(): Record<string, unknown>;
  /** Clear the wake counters. Called by whoever owns the reporting cadence, nothing else. OPTIONAL. */
  resetBackgroundWakeStats?(): void;
  /**
   * Take the Rust stores back from the native background runtime, bounded. LEGACY: only binaries
   * from before the shared node (`restartNode` absent) export it — on those the background runtime
   * built a node of its own, and opening the app after a background launch met `AlreadyOpen`.
   * Binaries with a node host have nothing to hand over: both halves hold leases on ONE node.
   */
  handOverNativeBackground?(timeoutMs: number): Promise<boolean>;
  /** LEGACY, iOS only: which half of the process owned the Rust stores before they were shared. */
  nativeNodeOwner?(): string;
  /**
   * Rebuild the node with new transport settings, keeping every holder's lease.
   *
   * Present exactly when the binary has a node host — so it doubles as that capability probe. A
   * rebind on such a binary MUST use it: `shutdown` + `createNode` there only returns this
   * context's lease and adopts the same node back (the background runtime's lease keeps it up),
   * so the new settings would never apply. The host also starts the new node before the
   * background runtime can start it from the stored (old) settings. OPTIONAL.
   */
  restartNode?(config?: TransportConfig): Promise<void>;
  /** The node host's view of who holds the node, for `device.health`. OPTIONAL. */
  nodeHostSnapshot?(): NodeHostSnapshot | null;
  /** Whether this phone reaches nobody, for `device.health` and the heal. OPTIONAL. */
  isolationStatus?(): IsolationStatus | null;
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
  /**
   * Every position envelope the native drain published since the last call, oldest first, with the
   * `seq` that went on the wire — and forget them. How a stretch published with no JS alive reaches
   * the own trail; the replica keeps only the latest fix per author. OPTIONAL: older binaries.
   */
  takeOwnPublished?(): Promise<{ seq: number; fix: NativeLocationFix }[]>;
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
   * Mirror each friend's X25519 receiving key (parallel lists, same order), so the native drain
   * can run §4.6 session recovery on a wake with no JS alive. The resync record is sealed to these
   * keys and the ratchet session does not carry them. Push alongside {@link setSharingRecipients},
   * for every friend, sharing and watch-only alike.
   *
   * OPTIONAL: absent on binaries built before native session recovery.
   */
  setRecipientKeys?(endpointsHex: string[], recvPublicsHex: string[]): Promise<void>;
  /**
   * Who the latest fix envelope was sealed for and who it left out, and why — recorded where the
   * sealing happens. `null` before this install has sealed anything. `device.health` reports it
   * as `ratchet.dropped*`; the JS row it replaces was only written by the JS publish path.
   *
   * OPTIONAL: absent on binaries built before native session recovery.
   */
  lastSealReport?(): Promise<{
    at: number;
    recipients: number;
    dropped: number;
    lapsed: number;
    noSession: number;
    other: number;
    /** One per friend left out. Absent on binaries that predate it. */
    droppedPeers?: RatchetDropped[];
  } | null>;
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
   * into its own local replica and reports success — iroh-docs broadcasts a local insert only to
   * the namespace's CURRENT live-sync neighbours, which a cold background wake usually has none
   * of yet. Two phones spent 2026-08-31 in exactly that state.
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
  /**
   * The last publish sequence number the native drain handed out, without advancing.
   *
   * The counter lives natively and only the drain advances it, durably, before the envelope it
   * numbers is sealed (`seq_store.rs`): expo-task-manager hands every headless callback a fresh JS
   * context, so a JS-side counter was duplicated along with every guard on it, and two envelopes
   * under one `author/seq` key is a payload lost to last-write-wins. OPTIONAL: absent on binaries
   * built before the native counter.
   */
  currentSeq?(): Promise<number>;
  /**
   * Raise the native counter to at least `floor`; resolves to whether it moved.
   *
   * Monotone, so it is safe to call repeatedly: this is both the one-time migration of the old
   * SecureStore value and the recovery path for an unreadable counter file. Raising can only skip
   * values, never re-issue them. OPTIONAL, as {@link currentSeq}.
   */
  seedSeq?(floor: number): Promise<boolean>;

  // ── Durable trail (iroh-docs) — see docs/social/ARCHITECTURE.md §5–6, §9 ────────────────────
  /**
   * Reconcile every replicated namespace so each author's current fix is up to date locally.
   *
   * `peerTickets` is every endpoint worth dialing for this pass: the trail stash when it is
   * enabled, and **every pool member**. Recovery is supposed to work "against C/D/A"
   * (ARCHITECTURE.md §1.3, §6), so a friend has to be a reachable source and not just the author
   * or the stash — with a single stash-only target, a device whose friend was offline could not
   * recover a fix that another friend was demonstrably holding. An empty list is valid and means
   * "reconcile with whatever the live engine already knows".
   *
   * There is no `sinceTs` and no backfill stream any more: each author's namespace holds ONE
   * overwritten slot (FORWARD-SECRECY.md §4.4), so there is no back-catalogue to bound or to
   * deliver incrementally. Read the result with {@link readLatest} once this resolves.
   */
  syncLatest(peerTickets: string[], traceparent?: string | null): Promise<void>;
  /**
   * Whether this binary refcounts the process-wide node instead of clobbering it.
   *
   * When true, a second `createNode` for the same identity ADOPTS the live node and `shutdown`
   * only tears it down on the last release — so a mounted app and a headless session can overlap
   * safely and the pre-`createNode` idle wait is unnecessary.
   *
   * OPTIONAL, and absence is the answer: a binary without it clobbers, so callers must keep
   * waiting. Guard with `typeof mod.nativeRuntimeAdoptsNode === 'function'`.
   */
  nativeRuntimeAdoptsNode?(): Promise<boolean>;
  /**
   * Read every author's CURRENT decrypted fix out of the local replica — at most one per author,
   * ours included. Replaces the old per-author range read: with a single last-write-wins slot per
   * author there is no range left to ask for, so this is one call instead of a loop.
   */
  readLatest(): Promise<NativeRatchetEvent[]>;

  // ── ratchet sessions + §4.6 recovery ────────────────────────────────────────────────────────
  //
  // There is deliberately no `beginSession` / `completeSession` here. A session is bootstrapped by
  // the SAS bump itself, from ephemerals that are signed, connection-pinned, and folded into the
  // figure the two humans compare — so there is no JS-callable seam that could root a session from
  // anything weaker (FORWARD-SECRECY.md §4.2, §4.6's "no automatic downgrade of any kind"). What
  // JS drives is recovery, and only recovery.
  //
  // The restart itself runs inside the native drain (`restart::run_pass`); JS only reads health and
  // erases sessions. All OPTIONAL: guard with `typeof mod.<name> === 'function'`.

  /**
   * Whether this peer's session needs a §4.6 restart: a run of distinct envelopes we could not
   * open, a record we cannot read, a lapsed peer, or — when we follow — no sending chain for an
   * hour. `false` for a peer we simply have no session with: that is unpaired, which a restart
   * cannot fix and a re-pair can.
   */
  isDesynced?(peerEndpointHex: string): Promise<boolean>;
  /**
   * How many restarts have been installed with this peer in this process. Recovery that keeps
   * recovering is not recovering — past a small number, surface "re-pair with this friend".
   */
  resyncCount?(peerEndpointHex: string): Promise<number>;
  /** Forget a peer's ratchet session entirely — unfriend, or revoke. */
  forgetSession?(peerEndpointHex: string): Promise<void>;
  /**
   * Forget the FINISHED pairing sessions with a peer, returning how many were dropped.
   *
   * The companion to {@link forgetSession}: that erases the ratchet state of what the friendship
   * became, this erases the pairing record of how it began (their recv key, SAS material and
   * tickets). Live sessions are spared — a pair in progress is the user's to cancel.
   *
   * Optional: absent on binaries built before the export existed.
   */
  forgetPairSessions?(peerEndpointHex: string): Promise<number>;

  /** Explicitly drop durable entries older than `olderThanTs`. */
  pruneTrail(olderThanTs: number): Promise<void>;
  /**
   * A shareable docs **read-ticket** granting replication of our trail namespace — the swarm-join
   * half of a grant (the decrypt half is registering the friend's recvPub). Goes in the contact card.
   */
  docTicket(): Promise<string>;
  /**
   * Import a friend's docs read-ticket (their card's `docTicket`) so we replicate their trail
   * namespace and can recover their missed fixes via {@link syncLatest}. Grants replication only;
   * reading still needs our per-recipient wrap in each envelope. See ARCHITECTURE §6.
   */
  importDocTicket(ticket: string): Promise<void>;
  /**
   * Stop replicating a removed friend's trail (or profile) namespace, and stop reopening it on
   * every start. Pass the ticket the friend was added with. Resolves whether it was replicated.
   * Optional: absent on binaries built before the namespace book.
   */
  forgetDocTicket?(ticket: string): Promise<boolean>;
  forgetProfileTicket?(ticket: string): Promise<boolean>;
  /**
   * Grant the trail stash replication of our trail and every friend's, from native. Resolves at
   * once; the grant itself runs on a native task. Optional: absent on binaries that predate it,
   * where the JS HTTP grant is still the only one.
   */
  grantStash?(): Promise<void>;

  // ── Repeaters (docs/social/REPEATERS.md). Optional: absent on binaries that predate them. ───
  /**
   * Claim the repeater whose console printed `link` (`streetcryptid-repeater:…`) into the roster
   * this phone owns, creating it (`open` or invite-only) if there is none. `carryMe` also enrols
   * this phone. Rejects unless the repeater's signed cert names this phone, this roster and the
   * machine that answered.
   */
  claimRepeater?(link: string, open: boolean, carryMe: boolean): Promise<NativeRepeaterClaim>;
  /** Every roster this phone knows. */
  repeaterRosters?(): Promise<NativeRepeaterRoster[]>;
  /** Have a roster carry our trail, or stop. Resolves whether it carries us now. */
  setRepeaterCarried?(rosterId: string, carry: boolean): Promise<boolean>;
  /** Owner only: who may enrol from now on (`open`, or invite-only). Never retroactive. */
  setRepeaterPolicy?(rosterId: string, open: boolean): Promise<void>;
  /** Owner only: stop carrying `member`'s trail. Sticky until someone invites them again. */
  removeRepeaterMember?(rosterId: string, member: string): Promise<void>;
  /** Owner only: take a machine out of the roster. */
  removeRepeater?(rosterId: string, repeaterId: string): Promise<void>;
  /** Ask every repeater that carries us to carry our namespaces now. Resolves at once. */
  grantRepeaters?(): Promise<void>;

  // ── Developer telemetry (dev/preview builds; see src/features/dev/telemetry in the app) ─────
  /**
   * Point the native core's OTLP exporter (traces + logs) at a collector, or disable with an
   * empty endpoint. Returns whether export is active — `false` when the binary was built without
   * the `otel` feature (store builds). OPTIONAL: absent on web and on iOS bindings generated
   * before this API existed (Swift bindings only regenerate on macOS), so callers must guard.
   */
  configureTelemetry?(endpoint: string, instanceId: string): Promise<boolean>;
  /** Flush buffered native telemetry. Headless contexts call this before the OS freezes them. */
  flushTelemetry?(): Promise<void>;
  /**
   * Flush, then send the core's whole offline spool now, ignoring its backoff (the debug screen's
   * push button). OPTIONAL: absent on web and on binaries built before it existed.
   */
  pushTelemetryNow?(): Promise<NativeTelemetryPush>;
  /**
   * Drain the OS-reported crash / hang / CPU / disk diagnostics recorded since the last call,
   * each a JSON object string (see `MetricKitDiagnostics.swift`).
   *
   * The only account of how a previous run ENDED — everything the app records itself stops at the
   * moment it stops. OPTIONAL: iOS only, and absent on binaries built before this existed, so
   * callers must guard on its presence.
   */
  takeCrashDiagnostics?(): Promise<string[]>;

  // ── Profiles — see docs/social/ARCHITECTURE.md §3 ──────────────────────────────────────────
  /**
   * Sign + publish our profile to the dedicated profile namespace. Returns the new monotonic,
   * wall-clock-anchored epoch (ms).
   */
  publishProfile(
    handle: string,
    cryptidName: string,
    sigil: string,
    color: string
  ): Promise<number>;
  /** A shareable **read**-ticket for our profile namespace (also exchanged inside a pairing Accept). */
  profileTicket(): Promise<string>;
  /** Import a friend's profile read-ticket and begin replicating + live-syncing their profile. */
  importProfileTicket(ticket: string): Promise<void>;
  /** Read the newest verified profile for `endpointIdHex` (self or friend), or `null` if absent. */
  readProfile(endpointIdHex: string): Promise<ProfileView | null>;
  /** Drain profile-update events surfaced by docs live-sync since the last poll. */
  pollProfileEvents(): Promise<ProfileView[]>;

  // ── Bilateral pairing (`streetcryptid/pair/4`) — ARCHITECTURE.md §4 ─────────────────────────
  /** Set whether we accept invite-less **nearby** (e.g. BLE) pairing Hellos. */
  setPairingReady(ready: boolean): Promise<void>;
  /** Whether invite-less nearby pairing is currently accepted. */
  pairingReady(): Promise<boolean>;
  /**
   * Mint a one-shot, time-limited invite carrying only immutable bootstrap material. Returns the
   * invite fields plus the opaque `scpair2:<base64url>` {@link PairInviteWithToken.token} for QR / links.
   */
  createPairInvite(ttlSecs: number): Promise<PairInviteWithToken>;
  /**
   * Withdraw an invite this node minted, given the opaque `scpair2:` token it was shared as.
   * Resolves true when the invite was still outstanding. A token already handed to someone cannot
   * be recalled, so this is what makes cancelling a shared link mean anything: the issuer stops
   * honouring it and redemption is refused as though the invite id were forged. Idempotent.
   *
   * OPTIONAL: absent on web and on binaries built before invite revocation existed, so callers
   * must guard. A phone can be running an older binary than the JS bundle.
   */
  revokePairInvite?(token: string): Promise<boolean>;
  /** Begin an invite-based pair from a decoded {@link PairInvite}. Returns the session id (hex). */
  initiatePair(invite: PairInvite): Promise<string>;
  /** Begin an invite-based pair from an opaque `scpair2:` token. Returns the session id (hex). */
  initiatePairByToken(token: string): Promise<string>;
  /** Begin an invite-less **nearby** pair with a BLE-discovered peer. Returns the session id (hex). */
  initiatePairNearby(peerEndpointIdHex: string): Promise<string>;
  /**
   * Reject/cancel a pending pairing session (`accept === false`). `accept === true` is **rejected
   * by the native layer** until the local SAS visual check is confirmed — use
   * {@link submitPairChoice} / {@link confirmPairDisplay} to advance a pair instead. A result is
   * emitted only after BOTH sides clear the SAS gate and accept.
   */
  respondPair(sessionIdHex: string, accept: boolean): Promise<void>;
  /**
   * The active SAS visual challenge for a session, or `null` if the gate isn't live (not yet
   * verified, complete/terminal, or expired). It remains available after this phone confirms so
   * the UI can preserve the waiting state.
   */
  pairSasChallenge(sessionIdHex: string): Promise<SasChallenge | null>;
  /**
   * Picker action: submit the chosen figure index. A correct choice latches the local SAS and
   * sends `Accept`; a wrong / late choice is terminal (no retry in the same session).
   */
  submitPairChoice(sessionIdHex: string, chosenIndex: number): Promise<void>;
  /**
   * Displayer action: confirm whether the other human matched the shown figure. `true` latches the
   * local SAS and sends `Accept`; `false` (or a late action) is terminal.
   */
  confirmPairDisplay(sessionIdHex: string, matched: boolean): Promise<void>;
  /** Cancel a pairing under SAS verification — terminal (requires a fresh attempt). */
  cancelPair(sessionIdHex: string): Promise<void>;
  /** Drain pairing events (pending requests, SAS-verifying, peer responses, ready, rejects). */
  pollPairEvents(): Promise<PairEvent[]>;
  /** Inspect a single session's current state, or `null` if unknown. */
  pairState(sessionIdHex: string): Promise<PairStateRecord | null>;
  /** List all known pairing sessions. */
  listPairSessions(): Promise<PairStateRecord[]>;
  /** The completed-pair result for a session (enriched with the peer's profile), or `null`. */
  pairResult(sessionIdHex: string): Promise<PairResult | null>;
  /** Encode a {@link PairInvite} into an opaque `scpair2:<base64url>` token for QR / links. */
  encodePairInvite(invite: PairInvite): Promise<string>;
  /** Decode an opaque `scpair2:<base64url>` token back into a {@link PairInvite}. */
  decodePairInvite(token: string): Promise<PairInvite>;

  /**
   * The EndpointId (hex) inside an endpoint ticket — a pure decode, no node required.
   *
   * Optional: absent in Expo Go, on web, and on installed binaries built before it existed. Guard
   * with `typeof … === 'function'`; a caller that cannot resolve a ticket simply cannot name that
   * device, which every consumer already has to handle.
   */
  endpointIdFromTicket?(ticket: string): Promise<string>;

  /** Local addresses plus live path usage for the requested peer EndpointIds. */
  transportDiagnostics(peerEndpointIdsHex: string[]): Promise<TransportDiagnostics>;

  /**
   * What this device's durable replica can SERVE, one record per author present in it.
   *
   * OPTIONAL: an installed dev client may predate the export.
   */
  trailReplicaStatus?(): Promise<TrailReplicaAuthor[]>;

  // ── BLE status (Android/Apple only; honest stub elsewhere) — ARCHITECTURE.md §2 ────────────
  /** Whether a BLE transport is wired into this node's endpoint on this platform. */
  bleAvailable(): Promise<boolean>;
  /** Honest BLE capability report combined with the app-level pairing-ready gate. */
  bleCapabilities(): Promise<BleCapabilities>;
  /** Snapshot of nearby BLE peers surfaced by the transport (empty on host / when unavailable). */
  nearbyBlePeers(): Promise<BlePeer[]>;
  /** Refresh BLE discovery and resolve the strongest unambiguous nearby streetCryptid signal. */
  resolveBumpPeer(timeoutMs: number): Promise<BumpResolution>;
  /** Passive proximity hint: has this peer's BLE advertisement been seen this session? */
  bleHasScanHint(endpointIdHex: string): Promise<boolean>;
  /** Power/authorization state of the Bluetooth radio, independent of the transport. */
  bluetoothRadioState?(): Promise<BluetoothRadioState>;
}
