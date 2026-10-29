const { IOSConfig, withDangerousMod } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

/**
 * Do not start React Native when iOS launches the app into the background.
 *
 * ## Why
 *
 * An SLC relaunch, a geofence crossing or a location delivery to a terminated app launches the
 * process in the background, and the Expo template starts React unconditionally — so every one of
 * those pays for 104 local modules plus React, Reanimated, Skia and the router before anything
 * publishes. None of it is needed: `BackgroundLocationRuntime` captures, gates, seals and sends
 * with no JS in the loop, and `IrohBackgroundAppDelegateSubscriber` has already armed it from
 * `willFinishLaunchingWithOptions` by the time a scene connects.
 *
 * ## Why the SCENE delegate (SDK 58)
 *
 * The iOS 27 SDK requires the UIKit scene life cycle, and SDK 58's template moved the window and
 * `startReactNative` out of `AppDelegate.didFinishLaunchingWithOptions` and into
 * `ExpoAppSceneDelegate.scene(_:willConnectTo:options:)`. A background launch can still connect a
 * scene — in the `.background` activation state — so the gate moved with it: this plugin replaces
 * the template's empty `SceneDelegate` with one that holds the connection back and replays it into
 * `super` only when the scene comes to the foreground — someone opened the app. Replaying the
 * ORIGINAL connection options is what keeps a link that cold-started the app working:
 * `ExpoAppSceneDelegate` rebuilds `Linking.getInitialURL()` from them.
 *
 * ## The invariant: React starts only for a scene on its way to the screen
 *
 * Everything else is native. A URL or a user activity (a deep link, a universal link, Handoff) is
 * NOT a reason on its own: tapping one foregrounds the app, and UIKit's order between that and the
 * delivery is not something to bet on. So one delivered to a scene that is still `.background`
 * while React is held back is queued and replayed after React starts on the way to the foreground,
 * and one delivered to a foreground scene simply starts it. The only way React comes up on a
 * background scene is the published decision saying so — DEBUG, or the `sc.bg.defer_rn_disabled`
 * kill switch.
 *
 * ## Why not a React delegate handler
 *
 * `ExpoReactDelegate.createReactRootView` is consulted from INSIDE `startReactNative`, so a handler
 * returning a placeholder still builds the root view controller and makes the window key — the
 * UIKit work this exists to avoid — and binds `SplashScreenManager` to a view that is then thrown
 * away. `expo-dev-launcher` also claims that seam in DEBUG with an undefined tie-break.
 *
 * ## DEBUG always starts immediately
 *
 * Which means this is only exercised by a Release build. That keeps every dev-client build
 * byte-identical and sidesteps dev-launcher entirely. A Release build on the simulator does
 * exercise it.
 *
 * ## It throws rather than no-oping
 *
 * `ios/` is regenerated from an Expo template on every prebuild, and that template changes between
 * SDK patches. A plugin that silently fails to match ships an app that boots React on every
 * background wake and looks completely fine — the failure would be invisible until someone read the
 * wake counters. Precedent: `withBackupExclusion` throws on a missing `<application>`.
 */

/** The SDK 58 template's scene delegate, which this plugin replaces wholesale. */
const TEMPLATE_BODY = `class SceneDelegate: ExpoAppSceneDelegate {
  // Extension point for config plugins.
}`;

/**
 * Posted (synchronously) before the scene decides, so `IrohBackgroundAppDelegateSubscriber` can
 * classify this launch by the scene's own activation state. Under the scene life cycle
 * `applicationState` is not evidence of anything before a scene connects, so the subscriber cannot
 * decide in `willFinishLaunching` alone. Must match `IrohLaunchClassifier.sceneWillConnect`.
 */
const SCENE_WILL_CONNECT = 'IrohLocationSceneWillConnect';

const REPLACEMENT_BODY = `class SceneDelegate: ExpoAppSceneDelegate {
  // MARK: - Deferred React Native start (see plugins/withDeferredReactNativeStart.js)

  /// The connection a background launch held back, replayed into \`super\` when React is needed.
  private var pendingConnection:
    (scene: UIScene, session: UISceneSession, options: UIScene.ConnectionOptions)?
  /// Links and activities delivered to the held-back scene while it was still in the background.
  private var pendingURLContexts: [Set<UIOpenURLContext>] = []
  private var pendingActivities: [NSUserActivity] = []

  override func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    // Let the bootstrap classify this launch from the scene's own state BEFORE the decision below
    // reads it. Synchronous: a posted notification runs its observers before \`post\` returns.
    NotificationCenter.default.post(
      name: Notification.Name("${SCENE_WILL_CONNECT}"), object: scene)
    if Self.shouldStartReactNativeNow() {
      super.scene(scene, willConnectTo: session, options: connectionOptions)
    } else {
      pendingConnection = (scene, session, connectionOptions)
      NSLog("[iroh-location] background scene: deferring React Native")
    }
  }

  /// Whether this connection should bring React up right now.
  ///
  /// DEBUG always does, so dev-client builds are unchanged. In Release the decision is made by
  /// IrohBackgroundAppDelegateSubscriber — one predicate, in the place that can see the state, and
  /// published through UserDefaults because this file cannot import that module. Two copies would
  /// drift, and the pair that disagrees is a mounted app that cannot claim its own node.
  static func shouldStartReactNativeNow() -> Bool {
#if DEBUG
    return true
#else
    return !UserDefaults.standard.bool(forKey: "sc.bg.rn_deferred")
#endif
  }

  /// Replay the held-back connection into \`super\`, which builds the window and starts React, then
  /// the links that arrived while it was held. Idempotent, and main-thread only (every caller is a
  /// UIKit scene callback). Only ever called for a scene on its way to the foreground.
  func startReactNativeIfNeeded() {
    guard let pending = pendingConnection else { return }
    pendingConnection = nil
    NSLog("[iroh-location] deferred scene: starting React Native")
    super.scene(pending.scene, willConnectTo: pending.session, options: pending.options)
    let urls = pendingURLContexts
    let activities = pendingActivities
    pendingURLContexts = []
    pendingActivities = []
    for contexts in urls { super.scene(pending.scene, openURLContexts: contexts) }
    for activity in activities { super.scene(pending.scene, continue: activity) }
  }

  /// Whether a delivery to \`scene\` must wait: React is held back and the scene is not on screen.
  private func holdsDelivery(for scene: UIScene) -> Bool {
    pendingConnection != nil && scene.activationState == .background
  }

  // The scene coming to the foreground is what starts a deferred React, and it does so BEFORE
  // forwarding, because \`super\` routes the event to subscribers and RCTLinkingManager, which
  // assume a live bridge.

  override func sceneWillEnterForeground(_ scene: UIScene) {
    startReactNativeIfNeeded()
    super.sceneWillEnterForeground(scene)
  }

  override func sceneDidBecomeActive(_ scene: UIScene) {
    startReactNativeIfNeeded()
    super.sceneDidBecomeActive(scene)
  }

  // A link is not a reason to start React: queued while the scene is in the background, replayed
  // once the foreground has started it.

  override func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    if holdsDelivery(for: scene) {
      pendingURLContexts.append(URLContexts)
      return
    }
    startReactNativeIfNeeded()
    super.scene(scene, openURLContexts: URLContexts)
  }

  override func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    if holdsDelivery(for: scene) {
      pendingActivities.append(userActivity)
      return
    }
    startReactNativeIfNeeded()
    super.scene(scene, continue: userActivity)
  }

  override func sceneDidDisconnect(_ scene: UIScene) {
    pendingConnection = nil
    pendingURLContexts = []
    pendingActivities = []
    super.sceneDidDisconnect(scene)
  }
}`;

function patchSceneDelegate(contents) {
  if (contents.includes('startReactNativeIfNeeded')) return contents;

  if (!contents.includes(TEMPLATE_BODY)) {
    throw new Error(
      '[withDeferredReactNativeStart] could not find the template SceneDelegate in ' +
        'SceneDelegate.swift. The Expo template changed; update TEMPLATE_BODY to match, and do ' +
        'not let this become a silent no-op — the whole point is that a background launch must ' +
        'not boot React, and a failure here is invisible at runtime.'
    );
  }
  return contents.replace(TEMPLATE_BODY, REPLACEMENT_BODY);
}

/**
 * The SDK 58 AppDelegate must NOT start React itself any more; the scene delegate does. Check
 * rather than trust it: an AppDelegate that still started React would boot it on every background
 * launch with the scene gate above looking perfectly healthy.
 */
function assertAppDelegateDoesNotStartReact(contents) {
  if (/\.startReactNative\(/.test(contents)) {
    throw new Error(
      '[withDeferredReactNativeStart] AppDelegate.swift calls startReactNative. Under the SDK 58 ' +
        'scene life cycle only SceneDelegate may start React, or the background-launch gate ' +
        'in SceneDelegate.swift is bypassed.'
    );
  }
}

module.exports = function withDeferredReactNativeStart(config) {
  return withDangerousMod(config, [
    'ios',
    async (cfg) => {
      const root = cfg.modRequest.platformProjectRoot;
      const appDir = path.join(
        root,
        IOSConfig.XcodeUtils.getProjectName(cfg.modRequest.projectRoot)
      );
      const scenePath = path.join(appDir, 'SceneDelegate.swift');
      if (!fs.existsSync(scenePath)) {
        throw new Error(
          `[withDeferredReactNativeStart] ${scenePath} does not exist. SDK 58 prebuild generates ` +
            'it; without it the app has no scene delegate and React is never gated.'
        );
      }
      fs.writeFileSync(scenePath, patchSceneDelegate(fs.readFileSync(scenePath, 'utf8')));
      assertAppDelegateDoesNotStartReact(
        fs.readFileSync(IOSConfig.Paths.getAppDelegateFilePath(cfg.modRequest.projectRoot), 'utf8')
      );
      return cfg;
    },
  ]);
};

module.exports.patchSceneDelegate = patchSceneDelegate;
module.exports.assertAppDelegateDoesNotStartReact = assertAppDelegateDoesNotStartReact;
module.exports.SCENE_WILL_CONNECT = SCENE_WILL_CONNECT;
