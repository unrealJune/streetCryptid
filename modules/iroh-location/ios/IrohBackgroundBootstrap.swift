import ExpoModulesCore
import Foundation
import UIKit

/// Everything that has to happen before — or without — React Native.
///
/// ## Why a subscriber and not the module's `OnCreate`
///
/// An Expo module is created when the JS module registry is built, which means every line of
/// `IrohLocationModule.definition()` is downstream of the JavaScript bundle loading. That is fine
/// while every launch starts React. It stops being fine the moment a background launch does not,
/// and it was already not fine for MetricKit: a payload arrives shortly after the launch FOLLOWING
/// the crash and is never redelivered, so a subscriber registered when JS first asks would miss
/// every launch that matters.
///
/// ## Why `willFinishLaunchingWithOptions`
///
/// `subscriberDidRegister()` runs from `+load`, before `main()` — far too early to be building a
/// `CLLocationManager` or touching `MXMetricManager`. `didFinishLaunchingWithOptions` on a
/// subscriber runs AFTER the app delegate's own. `willFinishLaunching` is the one hook that runs on
/// the main thread, after `main()`, and before anything else.
///
/// ## Why the launch is classified LATER (SDK 58, the scene life cycle)
///
/// The iOS 27 SDK requires the UIKit scene life cycle, and under it React is started by the scene
/// delegate when a scene connects — after both app-delegate launch callbacks. It also takes away the
/// signal this file used to decide with: `applicationState` describes the app's scenes, and before
/// any has connected it is not evidence that the launch is a background one. So the work only a
/// background launch does is no longer done here but by `IrohLaunchClassifier`, once, from the best
/// evidence there is: the `.location` launch key, else the activation state of the first scene to
/// connect, else — no scene by the time the launch has finished — a background launch, which is the
/// only kind that ends without one.
///
/// ## The return value is load-bearing
///
/// `ExpoAppDelegateSubscriberManager` reduces subscribers with `?? false || result`, and
/// short-circuits to `true` only when NO subscriber implements the method. Once ours does, the
/// reduction starts at `false` — so returning anything but `true` here breaks universal-link cold
/// launches, and `associatedDomains: applinks:streetcrypt.id` is a live path.
public class IrohBackgroundAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    willFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    // 1. MetricKit, first and unconditionally. `start()` is idempotent, and the module's `OnCreate`
    //    still calls it — this is the earlier of two registrations, not a move.
    MetricKitDiagnostics.shared.start()

    // 1a. The parked-phone wake. `BGTaskScheduler` insists every handler is registered before the
    //     app finishes launching — on EVERY launch, including the one it launches us for.
    NativeRefreshTask.register()

    // 2. Build the location runtime HERE, on the main thread, on every launch — foreground ones
    //    included, and before anything decides whether to start it.
    //
    //    Core Location delivers to the run loop of the thread that created the manager. Leave the
    //    first touch to JS and it lands on a bridge thread — `handOverNativeBackground` is an
    //    `AsyncFunction`, so a Swift concurrency worker with no run loop — and the process never
    //    receives a single location. Construction only: nothing is armed or started by it, and a
    //    launch that is not sharing pays for one idle `CLLocationManager`. See
    //    `BackgroundLocationRuntime.shared`.
    _ = BackgroundLocationRuntime.shared

    // 3. Everything that depends on whether this is a background launch. See the type docs.
    IrohLaunchClassifier.begin(locationLaunch: launchOptions?[.location] != nil)

    // MUST be true — see the note above about the subscriber reduction.
    return true
  }

  /// What depends on the kind of launch. Called exactly once per process, on main, by
  /// `IrohLaunchClassifier`.
  static func finishLaunch(background: Bool, locationLaunch: Bool, via: String) {
    // The wake ledger, before anything can spend the budget it is measuring. A scene-classified
    // launch reaches here a moment after `willFinishLaunching`, inside the same launch transaction.
    BackgroundWakeLedger.noteLaunch(background: background)

    // Rust telemetry, but ONLY on a launch that will not start React.
    //
    // The OTLP layer is dormant until something hands it an endpoint, and a JS-free wake has
    // nothing to hand it one. A FOREGROUND launch does — `init()` calls `configureTelemetry` within
    // a second — and doing it here as well means Rust reconfigures, which begins by shutting the
    // previous pipeline down and blocks on the exporter's blocking HTTP client. Caught on the
    // simulator doing exactly that: the launch stalled inside the `mirror-secrets` phase.
    // `TelemetryConfigurator` makes a repeat call idempotent regardless; this gate is the other
    // half, so a foreground launch does no telemetry work at all before React is up.
    if background, let persisted = TelemetryConfigurator.persisted {
      TelemetryConfigurator.apply(
        endpoint: persisted.endpoint, instanceId: persisted.instanceId, remember: false)
    }

    NSLog(
      "[iroh-location] bootstrap: background=\(background) via=\(via) location_launch="
        + "\(locationLaunch) armed=\(BackgroundLocationRuntime.wasArmed)")

    // Arm the Core Location ladder if sharing was on when we last ran.
    //
    // Only on a launch with no JS coming, for the same reason as the telemetry gate above: a
    // foreground launch reaches `startNativeBackground` within a second and arms the ladder
    // properly, with the event sink wired. Arming it here first would make that later call a no-op
    // (`start()` is idempotent) and strand the gate seed this call captured before any sink existed
    // — see `seedGateFromCache`. Gating keeps a foreground launch's ladder exactly as JS arms it.
    //
    // There is no ownership decision here any more. The runtime used to have to be told it could
    // build a node (`adoptNodeOwnership`), and the app had to take the stores back if it was opened
    // later. Both now hold leases on ONE node through `NodeHost`, so a delivery on a JS-free launch
    // simply acquires it, and an app opened later adopts the same one.
    //
    // A process nobody opened is one iOS will not keep running, and the stop it is dwelling on may
    // have to be declared before it has been proven. See `speculativeStop`.
    BackgroundLocationRuntime.launchedInBackground = background || locationLaunch
    // Published on every launch, whatever this launch does with it — see the function.
    _ = decideReactNativeDeferral(background: background)
    if BackgroundLocationRuntime.wasArmed && (background || locationLaunch) {
      BackgroundLocationRuntime.shared.start()
    }
  }

  /// Decide — on EVERY launch, and again for every scene that connects — whether React Native will
  /// be started, and publish it.
  ///
  /// Rewriting the flag unconditionally is the safety property. The generated `SceneDelegate`
  /// posts `IrohLaunchClassifier.sceneWillConnect` synchronously before it reads the flag, so the
  /// value it reads is always this scene's. Skip the write on some path and a `true` left by a
  /// background launch would still be sitting there on the next foreground one — an app that does
  /// not start React until it reaches the foreground, which is the fallback (the scene delegate
  /// starts a deferred scene on its way there), not the path.
  ///
  /// Two copies of a predicate this load-bearing WILL drift: one of them says "own the stores" and
  /// the other says "start React", and the pair that disagrees is a mounted app that cannot claim
  /// its own node. So it is computed here, where the state is legible, and read from UserDefaults
  /// by the generated SceneDelegate — which cannot import this module and should not have to.
  ///
  /// DEBUG never defers: `expo-dev-launcher` owns the React delegate seam in dev-client builds, so
  /// deferring there is both unnecessary and hard to reason about.
  static func decideReactNativeDeferral(background: Bool) -> Bool {
    let defaults = UserDefaults.standard
#if DEBUG
    let defer_ = false
#else
    let killed = defaults.bool(forKey: "sc.bg.defer_rn_disabled")
    let defer_ = background && !killed
#endif
    defaults.set(defer_, forKey: "sc.bg.rn_deferred")
    return defer_
  }

  // Under the scene life cycle UIKit no longer calls these on the app delegate; ExpoAppSceneDelegate
  // forwards the scene's own transitions to every subscriber instead.

  public func applicationDidEnterBackground(_ application: UIApplication) {
    BackgroundWakeLedger.enterBackground()
    // Keep a wake requested whenever we leave the screen; iOS may have run and consumed the last.
    NativeRefreshTask.schedule()
  }

  public func applicationWillEnterForeground(_ application: UIApplication) {
    BackgroundWakeLedger.enterForeground()
  }
}

/// Classifies this launch — once per process — and runs `finishLaunch` with the answer.
///
/// Evidence, strongest first:
/// 1. `UIApplication.LaunchOptionsKey.location`: a location relaunch, decided in
///    `willFinishLaunching` itself.
/// 2. The activation state of the first scene to connect: `.background` is a background launch,
///    anything else is someone opening the app. The generated `SceneDelegate` posts
///    `sceneWillConnect` before it decides whether to start React, so the decision it reads is
///    this one.
/// 3. No scene by the first main-queue turn after `willFinishLaunching`: a background launch (a
///    BGTask, a region crossing), since a launch someone opened connects its scene synchronously,
///    inside the launch transaction.
///
/// The `via=` in the bootstrap log says which. `no-scene` on a launch someone opened would mean
/// UIKit connected the scene later than that first turn. React would still start — the scene
/// delegate starts a deferred scene on its way to the foreground — but the ladder and telemetry
/// would have been armed before JS, which is the thing to look for if that line is ever wrong.
enum IrohLaunchClassifier {
  /// Must match `SCENE_WILL_CONNECT` in `plugins/withDeferredReactNativeStart.js`.
  static let sceneWillConnect = Notification.Name("IrohLocationSceneWillConnect")

  private static var decided = false
  private static var observer: NSObjectProtocol?

  static func begin(locationLaunch: Bool) {
    // `queue: nil` runs the block synchronously on the posting thread — the scene delegate, on
    // main — so the decision is published before the scene reads it.
    observer = NotificationCenter.default.addObserver(
      forName: sceneWillConnect, object: nil, queue: nil
    ) { note in
      let background = (note.object as? UIScene)?.activationState == .background
      if decide(background: background, locationLaunch: locationLaunch, via: "scene") { return }
      // Already classified: a background launch, and now a scene — usually someone opening the
      // app later. Only the React decision is this scene's to make.
      _ = IrohBackgroundAppDelegateSubscriber.decideReactNativeDeferral(background: background)
    }

    if locationLaunch {
      decide(background: true, locationLaunch: true, via: "location")
      return
    }
    DispatchQueue.main.async {
      decide(background: true, locationLaunch: false, via: "no-scene")
    }
  }

  /// Runs `finishLaunch` the first time it is called. Returns whether this call was that one.
  @discardableResult
  private static func decide(background: Bool, locationLaunch: Bool, via: String) -> Bool {
    guard !decided else { return false }
    decided = true
    IrohBackgroundAppDelegateSubscriber.finishLaunch(
      background: background, locationLaunch: locationLaunch, via: via)
    return true
  }
}
