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
/// relaunch, a visit, or a push. Anything designed around a cadence works on a desk and fails in a
/// pocket.
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
/// They share ONE node. `NodeHost` (Rust, `host.rs`) builds it, the mounted app and this runtime
/// each hold a lease on it, and it is shut down when the last lease goes. This runtime used to
/// build a node of its own and race the app for the process-wide store claim; every ownership rule
/// that grew up around that race — an owner flag, a claim backoff, a bounded handover — is gone,
/// because there is nothing left to race for.
final class BackgroundLocationRuntime: NSObject, CLLocationManagerDelegate {
  /// The one runtime. **It must first be touched on the main thread**, and
  /// `IrohBackgroundAppDelegateSubscriber` does exactly that on every launch, before React exists.
  ///
  /// Core Location delivers delegate callbacks on the run loop of the thread that CREATED the
  /// manager, and `manager` is created in `init`. A thread without a running run loop receives
  /// nothing — no location, no fence exit, no authorization change — and says nothing about it.
  ///
  /// Until 2026-09-29 the first touch on a foreground launch was whichever bridge call JS made
  /// first, and `init()` makes that `handOverNativeBackground`: an `AsyncFunction`, so a Swift
  /// concurrency worker with no run loop. Every foreground-launched process from then on was
  /// armed, authorised, `running`, `moving` and deaf. An iPhone 16 Pro Max drove for twenty
  /// minutes with the app mounted in the background, took zero deliveries, and published the
  /// position it had at launch on every heartbeat; its SLC wakes went to the same dead thread, so
  /// iOS had no reason to relaunch it until the process was finally reclaimed. The background
  /// launch that followed built the runtime from the bootstrap, on main, and took 45 deliveries in
  /// nine minutes. `delegate_on_main` in `device.health` is how a regression shows itself.
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
    /// A `BGProcessingTask` wake — `NativeRefreshTask`. A clock, like `periodic`, but a rare one
    /// the OS chose to give us, so it is allowed to pull as well as publish.
    case refresh
    /// A `CLVisit` — Core Location's own arrival/departure detector. See `didVisit`.
    case visit
  }

  /// Which mechanism confirmed a stop.
  ///
  /// `dwell` is the state machine working as designed: a second delivery inside the jitter radius,
  /// `stopDwellSeconds` after the first. The other two exist for a process that never gets that
  /// second delivery — one relaunched in the background, which iOS runs in short bursts and
  /// suspends mid-dwell — and seeing them often says how much of the fleet lives that way.
  enum StopEvidence: String {
    case dwell
    /// `NativeRefreshTask` found a candidate whose dwell had elapsed. See `confirmDwelledCandidate`.
    case refresh
    /// Core Location reported an arrival. See `didVisit`.
    case visit
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
  private var running = false

  private var state: MotionState = .moving
  private var lastWakeReason: WakeReason = .relaunch
  private var lastWakeAt: Date?

  /// Where a captured fix goes while the app is mounted.
  ///
  /// Routing, not ownership: the node is shared, and both paths end in the same `ingestFix` on it.
  /// A mounted app takes the capture because it runs the sampling policy and draws the user's own
  /// marker from what the gate accepted. Before the node was shared this was the ONLY path that
  /// could publish while the app was open — a fresh install could pair, sit there with the map
  /// open, and publish nothing, because nothing handed the captures over.
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
  ///
  /// Persisted, because the dwell it times routinely outlives the process timing it. A process
  /// relaunched in the background gets wakes of ~30 s against a 180 s dwell, and on 2026-10-06 an
  /// iPhone opened a candidate at home at 17:17, was killed, was relaunched at 17:37 and opened a
  /// NEW one from zero — and was killed again 32 s into that. Restored, the 17:37 seed would have
  /// found a candidate twenty minutes old at the same spot and parked on the spot.
  private var stopCandidate: (centre: CLLocation, since: Date)? {
    didSet { candidateDirty = true }
  }

  /// The centre of a fence armed *speculatively*, around a stop candidate, while still `moving`.
  ///
  /// Distinct from `stopAnchor`, which asserts "we are parked here". This one says only "we might
  /// be about to be", and it exists because the confirmation that would promote it cannot be
  /// relied on to arrive — see `considerStopping`. Not persisted itself: the region outlives the
  /// process in Core Location, and a restored `stopCandidate` re-adopts it.
  private var candidateFence: CLLocation?

  /// Whether `manager` was created on the main thread, i.e. whether its callbacks can arrive at all.
  /// See `shared`.
  private let delegateOnMain = Thread.isMainThread

  /// What confirmed the current stop. Persisted with the anchor, and reported, because three
  /// different mechanisms can take a stop and only one of them is the ordinary one — see
  /// `StopEvidence`.
  private var stopVia: StopEvidence?

  /// When Core Location last delivered a visit, of either kind. Persisted: a visit is precisely
  /// the event that relaunches a terminated app, so an in-memory stamp would die with the only
  /// process that could have reported it.
  private var lastVisitAt: Date?

  /// An arrival Core Location has reported and no real fix has yet placed: its coordinate and
  /// accuracy, stamped with the arrival time. The visit is the evidence that the phone has
  /// stopped; the next fix from after it is where. See `didVisit` and `considerStopping`.
  ///
  /// Persisted with the candidate, for the same reason: the fix that settles it may only ever
  /// reach a LATER process — a relaunch's seed — and an arrival held in memory dies first.
  private var visitArrival: CLLocation? {
    didSet { candidateDirty = true }
  }

  /// Whether `stopCandidate` or `visitArrival` changed since they were last written to disk. They
  /// change on deliveries, which are frequent, and are written only when they did.
  private var candidateDirty = false

  /// How long a persisted arrival may wait for its fix. A relaunch hours later has no business
  /// parking on an arrival the phone has very likely left since — the departure visit that would
  /// have cleared it is not guaranteed to be delivered.
  private static let visitArrivalLifetime: TimeInterval = 6 * 60 * 60

  /// The timestamp of the newest location Core Location has delivered, to recognise one it hands
  /// back again. See `didUpdateLocations`.
  private var lastDeliveredAt: Date?

  /// When a redelivery last stood in for a clock. See `didUpdateLocations`.
  private var lastRedeliveryHeartbeatAt: Date?

  /// Floor between heartbeats driven by redeliveries — a clock, not a reason to spin.
  private static let redeliveryHeartbeatFloor: TimeInterval = 60

  /// `location.runtime` spans. See `LocationRuntimeReporter`.
  private var reporter: LocationRuntimeReporter!

  private override init() {
    super.init()
    reporter = LocationRuntimeReporter { [unowned self] in self.reportSnapshot() }
    if !delegateOnMain {
      NSLog(
        "[iroh-location] runtime created OFF the main thread: Core Location will deliver nothing "
          + "to this process. Something touched BackgroundLocationRuntime.shared before the "
          + "launch bootstrap did.")
    }
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

  /// Whether this runtime holds a lease on the process's node right now.
  var holdsNode: Bool { nodeHost().snapshot().background }

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
      // `false` means every other field here describes a runtime that cannot hear Core Location.
      "delegate_on_main": delegateOnMain,
      "precise": manager.accuracyAuthorization == .fullAccuracy,
      "anchor_armed": stopAnchor != nil,
      // Who holds the process's node, from the host itself — `app`, `native`, `shared`, or
      // `none`. Observed, never declared: a declared owner came apart from the real one badly
      // enough once to silence a moving phone for an hour.
      "node_owner": Self.nodeOwnerLabel(nodeHost().snapshot()),
      "js_sink_wired": eventSink != nil,
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
      // An arrival Core Location reported that no fix has yet placed. Lingering `true` on a phone
      // that is not moving is the 2026-10-06 shape: the OS said "arrived", and nothing delivered.
      "visit_pending": visitArrival != nil,
      "candidate_fence_armed": candidateFence != nil,
    ]
    if let stopCandidate {
      snapshot["candidate_age_ms"] = Int(Date().timeIntervalSince(stopCandidate.since) * 1000)
    }
    if let lastWakeAt {
      snapshot["last_wake_age_ms"] = Int(Date().timeIntervalSince(lastWakeAt) * 1000)
    }
    // Wake and delivery are different clocks: a parked tick or a fence exit is a wake with no new
    // position in it. This says how old the newest position Core Location has given us is.
    if let lastDeliveredAt {
      snapshot["last_delivered_fix_age_ms"] = Int(Date().timeIntervalSince(lastDeliveredAt) * 1000)
    }
    // Absent, never zero, until a visit has arrived at all: absence on a phone that has been
    // somewhere and come home says the visit service is not delivering on that device.
    if let lastVisitAt {
      snapshot["last_visit_age_ms"] = Int(Date().timeIntervalSince(lastVisitAt) * 1000)
    }
    if let stopAnchor {
      snapshot["anchor_age_ms"] = Int(Date().timeIntervalSince(stopAnchor.timestamp) * 1000)
      if let stopVia { snapshot["stop_via"] = stopVia.rawValue }
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
    // Rung 3. Arrival and departure, detected by the OS. Like SLC it relaunches a terminated app,
    // and unlike SLC it fires on a phone that has STOPPED, which is the one event a suspended
    // process mid-dwell has no other way to hear about. See `didVisit`.
    manager.startMonitoringVisits()

    manager.allowsBackgroundLocationUpdates = true
    running = true
    // Record the intent NOW, before anything below can throw or hang. A launch that dies here must
    // still come back armed — the same argument as arming the resurrection ladder first.
    persistState()

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
    seedGateFromCache()

    manager.startUpdatingLocation()
    NativeRefreshTask.schedule()
    reporter.startPulse()
    reporter.event(.started, reason: lastWakeReason.rawValue)
  }

  // MARK: - Why there is no CLBackgroundActivitySession
  //
  // There was one, for a day, and it must not come back.
  //
  // On 2026-09-30 an iPhone 16 Pro Max arrived somewhere with a friend and never declared itself
  // parked. Its process had been relaunched in the background by Core Location, and from then on it
  // lived in bursts: 16:29:26 to 16:31:09, suspended, 16:36:44 to 16:38:13, suspended for good —
  // about ninety seconds per wake, each ended by iOS while the unfiltered candidate stream was still
  // delivering. `allowsBackgroundLocationUpdates` keeps a process running only for updates started
  // while it was in the FOREGROUND (Apple's own wording), so a relaunched one never qualifies, and
  // the 180 s dwell could not complete inside any single burst.
  //
  // 70afb94 answered that with a `CLBackgroundActivitySession`, held for as long as sharing ran, on
  // the belief that "with `Always` authorization this shows no indicator". That belief was wrong.
  // Apple documents the class as "an object that manages a visual indicator that keeps your app in
  // use in the background", and v2.16.0/v2.17.0 brought back the persistent location indicator on
  // sharing iPhones that report `perm.ios_scope=always` — the same complaint 7550186 had closed in
  // July. It also kept every background process resident, which is the CPU the native rewrite
  // existed to give back.
  //
  // A relaunched process now finishes its stop through events that need no indicator and no
  // residency: a `CLVisit` arrival (`didVisit`), which the OS raises on exactly the phone that has
  // stopped and will relaunch us to deliver, and `NativeRefreshTask` (`confirmDwelledCandidate`) as
  // the backstop. A process started from the foreground — the mounted app, and the one it leaves
  // behind in a pocket — never needed either: it is kept running, and the ordinary dwell parks it.

  /// Service a `NativeRefreshTask` wake: confirm a stop the wake windows starved, then publish and
  /// pull.
  ///
  /// The confirmation is the part that is not a heartbeat. A process suspended mid-dwell keeps its
  /// candidate in memory, and nothing else will ever complete it: with the phone still there, Core
  /// Location has no delivery to make. So a refresh that finds a candidate older than the dwell,
  /// and no evidence the phone has left it, takes the stop — and the heartbeat that follows then
  /// seals `parked`, which is what the friend's map was waiting to be told.
  func serviceRefresh() async {
    let proceed = await MainActor.run { () -> (run: Bool, parked: Bool?) in
      guard self.running else { return (false, nil) }
      self.note(.refresh)
      self.confirmDwelledCandidate()
      // A refresh is a clock. It may declare `parked` only when the state machine has a stop to
      // back it — confirmed just now or earlier — and otherwise says nothing about motion.
      return (true, self.state == .stopped ? true : nil)
    }
    guard proceed.run else { return }
    await heartbeat(battery: Self.battery(), parked: proceed.parked)
  }

  /// Take a stop whose dwell has elapsed without a delivery to confirm it. Returns whether we
  /// stopped.
  ///
  /// Evidence against it is a position newer than the candidate that has left the jitter radius;
  /// no position at all is not evidence — the candidate's fence is armed either way, so a phone
  /// that did leave comes back to `moving` on the fence.
  @discardableResult
  private func confirmDwelledCandidate() -> Bool {
    guard state == .moving, let candidate = stopCandidate,
      Date().timeIntervalSince(candidate.since) >= Self.stopDwellSeconds
    else { return false }
    if let here = manager.location ?? lastSeenLocation,
      here.timestamp > candidate.since,
      here.distance(from: candidate.centre) > Self.stopJitterRadiusM
    {
      return false
    }
    NSLog("[iroh-location] confirming a stop the wake windows starved of its second delivery")
    enterStopped(anchor: candidate.centre, via: .refresh)
    return state == .stopped
  }

  /// Push the cached position through the gate, so `heartbeat` has something to repeat.
  ///
  /// Split out of `start()` because `start()` is idempotent and its seed therefore happens exactly
  /// once — on whichever call armed the ladder. That was fine while `startNativeBackground` was the
  /// only caller. It is not fine now that the app-delegate bootstrap can arm the ladder first: that
  /// call runs before the event sink is wired and with the node owned by the app, so its seed has
  /// nowhere to go, and the later `startNativeBackground` finds the runtime already running and
  /// returns without seeding. The gate would never be seeded at all, which is precisely the
  /// 2026-08-30 failure — armed, authorised, running, and publishing nothing for 88 minutes.
  ///
  /// Safe to repeat: a seed is an ordinary capture, and the slot grid absorbs everything inside a
  /// slot, so a second one costs nothing on the wire.
  func seedGateFromCache() {
    if let cached = manager.location {
      note(.seed)
      let fix = Self.fix(from: cached)
      let battery = Self.battery()
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
      //
      // Decided BEFORE ingesting, as `didUpdateLocations` does, because a seed can now complete a
      // stop — a candidate or an arrival restored from an earlier process — and the envelope this
      // wake seals then has to say `parked`. Ingesting first would fill the slot `live` and leave
      // the declaration to a wake that, on a relaunched process, may not come.
      let wasMoving = state == .moving
      if wasMoving {
        considerStopping(at: cached)
      }
      if wasMoving && state == .stopped {
        Task { await self.heartbeat(battery: battery, parked: true) }
      } else {
        Task { await self.ingest(fix: fix, battery: battery) }
      }
    }
  }

  /// The `node_owner` health label for a host snapshot.
  static func nodeOwnerLabel(_ snapshot: HostSnapshot) -> String {
    switch (snapshot.appLeases > 0, snapshot.background) {
    case (true, true): return "shared"
    case (true, false): return "app"
    case (false, true): return "native"
    case (false, false): return "none"
    }
  }

  func stop() {
    guard running else { return }
    manager.stopUpdatingLocation()
    manager.stopMonitoringSignificantLocationChanges()
    clearStopAnchorFence()
    manager.stopMonitoringVisits()
    manager.allowsBackgroundLocationUpdates = false
    NativeRefreshTask.cancel()
    reporter.stopPulse()
    running = false
    state = .moving
    stopAnchor = nil
    stopVia = nil
    stopCandidate = nil
    candidateFence = nil
    visitArrival = nil
    persistState()
    // Sharing is off: return the background lease. If the app still holds the node it keeps
    // running; if not, the host shuts it down, bounded, and the stores are free.
    Task {
      _ = await nodeHost().release(holder: .background, timeoutMs: Self.releaseBudgetMs)
    }
  }

  /// Bounds the release of the background lease; matches the app's own teardown budget.
  private static let releaseBudgetMs: UInt64 = 5_000

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
    // Persisted so a launch with no JS to re-program us restores this cadence rather than the
    // compiled-in default. The interval is the one property of a sealed envelope the stash can
    // read, so publishing on a different one is a wire-visible change, not an internal detail.
    persistState()
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
  private func enterStopped(anchor: CLLocation, via evidence: StopEvidence) {
    guard armStopAnchorFence(at: anchor) else {
      NSLog("[iroh-location] stop declined: no fence could be armed, staying in moving")
      abandonStopCandidate()
      return
    }
    state = .stopped
    stopAnchor = anchor
    stopVia = evidence
    stopCandidate = nil
    visitArrival = nil
    // The speculative fence has just been re-armed at `anchor` by the guard above and is now the
    // real one; what it was centred on no longer matters.
    candidateFence = nil
    applyStoppedCadence()
    manager.startUpdatingLocation()
    persistState()
    note(.stateChange)
    reporter.event(.transition, reason: evidence.rawValue)
    NSLog(
      "[iroh-location] stopped: via=\(evidence.rawValue) anchor=(\(anchor.coordinate.latitude), "
        + "\(anchor.coordinate.longitude)) fence=\(Self.stopAnchorRadiusM)m")
  }

  private func enterMoving(reason: WakeReason) {
    state = .moving
    stopAnchor = nil
    stopVia = nil
    stopCandidate = nil
    candidateFence = nil
    clearStopAnchorFence()
    applyMovingCadence()
    manager.startUpdatingLocation()
    persistState()
    note(reason)
    reporter.event(.transition, reason: reason.rawValue)
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
    defer { persistCandidateIfChanged() }
    let movingFast = Self.isMovingFast(location)
    // A reported arrival, waiting for a fix from after it. Here and slow takes the stop with no
    // dwell, because the visit already IS the dwell; anywhere else means the phone has gone on,
    // and the arrival is spent. Here but still moving is the last few metres of the approach — the
    // arrival waits, and the stream stays unfiltered so the fix that settles it still comes.
    if let arrival = visitArrival, location.timestamp >= arrival.timestamp {
      if location.distance(from: arrival) > arrival.horizontalAccuracy + Self.stopAnchorRadiusM {
        visitArrival = nil
      } else if movingFast {
        holdCandidateCadence()
        return
      } else {
        visitArrival = nil
        enterStopped(anchor: location, via: .visit)
        if state == .stopped { return }
      }
    }
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
    enterStopped(anchor: location, via: .dwell)
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
    persistCandidateIfChanged()
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
      stopVia = nil
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
    // The sharing INTENT, mirrored where Swift can read it.
    //
    // `sc.social.sharingEnabled` lives in expo-sqlite and is unreachable from a launch that never
    // starts React — which is precisely the launch that needs to know whether to arm. Mirroring it
    // here needs no JS change at all: `startNativeBackground` / `stopNativeBackground` /
    // `setBackgroundCadence` are the only things that drive this runtime, so every transition
    // already passes through `persistState`.
    defaults.set(running, forKey: Self.armedKey)
    defaults.set(Int(slotIntervalMs), forKey: "sc.bg.interval_ms")
    defaults.set(movingDistanceFilter, forKey: "sc.bg.distance_m")
    defaults.set(movingAccuracy, forKey: "sc.bg.accuracy_m")
    if let stopAnchor {
      defaults.set(stopAnchor.coordinate.latitude, forKey: "sc.bg.anchor.lat")
      defaults.set(stopAnchor.coordinate.longitude, forKey: "sc.bg.anchor.lon")
      defaults.set(stopAnchor.timestamp.timeIntervalSince1970, forKey: "sc.bg.anchor.ts")
      defaults.set(stopVia?.rawValue, forKey: "sc.bg.anchor.via")
    } else {
      defaults.removeObject(forKey: "sc.bg.anchor.lat")
      defaults.removeObject(forKey: "sc.bg.anchor.lon")
      defaults.removeObject(forKey: "sc.bg.anchor.ts")
      defaults.removeObject(forKey: "sc.bg.anchor.via")
    }
    if let lastVisitAt {
      defaults.set(lastVisitAt.timeIntervalSince1970, forKey: "sc.bg.last_visit_ts")
    }
    writeCandidate(to: defaults)
  }

  /// Write the dwell-in-progress — `stopCandidate` and `visitArrival` — if it changed. See both.
  private func persistCandidateIfChanged() {
    guard candidateDirty else { return }
    writeCandidate(to: UserDefaults.standard)
  }

  private func writeCandidate(to defaults: UserDefaults) {
    candidateDirty = false
    Self.write(stopCandidate?.centre, prefix: "sc.bg.candidate", to: defaults)
    if let since = stopCandidate?.since {
      defaults.set(since.timeIntervalSince1970, forKey: "sc.bg.candidate.since")
    } else {
      defaults.removeObject(forKey: "sc.bg.candidate.since")
    }
    Self.write(visitArrival, prefix: "sc.bg.visit_arrival", to: defaults)
  }

  private static func write(_ location: CLLocation?, prefix: String, to defaults: UserDefaults) {
    guard let location else {
      for key in ["lat", "lon", "acc", "ts"] { defaults.removeObject(forKey: "\(prefix).\(key)") }
      return
    }
    defaults.set(location.coordinate.latitude, forKey: "\(prefix).lat")
    defaults.set(location.coordinate.longitude, forKey: "\(prefix).lon")
    defaults.set(location.horizontalAccuracy, forKey: "\(prefix).acc")
    defaults.set(location.timestamp.timeIntervalSince1970, forKey: "\(prefix).ts")
  }

  private static func readLocation(prefix: String, from defaults: UserDefaults) -> CLLocation? {
    guard defaults.object(forKey: "\(prefix).lat") != nil else { return nil }
    return CLLocation(
      coordinate: CLLocationCoordinate2D(
        latitude: defaults.double(forKey: "\(prefix).lat"),
        longitude: defaults.double(forKey: "\(prefix).lon")),
      altitude: 0,
      horizontalAccuracy: defaults.double(forKey: "\(prefix).acc"),
      verticalAccuracy: -1,
      timestamp: Date(timeIntervalSince1970: defaults.double(forKey: "\(prefix).ts")))
  }

  /// Bring back a dwell an earlier process started. Only while `moving` — a restored `stopped`
  /// already has its anchor, and a candidate beside it would be a contradiction.
  private func restoreCandidate(from defaults: UserDefaults) {
    guard state == .moving else { return }
    if let centre = Self.readLocation(prefix: "sc.bg.candidate", from: defaults),
      defaults.object(forKey: "sc.bg.candidate.since") != nil
    {
      stopCandidate = (
        centre: centre,
        since: Date(timeIntervalSince1970: defaults.double(forKey: "sc.bg.candidate.since"))
      )
      // The speculative fence `openStopCandidate` armed is still held by Core Location; adopt it
      // so `abandonStopCandidate` takes it down again if this turns out to be a departure.
      if manager.monitoredRegions.contains(where: { $0.identifier == Self.stopAnchorRegionId }) {
        candidateFence = centre
      }
    }
    if let arrival = Self.readLocation(prefix: "sc.bg.visit_arrival", from: defaults),
      Date().timeIntervalSince(arrival.timestamp) < Self.visitArrivalLifetime
    {
      visitArrival = arrival
    }
    candidateDirty = false
  }

  /// Whether sharing was on when this app was last running — readable with no JS and no SQLite.
  static let armedKey = "sc.bg.armed"

  /// Was sharing armed when we last persisted? The question a JS-free launch has to answer before
  /// it can decide whether to start the Core Location ladder.
  static var wasArmed: Bool { UserDefaults.standard.bool(forKey: armedKey) }

  private func restorePersistedState() {
    let defaults = UserDefaults.standard
    if let raw = defaults.string(forKey: "sc.bg.state"), let restored = MotionState(rawValue: raw) {
      state = restored
    }
    // Come back on the cadence we were last told to use rather than the compiled-in default, so a
    // launch with no JS to re-program us does not quietly publish on a different schedule — the
    // interval IS the thing the stash can read.
    let interval = defaults.integer(forKey: "sc.bg.interval_ms")
    if interval > 0 { slotIntervalMs = UInt64(interval) }
    let distance = defaults.double(forKey: "sc.bg.distance_m")
    if distance > 0 { movingDistanceFilter = distance }
    let accuracy = defaults.double(forKey: "sc.bg.accuracy_m")
    if accuracy > 0 { movingAccuracy = accuracy }
    let visitTs = defaults.double(forKey: "sc.bg.last_visit_ts")
    if visitTs > 0 { lastVisitAt = Date(timeIntervalSince1970: visitTs) }
    restoreCandidate(from: defaults)
    guard defaults.object(forKey: "sc.bg.anchor.lat") != nil else { return }
    stopVia = defaults.string(forKey: "sc.bg.anchor.via").flatMap(StopEvidence.init(rawValue:))
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
    // Every reason here IS a wake — this is the one place all five paths converge, which is why
    // the ledger hangs off it rather than off each delegate callback.
    BackgroundWakeLedger.noteWake()
  }

  // MARK: - CLLocationManagerDelegate

  func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
    guard let location = locations.last else { return }
    let battery = Self.battery()
    lastSeenLocation = location
    // Core Location hands back positions it has already given us — after a re-request, and on
    // 2026-10-02 every 30 s for 73 minutes while the phone could get nothing newer. A repeated
    // position carries no new information, and treating it as a capture did harm twice: the first
    // ones passed the gate and went out `live` with a position 5-9 minutes old, and the rest were
    // refused as stale while looking, to every counter, like a phone receiving fixes.
    let redelivery = lastDeliveredAt.map { location.timestamp <= $0 } ?? false
    if !redelivery { lastDeliveredAt = location.timestamp }
    reporter.noteDelivery(location, redelivery: redelivery)

    switch state {
    case .moving where redelivery:
      // It can still finish a dwell. A candidate is waiting on a second delivery inside its radius
      // `stopDwellSeconds` after the first, and a phone that can produce nothing newer than the
      // position it opened on is exactly a phone that has not gone anywhere. It is never ingested.
      if stopCandidate != nil {
        considerStopping(at: location)
        if state == .stopped {
          Task { await self.heartbeat(battery: battery, parked: true) }
          return
        }
      }
      // Otherwise it is worth something as a clock: it proves the process is running, and on a
      // JS-free process nothing else ticks while `moving`. Fill a due slot from the last ACCEPTED
      // fix, claiming nothing about motion, and no more than once a minute.
      let now = Date()
      if let last = lastRedeliveryHeartbeatAt,
        now.timeIntervalSince(last) < Self.redeliveryHeartbeatFloor
      {
        return
      }
      lastRedeliveryHeartbeatAt = now
      Task { await self.heartbeat(battery: battery, parked: nil) }

    case .moving:
      note(.movement)
      // Re-tier from the speed this fix reports. Cheap, and it is what keeps a walk from being
      // sampled like a motorway.
      applyMovingCadence(speedMps: location.speed)
      // Decide whether this delivery is the one that confirms a stop BEFORE deciding what to
      // publish, because if it is, the envelope it seals has to SAY so.
      //
      // `FIX_STATE_PARKED` is stamped only by `heartbeat`, and until 2026-09-29 the first heartbeat
      // after a stop came from the next tick of the parked coarse stream. That tick never comes to
      // a process iOS has suspended — which is every process relaunched in the background, since
      // those never get continuous background execution — so the last envelope before the silence
      // went out `live`: on 2026-09-29 an iPhone arrived somewhere, sealed its 17:51:10 slot
      // `fix_state=1` on a wake five minutes after the last (long enough to satisfy the dwell),
      // was suspended nine seconds later and never heard from again, and its friend's map had no way to tell a
      // parked phone from a dead one, which is the entire reason the stamp exists. The confirming
      // delivery is the last one we are sure to get, so it carries the declaration.
      //
      // Nothing is lost by not ingesting it: a stop is only confirmed inside `stopJitterRadiusM` of
      // a candidate whose fixes were already ingested, and the heartbeat republishes the last of
      // those. It also saves the stamp when this slot is already covered, so whatever wake comes
      // next — SLC, BGProcessing, the app opening — seals `parked` too.
      considerStopping(at: location)
      if state == .stopped {
        Task { await self.heartbeat(battery: battery, parked: true) }
      } else {
        let fix = Self.fix(from: location)
        Task { await self.ingest(fix: fix, battery: battery) }
      }

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
      Task { await self.heartbeat(battery: battery, parked: true) }
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
    Task { await self.heartbeat(battery: battery, parked: false) }
    return true
  }

  func locationManager(
    _ manager: CLLocationManager, didExitRegion region: CLRegion
  ) {
    guard region.identifier == Self.stopAnchorRegionId else { return }
    reporter.event(.fenceExit)
    // The whole point of the stopped state: exit is event-driven, so we are responsive to movement
    // and cost nothing while parked, which normally trade off against each other.
    //
    // `enterMoving` restarts the precise stream, whose first delivery is the fresh position — no
    // one-shot request, which is not a supported combination with an active stream. The heartbeat
    // covers the gap until that lands, so a crossing is never a silent slot.
    enterMoving(reason: .geofenceExit)
    let battery = Self.battery()
    Task { await self.heartbeat(battery: battery, parked: false) }
  }

  /// Core Location's own verdict that the phone has arrived somewhere, or left.
  ///
  /// ## Why the state machine needs it
  ///
  /// Confirming a stop takes a second delivery `stopDwellSeconds` after the first, which assumes
  /// the process is still running when the dwell elapses. A process started in the foreground is;
  /// one relaunched in the background is not — iOS gives it bursts of about ninety seconds and
  /// suspends it while the candidate is still dwelling, and nothing then wakes it, because the
  /// phone has stopped and every other rung of the ladder (SLC, the fence) is waiting for it to
  /// move. On 2026-09-30 that left an iPhone at a friend's that never declared itself parked.
  ///
  /// A visit is the one wake iOS raises for a phone that has STOPPED, and it relaunches a
  /// terminated app to deliver it. It shows no indicator and keeps nothing resident, which is why
  /// it, and not a `CLBackgroundActivitySession`, is what finishes the stop — see the note above
  /// `serviceRefresh`. A foreground-started process is normally parked by the ordinary dwell
  /// minutes before a visit arrives, so for it an arrival finds `stopped` and changes nothing.
  ///
  /// ## What it may and may not conclude
  ///
  /// A visit's coordinate can be coarse and its delivery late, so it is cross-checked against the
  /// newest position we hold rather than trusted alone. "The same place" means within the visit's
  /// own accuracy plus the fence radius — the tolerance `considerDeparture` uses, for the same
  /// reason.
  ///
  /// - An **arrival** while `moving` takes the stop, unless we hold a position from after the
  ///   arrival that is elsewhere (a late event about a place already left). Speed alone does not
  ///   veto it: the arrival is dated before the last fix of the approach, which is often still
  ///   moving. The anchor is always a real, slow fix from after the arrival — never the visit's own
  ///   coordinate — so with none in hand yet the arrival waits in `visitArrival`, persisted, with
  ///   the stream unfiltered so the fix that settles it actually arrives.
  ///   An arrival somewhere other than the anchor while `stopped` re-parks there: the fence missed
  ///   the departure, and this is where the phone now is.
  /// - A **departure** from the anchor, dated after we parked, leaves `stopped` — a third way out
  ///   alongside the fence and `considerDeparture`, for the same reason the second one exists.
  ///   While `moving` it changes nothing: the precise stream already has the phone.
  func locationManager(_ manager: CLLocationManager, didVisit visit: CLVisit) {
    lastVisitAt = Date()
    guard running else { return }
    note(.visit)
    persistState()

    // A negative accuracy means the coordinate is invalid, not that it is perfect.
    guard visit.horizontalAccuracy >= 0 else {
      reporter.event(.visit, reason: "invalid")
      return
    }
    let arrival = visit.departureDate == .distantFuture
    let at = arrival ? visit.arrivalDate : visit.departureDate
    let place = CLLocation(
      coordinate: visit.coordinate,
      altitude: 0,
      horizontalAccuracy: visit.horizontalAccuracy,
      verticalAccuracy: -1,
      timestamp: at == .distantPast ? Date() : at)
    let reach = visit.horizontalAccuracy + Self.stopAnchorRadiusM
    let newest = newestLocation()
    // What this visit DID, on the span. Until 2026-10-06 the span went out before the decision and
    // the decision went to `NSLog`, which reaches no telemetry — so an arrival the phone threw away
    // and one it was still waiting on read identically, and the one evening that needed telling
    // apart had to be reconstructed from which code path the next fix could have taken.
    var outcome = "ignored"
    defer {
      persistCandidateIfChanged()
      reporter.event(.visit, reason: arrival ? "arrival" : "departure", detail: outcome)
      NSLog(
        "[iroh-location] visit: \(arrival ? "arrival" : "departure") -> \(outcome) "
          + "state=\(state.rawValue) accuracy=\(Int(visit.horizontalAccuracy))m")
    }

    if !arrival {
      // Whatever arrival we were holding, the phone has now left it.
      visitArrival = nil
      guard state == .stopped, let anchor = stopAnchor,
        visit.departureDate > anchor.timestamp,
        place.distance(from: anchor) <= reach
      else { return }
      enterMoving(reason: .visit)
      outcome = "unparked"
      let battery = Self.battery()
      Task { await self.heartbeat(battery: battery, parked: false) }
      return
    }

    // A position from after the arrival that is somewhere ELSE outranks the visit: the event is
    // about a place already left.
    //
    // Distance only. Speed used to veto too, and that is what lost the 2026-10-06 arrival: iOS
    // dates an arrival to when the phone entered the place, which is routinely before the last
    // fix of the drive in, so the fix taken pulling up outside the house at 8.6 m/s was "newer and
    // moving" and the visit was discarded. A fast fix INSIDE the place's reach is the approach,
    // not a departure — it just cannot be the anchor, which is handled below.
    if let newest, newest.timestamp > visit.arrivalDate, newest.distance(from: place) > reach {
      outcome = "stale"
      return
    }

    switch state {
    case .moving:
      break
    case .stopped:
      // Already parked here: nothing to learn. Parked somewhere else: the fence missed the
      // departure, so go back to `moving` — the precise stream it restarts is what finds the new
      // spot, and the pending arrival below parks on its first fix.
      guard let anchor = stopAnchor, place.distance(from: anchor) > reach,
        visit.arrivalDate > anchor.timestamp
      else {
        outcome = "already-parked"
        return
      }
      enterMoving(reason: .visit)
    }

    // The fence is only ever centred on a REAL, SLOW fix from after the arrival, never on the
    // visit's own coordinate: a visit can be hundreds of metres coarse, and a fence armed around a
    // spot the phone is already outside never reports an exit — a park with no way out.
    if let newest, newest.timestamp >= visit.arrivalDate, !Self.isMovingFast(newest) {
      enterStopped(anchor: newest, via: .visit)
    } else if let candidate = stopCandidate, candidate.centre.timestamp >= visit.arrivalDate,
      candidate.centre.distance(from: place) <= reach
    {
      enterStopped(anchor: candidate.centre, via: .visit)
    }
    if state == .stopped {
      outcome = "parked"
    } else {
      // Nothing usable from after the arrival yet — on a relaunch, the cache; on a process that
      // was already running, the last fix of the drive in. `considerStopping` parks on the first
      // fix that agrees, and that fix has to be made to come: a process on the moving cadence
      // has a 20-50 m distance filter, and a phone that has arrived somewhere moves less than
      // that, so it would wait forever. That wait is the second half of 2026-10-06. Unfiltering
      // is what the candidate dwell does for the same reason, at the same accuracy.
      visitArrival = place
      holdCandidateCadence()
      outcome = "pending"
    }
    // Say so on the wire now, for the reason the confirming delivery does: this wake may be the
    // last this process gets before the phone is next moved. That holds in the pending case too:
    // the arrival is the OS saying the phone has stopped, so the `parked` stamp a heartbeat
    // carries is honest before a fix has placed it, and a fix showing otherwise re-stamps `live`.
    let battery = Self.battery()
    Task { await self.heartbeat(battery: battery, parked: true) }
  }

  /// Faster than anyone standing somewhere. A negative speed is Core Location's "unknown", which
  /// is not evidence of motion.
  private static func isMovingFast(_ location: CLLocation) -> Bool {
    location.speed >= 0 && location.speed > 1.0
  }

  /// Whichever of Core Location's cached position and the last one delivered to us is newer.
  private func newestLocation() -> CLLocation? {
    switch (manager.location, lastSeenLocation) {
    case let (cached?, seen?): return cached.timestamp >= seen.timestamp ? cached : seen
    case let (cached, seen): return cached ?? seen
    }
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
    if running { reporter.event(.authorization, reason: Self.authorizationName(status)) }
    switch status {
    case .authorizedAlways:
      guard running else { return }
      manager.allowsBackgroundLocationUpdates = true
      manager.startMonitoringSignificantLocationChanges()
      manager.startMonitoringVisits()
      rearmStopAnchorFence()
      note(.stateChange)
    case .authorizedWhenInUse:
      // Foreground updates still work; background ones will not survive suspension. Keep running
      // so the app is useful, and let `device.health` carry the truth. Core Location reports the
      // current status once at construction, which the bootstrap now does on every launch; that
      // is not a wake of a runtime that is not running.
      guard running else { return }
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
    reporter.event(.paused)
    manager.startUpdatingLocation()
  }

  func locationManagerDidResumeLocationUpdates(_ manager: CLLocationManager) {
    NSLog("[iroh-location] Core Location resumed updates")
    reporter.event(.resumed)
  }

  func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
    // Not fatal and not rare — a denied authorisation or a momentary lack of any fix both land
    // here. `requestLocation` in particular fails outright when it cannot get a fix in time, and
    // the running stream is unaffected, so this must not tear anything down.
    NSLog("[iroh-location] background location error: \(error.localizedDescription)")
    reporter.event(.locationError, detail: error.localizedDescription)
  }

  func locationManager(
    _ manager: CLLocationManager, monitoringDidFailFor region: CLRegion?, withError error: Error
  ) {
    // A fence we could not arm is a resurrection rung we do not have. SLC still covers us, but this
    // is worth saying out loud rather than inferring later from an absence.
    NSLog("[iroh-location] stop-anchor fence failed to arm: \(error.localizedDescription)")
    reporter.event(.fenceFailed, detail: error.localizedDescription)
  }

  // MARK: - Node lifecycle

  /// Hand a capture to the mounted JS runtime, which owns the node this process's stores belong to.
  ///
  /// `kind` is `fix` when there is a position to run through the gate and `heartbeat` when this is
  /// a tick from the parked coarse stream, which has no position worth gating — see the two call
  /// sites. Dropping to the main queue because that is where the Expo event emitter expects to be
  /// called from, and Core Location has already delivered us there anyway.
  private func handOff(
    kind: String, fix: LocationFix?, battery: BatteryState, parked: Bool? = nil
  ) {
    var payload: [String: Any] = [
      "kind": kind,
      "reason": lastWakeReason.rawValue,
      "state": state.rawValue,
      "battery": [
        "level": battery.level, "charging": battery.charging, "lowPower": battery.lowPower,
      ],
    ]
    // The heartbeat's motion claim, forwarded to `heartbeatFix` by `routeNativeCapture`. Omitted
    // rather than null when there is none, which reads the same as a binary that predates it.
    if let parked { payload["parked"] = parked }
    if let fix {
      payload["fix"] = [
        "lat": fix.lat, "lon": fix.lon, "accuracyM": fix.accuracyM,
        "headingDeg": fix.headingDeg, "ts": fix.ts,
      ]
    }
    let sink = eventSink
    // Handing off ends this side's part of the wake, whatever JS then does with it.
    BackgroundWakeLedger.closeWindow()
    guard let sink else {
      // Nobody to hand it to, and `ensureStarted` has already declined to take the node — so this
      // fix is being discarded. That must never be silent: a `sink?.sendEvent(...)` on a nil sink
      // is how a moving phone published nothing for an hour with nothing in any log to say so.
      // If this line appears at all, the gate above is wrong again.
      BackgroundWakeLedger.noteDroppedCapture()
      NSLog("[iroh-location] DROPPED \(kind): no node and no JS sink — nothing will publish this")
      return
    }
    reporter.noteHandOff()
    DispatchQueue.main.async { sink.sendEvent("onNativeFix", payload) }
    // The app publishes this capture; receiving is still ours while it is off screen, since its own
    // pull clock only runs on screen. `pullFriendFixes` declines when the app is active.
    Task { await self.pullFriendFixes() }
  }

  /// Run one captured fix through gate → outbox → seal → send.
  private func ingest(fix: LocationFix, battery: BatteryState) async {
    reporter.noteWorkStarted()
    defer { reporter.noteWorkFinished() }
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
      await pullFriendFixes()
      // The wake's work is done; fold what it cost into the counters. A window left open is not a
      // measurement error, it is the signal that the process did not survive its own wake.
      BackgroundWakeLedger.closeWindow()
    } catch {
      // The fix stays in the native outbox, so the next delivery retries it.
      NSLog("[iroh-location] ingest failed, fix stays queued: \(error.localizedDescription)")
    }
  }

  /// Fill the slots that have come due with no new fix, reusing the last accepted position.
  ///
  /// Not an optimisation. The cadence is the one property of a sealed envelope the stash can read,
  /// so it has to be uniform whether or not the phone is moving — a series that stops when its
  /// owner sits still is a series that leaks when its owner sits still.
  ///
  /// `parked` is the motion claim the envelopes carry: `true` only from a proven stop (a confirmed
  /// dwell, a visit arrival, a parked coarse tick), `false` from a stop just left, `nil` from a
  /// clock that proves neither. Until 2026-10-02 every heartbeat stamped `parked`, and the mounted
  /// timer published four hours of it from an iPhone this file had in `moving`.
  private func heartbeat(battery: BatteryState, parked: Bool?) async {
    reporter.noteWorkStarted()
    defer { reporter.noteWorkFinished() }
    guard let subscription = await ensureStarted() else {
      handOff(kind: "heartbeat", fix: nil, battery: battery, parked: parked)
      return
    }
    do {
      let outcome = try await subscription.heartbeatFix(
        subscriptionId: Self.subscriptionId,
        battery: battery,
        intervalMs: slotIntervalMs,
        nowMs: UInt64(Date().timeIntervalSince1970 * 1000),
        parked: parked)
      report("heartbeat", outcome)
      await pullFriendFixes()
      BackgroundWakeLedger.closeWindow()
    } catch {
      NSLog("[iroh-location] heartbeat failed: \(error.localizedDescription)")
    }
  }

  /// Pull friends' new fixes, so a JS-free wake RECEIVES as well as sends.
  ///
  /// Publishing without pulling makes a phone that never opens the app a write-only participant:
  /// its own dot moves for everyone else while every friend's dot on ITS map is frozen at whatever
  /// was last reconciled. That used to be the periodic `bg.refresh`'s job, which needed a JS
  /// context; with the refresh retired on iOS this is the only thing left that does it.
  ///
  /// ## Gated hard, because this is the expensive half
  ///
  /// `sync_latest` dials every delivery peer. `push_trail_budgeted`'s own notes record that 74% of
  /// pushes burned the full 30 s budget waiting on peers that never answered — 41.7 hours a week —
  /// so an ungated pull on every coarse tick is a new way to spend the exact budget this work
  /// exists to protect. Two gates:
  ///
  /// - a durable floor between pulls, so a burst of deliveries is still one pull: five minutes on a
  ///   wake that means something moved (`movement`, `geofence_exit`, `relaunch`, `visit`) or the
  ///   rare `refresh` the OS hands a parked phone, fifteen on a `periodic` tick from the parked
  ///   coarse stream, which is a clock rather than news;
  /// - and a wall-clock budget, clamped to what iOS says is left of the background allowance, so a
  ///   pull ends on our deadline rather than on the OS's.
  ///
  /// ## Also for a mounted app in the background
  ///
  /// Not only the JS-free wake. A foreground-launched app that is then pocketed stays resident
  /// (the location background mode), takes every capture through `handOff`, and until 2026-10-09
  /// pulled on none of them: the fleet showed 4892 wakes and 0 pulls across six hours on one
  /// iPhone, and every friend's dot frozen until the app was opened. The one case left out is the
  /// app ON SCREEN, which pulls for itself every 20 s – 5 min (`presenceSyncIntervalMs`). After a
  /// pull a mounted app is told (`onFriendsPulled`) so it re-reads the replica it already holds.
  ///
  /// ## Watched, because the failure it risks is silent
  ///
  /// Each pull is a `friend.pull` span (see `friend_pull.rs`) with the wake, the budget, iOS's
  /// remaining allowance before and after, and the CPU it cost; and a `wake.pull_*` counter in
  /// `BackgroundWakeLedger`, which survives a process that does not. A pull iOS cuts off is
  /// reported twice over: by the background task's expiration handler while it is happening
  /// (`expired`), and by the next pull, which finds the in-flight mark it never cleared
  /// (`stranded`).
  ///
  /// Failures are swallowed on purpose: a pull that could not reach anyone must not fail the
  /// publish that has already succeeded, and the next wake tries again.
  private func pullFriendFixes() async {
    let trigger = lastWakeReason
    let floorMs: Double
    switch trigger {
    case .movement, .geofenceExit, .relaunch, .refresh, .visit: floorMs = Self.syncFloorMs
    case .periodic: floorMs = Self.parkedSyncFloorMs
    case .coarseDeparture, .stateChange, .seed: return
    }
    let wired = eventSink != nil
    let appState = await MainActor.run { UIApplication.shared.applicationState }
    if wired && appState == .active { return }

    // Floor and in-flight check in one synchronous step, so concurrent deliveries cannot both
    // pass. An in-flight pull older than any budget allows is one that never came back.
    guard let claim = claimPull(floorMs: floorMs) else { return }
    defer { releasePull(claim.startedAt) }
    let nowMs = claim.nowMs
    let sinceLastMs: UInt64? = claim.lastMs > 0 ? UInt64(max(0, nowMs - claim.lastMs)) : nil

    // A mark left by an earlier pull means that pull never returned: the process was frozen or
    // killed inside it. Nothing else can say so.
    if let stranded = BackgroundWakeLedger.takeOpenPull() {
      BackgroundWakeLedger.notePullStranded()
      recordFriendPull(
        event: FriendPullEvent(
          outcome: .stranded, trigger: stranded.trigger, appState: "unknown", jsWired: false,
          budgetMs: stranded.budgetMs, bgRemainingStartMs: nil, bgRemainingEndMs: nil,
          elapsedMs: UInt64(max(0, nowMs - stranded.startedAtMs)), cpuMs: nil, cpuMsRust: nil,
          sinceLastMs: nil, floorMs: UInt64(floorMs), report: nil, error: nil))
      NSLog("[iroh-location] previous pull (\(stranded.trigger)) never returned")
    }

    guard let node = nodeHost().current() else { return }
    let peerTickets: [String]
    do {
      peerTickets = try await node.deliveryConfig().peerTickets
    } catch {
      NSLog("[iroh-location] pull skipped, no delivery config: \(error.localizedDescription)")
      return
    }
    guard !peerTickets.isEmpty else { return }

    // Ask iOS for time BEFORE reading how much is left: a relaunched process servicing a delivery
    // has seconds, and the assertion is what turns that into the ~30 s a pull can use.
    let task = PullBackgroundTask()
    let remainingStart: TimeInterval = await MainActor.run {
      task.begin { [weak task] in
        // On main, from iOS, with the pull still running: we are about to be suspended.
        guard let task, let ctx = task.expire() else { return }
        BackgroundWakeLedger.notePullExpired()
        recordFriendPull(
          event: FriendPullEvent(
            outcome: .expired, trigger: ctx.trigger, appState: ctx.appState, jsWired: ctx.wired,
            budgetMs: ctx.budgetMs, bgRemainingStartMs: ctx.remainingStartMs,
            bgRemainingEndMs: 0,
            elapsedMs: UInt64(max(0, Date().timeIntervalSince(ctx.startedAt) * 1000)),
            cpuMs: nil, cpuMsRust: nil, sinceLastMs: ctx.sinceLastMs, floorMs: ctx.floorMs,
            report: nil, error: nil))
        NSLog("[iroh-location] background time expired mid-pull (\(ctx.trigger))")
      }
      return UIApplication.shared.backgroundTimeRemaining
    }
    let remainingStartMs = Self.finiteMs(remainingStart)
    let budgetMs = Self.pullBudget(remainingMs: remainingStartMs)
    guard let budgetMs else {
      BackgroundWakeLedger.notePullNoTime()
      NSLog("[iroh-location] pull skipped: \(remainingStartMs ?? 0) ms of background time left")
      await MainActor.run { task.end() }
      return
    }

    let stateLabel = Self.label(appState)
    let startedAt = Date()
    task.arm(
      PullBackgroundTask.Context(
        trigger: trigger.rawValue, appState: stateLabel, wired: wired, budgetMs: budgetMs,
        remainingStartMs: remainingStartMs, startedAt: startedAt, sinceLastMs: sinceLastMs,
        floorMs: UInt64(floorMs)))
    let mark = BackgroundWakeLedger.openPull(trigger: trigger.rawValue, budgetMs: budgetMs)
    let cpuStart = BackgroundWakeLedger.cpuMs()
    let rustStart = BackgroundWakeLedger.groupCpuMs()[.rust]

    var report: PullReport?
    var failure: String?
    do {
      report = try await node.pullLatest(
        peerTickets: peerTickets, budgetMs: budgetMs, traceparent: nil)
    } catch {
      failure = error.localizedDescription
    }

    let elapsedMs = max(0, Date().timeIntervalSince(startedAt) * 1000)
    let cpuMs = max(0, BackgroundWakeLedger.cpuMs() - cpuStart)
    let rustMs = rustStart.flatMap { start in
      BackgroundWakeLedger.groupCpuMs()[.rust].map { max(0, $0 - start) }
    }
    BackgroundWakeLedger.closePull(mark)
    let remainingEnd: TimeInterval = await MainActor.run {
      let left = UIApplication.shared.backgroundTimeRemaining
      task.end()
      return left
    }
    let overran = elapsedMs > Double(budgetMs) + Self.pullOverrunSlackMs

    BackgroundWakeLedger.noteSync()
    BackgroundWakeLedger.notePull(
      elapsedMs: elapsedMs, cpuMs: cpuMs, delivered: (report?.entries ?? 0) > 0,
      failed: failure != nil, deadlineHit: (report?.nsDeadline ?? 0) > 0, overran: overran)
    recordFriendPull(
      event: FriendPullEvent(
        outcome: failure == nil ? .completed : .failed, trigger: trigger.rawValue,
        appState: stateLabel, jsWired: wired, budgetMs: budgetMs,
        bgRemainingStartMs: remainingStartMs, bgRemainingEndMs: Self.finiteMs(remainingEnd),
        elapsedMs: UInt64(elapsedMs), cpuMs: UInt64(cpuMs), cpuMsRust: rustMs.map { UInt64($0) },
        sinceLastMs: sinceLastMs, floorMs: UInt64(floorMs), report: report, error: failure))

    if let failure {
      NSLog("[iroh-location] pull failed, next wake retries: \(failure)")
      return
    }
    let entries = report?.entries ?? 0
    NSLog(
      "[iroh-location] pulled \(entries) entr(ies) from \(peerTickets.count) peer(s) in "
        + "\(Int(elapsedMs)) ms (budget \(budgetMs), \(stateLabel), \(trigger.rawValue))")
    // A mounted app draws friends from its own store, filled from the replica only when it reads
    // it; say there is something to read, so the map is current the moment it is opened.
    if wired, entries > 0, let sink = eventSink {
      let payload: [String: Any] = [
        "trigger": trigger.rawValue, "entries": Int(entries), "elapsedMs": Int(elapsedMs),
      ]
      DispatchQueue.main.async { sink.sendEvent("onFriendsPulled", payload) }
    }
  }

  /// The budget for one pull given iOS's remaining allowance, or `nil` when there is too little
  /// left to be worth starting. Leaves `pullSafetyMs` for the work after the pull and for
  /// `endBackgroundTask`, since an assertion still held when the allowance runs out gets the
  /// process killed rather than suspended.
  private static func pullBudget(remainingMs: UInt64?) -> UInt64? {
    guard let remainingMs else { return pullBudgetMs }
    let usable = remainingMs > pullSafetyMs ? remainingMs - pullSafetyMs : 0
    let budget = min(pullBudgetMs, usable)
    return budget >= pullMinBudgetMs ? budget : nil
  }

  /// `backgroundTimeRemaining` as milliseconds, or `nil` for the "no limit" it reports while the
  /// app is active (`.greatestFiniteMagnitude`).
  private static func finiteMs(_ seconds: TimeInterval) -> UInt64? {
    guard seconds.isFinite, seconds < 24 * 3600 else { return nil }
    return UInt64(max(0, seconds) * 1000)
  }

  private static func label(_ state: UIApplication.State) -> String {
    switch state {
    case .active: return "active"
    case .inactive: return "inactive"
    case .background: return "background"
    @unknown default: return "unknown"
    }
  }

  private static let lastSyncKey = "sc.bg.last_sync_ms"
  /// Minimum gap between receive-side pulls. Five minutes matches the default publish slot, so a
  /// phone in motion pulls about as often as it sends and no more.
  private static let syncFloorMs: Double = 5 * 60 * 1000
  /// The floor on the parked coarse stream's clock ticks: three publish slots. A parked phone's
  /// friends still move, but nothing about its own wake says they did.
  private static let parkedSyncFloorMs: Double = 15 * 60 * 1000
  /// The most one pull may take. A pass that is answered finishes in about a second (`trail.sync`
  /// p50 150–350 ms over 2026-10-02..09); the rest of a long one is waiting on peers that are
  /// asleep, which is the time a background window cannot spare.
  private static let pullBudgetMs: UInt64 = 20_000
  /// Below this there is no point starting: a cold dial alone takes longer.
  private static let pullMinBudgetMs: UInt64 = 3_000
  /// Kept back from iOS's allowance for everything after the pull.
  private static let pullSafetyMs: UInt64 = 5_000
  /// Past the budget by more than this, the deadline timer could not have been running.
  private static let pullOverrunSlackMs: Double = 2_000
  /// An in-memory in-flight pull older than budget + this is treated as gone.
  private static let pullStaleSlackMs: Double = 60_000

  private let pullLock = NSLock()
  /// When the pull in flight started, or `nil`. Guarded by `pullLock`.
  private var pullStartedAt: Date?

  /// Pass the floor and take the in-flight slot in one step, so concurrent deliveries cannot both
  /// get through. Synchronous on purpose: the lock is never held across an await. An in-flight
  /// pull older than any budget allows is one that never came back, and does not block.
  private func claimPull(floorMs: Double) -> (nowMs: Double, lastMs: Double, startedAt: Date)? {
    pullLock.lock()
    defer { pullLock.unlock() }
    let now = Date()
    if let inFlight = pullStartedAt,
      now.timeIntervalSince(inFlight) * 1000 < Double(Self.pullBudgetMs) + Self.pullStaleSlackMs
    {
      return nil
    }
    let nowMs = now.timeIntervalSince1970 * 1000
    let lastMs = UserDefaults.standard.double(forKey: Self.lastSyncKey)
    guard nowMs - lastMs >= floorMs else { return nil }
    UserDefaults.standard.set(nowMs, forKey: Self.lastSyncKey)
    pullStartedAt = now
    return (nowMs, lastMs, now)
  }

  /// Give the slot back — only if it is still ours. A pull that hung past the staleness bound has
  /// already been replaced, and must not release its successor's slot when it finally returns.
  private func releasePull(_ startedAt: Date) {
    pullLock.lock()
    if pullStartedAt == startedAt { pullStartedAt = nil }
    pullLock.unlock()
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

  /// The own-topic subscription on the process's node, taking the background lease if needed —
  /// or `nil` when a mounted app should get the capture instead.
  ///
  /// `nil` has three causes and only the first is routine: a mounted app is wired (`eventSink`)
  /// and runs the pipeline's front half itself; the device has no identity yet (a fresh install
  /// whose app has never run, where minting one would orphan the identity the app makes later);
  /// or the node could not be started. The last two are retried by the next delivery.
  ///
  /// There is no backoff, no owner flag and no in-flight dedupe any more. Each existed because
  /// this runtime used to BUILD a node, and a build could be refused by the app's claim (187
  /// constructions in a minute on 2026-09-16) or race a sibling delivery (three in a second on
  /// 2026-09-29). Now `NodeHost` builds at most one node per process and hands every caller the
  /// same one; concurrent deliveries simply queue on its transition lock.
  private func ensureStarted() async -> Subscription? {
    if eventSink != nil { return nil }
    do {
      let roots = nodeStorageRoots()
      guard
        let node = try await nodeHost().acquireBackground(
          secrets: KeychainDeviceSecrets.shared,
          dataRoot: roots.data.path,
          stateRoot: roots.state.path)
      else {
        return nil
      }
      // `nil` listener: never silence a mounted app's own-topic listener, and stay silent when
      // there is none. Inbound envelopes land in the replica either way.
      return try await node.ownSubscription(bootstrap: [], listener: nil)
    } catch {
      NSLog("[iroh-location] background node unavailable: \(error.localizedDescription)")
      return nil
    }
  }

  /// What `location.runtime` spans say about the state machine. See `LocationRuntimeReporter`.
  private func reportSnapshot() -> LocationRuntimeReporter.Snapshot {
    LocationRuntimeReporter.Snapshot(
      state: state.rawValue,
      reason: lastWakeReason.rawValue,
      desiredAccuracyM: manager.desiredAccuracy,
      distanceFilterM: manager.distanceFilter,
      nodeOwner: Self.nodeOwnerLabel(nodeHost().snapshot()),
      candidatePending: stopCandidate != nil,
      anchorArmed: stopAnchor != nil,
      fenceRegistered: manager.monitoredRegions.contains {
        $0.identifier == Self.stopAnchorRegionId
      })
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
      // Capture-side: the envelope stamps belong to a send that has not happened yet.
      state: nil,
      publishedDeltaS: nil)
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
  func onFix(
    author: Data, seq: UInt64, fix: LocationFix, backfill: Bool, via: String, viaPeer: String?
  ) {}
  func onOpaque(author: Data, seq: UInt64) {}
  func onStatus(status: String) {}
}

/// The background-task assertion one pull holds, and the context its expiration handler reports.
///
/// iOS calls the expiration handler on main while the pull may still be running, and the pull's
/// own completion ends the task on whatever thread it finishes on — so ending is idempotent and
/// both sides go through the lock. `expire()` returns the context only to the first caller, and
/// only while the pull is armed, so an expiry is reported once and never for a pull that already
/// returned.
private final class PullBackgroundTask: @unchecked Sendable {
  struct Context {
    let trigger: String
    let appState: String
    let wired: Bool
    let budgetMs: UInt64
    let remainingStartMs: UInt64?
    let startedAt: Date
    let sinceLastMs: UInt64?
    let floorMs: UInt64
  }

  private let lock = NSLock()
  private var id: UIBackgroundTaskIdentifier = .invalid
  private var context: Context?
  private var expired = false

  /// Call on main. `onExpire` runs on main, before the assertion is ended for it.
  func begin(onExpire: @escaping () -> Void) {
    let id = UIApplication.shared.beginBackgroundTask(withName: "sc.friend-pull") { [weak self] in
      onExpire()
      self?.end()
    }
    lock.lock()
    self.id = id
    lock.unlock()
  }

  func arm(_ context: Context) {
    lock.lock()
    self.context = context
    lock.unlock()
  }

  /// The context to report an expiry with, or `nil` when it is not this call's to report.
  func expire() -> Context? {
    lock.lock()
    defer { lock.unlock() }
    guard !expired, let context else { return nil }
    expired = true
    return context
  }

  /// End the assertion. Idempotent; call on main.
  func end() {
    lock.lock()
    let id = self.id
    self.id = .invalid
    context = nil
    lock.unlock()
    if id != .invalid { UIApplication.shared.endBackgroundTask(id) }
  }
}
