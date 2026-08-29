/** Shared domain types for the friend location-sharing feature. */

/** Lowercase hex string (no `0x` prefix). */
export type Hex = string;

/** A decrypted location fix. */
export interface LocationFix {
  lat: number;
  lon: number;
  accuracyM: number;
  headingDeg: number;
  /** ms since epoch */
  ts: number;
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
 * - `code`    — a raw `scpair2:` token pasted by hand, or a short human pairing code redeemed via
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
