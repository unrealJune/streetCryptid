import { NativeModule, registerWebModule } from 'expo-modules-core';
import { Image } from 'react-native';

import initWasm, {
  derive_topic_hex,
  WasmLocationNode,
  type WasmLocationSubscription,
} from '../web/iroh_location_wasm.js';
import { requireIrohRelayRuntimeConfig } from './relay-config';
import type {
  IrohLocationApi,
  IrohLocationEvents,
  BleCapabilities,
  BlePeer,
  BumpResolution,
  NativeIncomingFix,
  NativeLocationFix,
  NodeKeys,
  PairEvent,
  PairInvite,
  PairInviteWithToken,
  PairResult,
  PairStateRecord,
  ProfileView,
  SasChallenge,
} from './IrohLocation.types';

const ID_KEY = 'sc.iroh.identitySecret';
const RECV_KEY = 'sc.iroh.recvSecret';
const wasmAsset = require('../web/iroh_location_wasm_bg.wasm') as number | string;

type WasmEvent =
  | { type: 'fix'; author: string; seq: number; fix: NativeLocationFix; backfill: boolean }
  | { type: 'opaque'; author: string; seq: number }
  | { type: 'status'; status: string }
  | { type: 'sync'; author: string; status: string; recovered?: number };

interface StoredSubscription {
  sub: WasmLocationSubscription;
  abort: AbortController;
}

let wasmReady: Promise<void> | null = null;

/** A clear, consistent error for explicit pairing/BLE actions that the web (WASM) build can't do. */
function pairingUnsupported(method: string): Error {
  return new Error(
    `IrohLocation.${method} is unavailable on web: BLE and bilateral pairing require a native ` +
      'dev-client build (Android/iOS). Location sharing and durable trail still work on web.'
  );
}

async function ensureWasm(): Promise<void> {
  const wasmUri =
    typeof wasmAsset === 'string' ? wasmAsset : Image.resolveAssetSource(wasmAsset)?.uri;
  if (!wasmUri) throw new Error('Unable to resolve IrohLocation WASM asset.');
  wasmReady ??= initWasm(wasmUri).then(() => undefined);
  await wasmReady;
}

function storageGet(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // Best effort: private browsing or disabled storage makes web keys ephemeral.
  }
}

export class IrohLocationNativeModule
  extends NativeModule<IrohLocationEvents>
  implements IrohLocationApi
{
  private node: WasmLocationNode | null = null;
  private readonly subscriptions = new Map<string, StoredSubscription>();
  private nextSubscription = 1;

  async createNode(
    identitySecretHex: string | null,
    recvSecretHex: string | null
  ): Promise<NodeKeys> {
    await ensureWasm();
    await this.shutdown();
    const identity = identitySecretHex ?? storageGet(ID_KEY);
    const recv = recvSecretHex ?? storageGet(RECV_KEY);
    this.node = new WasmLocationNode(identity, recv);

    const keys: NodeKeys = {
      endpointId: this.node.endpoint_id(),
      identitySecret: this.node.identity_secret(),
      recvSecret: this.node.recv_secret(),
      recvPublic: this.node.recv_public(),
    };
    storageSet(ID_KEY, keys.identitySecret);
    storageSet(RECV_KEY, keys.recvSecret);
    return keys;
  }

  async start(): Promise<void> {
    await ensureWasm();
    const { relayUrls, authToken } = requireIrohRelayRuntimeConfig();
    await this.requireNode().start(relayUrls, authToken);
  }

  async shutdown(): Promise<void> {
    const subscriptionIds = [...this.subscriptions.keys()];
    await Promise.all(subscriptionIds.map((id) => this.unsubscribe(id)));
    this.node?.free();
    this.node = null;
  }

  async ticket(): Promise<string> {
    await ensureWasm();
    return this.requireNode().ticket();
  }

  async deriveTopic(authorEndpointIdHex: string): Promise<string> {
    await ensureWasm();
    return derive_topic_hex(authorEndpointIdHex);
  }

  async subscribe(topicHex: string, bootstrapTickets: string[]): Promise<string> {
    await ensureWasm();
    const sub = await this.requireNode().subscribe(topicHex, bootstrapTickets);
    const id = `web-${this.nextSubscription++}`;
    const abort = new AbortController();
    this.subscriptions.set(id, { sub, abort });
    this.emit('onStatus', { subscriptionId: id, status: 'subscribed' });
    void this.pumpSubscription(id, sub.receiver(), abort.signal);
    return id;
  }

  async publish(
    subscriptionId: string,
    seq: number,
    epoch: number,
    fix: NativeLocationFix,
    recipientsHex: string[]
  ): Promise<void> {
    await ensureWasm();
    const sub = this.subscriptions.get(subscriptionId)?.sub;
    if (!sub) throw new Error(`Unknown IrohLocation subscription: ${subscriptionId}`);
    await sub.publish(seq, epoch, fix, recipientsHex);
  }

  async unsubscribe(subscriptionId: string): Promise<void> {
    const stored = this.subscriptions.get(subscriptionId);
    if (!stored) return;
    this.subscriptions.delete(subscriptionId);
    stored.abort.abort();
    stored.sub.close();
    this.emit('onStatus', { subscriptionId, status: 'unsubscribed' });
  }

  // ── Durable trail (iroh-docs) — in-memory replica over relay-reachable connections ──────────
  // The browser (WASM) path is relay-only and has no filesystem, so the iroh-docs replica and its
  // iroh-blobs content store are BOTH in-memory. The sealed envelope bytes are identical to native
  // (shared rust/src/crypto.rs), so a web peer's durable entries interoperate with native peers and
  // per-recipient revocation carries over. Durability caveat: the trail is ephemeral — it is lost on
  // page reload / tab close. Range reconciliation still recovers missed fixes within a session and
  // across peers. See modules/iroh-location/README.md §5.
  async docsWrite(
    subscriptionId: string,
    seq: number,
    epoch: number,
    fix: NativeLocationFix,
    recipientsHex: string[]
  ): Promise<void> {
    await ensureWasm();
    await this.requireNode().docs_write(subscriptionId, seq, epoch, fix, recipientsHex);
  }

  async syncTrail(sinceTs: number, peerTicket: string | null): Promise<void> {
    await ensureWasm();
    await this.requireNode().sync_trail(sinceTs, peerTicket ?? undefined);
  }

  async readTrail(author: string, sinceTs: number): Promise<NativeIncomingFix[]> {
    await ensureWasm();
    return (await this.requireNode().read_trail(author, sinceTs)) as NativeIncomingFix[];
  }

  async pruneTrail(olderThanTs: number): Promise<void> {
    await ensureWasm();
    await this.requireNode().prune_trail(olderThanTs);
  }

  async docTicket(): Promise<string> {
    await ensureWasm();
    return this.requireNode().doc_ticket();
  }

  async importDocTicket(ticket: string): Promise<void> {
    await ensureWasm();
    await this.requireNode().import_doc_ticket(ticket);
  }

  // ── Profiles / pairing / BLE: unsupported on the web (WASM) build ────────────────────────────
  // The browser path is relay-only with no BLE radio and no profile/pairing protocol wired into the
  // WASM node. To keep the web build and existing location sharing working, read/poll/status calls
  // degrade gracefully (empty results, `false`, `null`) so normal service initialization never
  // throws. Only explicit pairing actions (mint/initiate/respond/encode) throw a clear error.

  async publishProfile(
    _handle: string,
    _cryptidName: string,
    _sigil: string,
    _color: string
  ): Promise<number> {
    // Profile sync is unavailable on web; report 0 (no epoch published) instead of throwing.
    return 0;
  }

  async profileTicket(): Promise<string> {
    return '';
  }

  async importProfileTicket(_ticket: string): Promise<void> {
    // No-op: web has no profile namespace to replicate into.
  }

  async readProfile(_endpointIdHex: string): Promise<ProfileView | null> {
    return null;
  }

  async pollProfileEvents(): Promise<ProfileView[]> {
    return [];
  }

  async setPairingReady(_ready: boolean): Promise<void> {
    // No-op: nearby pairing is unavailable on web.
  }

  async pairingReady(): Promise<boolean> {
    return false;
  }

  async createPairInvite(_ttlSecs: number): Promise<PairInviteWithToken> {
    throw pairingUnsupported('createPairInvite');
  }

  async initiatePair(_invite: PairInvite): Promise<string> {
    throw pairingUnsupported('initiatePair');
  }

  async initiatePairByToken(_token: string): Promise<string> {
    throw pairingUnsupported('initiatePairByToken');
  }

  async initiatePairNearby(_peerEndpointIdHex: string): Promise<string> {
    throw pairingUnsupported('initiatePairNearby');
  }

  async respondPair(_sessionIdHex: string, _accept: boolean): Promise<void> {
    throw pairingUnsupported('respondPair');
  }

  async pairSasChallenge(_sessionIdHex: string): Promise<SasChallenge | null> {
    // A read/poll call: degrade gracefully (no SAS gate on web) so service polling never throws.
    return null;
  }

  async submitPairChoice(_sessionIdHex: string, _chosenIndex: number): Promise<void> {
    throw pairingUnsupported('submitPairChoice');
  }

  async confirmPairDisplay(_sessionIdHex: string, _matched: boolean): Promise<void> {
    throw pairingUnsupported('confirmPairDisplay');
  }

  async cancelPair(_sessionIdHex: string): Promise<void> {
    throw pairingUnsupported('cancelPair');
  }

  async pollPairEvents(): Promise<PairEvent[]> {
    return [];
  }

  async pairState(_sessionIdHex: string): Promise<PairStateRecord | null> {
    return null;
  }

  async listPairSessions(): Promise<PairStateRecord[]> {
    return [];
  }

  async pairResult(_sessionIdHex: string): Promise<PairResult | null> {
    return null;
  }

  async encodePairInvite(_invite: PairInvite): Promise<string> {
    throw pairingUnsupported('encodePairInvite');
  }

  async decodePairInvite(_token: string): Promise<PairInvite> {
    throw pairingUnsupported('decodePairInvite');
  }

  async bleAvailable(): Promise<boolean> {
    return false;
  }

  async bleCapabilities(): Promise<BleCapabilities> {
    return {
      available: false,
      activeScanToggle: false,
      rssi: false,
      discoveryRefresh: false,
      pairingReady: false,
    };
  }

  async nearbyBlePeers(): Promise<BlePeer[]> {
    return [];
  }

  async resolveBumpPeer(_timeoutMs: number): Promise<BumpResolution> {
    return {
      status: 'unavailable',
      endpointId: null,
      deviceId: null,
      rssi: null,
      peerCount: 0,
      detail: 'BLE Bump pairing is unavailable in the browser.',
    };
  }

  async bleHasScanHint(_endpointIdHex: string): Promise<boolean> {
    return false;
  }

  private requireNode(): WasmLocationNode {
    if (!this.node) {
      throw new Error('IrohLocation web node has not been created. Call createNode() first.');
    }
    return this.node;
  }

  private async pumpSubscription(
    subscriptionId: string,
    stream: ReadableStream<WasmEvent>,
    signal: AbortSignal
  ): Promise<void> {
    const reader = stream.getReader();
    try {
      while (!signal.aborted) {
        const next = await reader.read();
        if (next.done) break;
        const event = next.value;
        if (event.type === 'fix') {
          this.emit('onFix', {
            author: event.author,
            seq: event.seq,
            fix: event.fix,
            backfill: event.backfill,
          });
        } else if (event.type === 'opaque') {
          this.emit('onOpaque', { author: event.author, seq: event.seq });
        } else if (event.type === 'sync') {
          this.emit('onSync', {
            author: event.author,
            status: event.status,
            recovered: event.recovered,
          });
        } else if (event.type === 'status') {
          this.emit('onStatus', { subscriptionId, status: event.status });
        }
      }
    } catch (error) {
      if (!signal.aborted) {
        this.emit('onStatus', { subscriptionId, status: `error: ${String(error)}` });
      }
    } finally {
      reader.releaseLock();
    }
  }
}

const module = registerWebModule(
  IrohLocationNativeModule,
  'IrohLocation'
) as unknown as IrohLocationNativeModule;

export function tryGetIrohLocation(): IrohLocationNativeModule {
  return module;
}

export function getIrohLocation(): IrohLocationNativeModule {
  return module;
}
