import CoreLocation
import Foundation
import UIKit

/// An iroh node driven straight from Core Location, with no JS in the loop.
///
/// The iOS counterpart of `BackgroundLocationService.kt`. It removes the same dependency — a fix
/// that arrives can be sealed and sent without a headless JS context existing — but it is worth
/// being clear about what it does *not* fix.
///
/// ## What this fixes on iOS, and what it does not
///
/// On Android the diagnosed failure was a JS context that never started while the OS delivered
/// location normally: 446 real fixes spooled over eleven and a half hours. Removing JS from that
/// path fixes it outright.
///
/// iOS failed differently. On 2026-08-29 an iPhone's `payload_ts` was frozen for nineteen hours —
/// Core Location delivered *nothing at all*, and the app's own `bg.refresh` never ran once in
/// thirty hours despite reading `registered` and `available`. This runtime asks the same scheduler
/// for the same updates, so it inherits that starvation. What it buys is that every fix iOS *does*
/// deliver now reaches the wire, instead of needing a JS context that may also be gone, and that
/// the queue survives in native storage between them.
///
/// ## Relationship to the JS pipeline
///
/// They cannot both run: the Rust stores take a process-wide directory claim, so whichever starts
/// first owns the counter and the queue and the other stands down. That needs no agreement between
/// them — see `durable.rs`, and `native-runtime-owner.ts` for what the coordinated version cost.
final class BackgroundLocationRuntime: NSObject, CLLocationManagerDelegate {
  static let shared = BackgroundLocationRuntime()

  /// The publish cadence, mirroring `DEFAULT_SHARE_INTERVAL_MS`. It is the *slot* interval, not the
  /// sampling rate: the gate absorbs everything inside a slot, so asking for updates more often
  /// buys a fresher position at a slot boundary rather than more envelopes.
  private let slotIntervalMs: UInt64 = 5 * 60 * 1000

  private let manager = CLLocationManager()
  private let queue = DispatchQueue(label: "com.unrealjune.irohlocation.background-runtime")
  private var node: LocationNode?
  private var subscription: Subscription?
  private var running = false

  private override init() {
    super.init()
    manager.delegate = self
    manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
    // 50 m, matching `AMBIENT_DISTANCE_INTERVAL_M`. On iOS `timeInterval` is ignored entirely, so
    // the distance filter is the only hardware-facing control we have — see the note in
    // `sampling-policy.ts` about live mode having had no rate limit at all because of this.
    manager.distanceFilter = 50
    manager.activityType = .other
    // FALSE, and this is the single most consequential line in the file.
    //
    // Apple recommends auto-pause for apps whose tracking *session ends* — navigation that arrives,
    // a workout that finishes. Ambient friend-location never ends, and on 2026-08-29 the difference
    // cost an iPhone nineteen hours. Core Location decided the phone was stationary, stopped
    // delivering, and every route back is gated on MOVEMENT: significant-change monitoring and the
    // region fence both fire only when the phone goes somewhere. A phone that pauses and then stays
    // put has no way back at all, and looks from the outside exactly like a phone that is working —
    // the app stayed alive throughout, ran a full session at 01:57 and burned 39 sequence numbers
    // publishing heartbeats, all carrying a position Core Location had stopped updating.
    //
    // The battery cost is real and is the reason the JS path chose the other way; it is bounded by
    // `distanceFilter` above rather than by the OS pausing us, which is a control we can actually
    // reason about. See the delegate callbacks below, which make the pause visible either way.
    manager.pausesLocationUpdatesAutomatically = false
  }

  /// Begin background location updates. Idempotent.
  func start() {
    guard !running else { return }
    // Without this the app stops receiving updates the moment it is backgrounded, which is the
    // entire window this exists to cover. It requires the `location` UIBackgroundMode.
    manager.allowsBackgroundLocationUpdates = true
    // Ask iOS to relaunch us into the background after a termination. Distinct from the updates
    // themselves: this is what gets a killed app a second chance at all.
    manager.startMonitoringSignificantLocationChanges()
    manager.startUpdatingLocation()
    running = true
  }

  func stop() {
    guard running else { return }
    manager.stopUpdatingLocation()
    manager.stopMonitoringSignificantLocationChanges()
    manager.allowsBackgroundLocationUpdates = false
    running = false
    queue.async { self.teardown() }
  }

  // MARK: - CLLocationManagerDelegate

  func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
    guard let location = locations.last else { return }
    let fix = Self.fix(from: location)
    let battery = Self.battery()
    Task { await self.publish(fix: fix, battery: battery) }
  }

  /// Core Location paused us anyway.
  ///
  /// It should not happen with `pausesLocationUpdatesAutomatically` off, but "should not" is what
  /// the last nineteen hours of silence were built on. `expo-location` implements neither this
  /// callback nor its counterpart, which is precisely why the pause was invisible: no span, no log,
  /// no watermark, and a phone indistinguishable from one whose owner simply had not moved.
  ///
  /// Restarting immediately is the only recovery that is not gated on movement. If Core Location
  /// pauses us again straight away we will have learned something worth knowing, and the log line
  /// is what will say so.
  func locationManagerDidPauseLocationUpdates(_ manager: CLLocationManager) {
    NSLog("[iroh-location] Core Location paused updates; restarting")
    manager.startUpdatingLocation()
  }

  func locationManagerDidResumeLocationUpdates(_ manager: CLLocationManager) {
    NSLog("[iroh-location] Core Location resumed updates")
  }

  func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
    // Not fatal and not rare — a denied authorisation or a momentary lack of any fix both land
    // here. The app surfaces authorisation state itself; this line is for the rest.
    NSLog("[iroh-location] background location error: \(error.localizedDescription)")
  }

  // MARK: - Node lifecycle

  private func publish(fix: LocationFix, battery: BatteryState) async {
    guard let subscription = await ensureStarted() else { return }
    do {
      let outcome = try await subscription.ingestFix(
        subscriptionId: Self.subscriptionId,
        fix: fix,
        battery: battery,
        intervalMs: slotIntervalMs,
        nowMs: UInt64(Date().timeIntervalSince1970 * 1000))
      // One line per wake that did something, so a quiet phone and a broken one look different in
      // the device log. The equivalent spans reach the collector from the Rust side.
      if outcome.enqueued > 0 || outcome.published > 0 {
        NSLog(
          "[iroh-location] wake: enqueued=\(outcome.enqueued) published=\(outcome.published) "
            + "pending=\(outcome.pending) suspended=\(outcome.suspended)")
      }
    } catch {
      // The fix stays in the native outbox, so the next delivery retries it.
      NSLog("[iroh-location] ingest failed, fix stays queued: \(error.localizedDescription)")
    }
  }

  /// Build and start a node from Keychain-held state, unless one is already running.
  ///
  /// `nil` means this process should not have a background node — the app owns the stores, or the
  /// device has no identity yet. Both are ordinary.
  private func ensureStarted() async -> Subscription? {
    if let subscription { return subscription }
    guard KeychainDeviceSecrets.shared.identitySecret() != nil else {
      // A fresh install whose app has never run. Minting an identity here would create one no
      // friend has paired with and orphan the one the app makes later.
      return nil
    }
    do {
      let roots = nodeStorageRoots()
      let built = try LocationNode.fromDeviceSecrets(
        secrets: KeychainDeviceSecrets.shared,
        dataRoot: roots.data.path,
        stateRoot: roots.state.path)
      try await built.startStored()
      let sub = try await built.subscribe(
        topic: deriveTopic(authorEndpointId: built.endpointId()),
        bootstrap: [],
        listener: SilentFixListener())
      node = built
      subscription = sub
      return sub
    } catch {
      // The store claim refusing is the common case and means the app is mounted and already
      // publishing — expected, not a fault.
      NSLog("[iroh-location] background node not started: \(error.localizedDescription)")
      teardown()
      return nil
    }
  }

  private func teardown() {
    subscription = nil
    node = nil
  }

  // MARK: - Conversions

  private static func fix(from location: CLLocation) -> LocationFix {
    LocationFix(
      lat: location.coordinate.latitude,
      lon: location.coordinate.longitude,
      // A negative accuracy means Core Location could not determine one — NOT that it is perfect.
      // Zero is how the gate spells "untestable", so it skips the check rather than passing it.
      accuracyM: location.horizontalAccuracy >= 0 ? location.horizontalAccuracy : 0,
      headingDeg: location.course >= 0 ? location.course : 0,
      ts: UInt64(location.timestamp.timeIntervalSince1970 * 1000))
  }

  /// Unknown battery reports as full rather than empty: a critical level is a hard stop in the
  /// gate, so a device we cannot read must not look flat and stop publishing forever.
  private static func battery() -> BatteryState {
    UIDevice.current.isBatteryMonitoringEnabled = true
    let level = UIDevice.current.batteryLevel
    let state = UIDevice.current.batteryState
    return BatteryState(
      level: level >= 0 ? Double(level) : 1.0,
      charging: state == .charging || state == .full,
      lowPower: ProcessInfo.processInfo.isLowPowerModeEnabled)
  }

  /// Accepted for API parity and ignored: a node owns a single trail namespace, so the Rust side
  /// takes this as `_subscription_id`.
  private static let subscriptionId = "background"
}

/// Inbound fixes still land in the durable replica; nothing here needs to surface them.
private final class SilentFixListener: FixListener {
  func onFix(author: Data, seq: UInt64, fix: LocationFix, backfill: Bool, via: String) {}
  func onOpaque(author: Data, seq: UInt64) {}
  func onStatus(status: String) {}
  func onRatchetEvent(event: RatchetEvent) {}
}
