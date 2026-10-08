import CoreLocation
import Foundation

/// The Swift half of `location.runtime` — see `location_runtime.rs` for the incident behind it.
///
/// ## The short version
///
/// On 2026-10-01 an iPhone drove home for 88 minutes with its process demonstrably alive and
/// published nothing, and no record anywhere could say whether Core Location had stopped
/// delivering, the main thread had stopped servicing it, or the deliveries had arrived and the work
/// they spawned never ran. The state machine logged to `NSLog`, which never leaves the phone, and a
/// background-relaunched process never boots the JS that emits `device.health`. These three
/// questions now each have a counter, and the counters ship through the Rust exporter that a
/// JS-free process does have.
///
/// ## Why the pulse runs on its own timer
///
/// Reporting from `didUpdateLocations` would describe the deliveries that arrived and fall silent
/// exactly when they stop, which is the one case worth describing. So a timer on a background
/// queue emits the pulse, and each tick first asks the main thread to answer: an answer carries
/// the state snapshot and its round-trip time; no answer within `mainStallThreshold` is itself the
/// report (`main_stalled`), built only from what this class holds under its own lock.
///
/// It costs one wake every five minutes, and only while the process is already running — a
/// suspended process's timer does not fire, so this can never be the thing that keeps it awake.
final class LocationRuntimeReporter {
  /// The runtime's view of itself, built by its `snapshot` closure. The pulse builds it on main, so
  /// a main thread that cannot answer is measured rather than read through.
  struct Snapshot {
    var state: String
    var reason: String?
    var desiredAccuracyM: Double
    var distanceFilterM: Double
    var nodeOwner: String
    var candidatePending: Bool
    var anchorArmed: Bool
    var fenceRegistered: Bool
  }

  static let pulseInterval: TimeInterval = 5 * 60
  /// Longer than any ordinary main-thread hitch, short against the minutes a wedge lasts.
  static let mainStallThreshold: TimeInterval = 10

  private let lock = NSLock()
  private var deliveries: UInt32 = 0
  private var redeliveries: UInt32 = 0
  private var workStarted: UInt32 = 0
  private var workFinished: UInt32 = 0
  private var handedOff: UInt32 = 0
  private var lastDeliveryAt: Date?
  private var fixAgeAtDeliveryMs: UInt64?
  private var accuracyM: Double?
  private var speedMps: Double?
  /// The last snapshot main produced, for a `main_stalled` report that cannot ask main for one.
  private var lastSnapshot: Snapshot?
  /// Whether the previous probe went unanswered, so one stall is one report and its end is another.
  private var stalled = false

  private let queue = DispatchQueue(
    label: "com.unrealjune.irohlocation.runtime-pulse", qos: .utility)
  private var timer: DispatchSourceTimer?
  private let snapshot: () -> Snapshot

  /// - Parameter snapshot: called on main by the pulse, and on the caller's thread by `event`.
  init(snapshot: @escaping () -> Snapshot) {
    self.snapshot = snapshot
  }

  // MARK: - Counting

  /// One `didUpdateLocations`. `redelivery` when its newest location was not newer than the last.
  func noteDelivery(_ location: CLLocation, redelivery: Bool) {
    let now = Date()
    lock.lock()
    deliveries &+= 1
    if redelivery { redeliveries &+= 1 }
    lastDeliveryAt = now
    fixAgeAtDeliveryMs = UInt64(max(0, now.timeIntervalSince(location.timestamp)) * 1000)
    accuracyM = location.horizontalAccuracy
    speedMps = location.speed
    lock.unlock()
  }

  func noteWorkStarted() {
    lock.lock()
    workStarted &+= 1
    lock.unlock()
  }

  func noteWorkFinished() {
    lock.lock()
    workFinished &+= 1
    lock.unlock()
  }

  func noteHandOff() {
    lock.lock()
    handedOff &+= 1
    lock.unlock()
  }

  // MARK: - Events

  /// A discrete event, emitted where it happened. Does not reset the pulse counts.
  func event(_ kind: LocationRuntimeKind, reason: String? = nil, detail: String? = nil) {
    let snap = snapshot()
    var snapReason = snap
    if let reason { snapReason.reason = reason }
    lock.lock()
    lastSnapshot = snap
    let event = build(kind, snap: snapReason, latencyMs: nil, detail: detail, reset: false)
    lock.unlock()
    recordLocationRuntime(event: event)
  }

  func startPulse() {
    queue.async {
      guard self.timer == nil else { return }
      let timer = DispatchSource.makeTimerSource(queue: self.queue)
      timer.schedule(
        deadline: .now() + Self.pulseInterval, repeating: Self.pulseInterval,
        leeway: .seconds(30))
      timer.setEventHandler { [weak self] in self?.pulse() }
      self.timer = timer
      timer.resume()
    }
  }

  func stopPulse() {
    queue.async {
      self.timer?.cancel()
      self.timer = nil
    }
  }

  /// One tick, on `queue`. Blocks this utility queue — never main — for at most the stall threshold.
  private func pulse() {
    final class Box {
      let lock = NSLock()
      var snap: Snapshot?
    }
    let box = Box()
    let answered = DispatchSemaphore(value: 0)
    let sent = Date()
    DispatchQueue.main.async {
      let snap = self.snapshot()
      box.lock.lock()
      box.snap = snap
      box.lock.unlock()
      answered.signal()
    }
    let ok = answered.wait(timeout: .now() + Self.mainStallThreshold) == .success
    let latencyMs = UInt64(Date().timeIntervalSince(sent) * 1000)

    lock.lock()
    let event: LocationRuntimeEvent
    if ok {
      box.lock.lock()
      let snap = box.snap
      box.lock.unlock()
      lastSnapshot = snap
      stalled = false
      event = build(.pulse, snap: snap, latencyMs: latencyMs, detail: nil, reset: true)
    } else if !stalled {
      stalled = true
      event = build(
        .mainStalled, snap: lastSnapshot, latencyMs: latencyMs, detail: nil, reset: true)
    } else {
      // Still wedged: the counts keep accumulating into the pulse that follows recovery, and the
      // stall has already been reported once.
      lock.unlock()
      return
    }
    lock.unlock()
    recordLocationRuntime(event: event)
  }

  /// Caller holds `lock`.
  private func build(
    _ kind: LocationRuntimeKind, snap: Snapshot?, latencyMs: UInt64?, detail: String?,
    reset: Bool
  ) -> LocationRuntimeEvent {
    let event = LocationRuntimeEvent(
      kind: kind,
      state: snap?.state ?? "unknown",
      reason: snap?.reason,
      deliveries: deliveries,
      redeliveries: redeliveries,
      workStarted: workStarted,
      workFinished: workFinished,
      handedOff: handedOff,
      lastDeliveryAgeMs: lastDeliveryAt.map { UInt64(max(0, Date().timeIntervalSince($0)) * 1000) },
      fixAgeAtDeliveryMs: fixAgeAtDeliveryMs,
      accuracyM: accuracyM,
      speedMps: speedMps,
      desiredAccuracyM: snap?.desiredAccuracyM ?? -1,
      distanceFilterM: snap?.distanceFilterM ?? -1,
      mainLatencyMs: latencyMs,
      nodeOwner: snap?.nodeOwner ?? "unknown",
      candidatePending: snap?.candidatePending ?? false,
      anchorArmed: snap?.anchorArmed ?? false,
      fenceRegistered: snap?.fenceRegistered ?? false,
      detail: detail)
    // `workStarted`/`workFinished` are deliberately NOT reset: they are process-lifetime totals,
    // so their difference is the work in flight right now, whichever pulse it straddles.
    if reset {
      deliveries = 0
      redeliveries = 0
      handedOff = 0
    }
    return event
  }
}
