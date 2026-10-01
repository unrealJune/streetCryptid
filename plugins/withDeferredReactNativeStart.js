const { withAppDelegate } = require('expo/config-plugins');

/**
 * Do not start React Native when iOS launches the app into the background.
 *
 * ## Why
 *
 * An SLC relaunch, a geofence crossing or a location delivery to a terminated app launches the
 * process in the background, and `didFinishLaunchingWithOptions` starts React unconditionally — so
 * every one of those pays for 104 local modules plus React, Reanimated, Skia and the router before
 * anything publishes. None of it is needed: `BackgroundLocationRuntime` captures, gates, seals and
 * sends with no JS in the loop, and `IrohBackgroundAppDelegateSubscriber` has already armed it from
 * `willFinishLaunchingWithOptions` by the time this runs.
 *
 * ## Why an AppDelegate mod and not a React delegate handler
 *
 * `ExpoReactDelegate.createReactRootView` is consulted from INSIDE `startReactNative`, so a handler
 * returning a placeholder still runs `createRootViewController`, `setRootView:` and
 * `makeKeyAndVisible` — the UIKit work this exists to avoid — and binds `SplashScreenManager` to a
 * view that is then thrown away. Worse, `expo-dev-launcher` already claims that seam and returns
 * first in DEBUG, with an undefined priority tie-break, so our handler would be unreachable or
 * nondeterministically reachable in every dev-client build.
 *
 * ## DEBUG always starts immediately
 *
 * Which means this is only exercised by a Release build. That is deliberate: it keeps every
 * dev-client build byte-identical and sidesteps dev-launcher entirely. A Release build on the
 * simulator does exercise it.
 *
 * ## It throws rather than no-oping
 *
 * `ios/` is regenerated from an Expo template on every prebuild, and that template changes between
 * SDK patches. A plugin that silently fails to match ships an app that boots React on every
 * background wake and looks completely fine — the failure would be invisible until someone read the
 * wake counters. Precedent: `withBackupExclusion` throws on a missing `<application>`.
 */

const ANCHOR = `#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif`;

const REPLACEMENT = `#if os(iOS) || os(tvOS)
    // Remember what a later start will need, then decide whether to start at all.
    self.pendingLaunchOptions = launchOptions
    if Self.shouldStartReactNativeNow(application) {
      startReactNativeIfNeeded()
    } else {
      NSLog("[iroh-location] background launch: deferring React Native")
    }
#endif`;

const MEMBERS = `
  // MARK: - Deferred React Native start (see plugins/withDeferredReactNativeStart.js)

  var pendingLaunchOptions: [UIApplication.LaunchOptionsKey: Any]?
  var didStartReactNative = false

  /// Whether this launch should bring React up right now.
  ///
  /// DEBUG always does, so dev-client builds are unchanged. In Release the only reason to defer is
  /// a launch into the background, and a user-flippable kill switch turns the whole thing off — it
  /// can only be set by JS, which only runs on a foreground launch, which is the path that always
  /// works.
  static func shouldStartReactNativeNow(_ application: UIApplication) -> Bool {
#if DEBUG
    return true
#else
    // The decision itself is made in IrohBackgroundAppDelegateSubscriber, which runs in
    // willFinishLaunchingWithOptions — before this — and publishes it here. One predicate, in the
    // place that can see the state; two copies would drift, and the pair that disagrees is a
    // mounted app that cannot claim its own node.
    return !UserDefaults.standard.bool(forKey: "sc.bg.rn_deferred")
#endif
  }

  /// Build the window and start React. Idempotent, and main-thread only.
  func startReactNativeIfNeeded() {
    guard !didStartReactNative else { return }
    didStartReactNative = true
    let window = self.window ?? UIWindow(frame: UIScreen.main.bounds)
    self.window = window
    reactNativeFactory?.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: pendingLaunchOptions)
  }
`;

/** The three ways a deferred launch can become one that needs React. */
const FOREGROUND_HOOKS = `
  public override func applicationWillEnterForeground(_ application: UIApplication) {
    startReactNativeIfNeeded()
    super.applicationWillEnterForeground(application)
  }
`;

function patchAppDelegate(contents) {
  if (contents.includes('startReactNativeIfNeeded')) return contents;

  if (!contents.includes(ANCHOR)) {
    throw new Error(
      '[withDeferredReactNativeStart] could not find the startReactNative block in ' +
        'AppDelegate.swift. The Expo template changed; update ANCHOR to match, and do not ' +
        'let this become a silent no-op — the whole point is that a background launch must ' +
        'not boot React, and a failure here is invisible at runtime.'
    );
  }
  let next = contents.replace(ANCHOR, REPLACEMENT);

  // A deep link or universal link can arrive on a process that has only ever been a background
  // one, and both handlers below assume a live bridge via RCTLinkingManager.
  next = next.replace(/(\n  \/\/ Linking API\n)/, `\n${MEMBERS}${FOREGROUND_HOOKS}$1`);
  next = next.replace(
    /(return super\.application\(app, open: url, options: options\))/,
    'startReactNativeIfNeeded()\n    $1'
  );
  next = next.replace(
    /(let result = RCTLinkingManager\.application\(application, continue: userActivity)/,
    'startReactNativeIfNeeded()\n    $1'
  );

  if (!next.includes('applicationWillEnterForeground')) {
    throw new Error(
      '[withDeferredReactNativeStart] failed to insert the foreground hooks; a deferred launch ' +
        'would never start React and the app would appear dead on open.'
    );
  }
  return next;
}

module.exports = function withDeferredReactNativeStart(config) {
  return withAppDelegate(config, (cfg) => {
    cfg.modResults.contents = patchAppDelegate(cfg.modResults.contents);
    return cfg;
  });
};

module.exports.patchAppDelegate = patchAppDelegate;
