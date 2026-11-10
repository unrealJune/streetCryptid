import { NativeModule, registerWebModule } from 'expo-modules-core';
import { Image } from 'react-native';

import initWasm, { WasmLocationNode } from '../web/iroh_location_wasm.js';
import { requireIrohRelayRuntimeConfig } from './relay-config';
import type {
  IrohLocationApi,
  IrohLocationEvents,
  BleCapabilities,
  BlePeer,
  BluetoothRadioState,
  BumpResolution,
  NativeIngestOutcome,
  NativeRatchetEvent,
  NodeKeys,
  PairEvent,
  PairInvite,
  PairInviteWithToken,
  PairResult,
  PairStateRecord,
  ProfileView,
  SasChallenge,
  TrailReplicaAuthor,
  TransportDiagnostics,
  TransportConfig,
} from './IrohLocation.types';

const ID_KEY = 'sc.iroh.identitySecret';
const RECV_KEY = 'sc.iroh.recvSecret';
const wasmAsset = require('../web/iroh_location_wasm_bg.wasm') as number | string;

/**
 * What every publish call answers on web: nothing was accepted, nothing was sealed.
 *
 * Resolved rather than thrown because the mounted heartbeat timer calls these on every platform,
 * and a throw there reads as a broken engine. An explicit "share now" still fails loudly, on the
 * rejection.
 */
const WEB_DOES_NOT_PUBLISH: NativeIngestOutcome = {
  accepted: false,
  rejection: 'web-no-publish',
  enqueued: 0,
  published: 0,
  pending: 0,
  slotsSkipped: 0,
  overflowDropped: 0,
  suspended: false,
};

let wasmReady: Promise<void> | null = null;

/** A clear, consistent error for explicit pairing/BLE actions that the web (WASM) build can't do. */
function pairingUnsupported(method: string): Error {
  return new Error(
    `IrohLocation.${method} is unavailable on web: BLE and bilateral pairing require a native ` +
      'dev-client build (Android/iOS).'
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

  async start(config: TransportConfig = { relay: true, ip: true, ble: true }): Promise<void> {
    if (!config.relay) {
      throw new Error('The browser node requires the relay transport.');
    }
    await ensureWasm();
    const { relayUrls, authToken } = requireIrohRelayRuntimeConfig();
    await this.requireNode().start(relayUrls, authToken);
  }

  async shutdown(): Promise<void> {
    this.node?.free();
    this.node = null;
  }

  async ticket(): Promise<string> {
    await ensureWasm();
    return this.requireNode().ticket();
  }

  // ── The web node replicates; it neither reads nor publishes ─────────────────────────────────
  //
  // Every fix is a v3 envelope sealed under a per-friend Double Ratchet (FORWARD-SECRECY.md).
  // A ratchet needs sequential state that survives a reload, and the WASM build has no
  // filesystem: its replica and blob store are in-memory and vanish with the tab, so ratchet state
  // kept there would rewind on every reload — key reuse, not a missing feature. Sessions are also
  // installed by pairing, which the web build cannot do. So the browser node holds and reconciles
  // namespaces (a development surface for the replica), and the publish calls below decline.
  //
  // Making web a real peer means a persistent store with the rollback problem solved. That is a
  // product decision, not a port.

  async ingestFix(): Promise<NativeIngestOutcome> {
    return { ...WEB_DOES_NOT_PUBLISH };
  }

  async heartbeatFix(): Promise<NativeIngestOutcome> {
    return { ...WEB_DOES_NOT_PUBLISH };
  }

  async publishIntroduction(): Promise<NativeIngestOutcome> {
    return { ...WEB_DOES_NOT_PUBLISH };
  }

  // ── Durable replica (iroh-docs) — in-memory, over relay-reachable connections ────────────────
  // Relay-only and lost on page reload / tab close. See modules/iroh-location/README.md §5.

  async syncLatest(peerTickets: string[], _traceparent?: string | null): Promise<void> {
    await ensureWasm();
    await this.requireNode().sync_latest(peerTickets);
  }

  async trailReplicaStatus(): Promise<TrailReplicaAuthor[]> {
    await ensureWasm();
    return (await this.requireNode().trail_replica_status()) as TrailReplicaAuthor[];
  }

  /** Always empty: opening a friend's envelope needs the ratchet session web does not hold. */
  async readLatest(): Promise<NativeRatchetEvent[]> {
    return [];
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

  async transportDiagnostics(_peerEndpointIdsHex: string[]): Promise<TransportDiagnostics> {
    return { localAddresses: [], peers: [] };
  }

  // ── Profiles / pairing / BLE: unsupported on the web (WASM) build ────────────────────────────
  // The browser path is relay-only with no BLE radio and no profile/pairing protocol wired into the
  // WASM node. Read/poll/status calls degrade gracefully (empty results, `false`, `null`) so normal service initialization never
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

  async revokePairInvite(_token: string): Promise<boolean> {
    throw pairingUnsupported('revokePairInvite');
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

  async bluetoothRadioState(): Promise<BluetoothRadioState> {
    return 'unsupported';
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
