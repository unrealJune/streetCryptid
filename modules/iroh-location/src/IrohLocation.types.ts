/**
 * JS-facing type contract for the native `IrohLocation` Expo module. These types must
 * match what the Swift/Kotlin `IrohLocationModule` exposes (see the ios/ + android/
 * sources). Keys cross the bridge as lowercase hex strings.
 */

/** A raw location fix as it crosses the native bridge. */
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

export interface OnFixEvent {
  author: string;
  seq: number;
  fix: NativeLocationFix;
  /**
   * True when this fix arrived via durable range-reconciliation (iroh-docs catch-up) rather than
   * the live gossip path — lets the app distinguish backfill from live updates. Absent ⇒ live.
   */
  backfill?: boolean;
}

export interface OnOpaqueEvent {
  author: string;
  seq: number;
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

/** A decrypted fix read back from the local durable replica (see {@link IrohLocationApi.readTrail}). */
export interface NativeIncomingFix {
  author: string;
  seq: number;
  fix: NativeLocationFix;
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
  /** Seal `fix` for `recipientsHex` (X25519 pubkeys) and broadcast on the topic. */
  publish(
    subscriptionId: string,
    seq: number,
    epoch: number,
    fix: NativeLocationFix,
    recipientsHex: string[],
    traceparent?: string | null
  ): Promise<void>;
  /** Leave a topic. */
  unsubscribe(subscriptionId: string): Promise<void>;

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
    epoch: number,
    fix: NativeLocationFix,
    recipientsHex: string[],
    traceparent?: string | null
  ): Promise<void>;
  /**
   * Kick off range-based set reconciliation to recover envelopes we missed while offline. Recovered
   * fixes we can decrypt arrive as `onFix` with `backfill: true`; progress via `onSync`. `sinceTs`
   * bounds how far back to reconcile (0 = full history). `peerTicket` explicitly targets the trail
   * stash; null retains peer-only reconciliation.
   */
  syncTrail(sinceTs: number, peerTicket: string | null, traceparent?: string | null): Promise<void>;
  /** Read decrypted fixes for `author` (self or a friend) from the local replica, `fix.ts >= sinceTs`. */
  readTrail(author: string, sinceTs: number): Promise<NativeIncomingFix[]>;
  /** Explicitly drop durable entries older than `olderThanTs`. */
  pruneTrail(olderThanTs: number): Promise<void>;
  /**
   * A shareable docs **read-ticket** granting replication of our trail namespace — the swarm-join
   * half of a grant (the decrypt half is registering the friend's recvPub). Goes in the contact card.
   */
  docTicket(): Promise<string>;
  /**
   * Import a friend's docs read-ticket (their card's `docTicket`) so we replicate their trail
   * namespace and can recover their missed fixes via {@link syncTrail}. Grants replication only;
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
}
