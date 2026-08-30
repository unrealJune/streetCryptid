/**
 * JS-facing type contract for the native `IrohLocation` Expo module. These types must
 * match what the Swift/Kotlin `IrohLocationModule` exposes (see the ios/ + android/
 * sources). Keys cross the bridge as lowercase hex strings.
 */

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
  /** ms since epoch */
  ts: number;
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
export interface TransportConfig {
  relay: boolean;
  ip: boolean;
  ble: boolean;
}

/**
 * The last hop a fix took INTO this device — never a claim about the author's own link, because
 * gossip is epidemic and the stash is a mirror.
 *
 * `relay` | `direct` | `lan` | `ble` are live gossip paths; `live` means live but with no active
 * path to report; `docs` / `stash` mean the fix was recovered from the durable trail.
 */
export type FixVia = 'relay' | 'direct' | 'lan' | 'ble' | 'live' | 'docs' | 'stash';

export interface OnFixEvent {
  author: string;
  seq: number;
  fix: NativeLocationFix;
  /**
   * True when this fix arrived via durable range-reconciliation (iroh-docs catch-up) rather than
   * the live gossip path — lets the app distinguish backfill from live updates. Absent ⇒ live.
   */
  backfill?: boolean;
  /** How the fix reached this device. Absent on binaries built before per-fix transport labels. */
  via?: FixVia;
}

export interface OnOpaqueEvent {
  author: string;
  seq: number;
  /** `null` means a decrypted null-lane response; `opaque` means no payload was opened. */
  kind?: 'null' | 'opaque';
}

export interface OnStatusEvent {
  subscriptionId: string;
  status: string;
}

/** Emitted when a durable-trail sync (range reconciliation) starts/completes for an author. */
export interface OnSyncEvent {
  author: string;
  /** e.g. `started` | `completed` | `error`. */
  status: string;
  /** How many missed envelopes were pulled (on completion). */
  recovered?: number;
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
 *   §4.6 resync, which `isDesynced` will also be reporting.
 */
export type RatchetDropped = string;

/** A decrypted fix read back from the local durable replica (see {@link IrohLocationApi.readLatest}). */
export interface NativeIncomingFix {
  author: string;
  seq: number;
  fix: NativeLocationFix;
}

/** A decrypted v3 envelope from the durable replica, including the position-less null lane. */
export interface NativeRatchetEvent {
  author: string;
  seq: number;
  /** Sender timestamp from the signed envelope header. */
  ts?: number;
  /** Absent on installed native binaries from before null-lane activity was surfaced. */
  kind?: 'fix' | 'null';
  fix?: NativeLocationFix;
}

// ── Control messages (docs/social/ARCHITECTURE.md §9c) ──────────────────────────────────────

/** Ask a friend to switch to the real-time live cadence. */
export const CTL_KIND_LIVE_REQUEST = 1;
/** Withdraw an outstanding {@link CTL_KIND_LIVE_REQUEST}. */
export const CTL_KIND_LIVE_CANCEL = 2;

/**
 * A control message: the live-mode request channel. Sealed with the same envelope machinery as a
 * fix and written to the sender's own trail namespace under a `ctl/` key, so the stash and every
 * pool member it is not wrapped for see only ciphertext. Carries no location.
 *
 * There is exactly ONE control slot per author — writing supersedes the previous message — so a
 * receiver can only ever see the sender's current intent. `ts` + `nonce` are the replay defence:
 * a replica could withhold an update and keep serving a stale request, so receivers MUST check
 * freshness and dedupe by `nonce`. See `src/features/social/net/live-requests.ts`.
 */
export interface NativeControlMsg {
  /** Wire version of the payload (currently 1). */
  v: number;
  /** One of `CTL_KIND_*`. Unknown kinds must be ignored, not treated as an error. */
  kind: number;
  /** When the sender created it (ms since epoch). */
  ts: number;
  /** Requested live window in ms; the receiver clamps it and may always refuse. */
  ttlMs: number;
  /** 16 random bytes as lowercase hex — this message's dedup identity. */
  nonce: string;
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

// ── Bilateral pairing (`streetcryptid/pair/2`) — ARCHITECTURE.md §4 ──────────────────────────

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

/** A freshly minted invite plus its opaque, shareable `scpair1:<hex>` token (QR / deep link). */
export interface PairInviteWithToken extends PairInvite {
  /** Opaque encoded token (`scpair1:<hex>`) for QR codes / links. */
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
 * Deliberately NOT the same question as "have we seen this author's fix": the live gossip lane
 * writes app storage (`friend_latest`, the trail cache) too, and a fix that arrived that way never
 * enters the author's docs namespace — a pool member holds a READ ticket and cannot write there.
 * Reconciliation serves out of the replica, so only this answers "can this device relay author X".
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
export type IrohLocationEvents = {
  onFix: (event: OnFixEvent) => void;
  onOpaque: (event: OnOpaqueEvent) => void;
  onStatus: (event: OnStatusEvent) => void;
  onSync: (event: OnSyncEvent) => void;
};

/** The callable surface of the native module. */
export interface IrohLocationApi {
  /**
   * Create (or restore) the device node. Pass `null` to generate fresh keys; then
   * persist the returned secrets. Returns the stable ids + key material.
   */
  createNode(identitySecretHex: string | null, recvSecretHex: string | null): Promise<NodeKeys>;
  /** Bind the iroh endpoint + spawn the gossip router. Idempotent. */
  start(config?: TransportConfig): Promise<void>;
  /** Drop subscriptions and release the native endpoint/router. */
  shutdown(): Promise<void>;
  /** A shareable endpoint ticket (dialing info) for the contact card / bootstrap. */
  ticket(): Promise<string>;
  /** Derive the gossip topic (hex) for a given author's location stream. */
  deriveTopic(authorEndpointIdHex: string): Promise<string>;
  /** Join a topic; returns a subscription id. Inbound fixes arrive via `onFix`. */
  subscribe(topicHex: string, bootstrapTickets: string[]): Promise<string>;
  /**
   * Seal `fix` under each recipient's **ratchet session** and broadcast it on the topic
   * (envelope v3 — FORWARD-SECRECY.md §4.7).
   *
   * Recipients are **endpoint ids**, not receiving keys. A v3 wrap is keyed by the per-friend
   * Double Ratchet session, and sessions are keyed by endpoint id; the long-term receiving key
   * plays no part in the fix lanes any more. Passing recv keys here fails at the hex decode.
   *
   * Returns the recipients that were **left out** — see {@link RatchetDropped}. An empty array
   * means everyone asked for got a wrap.
   */
  publish(
    subscriptionId: string,
    seq: number,
    fix: NativeLocationFix,
    recipientEndpointsHex: string[],
    traceparent?: string | null
  ): Promise<RatchetDropped[]>;
  /** Leave a topic. */
  unsubscribe(subscriptionId: string): Promise<void>;
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
   * Takes the same toggles as {@link start}: the relay URLs and token are this bundle's build-time
   * `EXPO_PUBLIC_*` constants and are filled in by the module, so a device only learns them by
   * being told. Push on every launch and whenever a toggle changes.
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
  startNativeBackground?(): void;
  stopNativeBackground?(): void;
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
   * Persisted natively so an OS location callback can read it with no JS context alive. Push it on
   * every pool change. A momentarily stale list is safe in the only direction it can be stale: the
   * ratchet session remains the authority on who can decrypt, and this list only narrows who we
   * attempt to seal for.
   *
   * OPTIONAL: absent on binaries built before the native drain path.
   */
  setSharingRecipients?(recipientEndpointsHex: string[]): Promise<void>;
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
   * Broadcast a **null fix**: an envelope carrying an empty padded payload rather than a position
   * (FORWARD-SECRECY.md §4.1). Wrapped for the friends we do NOT share position with, so every
   * sharing relationship runs the protocol in both directions and a watcher's device contributes
   * fresh key material on the same cadence a sharer does.
   *
   * Identical to {@link publish} in signing, AAD binding, `seq` monotonicity and — because the
   * plaintext is padded to a fixed size class — ciphertext length, so the stash cannot tell the
   * two lanes apart. `ts` is the tick's timestamp; it rides in the signed header exactly as a
   * real fix's does.
   *
   * OPTIONAL: absent on iOS bindings generated before this API existed (Swift bindings only
   * regenerate on macOS), so callers must guard with `typeof mod.publishNull === 'function'`.
   */
  publishNull?(
    subscriptionId: string,
    seq: number,
    ts: number,
    watcherEndpointsHex: string[],
    traceparent?: string | null
  ): Promise<RatchetDropped[]>;

  // ── Durable trail (iroh-docs) — see docs/social/ARCHITECTURE.md §5–6, §9 ────────────────────
  /**
   * Seal `fix` for `recipientsHex` and write it to OUR docs namespace under `author/seq`, mirroring
   * the gossip broadcast. Same sealed bytes as {@link publish}, so per-recipient revocation carries
   * over (a dropped recipient replicates ciphertext it can't open). Typically called alongside
   * `publish` for every fix. `subscriptionId` ties the write to our own topic/namespace.
   */
  docsWrite(
    subscriptionId: string,
    seq: number,
    fix: NativeLocationFix,
    recipientEndpointsHex: string[],
    traceparent?: string | null
  ): Promise<RatchetDropped[]>;
  /**
   * Durable mirror of {@link publishNull}, written to a **separate** last-write-wins slot from the
   * fix lane. The two envelopes a tick produces are wrapped for disjoint recipient sets, so a
   * shared slot would make each silently supersede the other and a device that both shares and
   * watches could keep only one lane durable.
   *
   * Same write-then-push rule as {@link docsWrite}: call {@link pushTrail} afterwards or it never
   * leaves the device.
   *
   * OPTIONAL: same iOS bindgen caveat as {@link publishNull}.
   */
  docsWriteNull?(
    subscriptionId: string,
    seq: number,
    ts: number,
    watcherEndpointsHex: string[],
    traceparent?: string | null
  ): Promise<RatchetDropped[]>;
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
   * Push OUR trail namespace to `peerTickets` — the trail stash when it is enabled, and **every
   * pool member** — and wait for the exchange to finish.
   *
   * **This is what actually gets a published fix off the phone.** {@link docsWrite} only writes the
   * local replica; iroh-docs broadcasts a local insert only for namespaces that `start_sync` has
   * marked as syncing, and nothing but this call (or {@link syncLatest}) does that. A context that
   * publishes without it — every headless background wake — strands its envelopes on the device.
   * Call it after draining a batch.
   *
   * The peer list is the send-side mirror of {@link syncLatest} and it is what makes the pool
   * relay of ARCHITECTURE.md §1.3/§6 the normal flow: with a stash-only target an author's fix was
   * broadcast to the durable server and to nobody else, so a friend could only relay it if it
   * happened to dial the author during a reconciliation window. An empty list is valid and means
   * "broadcast to whatever the live engine already knows".
   *
   * OPTIONAL: absent on iOS bindings generated before this API existed (Swift bindings only
   * regenerate on macOS), so callers must guard with `typeof mod.pushTrail === 'function'`.
   */
  pushTrail?(peerTickets: string[], traceparent?: string | null): Promise<void>;
  /** Upload current opaque trail slots to the stash and wait for durable HTTP receipts. */
  uploadTrailContent?(baseUrl: string, psk: string | null): Promise<number>;
  /**
   * Seal `msg` for `recipientsHex` and write it to OUR namespace's single control slot,
   * superseding any previous control message from us (ARCHITECTURE §9c). `recipientsHex` is
   * normally one friend — a live request addressed to one person should be readable by exactly
   * that person.
   *
   * Call {@link pushTrail} afterwards, or it never leaves the device — the same
   * write-then-push rule as {@link docsWrite}.
   *
   * OPTIONAL: absent on iOS bindings generated before this API existed (Swift bindings only
   * regenerate on macOS), so callers must guard with `typeof mod.docsWriteControl === 'function'`.
   */
  docsWriteControl?(msg: NativeControlMsg, recipientsHex: string[]): Promise<void>;
  /**
   * Read `author`'s current control message from the local replica, if it is addressed to us.
   * Empty when there is none, when it is for someone else, or when the content has not
   * replicated yet — all indistinguishable, and all "nothing to act on".
   *
   * Freshness and dedup are the CALLER's responsibility; see {@link NativeControlMsg}.
   *
   * OPTIONAL: same iOS bindgen caveat as {@link docsWriteControl}.
   */
  readControl?(author: string): Promise<NativeControlMsg[]>;
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
  // All OPTIONAL: absent on iOS bindings generated before this API existed (Swift bindings only
  // regenerate on macOS), so callers must guard with `typeof mod.<name> === 'function'`.

  /**
   * Whether this peer's session needs §4.6 recovery — a run of signature-valid envelopes we could
   * not open, or state we cannot read at all. `false` for a peer we simply have no session with:
   * that is un-bootstrapped, which a resync cannot fix and a re-pair can.
   */
  isDesynced?(peerEndpointHex: string): Promise<boolean>;
  /**
   * How many resyncs we have driven with this peer. Recovery that keeps recovering is not
   * recovering — past a small number, surface "re-pair with this friend" instead of retrying.
   */
  resyncCount?(peerEndpointHex: string): Promise<number>;
  /**
   * Publish our half of a resync exchange, addressed to these friends' **receiving keys**.
   *
   * HPKE-sealed rather than ratcheted, necessarily: this is the message that re-establishes a
   * ratchet, so it cannot depend on one already working. Idempotent while the record is fresh,
   * re-minted once it ages past half its acceptance window. Returns our ephemeral's public half.
   */
  publishResync?(recipientRecvPubsHex: string[]): Promise<string>;
  /**
   * Look for this peer's resync record and restart the session from it, publishing our own half
   * first if we have not — so one call from each side completes the exchange without either
   * having to go first.
   *
   * Returns whether a session was installed. `false` covers "no record yet", "stale record", and
   * "already applied": all ordinary, none an error.
   */
  pollResync?(peerEndpointHex: string, peerRecvPubHex: string): Promise<boolean>;
  /** Drop our in-flight resync ephemeral once every peer has been restarted. */
  clearResync?(): Promise<void>;
  /** Forget a peer's ratchet session entirely — unfriend, or revoke. */
  forgetSession?(peerEndpointHex: string): Promise<void>;

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

  // ── Bilateral pairing (`streetcryptid/pair/2`) — ARCHITECTURE.md §4 ─────────────────────────
  /** Set whether we accept invite-less **nearby** (e.g. BLE) pairing Hellos. */
  setPairingReady(ready: boolean): Promise<void>;
  /** Whether invite-less nearby pairing is currently accepted. */
  pairingReady(): Promise<boolean>;
  /**
   * Mint a one-shot, time-limited invite carrying only immutable bootstrap material. Returns the
   * invite fields plus the opaque `scpair1:<hex>` {@link PairInviteWithToken.token} for QR / links.
   */
  createPairInvite(ttlSecs: number): Promise<PairInviteWithToken>;
  /** Begin an invite-based pair from a decoded {@link PairInvite}. Returns the session id (hex). */
  initiatePair(invite: PairInvite): Promise<string>;
  /** Begin an invite-based pair from an opaque `scpair1:<hex>` token. Returns the session id (hex). */
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
  /** Encode a {@link PairInvite} into an opaque `scpair1:<hex>` token for QR / links. */
  encodePairInvite(invite: PairInvite): Promise<string>;
  /** Decode an opaque `scpair1:<hex>` token back into a {@link PairInvite}. */
  decodePairInvite(token: string): Promise<PairInvite>;

  /** Local addresses plus live path usage for the requested peer EndpointIds. */
  transportDiagnostics(peerEndpointIdsHex: string[]): Promise<TransportDiagnostics>;

  /**
   * What this device's durable replica can SERVE, one record per author present in it.
   *
   * OPTIONAL for the same reason as {@link pushTrail}: iOS Swift bindings regenerate only on
   * macOS, so an installed dev client may predate the export.
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
