/** Shared domain types for the friend location-sharing feature. */

/** Lowercase hex string (no `0x` prefix). */
export type Hex = string;

/** A decrypted location fix. */
/**
 * What the sender says about the envelope a position arrived in.
 *
 * Mirrors `FIX_STATE_*` in `modules/iroh-location/rust/src/lib.rs`, which is the source of truth;
 * the numbers are on the wire and must stay in step with it.
 *
 * Numbers rather than a string union because that is what is transmitted: a value from a newer
 * peer that we do not recognise has to degrade to "this sender says something we cannot read" —
 * which behaves like a sender that says nothing — rather than fail the payload.
 */
/** The position is fresh: it passed the sender's confidence gate on that wake. */
export const FIX_STATE_LIVE = 1;
/**
 * The sender has parked. The position is the anchor it settled on, and it will not advance until
 * they move again — so silence after this envelope is EXPLAINED, not evidence of death.
 *
 * This is the one that earns its byte. Liveness cannot be inferred from contact continuing,
 * because on iOS it does not: parked publishing rides on `BGProcessing` wakes the OS grants a few
 * times a day, and the measured gap between contacts is p50 5 min but p90 92 min with a 17-hour
 * maximum, on phones that were working the whole time.
 */
export const FIX_STATE_PARKED = 2;
/**
 * The sender is not parked, but nothing passed its quality gate — indoors, a tunnel, reduced
 * accuracy. The position is the last accepted one and they may well be moving.
 *
 * On the wire this is byte-identical to {@link FIX_STATE_PARKED} in every respect except this
 * field, which is the point: "parked at the pub" and "somewhere on the Underground" look the same
 * from outside and need different sentences.
 */
export const FIX_STATE_NO_FIX = 3;

export interface LocationFix {
  lat: number;
  lon: number;
  accuracyM: number;
  headingDeg: number;
  /**
   * ms since epoch — when the POSITION was measured.
   *
   * Deliberately does NOT advance when a parked phone republishes this position on cadence, so it
   * is honest about how old the dot is. That also means it says nothing about whether the sender
   * is still running: see {@link publishedDeltaS}.
   */
  ts: number;
  /** One of `FIX_STATE_*`. Absent ⇒ the sender predates the field. */
  state?: number;
  /** Seconds between {@link ts} and the moment the sender sealed the envelope. */
  publishedDeltaS?: number;
}

/**
 * The public identity a device shares to be added as a friend. Exchanged out-of-band via
 * QR code / `streetcryptid://contact?…` deep link. See docs/social/ARCHITECTURE.md §3.
 */
export interface ContactCard {
  /** ed25519 EndpointId (hex) — the envelope author + topic seed. */
  endpointId: Hex;
  /** `@handle`. */
  handle: string;
  /** ASCII "cryptid" sigil (see DESIGN.md). */
  sigil: string;
  /** Human-readable name for the selected/custom ASCII form. */
  cryptidName?: string;
  /** Six-digit RGB profile signal color chosen by the friend. */
  color?: string;
  /** X25519 receiving public key (hex) — used to wrap fixes for this device. */
  recvPublic: Hex;
  /** iroh endpoint ticket (dialing info) for bootstrap. */
  ticket: string;
  /**
   * iroh-docs read-ticket granting replication of this device's durable trail namespace — the
   * swarm-join half of a sharing grant (the decrypt half is {@link recvPublic}). Optional for
   * backward compatibility with live-only cards; absent ⇒ live gossip only, no offline recovery.
   * See docs/social/ARCHITECTURE.md §6.
   */
  docTicket?: string;
}

/**
 * How a friend entered the pool.
 *
 * - `legacy`  — added out-of-band via a `streetcryptid://contact?…` card (pre-pairing).
 * - `nearby`  — invite-less BLE nearby pairing.
 * - `invite`  — a scanned/opened `streetcryptid:///social?token=…` invite link.
 * - `code`    — a raw `scpair1:` token pasted by hand, or a short human pairing code redeemed via
 *   the encrypted pairing mailbox (see `core/pairing-code.ts`).
 */
export type PairingMethod = 'legacy' | 'nearby' | 'invite' | 'code';

/**
 * A friend is a contact card we've added to our pool, optionally enriched with bilateral-pairing
 * provenance and a replicating profile namespace. Every added field is optional so records stored
 * before pairing existed (plain {@link ContactCard}s) keep loading unchanged.
 */
export interface Friend extends ContactCard {
  /** iroh-docs read-ticket for the friend's profile namespace (from a completed pair). */
  profileTicket?: string;
  /**
   * Monotonic publish epoch (ms) of the verified profile we last merged in. Guards profile
   * updates so a stale event can never clobber newer identity fields. Absent ⇒ none merged yet.
   */
  profileEpoch?: number;
  /** When the bilateral pair completed (ms since epoch). */
  pairedAt?: number;
  /** How this friend was added. Absent on legacy contact-card records. */
  pairingMethod?: PairingMethod;
}

/** This device's own identity (public parts) for rendering / sharing. */
export interface SelfIdentity {
  endpointId: Hex;
  handle: string;
  sigil: string;
  cryptidName?: string;
  color?: string;
  recvPublic: Hex;
}

/**
 * How a fix reached THIS device — the last hop in, not a claim about the author's own link.
 * Gossip is epidemic, so a live fix may have been forwarded by any neighbour in the swarm.
 *
 * - `relay`  — live, arrived over an iroh relay path.
 * - `direct` — live, arrived over a direct (routable IP) path.
 * - `lan`    — live, arrived over a private/link-local IP path.
 * - `ble`    — live, arrived over the BLE (custom) transport.
 * - `live`   — live gossip, last hop unknown (older binaries; no path info).
 * - `docs`   — recovered by range-reconciliation with a peer's durable trail.
 * - `stash`  — recovered from the trail stash mirror.
 * - `sync`   — recovered from the durable trail, source unknown.
 */
export type FixTransport = 'relay' | 'direct' | 'lan' | 'ble' | 'live' | 'docs' | 'stash' | 'sync';

/** An inbound decrypted fix from a friend. */
export interface IncomingFix {
  author: Hex;
  seq: number;
  fix: LocationFix;
  receivedAt: number;
  /** True when recovered via durable range-reconciliation (iroh-docs) rather than live gossip. */
  backfill?: boolean;
  /**
   * The last hop this fix took into this device. Absent ⇒ unknown, and the trail store falls back
   * to the coarse live/sync split implied by {@link backfill}.
   */
  via?: FixTransport;
}

export type RatchetAckKind = 'fix' | 'null';
export type RatchetAckSource = 'live' | 'durable';

export interface RatchetAck {
  seq: number;
  /** When this device successfully opened the friend's response. */
  receivedAt: number;
  source: RatchetAckSource;
}

/** Latest signed return-envelope activity for one friend. */
export interface RatchetActivity {
  fix: RatchetAck | null;
  null: RatchetAck | null;
}
