import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from 'react';
import { AppState, Platform } from 'react-native';

import { useCryptidProfile } from '@/features/account/hooks/use-cryptid-profile';
import { buildFriendPresence, type FriendPresence } from '@/features/social/core/presence';
import type { IncomingFix, LocationFix } from '@/features/social/core/types';
import { SELF_AUTHOR, type TrailPoint } from '@/features/social/net/background/trail-store';
import {
  LocationSharingService,
  type PairingSnapshot,
  type SharingSnapshot,
} from '@/features/social/net/location-sharing';
import {
  createPersistentKV,
  loadLocationDisclosureChoice,
  saveLocationDisclosureChoice,
} from '@/features/social/net/persistence';
import { buildTransportReport, type TransportReport } from '@/features/social/net/transports';
import {
  ensureLocalNetworkPermission,
  ensurePairingPermissions,
  hasPairingPermissions,
} from '@/features/social/net/pairing-permissions';

export type LocationRuntimeStatus =
  'starting' | 'running' | 'permission-denied' | 'unavailable' | 'error';

/**
 * Google Play requires a "prominent disclosure" screen — shown in-app, before the OS runtime
 * permission prompt — for any app requesting ACCESS_BACKGROUND_LOCATION. `pending` gates the app
 * behind `LocationDisclosureScreen`; `loading` is the brief KV read on boot.
 */
export type LocationDisclosureStatus = 'loading' | 'pending' | 'accepted' | 'declined';

interface LocationSharingContextValue {
  snapshot: SharingSnapshot | null;
  pairing: PairingSnapshot | null;
  trail: TrailPoint[];
  selfFix: LocationFix | null;
  hasLiveSelfFix: boolean;
  friends: FriendPresence[];
  locationStatus: LocationRuntimeStatus;
  error: string | null;
  /** Status of the in-app background-location disclosure gate (see `LocationDisclosureScreen`). */
  disclosureStatus: LocationDisclosureStatus;
  /** Record the user's choice on the disclosure screen; `true` proceeds to request OS permission. */
  acknowledgeLocationDisclosure(accepted: boolean): Promise<void>;
  armBump(): Promise<void>;
  commitBump(): Promise<void>;
  cancelBump(): Promise<void>;
  createPairInvite(ttlSecs?: number): Promise<string | undefined>;
  pairFromInput(input: string): Promise<void>;
  respondPair(sessionId: string, accept: boolean): Promise<void>;
  submitPairChoice(sessionId: string, chosenIndex: number): Promise<void>;
  confirmPairDisplay(sessionId: string, matched: boolean): Promise<void>;
  cancelPair(sessionId: string): Promise<void>;
  refreshPairing(): Promise<void>;
  refreshTransportDiagnostics(): Promise<void>;
  toggleShare(endpointId: string, on: boolean): Promise<void>;
  removeFriend(endpointId: string): Promise<void>;
  retryLocation(): Promise<void>;
  /** Opt in/out of offline delivery via the trail stash. */
  setStashOptIn(optedIn: boolean): Promise<void>;
  /** Force (or unforce) relay-only transport. */
  setRelayOnly(relayOnly: boolean): Promise<void>;
  /** Capture and publish a fresh GPS fix immediately, bypassing normal sampling. */
  forceLocationPush(trigger?: 'manual' | 'scheduled'): Promise<number>;
  /** Honest, live diagnostic of every transport (for the Settings tab). */
  transportReport: TransportReport;
  acknowledgeDiscoveredFriend(): void;
  rejectDiscoveredFriend(): Promise<void>;
}

/**
 * Configured relay URLs, read statically at module scope so Hermes release builds inline the value
 * (a dynamic `process.env.EXPO_PUBLIC_*` read silently yields undefined in release — see the
 * `expo-public-env-static-access` memory).
 */
const RELAY_URLS = (process.env.EXPO_PUBLIC_IROH_RELAY_URLS ?? '')
  .split(',')
  .map((url) => url.trim())
  .filter((url) => url.length > 0);

const LocationSharingContext = createContext<LocationSharingContextValue | null>(null);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function locationStatusFor(error: unknown): LocationRuntimeStatus {
  return /permission|location access/i.test(errorMessage(error)) ? 'permission-denied' : 'error';
}

function profileSignature(
  profile: NonNullable<ReturnType<typeof useCryptidProfile>['profile']>
): string {
  return `${profile.handle}\u0000${profile.cryptidName}\u0000${profile.sigil}\u0000${profile.color}`;
}

/**
 * The native `IrohLocation` module is a process-wide singleton that owns a single node, and the
 * background location service is meant to outlive any single mount of this provider. So the service
 * (and its native node) is held as a module-level singleton: remounts — including React StrictMode's
 * dev double-invoke — reuse it and re-attach listeners, rather than create a second service that
 * would race the shared native node. That race surfaced as `IrohLocation.setPairingReady` rejecting
 * with "call createNode first" when a stale unmount tore the node down under a freshly-mounted,
 * already-"ready" instance. Initialised exactly once; a failed attempt clears the latch so a later
 * mount can retry instead of inheriting a rejected promise.
 */
let sharedService: LocationSharingService | null = null;
let sharedServiceInit: Promise<void> | null = null;

function getSharedService(): LocationSharingService {
  if (!sharedService) sharedService = new LocationSharingService();
  return sharedService;
}

export function LocationSharingProvider({ children }: PropsWithChildren) {
  const { profile } = useCryptidProfile();
  const [initialProfile] = useState(profile);
  const serviceRef = useRef<LocationSharingService | null>(null);
  const bluetoothPermissionGranted = useRef(false);
  const trailRefreshId = useRef(0);
  const publishedProfileSignature = useRef('');
  const [kv] = useState(() => createPersistentKV());
  const [snapshot, setSnapshot] = useState<SharingSnapshot | null>(null);
  const [trail, setTrail] = useState<TrailPoint[]>([]);
  const [persistedSelfFix, setPersistedSelfFix] = useState<LocationFix | null>(null);
  const [liveSelfFix, setLiveSelfFix] = useState<LocationFix | null>(null);
  const [locationStatus, setLocationStatus] = useState<LocationRuntimeStatus>('starting');
  const [locationError, setLocationError] = useState<string | null>(null);
  const [serviceError, setServiceError] = useState<string | null>(null);
  const [disclosureStatus, setDisclosureStatus] = useState<LocationDisclosureStatus>('loading');
  const [serviceReady, setServiceReady] = useState(false);
  const locationStartRequested = useRef(false);

  // Read the disclosure choice as soon as possible — independent of (and faster than) the heavy
  // service-init effect below, so the gate can render its "loading" state as briefly as possible.
  useEffect(() => {
    let active = true;
    void loadLocationDisclosureChoice(kv).then((choice) => {
      if (active) setDisclosureStatus(choice ?? 'pending');
    });
    return () => {
      active = false;
    };
  }, [kv]);

  const acknowledgeLocationDisclosure = useCallback(
    async (accepted: boolean) => {
      await saveLocationDisclosureChoice(kv, accepted ? 'accepted' : 'declined');
      setDisclosureStatus(accepted ? 'accepted' : 'declined');
    },
    [kv]
  );

  const refreshTrail = useCallback(async (service: LocationSharingService): Promise<void> => {
    const requestId = ++trailRefreshId.current;
    const latest = await service.trailAll();
    if (requestId !== trailRefreshId.current) return;
    setTrail(latest);
    const persistedSelf = latest.reduce<LocationFix | null>(
      (current, point) =>
        point.author === SELF_AUTHOR && (!current || point.fix.ts > current.ts)
          ? point.fix
          : current,
      null
    );
    if (persistedSelf) {
      setPersistedSelfFix((current) =>
        !current || persistedSelf.ts > current.ts ? persistedSelf : current
      );
    }
  }, []);

  const startLocation = useCallback(async (service: LocationSharingService): Promise<void> => {
    if (!(await service.isBackgroundAvailable())) {
      setLocationStatus('unavailable');
      setLocationError('Background location is unavailable in this build.');
      return;
    }
    try {
      setLocationStatus('starting');
      const access = await service.startBackground();
      if (access === 'full') {
        setLocationStatus('running');
        setLocationError(null);
      } else {
        setLocationStatus('permission-denied');
        setLocationError('Allow background location so your friends stay current.');
      }
    } catch (startError: unknown) {
      setLocationStatus(locationStatusFor(startError));
      setLocationError(errorMessage(startError));
    }
  }, []);

  useEffect(() => {
    if (locationStatus !== 'permission-denied') return;
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      const service = serviceRef.current;
      if (!service) return;
      void service.stopBackground().then(() => startLocation(service));
    });
    return () => subscription.remove();
  }, [locationStatus, startLocation]);

  // Fires once both the node is ready and the user has accepted the in-app disclosure — whichever
  // resolves last. Covers a returning user (disclosure already 'accepted' from a prior session, node
  // still initializing) and a first-run user (node ready first, waiting on the disclosure screen).
  useEffect(() => {
    if (!serviceReady || disclosureStatus !== 'accepted') return;
    if (locationStartRequested.current) return;
    const service = serviceRef.current;
    if (!service) return;
    locationStartRequested.current = true;
    void startLocation(service);
  }, [serviceReady, disclosureStatus, startLocation]);

  useEffect(() => {
    if (!initialProfile) return;

    const service = getSharedService();
    serviceRef.current = service;
    let active = true;

    const offSnapshot = service.onChange((next) => {
      if (active) setSnapshot(next);
    });
    const offLocalFix = service.onLocalFix((fix) => {
      if (!active) return;
      setLiveSelfFix((current) => (!current || fix.ts >= current.ts ? fix : current));
    });
    const offTrail = service.onTrailChange(() => {
      if (active) void refreshTrail(service);
    });
    const offFix = service.onFix((_fix: IncomingFix) => {
      if (active) void refreshTrail(service);
    });
    const offError = service.onError((message) => {
      // An empty message is the service's "recovered" signal — clear the banner rather than pin it.
      if (active) setServiceError(message || null);
    });

    void (async () => {
      if (!LocationSharingService.isAvailable()) {
        if (active) {
          setLocationStatus('unavailable');
          setServiceError('Friend sync needs an installed Android or iOS build.');
        }
        return;
      }
      try {
        // Initialise the shared native node exactly once across all mounts. A failed attempt
        // clears the latch (below) so a later mount retries rather than awaiting a rejected promise.
        if (!sharedServiceInit) {
          sharedServiceInit = (async () => {
            await ensureLocalNetworkPermission();
            bluetoothPermissionGranted.current = await hasPairingPermissions();
            await service.init(
              initialProfile.handle,
              initialProfile.sigil,
              initialProfile.cryptidName,
              initialProfile.color
            );
          })().catch((error: unknown) => {
            sharedServiceInit = null;
            throw error;
          });
        }
        await sharedServiceInit;
        publishedProfileSignature.current = profileSignature(initialProfile);
        if (!active) return;
        await refreshTrail(service);
        // Background location itself is gated behind the disclosure screen below (Play Store
        // requires that prominent, in-app disclosure before the OS runtime prompt fires) — this
        // effect only readies everything else the node needs (pairing, trail sync).
        setServiceReady(true);
        await service.syncTrail(0);
      } catch (initError: unknown) {
        if (!active) return;
        setLocationStatus('error');
        setServiceError(errorMessage(initError));
      }
    })();

    return () => {
      // Detach this mount's listeners only. The shared service, its native node, and the background
      // location service are process-lifetime singletons and are intentionally NOT shut down here,
      // so a remount (or StrictMode's dev double-invoke) can't tear the node down under another
      // still-live, already-"ready" instance.
      active = false;
      trailRefreshId.current += 1;
      offSnapshot();
      offLocalFix();
      offTrail();
      offFix();
      offError();
    };
  }, [initialProfile, refreshTrail, startLocation]);

  useEffect(() => {
    if (!profile || !snapshot?.ready) return;
    const signature = profileSignature(profile);
    if (signature === publishedProfileSignature.current) return;
    const service = serviceRef.current;
    if (!service) return;
    void service
      .updateProfile(profile.handle, profile.sigil, profile.cryptidName, profile.color)
      .then(() => {
        publishedProfileSignature.current = signature;
      })
      .catch((profileError: unknown) => {
        setServiceError(errorMessage(profileError));
      });
  }, [profile, snapshot?.ready]);

  const run = useCallback(async (action: (service: LocationSharingService) => Promise<void>) => {
    const service = serviceRef.current;
    if (!service) return;
    try {
      await action(service);
    } catch (actionError: unknown) {
      setServiceError(errorMessage(actionError));
    }
  }, []);

  const armBump = useCallback(async () => {
    const service = serviceRef.current;
    if (!service) {
      const message = 'Friend sync is not ready. Try again.';
      setServiceError(message);
      throw new Error(message);
    }
    try {
      if (!bluetoothPermissionGranted.current) {
        const granted = await ensurePairingPermissions();
        if (!granted) {
          throw new Error('Bluetooth access is needed to Bump with a nearby friend.');
        }
        bluetoothPermissionGranted.current = true;
      }
      setServiceError(null);
      await service.ensureBleReady();
      await service.armBump();
    } catch (bumpError: unknown) {
      setServiceError(errorMessage(bumpError));
      throw bumpError;
    }
  }, []);

  const createPairInvite = useCallback(async (ttlSecs = 300) => {
    const service = serviceRef.current;
    if (!service) return undefined;
    try {
      const link = await service.createPairInvite(ttlSecs);
      setServiceError(null);
      return link;
    } catch (inviteError: unknown) {
      setServiceError(errorMessage(inviteError));
      return undefined;
    }
  }, []);

  const retryLocation = useCallback(async () => {
    const service = serviceRef.current;
    if (!service) return;
    await service.stopBackground();
    await startLocation(service);
  }, [startLocation]);

  const hasLiveSelfFix = liveSelfFix !== null;
  const selfFix = liveSelfFix ?? persistedSelfFix;
  const commitBump = useCallback(() => {
    setServiceError(null);
    return run((service) => service.commitBump());
  }, [run]);
  const cancelBump = useCallback(() => {
    setServiceError(null);
    return run((service) => service.cancelBump());
  }, [run]);
  const pairFromInput = useCallback(async (input: string) => {
    const service = serviceRef.current;
    if (!service) {
      const message = 'Friend sync is not ready. Try again.';
      setServiceError(message);
      throw new Error(message);
    }
    setServiceError(null);
    try {
      await service.pairFromInput(input);
    } catch (pairError: unknown) {
      setServiceError(errorMessage(pairError));
      throw pairError;
    }
  }, []);
  const respondPair = useCallback(
    (sessionId: string, accept: boolean) => {
      setServiceError(null);
      return run((service) => service.respondPair(sessionId, accept));
    },
    [run]
  );
  const submitPairChoice = useCallback(
    (sessionId: string, chosenIndex: number) => {
      setServiceError(null);
      return run((service) => service.submitPairChoice(sessionId, chosenIndex));
    },
    [run]
  );
  const confirmPairDisplay = useCallback(
    (sessionId: string, matched: boolean) => {
      setServiceError(null);
      return run((service) => service.confirmPairDisplay(sessionId, matched));
    },
    [run]
  );
  const cancelPair = useCallback(
    (sessionId: string) => {
      setServiceError(null);
      return run((service) => service.cancelPair(sessionId));
    },
    [run]
  );
  const refreshPairing = useCallback(() => run((service) => service.refreshPairing()), [run]);
  const refreshTransportDiagnostics = useCallback(
    () => run((service) => service.refreshTransportDiagnostics()),
    [run]
  );
  const setStashOptIn = useCallback(
    (optedIn: boolean) => {
      setServiceError(null);
      return run((service) => service.setStashOptIn(optedIn));
    },
    [run]
  );
  const setRelayOnly = useCallback(
    (relayOnly: boolean) => {
      setServiceError(null);
      return run((service) => service.setRelayOnly(relayOnly));
    },
    [run]
  );
  const forceLocationPush = useCallback(async (trigger: 'manual' | 'scheduled' = 'manual') => {
    const service = serviceRef.current;
    if (!service) {
      const message = 'Friend sync is not ready. Try again.';
      setServiceError(message);
      throw new Error(message);
    }
    try {
      const seq = await service.forceLocationPush(trigger);
      setServiceError(null);
      return seq;
    } catch (pushError: unknown) {
      setServiceError(errorMessage(pushError));
      throw pushError;
    }
  }, []);
  const toggleShare = useCallback(
    (endpointId: string, on: boolean) => {
      setServiceError(null);
      return run((service) => (on ? service.shareWith(endpointId) : service.revoke(endpointId)));
    },
    [run]
  );
  const removeFriend = useCallback(async (endpointId: string) => {
    setServiceError(null);
    const service = serviceRef.current;
    if (!service) {
      const message = 'Friend sync is not ready. Try again.';
      setServiceError(message);
      throw new Error(message);
    }
    try {
      await service.removeFriend(endpointId);
    } catch (removeError: unknown) {
      setServiceError(errorMessage(removeError));
      throw removeError;
    }
  }, []);
  const acknowledgeDiscoveredFriend = useCallback(() => {
    serviceRef.current?.acknowledgeDiscoveredFriend();
  }, []);
  const rejectDiscoveredFriend = useCallback(() => {
    setServiceError(null);
    return run((service) => service.rejectDiscoveredFriend());
  }, [run]);

  const friends = useMemo(
    () =>
      buildFriendPresence({
        friends: snapshot?.friends ?? [],
        latest: trail.filter((point) => point.author !== SELF_AUTHOR),
        selfFix: hasLiveSelfFix ? selfFix : null,
      }),
    [snapshot?.friends, trail, hasLiveSelfFix, selfFix]
  );
  const error = locationError ?? serviceError;

  const transportReport = useMemo<TransportReport>(
    () =>
      buildTransportReport({
        nativeAvailable: LocationSharingService.isAvailable(),
        platformOS: Platform.OS,
        platformVersion: String(Platform.Version),
        nodeReady: snapshot?.ready ?? false,
        nodeStatus: snapshot?.status ?? 'Not started',
        selfEndpointId: snapshot?.self?.endpointId ?? null,
        relayUrls: RELAY_URLS,
        diagnostics: snapshot?.transportDiagnostics.snapshot ?? null,
        diagnosticsUpdatedAt: snapshot?.transportDiagnostics.updatedAt ?? null,
        diagnosticsError: snapshot?.transportDiagnostics.error ?? null,
        ble: snapshot?.pairing.capabilities ?? null,
        blePeers: snapshot?.pairing.nearbyPeers ?? [],
        pairingSessions: snapshot?.pairing.sessions ?? [],
        // Wi-Fi Aware / Multipeer is Phase 3; null renders an honest "planned" row.
        nearby: null,
        stash: snapshot?.stash ?? { available: false, optedIn: false },
        relayOnly: {
          enabled: snapshot?.transports.relayOnly ?? false,
          enforced: snapshot?.transports.relayOnlyEnforced ?? false,
        },
        friends: snapshot?.friends ?? [],
        background: {
          sharing: snapshot?.backgroundSharing ?? false,
          access: snapshot?.backgroundAccess ?? 'unknown',
        },
      }),
    [snapshot]
  );

  const value = useMemo<LocationSharingContextValue>(
    () => ({
      snapshot,
      pairing: snapshot?.pairing ?? null,
      trail,
      selfFix,
      hasLiveSelfFix,
      friends,
      locationStatus,
      error,
      disclosureStatus,
      acknowledgeLocationDisclosure,
      armBump,
      commitBump,
      cancelBump,
      createPairInvite,
      pairFromInput,
      respondPair,
      submitPairChoice,
      confirmPairDisplay,
      cancelPair,
      refreshPairing,
      refreshTransportDiagnostics,
      toggleShare,
      removeFriend,
      retryLocation,
      setStashOptIn,
      setRelayOnly,
      forceLocationPush,
      transportReport,
      acknowledgeDiscoveredFriend,
      rejectDiscoveredFriend,
    }),
    [
      snapshot,
      trail,
      selfFix,
      hasLiveSelfFix,
      friends,
      locationStatus,
      disclosureStatus,
      acknowledgeLocationDisclosure,
      error,
      armBump,
      commitBump,
      cancelBump,
      createPairInvite,
      pairFromInput,
      respondPair,
      submitPairChoice,
      confirmPairDisplay,
      cancelPair,
      refreshPairing,
      refreshTransportDiagnostics,
      toggleShare,
      removeFriend,
      retryLocation,
      setStashOptIn,
      setRelayOnly,
      forceLocationPush,
      transportReport,
      acknowledgeDiscoveredFriend,
      rejectDiscoveredFriend,
    ]
  );

  return (
    <LocationSharingContext.Provider value={value}>{children}</LocationSharingContext.Provider>
  );
}

export function useLocationSharing(): LocationSharingContextValue {
  const context = useContext(LocationSharingContext);
  if (!context) {
    throw new Error('useLocationSharing must be used inside LocationSharingProvider.');
  }
  return context;
}
