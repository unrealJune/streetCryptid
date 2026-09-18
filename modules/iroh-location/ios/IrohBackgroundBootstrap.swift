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

    // 3. Rust telemetry. The OTLP layer is dormant until something hands it an endpoint, and on a
    //    launch with no JS there is nothing to. Re-applied from what JS last configured.
    let defaults = UserDefaults.standard
    if let endpoint = defaults.string(forKey: "sc.otel.endpoint"), !endpoint.isEmpty {
      let instance = defaults.string(forKey: "sc.otel.instance_id") ?? "bg"
      _ = configureTelemetry(endpoint: endpoint, instanceId: instance)
    }

    NSLog(
      "[iroh-location] bootstrap: background=\(background) location_launch="
        + "\(launchOptions?[.location] != nil) armed=\(BackgroundLocationRuntime.wasArmed)")

    // 4. Arm the Core Location ladder if sharing was on when we last ran.
    //
    //    Ownership is deliberately NOT taken here. Arming is safe on every launch — `start()` is
    //    idempotent and the ladder is what brings a terminated app back — but taking the stores is
    //    not: `start()` seeds the gate from `manager.location`, which fires an `ingest` and
    //    therefore `ensureStarted()`. With ownership left at `.app` that returns on its first line,
    //    so a foreground launch behaves exactly as it always has. Only a launch that decides not to
    //    start React calls `adoptNodeOwnership()`.
    if BackgroundLocationRuntime.wasArmed {
      BackgroundLocationRuntime.shared.start()
    }

    // MUST be true — see the note above about the subscriber reduction.
    return true
  }

  public func applicationDidEnterBackground(_ application: UIApplication) {
    BackgroundWakeLedger.openWindow()
  }

  public func applicationWillEnterForeground(_ application: UIApplication) {
    BackgroundWakeLedger.closeWindow()
  }
}
