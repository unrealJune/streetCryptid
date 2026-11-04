/**
 * Which permission steps first-run onboarding still owes, and in what order.
 *
 * Every OS prompt the app needs is asked from one place (`PermissionsGate`), one step per
 * permission, each behind a screen that says what it is for. Before this, Bluetooth and nearby
 * devices were requested by node init the moment a profile existed — on top of the location
 * disclosure — and iOS showed its Bluetooth and local-network alerts whenever the node first
 * touched the radio or the LAN.
 *
 * Pure: the gate reads the OS and the store, hands the facts in, and executes the answer.
 */

/** In the order they are asked. Location first: it is the one the app exists for. */
export const PERMISSION_STEPS = [
  'location',
  'background-location',
  'bluetooth',
  'local-network',
  'notifications',
  'battery',
] as const;

export type PermissionStepId = (typeof PERMISSION_STEPS)[number];

export type PermissionPlatform = 'ios' | 'android' | 'web';

export interface PermissionContext {
  readonly platform: PermissionPlatform;
  /** `Platform.Version` on Android; ignored elsewhere. */
  readonly androidApi: number;
  /**
   * Whether this binary can ask at all. The native exports are optional — a phone can run an
   * older binary than the bundle — and a step that cannot ask is not shown.
   */
  readonly native: {
    readonly bluetooth: boolean;
    readonly localNetwork: boolean;
    readonly battery: boolean;
  };
  /** The location disclosure's stored choice; `null` until it has been answered. */
  readonly disclosure: 'accepted' | 'declined' | null;
  /** Steps already asked on this install. */
  readonly asked: ReadonlySet<PermissionStepId>;
  /**
   * Whether this install has a record of the steps at all. With none and a disclosure answered, it
   * onboarded before the steps existed. The battery step's older record is folded into `asked`
   * without making the install `recorded`.
   */
  readonly recorded: boolean;
  /**
   * What the OS says now, without prompting. `undefined` when it cannot be read — iOS has no way
   * to read local-network access, for one.
   */
  readonly granted: Partial<Record<PermissionStepId, boolean>>;
}

/** Android 12 split Bluetooth into its own runtime permissions; before it, BLE rode on location. */
const ANDROID_BLUETOOTH_RUNTIME_API = 31;
/** POST_NOTIFICATIONS exists from Android 13. */
const ANDROID_NOTIFICATIONS_API = 33;
/**
 * ACCESS_LOCAL_NETWORK, Android 17. On 13-16 the interim gate is NEARBY_WIFI_DEVICES, which sits in
 * the same "Nearby devices" group as Bluetooth and is asked in that step's dialog, so it does not
 * get a screen of its own.
 */
export const ANDROID_LOCAL_NETWORK_API = 37;
/** NEARBY_WIFI_DEVICES exists from Android 13. */
export const ANDROID_NEARBY_WIFI_API = 33;

/** Whether this platform and binary have the permission at all. */
export function permissionStepExists(step: PermissionStepId, ctx: PermissionContext): boolean {
  const { platform, androidApi, native } = ctx;
  switch (step) {
    case 'location':
      return true;
    case 'background-location':
      return platform !== 'web';
    case 'bluetooth':
      if (!native.bluetooth) return false;
      if (platform === 'ios') return true;
      return platform === 'android' && androidApi >= ANDROID_BLUETOOTH_RUNTIME_API;
    case 'local-network':
      if (!native.localNetwork) return false;
      if (platform === 'ios') return true;
      return platform === 'android' && androidApi >= ANDROID_LOCAL_NETWORK_API;
    case 'notifications':
      return platform === 'android' && androidApi >= ANDROID_NOTIFICATIONS_API;
    case 'battery':
      return platform === 'android' && native.battery;
  }
}

/** Steps that only matter once location sharing is on: they serve the background service. */
const NEEDS_LOCATION: ReadonlySet<PermissionStepId> = new Set([
  'background-location',
  'notifications',
  'battery',
]);

/**
 * The steps still owed, in order.
 *
 * - `location` is owed until the disclosure is answered, whatever the OS says: Play requires the
 *   disclosure itself, and the stored choice is what turns sharing on.
 * - Anything the OS already grants is skipped, as is anything asked before.
 * - Steps serving the background service wait for location to be accepted, and background location
 *   also for the while-in-use grant it extends.
 * - An install that answered the disclosure before this flow existed (nothing `recorded`) was already
 *   prompted for everything by the old init path. It is owed only what that path never asked:
 *   battery, unless its own older record says it was, and Android 17's local-network permission
 *   when it is still missing — it arrived after most phones had onboarded.
 */
export function pendingPermissionSteps(ctx: PermissionContext): PermissionStepId[] {
  const legacy = !ctx.recorded && ctx.disclosure !== null;
  return PERMISSION_STEPS.filter((step) => {
    if (!permissionStepExists(step, ctx)) return false;
    if (step === 'location') return ctx.disclosure === null;
    if (ctx.asked.has(step)) return false;
    if (ctx.granted[step] === true) return false;
    if (NEEDS_LOCATION.has(step) && ctx.disclosure !== 'accepted') return false;
    if (step === 'background-location' && ctx.granted.location !== true) return false;
    if (legacy) {
      if (step === 'battery') return true;
      return step === 'local-network' && ctx.granted[step] === false;
    }
    return true;
  });
}

/**
 * An install that onboarded before the steps existed, converted to one that has a record: every
 * step it is not owed is marked asked. `null` when the install is not one of those.
 *
 * The caller persists the record before asking anything, because the first answer creates a record
 * anyway — and a record without the seed would read, on the next launch, as an install that was
 * never asked about Bluetooth at all.
 */
export function seedLegacyInstall(ctx: PermissionContext): PermissionContext | null {
  if (ctx.recorded || ctx.disclosure === null) return null;
  const owed = new Set(pendingPermissionSteps(ctx));
  return {
    ...ctx,
    asked: new Set([...ctx.asked, ...PERMISSION_STEPS.filter((step) => !owed.has(step))]),
    recorded: true,
  };
}

/**
 * The steps a run is expected to ask, for the overview and the step count: those pending now, plus
 * the ones that open up once location is accepted and granted — the answer the run is asking for.
 * A "Not now" on location shrinks the count rather than a "Continue" growing it.
 */
export function projectedPermissionSteps(ctx: PermissionContext): PermissionStepId[] {
  if (ctx.disclosure !== null) return pendingPermissionSteps(ctx);
  const accepted: PermissionContext = {
    ...ctx,
    disclosure: 'accepted',
    // As the run will record it — without this a fresh install would project as a legacy one.
    asked: new Set([...ctx.asked, 'location']),
    recorded: true,
    granted: { ...ctx.granted, location: true },
  };
  return ['location', ...pendingPermissionSteps(accepted)];
}

/**
 * Whether the run opens on the overview. One step is its own explanation; a list of one is not
 * worth a screen, which is exactly the case of an existing install owed only the battery step.
 */
export function showsPermissionIntro(pending: readonly PermissionStepId[]): boolean {
  return pending.length > 1;
}

/**
 * Whether a step offers "Not now" beside its continue button.
 *
 * Not on iOS: App Review rejects a screen in front of a system alert that lets someone skip the
 * alert, and the alert's own "Don't Allow" is the decline. It also keeps iOS from asking anyway at
 * a random moment later, because a skipped Bluetooth or local-network step there would only defer
 * the alert to the node's first touch of the radio or the LAN.
 */
export function permissionStepCanDecline(platform: PermissionPlatform): boolean {
  return platform !== 'ios';
}
