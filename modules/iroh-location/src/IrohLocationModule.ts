import { NativeModule, requireNativeModule } from 'expo-modules-core';

import { requireIrohRelayRuntimeConfig } from './relay-config';
import type {
  IrohLocationEvents,
  IrohLocationApi,
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
  start(): Promise<void>;
  shutdown(): Promise<void>;
  ticket(): Promise<string>;
  deriveTopic(authorEndpointIdHex: string): Promise<string>;
  subscribe(topicHex: string, bootstrapTickets: string[]): Promise<string>;
  publish(
    subscriptionId: string,
    seq: number,
    epoch: number,
    fix: NativeLocationFix,
    recipientsHex: string[],
    traceparent?: string | null
  ): Promise<void>;
  unsubscribe(subscriptionId: string): Promise<void>;
  docsWrite(
    subscriptionId: string,
    seq: number,
    epoch: number,
    fix: NativeLocationFix,
    recipientsHex: string[],
    traceparent?: string | null
  ): Promise<void>;
  syncTrail(sinceTs: number, peerTicket: string | null, traceparent?: string | null): Promise<void>;
  readTrail(author: string, sinceTs: number): Promise<NativeIncomingFix[]>;
  pruneTrail(olderThanTs: number): Promise<void>;
  docTicket(): Promise<string>;
  importDocTicket(ticket: string): Promise<void>;

  // Optional for compatibility with installed iOS binaries built before the telemetry API.
  configureTelemetry?(endpoint: string, instanceId: string): Promise<boolean>;
  flushTelemetry?(): Promise<void>;

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

  bleAvailable(): Promise<boolean>;
  bleCapabilities(): Promise<BleCapabilities>;
  nearbyBlePeers(): Promise<BlePeer[]>;
  resolveBumpPeer(timeoutMs: number): Promise<BumpResolution>;
  bleHasScanHint(endpointIdHex: string): Promise<boolean>;
}

type RawIrohLocationNativeModule = Omit<IrohLocationNativeModule, 'start'> & {
  start(relayUrls: string[], relayAuthToken: string): Promise<void>;
};

let cached: IrohLocationNativeModule | null | undefined;

function withRelayConfig(raw: RawIrohLocationNativeModule): IrohLocationNativeModule {
  const start = raw.start.bind(raw);

  return new Proxy(raw, {
    get(target, property) {
      if (property === 'start') {
        return async () => {
          const { relayUrls, authToken } = requireIrohRelayRuntimeConfig();
          await start(relayUrls, authToken);
        };
      }

      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as IrohLocationNativeModule;
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
