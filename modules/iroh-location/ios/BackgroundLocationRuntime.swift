import CoreLocation
import Foundation
import UIKit

/// An iroh node driven straight from Core Location, with no JS in the loop.
///
/// The iOS counterpart of `BackgroundLocationService.kt`. It removes the same dependency — a fix
/// that arrives can be sealed and sent without a headless JS context existing — but iOS needs a
/// good deal more than that, because the OS gives us no timers and no daemons.
///
/// ## The rule this file is built around
///
/// **Every piece of periodic work has to be parasitic on a Core Location callback.** There is no
/// other clock. A `Timer` does not survive suspension, a JS `setInterval` does not survive
/// suspension, and `BGTaskScheduler` fires a handful of times a day. So the only things that can
/// wake this app are: a location delivery, a geofence crossing, a significant-location-change
/// relaunch, or a push. Anything designed around a cadence works on a desk and fails in a pocket.
///
/// ## What went wrong before this rewrite
///
/// Two incidents, one file:
///
/// - 2026-08-29, an iPhone's `payload_ts` froze for nineteen hours while the app stayed alive and
///   burned 39 sequence numbers on heartbeats. `pausesLocationUpdatesAutomatically` had paused
///   updates and every route back was gated on MOVEMENT. That is why the flag is `false` below.
/// - 2026-08-30, an iPhone sat at home for 88 minutes with `task.location_running = true`,
///   `Always` authorization, one recipient — and published nothing at all. Two causes, both fixed
///   here. A 50 m `distanceFilter` means a phone in a living room never generates a delivery, so
///   the process is suspended and nothing runs; and nothing ever seeded the gate, so the native
///   `heartbeat` had no position to repeat and returned 0 every time it was asked (see the
///   `last_known_fix` guard in `publish.rs`, and the cold-start escape in `gate.rs`).
///
/// The fix for the second is the `stopped` state below: when the phone settles we stop the precise
/// stream, drop to a **coarse** Wi-Fi/cell-derived stream that costs no GPS, and let each of those
/// cheap deliveries drive a heartbeat. That keeps the process alive and the cadence uniform while
/// someone sits on their sofa, which is the single most common thing a user does.
///
/// ## Relationship to the JS pipeline
///
/// They cannot both run: the Rust stores take a process-wide directory claim, so whichever starts
/// first owns the counter and the queue and the other stands down. That needs no agreement between
/// them — see `durable.rs`, and `native-runtime-owner.ts` for what the coordinated version cost.
final class BackgroundLocationRuntime: NSObject, CLLocationManagerDelegate {
  static let shared = BackgroundLocationRuntime()

  // MARK: - Vocabulary

  /// Where the phone is in the moving/stopped cycle.
  ///
  /// There is deliberately no `dark` case. Darkness is the absence of contact and only the server
  /// can observe it; a client that believed it was dark would be a client that was still running.
  enum MotionState: String {
    case moving
    case stopped
  }

  /// Why this runtime is executing right now.
  ///
  /// Stamped on every log line and reported to `device.health`. With five interleaving wakeup paths
  /// running on hardware we do not own, "why did this phone go quiet at 23:00" is either a field on
  /// a record or it is tea leaves.
  /// Only reasons we can actually tell apart appear here. There is deliberately no `slc` case:
  /// a significant-location-change delivery arrives through `didUpdateLocations` looking exactly
  /// like any other, so claiming to distinguish it would be a field that lies. What separates an SLC
  /// relaunch from a running app is `relaunch`, which is what a cold start reports.
  enum WakeReason: String {
    /// A delivery on the precise stream, i.e. the phone is going somewhere.
    case movement
    /// A tick on the coarse stream while parked. Not movement — a clock.
    case periodic
    case geofenceExit = "geofence_exit"
    /// The parked clock reported us confidently away from the anchor, and the fence had not said
    /// so. See `considerDeparture(from:)` — this reason appearing at all means the fence is
    /// unreliable on that device, which is worth being able to count.
    case coarseDeparture = "coarse_departure"
    case relaunch
    case stateChange = "state_change"
    case seed
  }

  // MARK: - Tuning

  /// Radius of the stop-anchor exit fence. A tuning knob, not a constant of nature: too small and
  /// GPS jitter causes false exits and battery churn, too large and we look laggy when someone
  /// leaves the house. 100 m is the starting guess; `bg.stop_anchor` telemetry carries the
  /// re-entry-within-two-minutes rate that should tune it.
  private static let stopAnchorRadiusM: CLLocationDistance = 100

  /// How far fixes may wander from the candidate anchor and still count as "not going anywhere".
  private static let stopJitterRadiusM: CLLocationDistance = 50

  /// How long the phone must stay inside `stopJitterRadiusM` before we believe it has stopped.
  /// Belt and braces on purpose — `CLLocation.speed` alone is not trustworthy in the field.
  private static let stopDwellSeconds: TimeInterval = 180

  /// The accuracy we ask for while a stop candidate is dwelling.
  ///
  /// Deliberately not the speed tier's choice. The dwell runs an *unfiltered* stream (see
  /// `holdCandidateCadence`) and the 0.5-3 m/s tier asks for `kCLLocationAccuracyNearestTenMeters`,
  /// which is GPS — unfiltered GPS on a phone that is nearly stationary is a battery hole. This is
  /// the file's ambient default instead: Wi-Fi/cell derived, comfortably inside the confidence
  /// gate's 150 m rejection, and precise enough to centre a 100 m fence on.
  private static let candidateAccuracy: CLLocationAccuracy = kCLLocationAccuracyHundredMeters

  /// The accuracy we ask for while stopped. Wi-Fi/cell derived: it does not spin up GPS, so it is
  /// nearly free, and it is the only thing that keeps the process alive and ticking on a phone
  /// that is not moving. The gate refuses these as *positions* (they land far past
  /// `max_accuracy_m`), which is correct — they are used as a clock, not as a location.
  private static let stoppedAccuracy: CLLocationAccuracy = kCLLocationAccuracyThreeKilometers

  private static let stopAnchorRegionId = "sc.stop-anchor"

  // MARK: - State

  /// The publish cadence. It is the *slot* interval, not the sampling rate: the gate absorbs
  /// everything inside a slot, so asking for updates more often buys a fresher position at a slot
  /// boundary rather than more envelopes.
  private var slotIntervalMs: UInt64 = 5 * 60 * 1000

  /// What the sampling policy last asked for while moving. Held separately from what is programmed
  /// on the manager, because `stopped` deliberately overrides both and has to be able to put them
  /// back on exit.
  private var movingAccuracy: CLLocationAccuracy = kCLLocationAccuracyHundredMeters
  private var movingDistanceFilter: CLLocationDistance = 50

  private let manager = CLLocationManager()
  private let queue = DispatchQueue(label: "com.unrealjune.irohlocation.background-runtime")
  private var node: LocationNode?
  private var subscription: Subscription?
  private var running = false

  private var state: MotionState = .moving
  private var lastWakeReason: WakeReason = .relaunch
  private var lastWakeAt: Date?

  /// Where a captured fix goes when this runtime cannot own the node.
  ///
  /// The writer claim in `durable.rs` is **process-wide**, and on iOS the mounted app and this
  /// runtime are the same process using the same `nodeStorageRoots()`. So whenever the app is open
  /// it has already claimed the stores and `ensureStarted()` returns nil here — always, not
  /// occasionally. That was survivable while a JS `watchPositionAsync` covered the mounted case;
  /// once capture moved into Rust and that watcher was deleted, it meant a foregrounded app
  /// captured fixes and dropped every one of them on the floor. A fresh install could pair, sit
  /// there with the map open, and never publish anything at all.
  ///
  /// Handing the fix to JS is not a fallback path, it is the mounted path. The mounted runtime
  /// owns the node, so it is the only thing that *can* publish; this side is the sensor.
  weak var eventSink: IrohLocationModule?

  /// The coordinate the stop fence is centred on. Persisted, because a cold launch has to be able
  /// to re-arm the fence before anything else runs.
  private var stopAnchor: CLLocation?

  /// The most recent position from either stream, however coarse. Not a published fix and never
  /// used as one — it exists so `healthSnapshot` can report how far a parked phone has drifted from
  /// its anchor, which is the difference between "still at home" and "the fence is not firing".
  private var lastSeenLocation: CLLocation?

  /// When the phone first entered the jitter radius of the current stop candidate. `nil` while
  /// moving or once the stop is confirmed.
  private var stopCandidate: (centre: CLLocation, since: Date)?

  /// The centre of a fence armed *speculatively*, around a stop candidate, while still `moving`.
  ///
  /// Distinct from `stopAnchor`, which asserts "we are parked here". This one says only "we might
  /// be about to be", and it exists because the confirmation that would promote it cannot be
  /// relied on to arrive — see `considerStopping`. Not persisted: a guess is not worth restoring
  /// across a launch, and a stop that was real got promoted to `stopAnchor` before we died.
  private var candidateFence: CLLocation?

  private override init() {
    super.init()
    manager.delegate = self
    manager.desiredAccuracy = movingAccuracy
    manager.distanceFilter = movingDistanceFilter
    manager.activityType = .other
    // FALSE, and this is still the single most consequential line in the file.
    //
    // Apple recommends auto-pause for apps whose tracking *session ends* — navigation that arrives,
    // a workout that finishes. Ambient friend-location never ends, and on 2026-08-29 the difference
    // cost an iPhone nineteen hours: Core Location decided the phone was stationary, stopped
    // delivering, and every route back was gated on movement. A phone that pauses and then stays
    // put has no way back at all.
    //
    // We replace the system's pause with the `stopped` state below, which is the same idea done
    // where we can see it: we choose when to stop the precise stream, we leave a fence that fires
    // on exit, and we keep a cheap tick running so the silence is legible.
    manager.pausesLocationUpdatesAutomatically = false
    // With `Always` there is no blue pill, and asking for one would advertise a background session
    // the user has already consented to in the permission sheet.
    manager.showsBackgroundLocationIndicator = false
    restorePersistedState()
  }

  /// Whether this runtime is the one currently receiving locations.
  ///
  /// `device.health` reports it, because "sharing is on" and "something is actually being handed
  /// positions" are different claims and the gap between them is the entire background failure.
  var isRunning: Bool { running }

  /// What `device.health` needs to tell a stationary phone apart from a broken one.
  ///
  /// Every field here answers a question that was previously unanswerable from the outside: which
  /// state the machine is in, why it last ran, whether the fence that is supposed to resurrect it
  /// actually exists, and whether the authorization it was started under still holds.
  var healthSnapshot: [String: Any] {
    var snapshot: [String: Any] = [
      "running": running,
      "state": state.rawValue,
      "wake_reason": lastWakeReason.rawValue,
      // `auth_status`, not `authorization`: the telemetry event log redacts any key matching
      // /authorization|password|psk|secret|ticket|token/i — a rule meant for HTTP headers that would
      // otherwise ship this as `[REDACTED]` and hide the one field that says whether the user
      // downgraded us. The design doc's heartbeat payload spells it this way too.
      "auth_status": Self.authorizationName(manager.authorizationStatus),
      "precise": manager.accuracyAuthorization == .fullAccuracy,
      "anchor_armed": stopAnchor != nil,
      "fence_registered": manager.monitoredRegions.contains {
        $0.identifier == Self.stopAnchorRegionId
      },
      "slc_available": CLLocationManager.significantLocationChangeMonitoringAvailable(),
      // A candidate pending while `moving` is the window this phone is most fragile in, and it had
      // no reporting at all until 2026-09-02, when an iPhone spent two hours inside it. `moving` +
      // pending + a fence that is only `candidate_fence_armed` is a stop that has not converted;
      // if `candidate_age_ms` keeps climbing past `stopDwellSeconds`, the dwell is being starved of
      // deliveries and `holdCandidateCadence` is not doing its job.
      "candidate_pending": stopCandidate != nil,
      "candidate_fence_armed": candidateFence != nil,
    ]
    if let stopCandidate {
      snapshot["candidate_age_ms"] = Int(Date().timeIntervalSince(stopCandidate.since) * 1000)
    }
    if let lastWakeAt {
      snapshot["last_wake_age_ms"] = Int(Date().timeIntervalSince(lastWakeAt) * 1000)
    }
    if let stopAnchor {
      snapshot["anchor_age_ms"] = Int(Date().timeIntervalSince(stopAnchor.timestamp) * 1000)
      // How far the last position we saw was from the fence we are parked behind.
      //
      // The field that would have ended the 2026-08-31 investigation in one query. Every other
      // attribute on a phone parked through a commute reads healthy — armed, authorised, running,
      // fence registered — and "still parked" is indistinguishable from "still at home" without
      // this. A `stopped` record whose distance is kilometres is a fence that is not firing.
      if let lastSeen = lastSeenLocation {
        snapshot["anchor_distance_m"] = Int(lastSeen.distance(from: stopAnchor))
      }
    }
    return snapshot
  }

  /// Whether background location is actually usable, as Core Location sees it right now.
  ///
  /// Read on demand rather than sampled once at start. `startBackground` used to latch its answer
  /// from a single `requestAlwaysAuthorization` round-trip, and on a fresh install that call
  /// returns before the delegate has settled — so a phone holding `authorizedAlways` spent an
  /// evening showing "allow background location" and reporting `access=foreground`.
  var hasBackgroundAuthorization: Bool {
    manager.authorizationStatus == .authorizedAlways
  }

  // MARK: - Lifecycle

  /// Begin background location updates. Idempotent.
  ///
  /// Order matters and is the same order `didFinishLaunchingWithOptions` should use: **arm the
  /// resurrection ladder before anything that can throw or hang.** If the node fails to build, or
  /// the store claim is refused, or we are killed two lines from now, the phone must still be able
  /// to come back.
  func start() {
    guard !running else { return }

    // Rung 1. Armed always, never stopped, and first. This is the only mechanism that relaunches a
    // *terminated* app, and standard location updates emphatically are not one.
    manager.startMonitoringSignificantLocationChanges()
    // Rung 2. If we were stopped when we died, the fence we died holding is what brings us back.
    rearmStopAnchorFence()

    manager.allowsBackgroundLocationUpdates = true
    running = true

    // A background launch is amnesia: `restorePersistedState` has put the state machine back, so
    // honour it rather than assuming we start moving. A phone that was parked overnight should
    // come back parked, not spin GPS up to rediscover that.
    switch state {
    case .stopped where stopAnchor != nil:
      applyStoppedCadence()
    default:
      state = .moving
      applyMovingCadence()
    }
    // Re-assert it either way. The gate persists the motion state too, so the common case is a
    // no-op — but the `default` branch above can *demote* a restored `stopped` back to `moving`
    // when the anchor did not survive, and a gate left saying `parked` would then have every
    // envelope claim she is sitting still while the phone spins GPS looking for her.
    //
    // The date only lands if the state actually CHANGED — `set_motion` is idempotent — so a phone
    // relaunching into the same state it died in keeps the original moment. That is the difference
    // between "parked since 22:09" and a phone that reports itself freshly parked every time iOS
    // revives it, which on this device is several times a night.
    publishMotion(
      state == .stopped ? .parked : .moving,
      since: stopAnchor?.timestamp ?? Date())
    // Seed the gate from the cached position, BEFORE starting the stream.
    //
    // Nothing else in the system will. Until something has passed the gate there is no
    // `last_known_fix`, so `heartbeat` returns 0 every time it is asked, and there is no position to
    // centre the stop fence on either — a phone can be armed, authorised and running while
    // publishing nothing at all, which is precisely what one did for 88 minutes on 2026-08-30.
    //
    // `manager.location` and not `requestLocation()`: it is free, it needs no delegate round-trip,
    // and one-shot requests are not a supported combination with `startUpdatingLocation()`. If there
    // is no cached position — a genuinely fresh install — the stream's first delivery seeds it
    // instead, which is why this is best-effort rather than a precondition.
    if let cached = manager.location {
      note(.seed)
      let fix = Self.fix(from: cached)
      let battery = Self.battery()
      Task { await self.ingest(fix: fix, battery: battery) }
      // And let the seed open a stop candidate, exactly as a delivery would.
      //
      // Without this, a runtime that comes up while the phone is ALREADY still can never leave
      // `moving`: `considerStopping` runs only from `didUpdateLocations`, and a stationary phone at
      // a 20-50 m `distanceFilter` produces no deliveries to run it from. So no candidate, no
      // fence, no unfiltered stream — the deadlock the candidate rewrite exists to break, entered
      // through the one door that rewrite does not cover. Every restart onto a stationary phone
      // takes that door: a relaunch after termination, a `stop()`/`start()` cycle that cleared the
      // anchor, a fresh install indoors.
      //
      // The cached fix can be old, and arming on it anyway is the right trade. A stop fence in the
      // wrong place fires on the next delivery and costs one wake; no fence at all costs a day. If
      // the cached fix still reports real speed, `considerStopping` refuses it and we stay moving.
      if state == .moving {
        considerStopping(at: cached)
      }
    }

    manager.startUpdatingLocation()
  }

  /// Give up the node this runtime holds, and change nothing else.
  ///
  /// The counterpart to `stop()`, and the distinction is the same one `teardownBackground` draws on
  /// the JS side and then did not honour here: "the user switched sharing off" tears the ladder
  /// down, "this process is going away" must leave every rung of it standing. `stop()` unmonitors
  /// SLC, clears the stop fence and un-persists the anchor — on iOS those are the only three things
  /// that can bring a terminated app back, and a teardown that removes them leaves a phone that
  /// cannot wake until its owner opens the app.
  ///
  /// Deliberately does NOT touch `running`, the location stream, the fence, or the anchor. All it
  /// does is drop the node handle, because the JS session that is going away is about to close the
  /// stores it was built on; `ensureStarted` rebuilds against the freed stores on the next delivery,
  /// which is what lets the native path take over publishing exactly when JS stops being able to.
  func release() {
    guard running else { return }
    NSLog("[iroh-location] releasing the node; ladder stays armed")
    queue.async { self.teardown() }
  }

  func stop() {
    guard running else { return }
    manager.stopUpdatingLocation()
    manager.stopMonitoringSignificantLocationChanges()
    clearStopAnchorFence()
    manager.allowsBackgroundLocationUpdates = false
    running = false
    state = .moving
    stopAnchor = nil
    stopCandidate = nil
    candidateFence = nil
    persistState()
    queue.async { self.teardown() }
  }

  /// Re-program the OS from the sampling policy's decision.
  ///
  /// Core Location ignores any time interval, so the distance filter and the accuracy tier are the
  /// whole of what we can ask for; the publish interval is enforced on our side by the slot grid.
  ///
  /// Recorded as the *moving* cadence and only applied immediately if we are moving — a policy
  /// re-arm must not quietly cancel a stop and start burning GPS on a parked phone.
  func setCadence(intervalMs: UInt64, distanceM: Double, accuracy: String) {
    slotIntervalMs = max(1, intervalMs)
    movingDistanceFilter = distanceM > 0 ? distanceM : kCLDistanceFilterNone
    movingAccuracy = Self.accuracy(for: accuracy)
    // The `state == .moving` half is that rule; `stopCandidate == nil` is the same rule one step
    // earlier. A candidate is dwelling on an unfiltered stream, and putting the policy's distance
    // filter back over the top of it is exactly how the confirming delivery goes missing.
    if running && state == .moving && stopCandidate == nil {
      applyMovingCadence()
      // Re-requesting is what makes a change take effect; Core Location applies the new filter to
      // the running request rather than needing a stop/start.
      manager.startUpdatingLocation()
    }
  }

  /// Map the policy's tier onto Core Location's constants. `balanced` is the ambient default and
  /// is deliberately not `kCLLocationAccuracyKilometer`: the confidence gate rejects at 150 m, so a
  /// coarser tier would spend battery producing fixes we then throw away.
  ///
  /// `kCLLocationAccuracyBest` is never one of these. It is for turn-by-turn navigation; showing a
  /// friend which building you are in does not need sub-10 m precision and the power difference is
  /// large.
  private static func accuracy(for tier: String) -> CLLocationAccuracy {
    switch tier {
    case "high": return kCLLocationAccuracyNearestTenMeters
    case "low": return kCLLocationAccuracyKilometer
    default: return kCLLocationAccuracyHundredMeters
    }
  }

  // MARK: - State machine

  /// Program the manager for a phone that is going somewhere.
  ///
  /// The tier is derived from `CLLocation.speed` rather than `CMMotionActivityManager`: motion
  /// activity would be a better signal, but it is a second permission prompt and a second thing to
  /// be denied, and speed rides along on fixes we already have. If the activity permission is ever
  /// added, this is the one function that needs to change.
  private func applyMovingCadence(speedMps: CLLocationSpeed = -1) {
    // A negative speed is Core Location's "unknown", and it is also the default here, so a caller
    // with no fix in hand lands on whatever the sampling policy last asked for.
    var accuracy = movingAccuracy
    var filter = movingDistanceFilter
    var activity: CLActivityType = .other
    switch speedMps {
    case 8...:
      accuracy = kCLLocationAccuracyNearestTenMeters
      filter = 50
      activity = .automotiveNavigation
    case 3..<8:
      accuracy = kCLLocationAccuracyNearestTenMeters
      filter = 30
      activity = .fitness
    case 0.5..<3:
      accuracy = kCLLocationAccuracyHundredMeters
      filter = 20
      activity = .fitness
    default:
      break
    }
    manager.desiredAccuracy = accuracy
    manager.distanceFilter = filter
    manager.activityType = activity
  }

  /// Program the manager for a phone that is parked.
  ///
  /// GPS off, and a coarse stream left running as the clock. `kCLDistanceFilterNone` is essential
  /// here and is the correction to the bug this rewrite exists for: with a 50 m filter a phone in a
  /// living room produces no deliveries at all, and an app that produces no deliveries is an app
  /// iOS suspends. At three-kilometre accuracy the deliveries cost effectively nothing and each one
  /// is a chance to fill a slot.
  private func applyStoppedCadence() {
    manager.desiredAccuracy = Self.stoppedAccuracy
    manager.distanceFilter = kCLDistanceFilterNone
    manager.activityType = .other
  }

  /// Settle into `stopped`, but only behind a tripwire that actually exists.
  ///
  /// Exit from `stopped` is entirely event-driven — the fence is the only way out, because the
  /// coarse stream it runs on reports a three-kilometre radius and cannot tell a hundred-metre
  /// departure from standing still. So a stop taken without a fence is not a low-power state, it is
  /// a phone that has gone dark until the next relaunch. Staying in `moving` costs battery; that is
  /// the correct way to fail.
  private func enterStopped(anchor: CLLocation) {
    guard armStopAnchorFence(at: anchor) else {
      NSLog("[iroh-location] stop declined: no fence could be armed, staying in moving")
      abandonStopCandidate()
      return
    }
    state = .stopped
    // Before `persistState`, and before the coarse stream starts producing the heartbeats that
    // carry it: the first envelope after this point is the one that tells her friends she has
    // settled rather than gone quiet, and this phone may not survive many more.
    //
    // Dated from the CANDIDATE, not from now. `enterStopped` runs on the delivery that *confirmed*
    // the dwell, which is `stopDwellSeconds` after she actually stopped — dating it here would
    // report every arrival three minutes late for as long as she stays. `stopCandidate` is still
    // set at this point and is cleared two lines below.
    publishMotion(.parked, since: stopCandidate?.since ?? anchor.timestamp)
    stopAnchor = anchor
    stopCandidate = nil
    // The speculative fence has just been re-armed at `anchor` by the guard above and is now the
    // real one; what it was centred on no longer matters.
    candidateFence = nil
    applyStoppedCadence()
    manager.startUpdatingLocation()
    persistState()
    note(.stateChange)
    NSLog(
      "[iroh-location] stopped: anchor=(\(anchor.coordinate.latitude), "
        + "\(anchor.coordinate.longitude)) fence=\(Self.stopAnchorRadiusM)m")
  }

  private func enterMoving(reason: WakeReason) {
    state = .moving
    // No candidate to date this from: leaving is observed as it happens, unlike settling.
    publishMotion(.moving, since: Date())
    stopAnchor = nil
    stopCandidate = nil
    candidateFence = nil
    clearStopAnchorFence()
    applyMovingCadence()
    manager.startUpdatingLocation()
    persistState()
    note(reason)
    NSLog("[iroh-location] moving: reason=\(reason.rawValue)")
  }

  /// Decide whether a fix while `moving` means we have settled.
  ///
  /// Two signals, and neither is trusted alone: the phone must be slow *and* have stayed inside
  /// `stopJitterRadiusM` for `stopDwellSeconds`. The `.stationary` flag Core Location sets on
  /// updates is not reliable enough in the field to be one of them.
  ///
  /// ## Why a candidate pays up front
  ///
  /// Confirming a stop takes a *second* delivery, `stopDwellSeconds` after the first. Nothing
  /// guarantees one arrives, and the thing that prevents it is the stop itself: with the 20-50 m
  /// `distanceFilter` `moving` runs on, a phone that has genuinely stopped produces no deliveries
  /// at all. On 2026-09-02 an iPhone held a clean five-minute cadence into a cafe, sat down at
  /// 13:08 and was never heard from again — still `moving`, `fence_registered=false`, two hours of
  /// nothing on every device the pipeline touches. `enterStopped` had never run, so neither the
  /// fence nor the coarse clock that `stopped` exists to install were ever installed. The state
  /// that fixes going dark could only be reached by not being still.
  ///
  /// So opening a candidate now does both of the things confirmation used to do, immediately and
  /// without waiting to be right about it:
  ///
  /// - **arms the fence** (`candidateFence`), so a way back exists even if this process is
  ///   suspended one second from now and nothing else ever runs;
  /// - **unfilters the stream** (`holdCandidateCadence`), so the delivery the dwell is waiting on
  ///   is one the OS still has a reason to make.
  ///
  /// Both are cheap, and both are handed straight back by `abandonStopCandidate` the moment the
  /// phone turns out to have been moving after all. Guessing early and paying for the guess is the
  /// correct way to fail here; the other way is a day of silence.
  private func considerStopping(at location: CLLocation) {
    let movingFast = location.speed >= 0 && location.speed > 1.0
    guard !movingFast else {
      abandonStopCandidate()
      return
    }
    guard let candidate = stopCandidate,
      location.distance(from: candidate.centre) <= Self.stopJitterRadiusM
    else {
      // No candidate, or this fix has wandered out of the one we had. Either way the dwell starts
      // again from here.
      openStopCandidate(at: location)
      return
    }
    guard Date().timeIntervalSince(candidate.since) >= Self.stopDwellSeconds else {
      holdCandidateCadence()
      return
    }
    enterStopped(anchor: location)
  }

  /// Open — or re-centre — the stop candidate, and arm the tripwire before we have earned it.
  ///
  /// Arming here rather than in `enterStopped` is the safety net. A speculative exit fence around a
  /// phone that merely *looks* settled costs one monitored region and nothing else, and it is the
  /// only rung on the ladder that answers a short departure: SLC wants roughly half a kilometre,
  /// and walking out of a cafe does not qualify. If the stop is confirmed the fence is already
  /// where it needs to be; if it is not, `abandonStopCandidate` takes it away again.
  private func openStopCandidate(at location: CLLocation) {
    stopCandidate = (centre: location, since: Date())
    // A failed arm is not a new failure — `enterStopped` would refuse for the same two reasons, and
    // says so. It does mean the dwell below is now the only thing keeping this process alive.
    candidateFence = armStopAnchorFence(at: location) ? location : nil
    holdCandidateCadence()
  }

  /// Keep deliveries arriving while a candidate dwells.
  ///
  /// `kCLDistanceFilterNone` is the whole of it: it is the difference between a clock and a
  /// tripwire that never trips, and it is the same correction `applyStoppedCadence` makes for the
  /// same reason one state later. The accuracy comes down to `candidateAccuracy` at the same time
  /// so that an unfiltered stream cannot mean an unfiltered *GPS* stream — this only ever engages
  /// below 1 m/s, where ten-metre precision buys nothing that hundred-metre precision does not.
  ///
  /// Re-asserted on every delivery, because `didUpdateLocations` calls `applyMovingCadence` first
  /// and that overwrites both.
  private func holdCandidateCadence() {
    guard manager.distanceFilter != kCLDistanceFilterNone
      || manager.desiredAccuracy != Self.candidateAccuracy
    else { return }
    manager.desiredAccuracy = Self.candidateAccuracy
    manager.distanceFilter = kCLDistanceFilterNone
    // Re-requesting is what makes a change take effect; Core Location applies the new filter to the
    // running request rather than needing a stop/start.
    manager.startUpdatingLocation()
  }

  /// The phone is going somewhere after all: give back everything the candidate borrowed.
  ///
  /// The cadence needs no restoring here. `didUpdateLocations` calls `applyMovingCadence` with this
  /// fix's own speed before it calls `considerStopping`, so the manager is already holding the
  /// policy's accuracy and filter by the time we get here; only the re-request is ours to make.
  private func abandonStopCandidate() {
    guard stopCandidate != nil || candidateFence != nil else { return }
    stopCandidate = nil
    if candidateFence != nil {
      clearStopAnchorFence()
      candidateFence = nil
    }
    manager.startUpdatingLocation()
  }

  // MARK: - The resurrection ladder

  /// Returns whether a fence is now armed. `false` means region monitoring is unavailable or the
  /// app is not authorised for it, and the caller must not treat the phone as parked.
  ///
  /// Note that this is optimistic: `startMonitoring` is asynchronous and can still fail later, which
  /// arrives at `monitoringDidFailFor`. `location.fence_registered` on `device.health` reports what
  /// the OS actually holds, which is the number to trust.
  @discardableResult
  private func armStopAnchorFence(at location: CLLocation) -> Bool {
    guard CLLocationManager.isMonitoringAvailable(for: CLCircularRegion.self) else { return false }
    guard manager.authorizationStatus == .authorizedAlways else { return false }
    clearStopAnchorFence()
    let region = CLCircularRegion(
      center: location.coordinate,
      radius: Self.stopAnchorRadiusM,
      identifier: Self.stopAnchorRegionId)
    // Exit only. Entry would fire the moment we arm it and tell us nothing we do not know.
    region.notifyOnExit = true
    region.notifyOnEntry = false
    manager.startMonitoring(for: region)
    return true
  }

  /// Re-arm from disk, without needing a fix.
  ///
  /// The point of persisting the anchor: a cold launch has to restore the fence *before* it tries
  /// to build a node, because building the node is the part that can fail.
  private func rearmStopAnchorFence() {
    guard let stopAnchor else { return }
    if !armStopAnchorFence(at: stopAnchor) {
      // We were parked when we died and cannot re-arm the way out. Come back moving rather than
      // come back dark; `start` reads this.
      NSLog("[iroh-location] could not re-arm the stop fence; resuming as moving")
      state = .moving
      self.stopAnchor = nil
      persistState()
    }
  }

  private func clearStopAnchorFence() {
    for region in manager.monitoredRegions where region.identifier == Self.stopAnchorRegionId {
      manager.stopMonitoring(for: region)
    }
  }

  // MARK: - Persistence

  /// Small, synchronous, and written on every transition. We will be killed mid-flight and we want
  /// to come back knowing where we were.
  private func persistState() {
    let defaults = UserDefaults.standard
    defaults.set(state.rawValue, forKey: "sc.bg.state")
    if let stopAnchor {
      defaults.set(stopAnchor.coordinate.latitude, forKey: "sc.bg.anchor.lat")
      defaults.set(stopAnchor.coordinate.longitude, forKey: "sc.bg.anchor.lon")
      defaults.set(stopAnchor.timestamp.timeIntervalSince1970, forKey: "sc.bg.anchor.ts")
    } else {
      defaults.removeObject(forKey: "sc.bg.anchor.lat")
      defaults.removeObject(forKey: "sc.bg.anchor.lon")
      defaults.removeObject(forKey: "sc.bg.anchor.ts")
    }
  }

  private func restorePersistedState() {
    let defaults = UserDefaults.standard
    if let raw = defaults.string(forKey: "sc.bg.state"), let restored = MotionState(rawValue: raw) {
      state = restored
    }
    guard defaults.object(forKey: "sc.bg.anchor.lat") != nil else { return }
    let lat = defaults.double(forKey: "sc.bg.anchor.lat")
    let lon = defaults.double(forKey: "sc.bg.anchor.lon")
    let ts = defaults.double(forKey: "sc.bg.anchor.ts")
    stopAnchor = CLLocation(
      coordinate: CLLocationCoordinate2D(latitude: lat, longitude: lon),
      altitude: 0,
      horizontalAccuracy: Self.stopAnchorRadiusM,
      verticalAccuracy: -1,
      timestamp: Date(timeIntervalSince1970: ts))
  }

  private func note(_ reason: WakeReason) {
    lastWakeReason = reason
    lastWakeAt = Date()
  }

  // MARK: - CLLocationManagerDelegate

  func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
    guard let location = locations.last else { return }
    let battery = Self.battery()
    lastSeenLocation = location

    switch state {
    case .moving:
      note(.movement)
      // Re-tier from the speed this fix reports. Cheap, and it is what keeps a walk from being
      // sampled like a motorway.
      applyMovingCadence(speedMps: location.speed)
      let fix = Self.fix(from: location)
      Task { await self.ingest(fix: fix, battery: battery) }
      considerStopping(at: location)

    case .stopped:
      // Deliberately NOT ingested. This is a three-kilometre Wi-Fi fix; the gate would refuse it as
      // a position and be right to. Its whole value is that it arrived — it is the clock that lets
      // a parked phone keep filling slots with the anchor it already accepted, at the anchor's own
      // timestamp, so a stationary stretch is honest about being stationary rather than absent.
      //
      // Its *coordinate* is still worth one comparison, though, which is the correction below: a
      // fix too coarse to publish can still be good enough to prove we are nowhere near the anchor.
      if considerDeparture(from: location) { return }
      note(.periodic)
      Task { await self.heartbeat(battery: battery) }
    }
  }

  /// Leave `stopped` when the parked clock itself shows we have gone, and the fence has not said so.
  ///
  /// The stopped state was built with exactly one way out — `didExitRegion` on a 100 m fence — on
  /// the reasoning that the coarse stream "cannot tell a hundred-metre departure from standing
  /// still". True, and it does not have to: a commute is kilometres, and the same delivery that
  /// serves as the clock also carries a coordinate.
  ///
  /// That single exit failed in the field. On 2026-08-31 an iPhone parked at 05:10 UTC and was
  /// still `stopped` at 14:55 with the anchor untouched — `anchor_age_ms` climbing 47 → 584 minutes
  /// across a drive to work — while `fence_registered` read `true` the whole time. The JS revive
  /// fence, a second and independent region, was equally silent through the same window. Whatever
  /// the cause, one mechanism with no backstop is what turned it into a day of silence.
  ///
  /// The threshold is the fix's OWN accuracy plus the fence radius, so this cannot false-positive:
  /// a three-kilometre cell fix has to be three kilometres out before it counts, while a 65 m Wi-Fi
  /// fix unparks at ~165 m. A parked phone's noise is bounded by the accuracy it reports, so a
  /// stationary stretch stays stationary and stays cheap — which is the whole value of `stopped`.
  ///
  /// Returns whether we left; the caller skips the heartbeat when we did, because `enterMoving`
  /// runs one itself.
  private func considerDeparture(from location: CLLocation) -> Bool {
    guard let anchor = stopAnchor else { return false }
    // A negative accuracy means the coordinate is invalid, not that it is perfect.
    guard location.horizontalAccuracy >= 0 else { return false }
    let threshold = location.horizontalAccuracy + Self.stopAnchorRadiusM
    let travelled = location.distance(from: anchor)
    guard travelled > threshold else { return false }
    NSLog(
      "[iroh-location] coarse departure: \(Int(travelled))m from anchor "
        + "(threshold \(Int(threshold))m); the fence did not fire")
    enterMoving(reason: .coarseDeparture)
    let battery = Self.battery()
    Task { await self.heartbeat(battery: battery) }
    return true
  }

  func locationManager(
    _ manager: CLLocationManager, didExitRegion region: CLRegion
  ) {
    guard region.identifier == Self.stopAnchorRegionId else { return }
    // The whole point of the stopped state: exit is event-driven, so we are responsive to movement
    // and cost nothing while parked, which normally trade off against each other.
    //
    // `enterMoving` restarts the precise stream, whose first delivery is the fresh position — no
    // one-shot request, which is not a supported combination with an active stream. The heartbeat
    // covers the gap until that lands, so a crossing is never a silent slot.
    enterMoving(reason: .geofenceExit)
    let battery = Self.battery()
    Task { await self.heartbeat(battery: battery) }
  }

  /// Authorization changed under us — including the delayed re-prompt, where iOS shows the user a
  /// map of everywhere the app has tracked them and a great many say no.
  ///
  /// A downgrade is a product event, not an error: it is reported, and the runtime stands down
  /// rather than pretending to share. An upgrade re-arms, which is what makes the fresh-install
  /// race self-correcting instead of latched until the next relaunch.
  func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
    let status = manager.authorizationStatus
    NSLog("[iroh-location] authorization -> \(Self.authorizationName(status))")
    switch status {
    case .authorizedAlways:
      guard running else { return }
      manager.allowsBackgroundLocationUpdates = true
      manager.startMonitoringSignificantLocationChanges()
      rearmStopAnchorFence()
      note(.stateChange)
    case .authorizedWhenInUse:
      // Foreground updates still work; background ones will not survive suspension. Keep running
      // so the app is useful, and let `device.health` carry the truth.
      note(.stateChange)
    default:
      guard running else { return }
      NSLog("[iroh-location] authorization lost; standing down")
      stop()
    }
  }

  /// Core Location paused us anyway.
  ///
  /// It should not happen with `pausesLocationUpdatesAutomatically` off, but "should not" is what
  /// the nineteen hours of silence were built on. `expo-location` implements neither this callback
  /// nor its counterpart, which is precisely why the pause was invisible: no span, no log, no
  /// watermark, and a phone indistinguishable from one whose owner simply had not moved.
  func locationManagerDidPauseLocationUpdates(_ manager: CLLocationManager) {
    NSLog("[iroh-location] Core Location paused updates; restarting")
    manager.startUpdatingLocation()
  }

  func locationManagerDidResumeLocationUpdates(_ manager: CLLocationManager) {
    NSLog("[iroh-location] Core Location resumed updates")
  }

  func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
    // Not fatal and not rare — a denied authorisation or a momentary lack of any fix both land
    // here. `requestLocation` in particular fails outright when it cannot get a fix in time, and
    // the running stream is unaffected, so this must not tear anything down.
    NSLog("[iroh-location] background location error: \(error.localizedDescription)")
  }

  func locationManager(
    _ manager: CLLocationManager, monitoringDidFailFor region: CLRegion?, withError error: Error
  ) {
    // A fence we could not arm is a resurrection rung we do not have. SLC still covers us, but this
    // is worth saying out loud rather than inferring later from an absence.
    NSLog("[iroh-location] stop-anchor fence failed to arm: \(error.localizedDescription)")
  }

  // MARK: - Node lifecycle

  /// Hand a capture to the mounted JS runtime, which owns the node this process's stores belong to.
  ///
  /// `kind` is `fix` when there is a position to run through the gate and `heartbeat` when this is
  /// a tick from the parked coarse stream, which has no position worth gating — see the two call
  /// sites. Dropping to the main queue because that is where the Expo event emitter expects to be
  /// called from, and Core Location has already delivered us there anyway.
  private func handOff(kind: String, fix: LocationFix?, battery: BatteryState) {
    var payload: [String: Any] = [
      "kind": kind,
      "reason": lastWakeReason.rawValue,
      "state": state.rawValue,
      "battery": [
        "level": battery.level, "charging": battery.charging, "lowPower": battery.lowPower,
      ],
    ]
    if let fix {
      payload["fix"] = [
        "lat": fix.lat, "lon": fix.lon, "accuracyM": fix.accuracyM,
        "headingDeg": fix.headingDeg, "ts": fix.ts,
      ]
    }
    let sink = eventSink
    DispatchQueue.main.async { sink?.sendEvent("onNativeFix", payload) }
  }

  /// Run one captured fix through gate → outbox → seal → send.
  private func ingest(fix: LocationFix, battery: BatteryState) async {
    guard let subscription = await ensureStarted() else {
      handOff(kind: "fix", fix: fix, battery: battery)
      return
    }
    do {
      let outcome = try await subscription.ingestFix(
        subscriptionId: Self.subscriptionId,
        fix: fix,
        battery: battery,
        intervalMs: slotIntervalMs,
        nowMs: UInt64(Date().timeIntervalSince1970 * 1000))
      report("ingest", outcome)
    } catch {
      // The fix stays in the native outbox, so the next delivery retries it.
      NSLog("[iroh-location] ingest failed, fix stays queued: \(error.localizedDescription)")
    }
  }

  /// Tell the publish path which state this phone is in, so every envelope it seals says so.
  ///
  /// The receiver cannot work this out for itself. A parked phone republishes its anchor at the
  /// anchor's own timestamp, so an old `ts` on a fresh envelope is equally the signature of a
  /// friend sitting at home and of a fix that took twenty minutes to reach them through the stash.
  /// This is the phone answering which — the one question only it can answer.
  ///
  /// Fire-and-forget on purpose: it writes one field and publishes nothing, so there is nothing to
  /// wait for, and a state change must never be able to block a delivery callback. A failure costs
  /// one envelope's worth of staleness in the flag, not a fix.
  private func publishMotion(_ motion: MotionState, since: Date) {
    let sinceMs = UInt64(max(0, since.timeIntervalSince1970 * 1000))
    Task {
      guard let subscription = await ensureStarted() else { return }
      do {
        try await subscription.setMotionState(motion: motion, sinceMs: sinceMs)
      } catch {
        NSLog("[iroh-location] motion state not recorded: \(error.localizedDescription)")
      }
    }
  }

  /// Fill the slots that have come due with no new fix, reusing the last accepted position.
  ///
  /// Not an optimisation. The cadence is the one property of a sealed envelope the stash can read,
  /// so it has to be uniform whether or not the phone is moving — a series that stops when its
  /// owner sits still is a series that leaks when its owner sits still.
  private func heartbeat(battery: BatteryState) async {
    guard let subscription = await ensureStarted() else {
      handOff(kind: "heartbeat", fix: nil, battery: battery)
      return
    }
    do {
      let outcome = try await subscription.heartbeatFix(
        subscriptionId: Self.subscriptionId,
        battery: battery,
        intervalMs: slotIntervalMs,
        nowMs: UInt64(Date().timeIntervalSince1970 * 1000))
      report("heartbeat", outcome)
    } catch {
      NSLog("[iroh-location] heartbeat failed: \(error.localizedDescription)")
    }
  }

  /// One line per wake that did something, so a quiet phone and a broken one look different in the
  /// device log. The equivalent spans reach the collector from the Rust side.
  private func report(_ lane: String, _ outcome: IngestOutcome) {
    guard outcome.enqueued > 0 || outcome.published > 0 else { return }
    NSLog(
      "[iroh-location] \(lane): reason=\(lastWakeReason.rawValue) state=\(state.rawValue) "
        + "enqueued=\(outcome.enqueued) published=\(outcome.published) "
        + "pending=\(outcome.pending) suspended=\(outcome.suspended)")
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
      ts: UInt64(location.timestamp.timeIntervalSince1970 * 1000),
      // Not stamped here. A fix becomes "the parked position" a dwell AFTER it was measured, and
      // every heartbeat republishes a fix captured under a state that has since changed — so the
      // publish path reads the state at enqueue instead. `publishMotion` is what sets it.
      motion: nil)
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

  private static func authorizationName(_ status: CLAuthorizationStatus) -> String {
    switch status {
    case .authorizedAlways: return "always"
    case .authorizedWhenInUse: return "when_in_use"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "not_determined"
    @unknown default: return "unknown"
    }
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
}
