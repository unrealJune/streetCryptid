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
/// subscriber runs AFTER the app delegate's own, which is where `startReactNative` is called, so it
/// would be too late to matter. `willFinishLaunching` is the one hook that runs on the main thread,
/// after `main()`, and before React.
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

    // 2. The wake ledger, before anything can spend the budget it is measuring.
    let background = application.applicationState == .background
    BackgroundWakeLedger.noteLaunch(background: background)

    // 3. Rust telemetry, but ONLY on a launch that will not start React.
    //
    //    The OTLP layer is dormant until something hands it an endpoint, and a JS-free wake has
    //    nothing to hand it one. A FOREGROUND launch does — `init()` calls `configureTelemetry`
    //    within a second — and doing it here as well means Rust reconfigures, which begins by
    //    shutting the previous pipeline down and blocks on the exporter's blocking HTTP client.
    //    Caught on the simulator doing exactly that: the launch stalled inside the
    //    `mirror-secrets` phase. `TelemetryConfigurator` makes
    //    a repeat call idempotent regardless; this gate is the other half, so a foreground launch
    //    does no telemetry work at all before React is up.
    if background, let persisted = TelemetryConfigurator.persisted {
      TelemetryConfigurator.apply(
        endpoint: persisted.endpoint, instanceId: persisted.instanceId, remember: false)
    }

    NSLog(
      "[iroh-location] bootstrap: background=\(background) location_launch="
        + "\(launchOptions?[.location] != nil) armed=\(BackgroundLocationRuntime.wasArmed)")

    // 4. Arm the Core Location ladder if sharing was on when we last ran.
    //
    //    Only on a launch with no JS coming, for the same reason as the telemetry gate above: a
    //    foreground launch reaches `startNativeBackground` within a second and arms the ladder
    //    properly, with the event sink wired. Arming it here first would make that later call a
    //    no-op (`start()` is idempotent) and strand the gate seed this call captured before any
    //    sink existed — see `seedGateFromCache`. Gating keeps a foreground launch byte-for-byte
    //    what it was before this file existed.
    //
    //    Ownership is deliberately NOT taken even here. Taking it is what lets this runtime build
    //    its own node, and nothing should do that while React is still going to start; the launch
    //    that skips React is the one that calls `adoptNodeOwnership()`.
    let locationLaunch = launchOptions?[.location] != nil
    let jsFree = Self.decideReactNativeDeferral(background: background)
    if BackgroundLocationRuntime.wasArmed && (background || locationLaunch) {
      // A launch with no JS coming is the one case this runtime must own the stores, because
      // nothing else will ever claim them. `ensureStarted` returns on its first line until it
      // does, so this is what turns the whole native path from scaffolding into the live one.
      // The app takes them back through `handOverNativeBackground` if it is ever opened.
      if jsFree { BackgroundLocationRuntime.shared.adoptNodeOwnership() }
      BackgroundLocationRuntime.shared.start()
    }

    // MUST be true — see the note above about the subscriber reduction.
    return true
  }

  /// Decide — once — whether React Native will be started on this launch, and publish the answer.
  ///
  /// The AppDelegate makes the same call a moment later in `didFinishLaunchingWithOptions`, and two
  /// copies of a predicate this load-bearing WILL drift: one of them says "own the stores" and the
  /// other says "start React", and the pair that disagrees is a mounted app that cannot claim its
  /// own node. So it is computed here, where the state is legible, and read from UserDefaults by
  /// the generated AppDelegate — which cannot import this module and should not have to.
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

  public func applicationDidEnterBackground(_ application: UIApplication) {
    BackgroundWakeLedger.openWindow()
  }

  public func applicationWillEnterForeground(_ application: UIApplication) {
    BackgroundWakeLedger.closeWindow()
  }
}
