import Foundation
import UIKit

/// The background-task assertion one piece of native publish work runs under: a capture, a
/// heartbeat, or a capture and the claim it owes.
///
/// ## Why it exists
///
/// Core Location wakes this process to deliver a location, a fence crossing or a visit, and iOS
/// owes it nothing once the delegate callback returns. Every publish the runtime starts from a
/// callback is a `Task` — the seal, the commit and the push all run AFTER the callback has
/// returned — so on a process that is not kept resident (one relaunched in the background, or one
/// whose stream has wound down to the parked coarse tick) iOS was free to suspend it anywhere in
/// that work, and did. On 2026-11-10/11 (v2.28.0):
///
/// - `e485af31aa`: a `trail.push` that `docs::PUSH_TIMEOUT_SECS` bounds at 30 s lasted 162.8 s, and
///   the next heartbeat's `docs.write` 200.7 s — each frozen mid-flight and resumed by a later
///   wake. Then a `CLVisit` arrival at 19:23:50 took the stop, the parked heartbeat's drain began
///   (`session.recover` at .940), and nothing followed: friends' last envelope said `live`, and
///   two hours later they read "out of contact" about a phone sitting still.
/// - `14befa639f`: a parked declaration sealed at 20:54:01, no `trail.push` after it, and the
///   process silent for 25 hours.
///
/// The only assertion the runtime held was `sc.friend-pull`, which begins after the publish has
/// finished — the pull was protected and the thing friends read was not.
///
/// ## The rules it keeps
///
/// - **Taken on the thread that decided to publish, before any hop.** `beginBackgroundTask` is
///   documented safe off the main thread, and asking for it inside the `Task` would leave exactly
///   the gap this closes: the callback returns, the process is suspended, the `Task` never starts.
/// - **Seal first, push second, and only the push is bounded.** The seal is local and durable (the
///   replica and the outbox); the push is what waits on peers who are asleep. Each drain is handed
///   what is left of `backgroundTimeRemaining` minus `safetyMs` as its push deadline
///   (`ingestFixWithin` / `heartbeatFixWithin`), and Rust declines to start a push with under two
///   seconds left (`push_deferred`), because a push the OS suspends half-way is how a `trail.push`
///   comes to read minutes.
/// - **Ended exactly once**, by the work or by the expiration handler, whichever comes first. An
///   assertion still held when the allowance runs out gets the process killed, not suspended.
/// - **Every ending is counted durably** (`wake.publish_*`), because the endings that matter are
///   the ones that may never ship: `expired` is recorded from the handler, and `stranded` — the
///   process killed while holding one — by the next process, which finds the open count.
/// - **A deferred or cut-short publish asks for another wake** (`NativeRefreshTask.ensureScheduled`).
///   A phone that has just parked will not move again to give Core Location a reason to wake it,
///   and the envelope it sealed is waiting in the replica for a push.
///
/// This is not a `CLBackgroundActivitySession` and must never become one (see the note in
/// `BackgroundLocationRuntime`): an assertion shows no indicator and keeps nothing resident beyond
/// the seconds one piece of work needs.
final class PublishAssertion: @unchecked Sendable {
  /// What started the work. A closed vocabulary: it is the `reason` detail on a
  /// `location.runtime{event=publish_assertion}` span.
  enum Lane: String {
    case seed
    case delivery
    case redelivery
    case parkedTick = "parked_tick"
    case fenceExit = "fence_exit"
    case movingFence = "moving_fence"
    case departure
    case visit
  }

  /// What the expiration handler knew, for the span it emits.
  struct Expiry {
    let lane: Lane
    let heldMs: Double
    let remainingStartMs: UInt64?
  }

  /// Kept back from iOS's allowance for everything after a push — reporting, the pull's own
  /// decision to decline, `endBackgroundTask` — matching the pull's `pullSafetyMs`.
  static let safetyMs: UInt64 = 5_000
  /// Reserved for the claim heartbeat when a capture is ingested ahead of one (`settleClaims`):
  /// a push to friends who are asleep spends its whole deadline, and the claim is the envelope
  /// friends most need to read.
  static let claimReserveMs: UInt64 = 8_000
  /// Passed when iOS reports no limit (the app is active). Larger than `PUSH_TIMEOUT_SECS`, so
  /// Rust's own deadline applies.
  static let unboundedMs: UInt64 = 60_000

  /// The push budget for a drain started now, given iOS's remaining allowance (`nil` for none).
  /// Zero is a valid answer: the drain still seals, and reports the push as deferred.
  static func pushBudgetMs(remainingMs: UInt64?, reserveMs: UInt64) -> UInt64 {
    guard let remainingMs else { return unboundedMs }
    let held = safetyMs + reserveMs
    return remainingMs > held ? remainingMs - held : 0
  }

  let lane: Lane
  private let lock = NSLock()
  private var id: UIBackgroundTaskIdentifier = .invalid
  private var ended = false
  private var remainingStartMs: UInt64?
  private let beganAt = BackgroundWakeLedger.wallMs()

  /// Begin the assertion now, on the calling thread.
  ///
  /// - Parameters:
  ///   - onStranded: called once per process, synchronously, with how many assertions an EARLIER
  ///     process began and never ended.
  ///   - onExpire: called on main from iOS's expiration handler, before the assertion is ended.
  init(
    lane: Lane, onStranded: (Int) -> Void, onExpire: @escaping (Expiry) -> Void
  ) {
    self.lane = lane
    let stranded = BackgroundWakeLedger.openPublish()
    if stranded > 0 { onStranded(stranded) }
    let id = UIApplication.shared.beginBackgroundTask(withName: "sc.publish.\(lane.rawValue)") {
      [weak self] in
      // Reported BEFORE the assertion is ended: once it is, iOS may suspend us mid-line.
      self?.end(expired: true, report: onExpire)
    }
    lock.lock()
    if ended {
      // Expired before `beginBackgroundTask` even returned: iOS had no time to give. The handler
      // could not end an id it did not have yet, so end it here.
      lock.unlock()
      if id != .invalid { UIApplication.shared.endBackgroundTask(id) }
      return
    }
    self.id = id
    lock.unlock()
  }

  /// The push budget for a drain about to start. Reads iOS's allowance on main, where
  /// `UIApplication` must be read; the first reading is kept for the expiry span.
  func pushBudgetMs(reserveMs: UInt64 = 0) async -> UInt64 {
    let remaining = await MainActor.run { UIApplication.shared.backgroundTimeRemaining }
    let remainingMs = Self.finiteMs(remaining)
    keepFirstReading(remainingMs)
    return Self.pushBudgetMs(remainingMs: remainingMs, reserveMs: reserveMs)
  }

  /// Synchronous so the lock is never held across an await.
  private func keepFirstReading(_ remainingMs: UInt64?) {
    lock.lock()
    if remainingStartMs == nil { remainingStartMs = remainingMs }
    lock.unlock()
  }

  /// The work is done. Idempotent; a no-op after an expiry, which has already been counted.
  func finish() {
    end(expired: false, report: nil)
  }

  /// End the assertion and count how it ended — once, whichever of the work and the expiration
  /// handler gets here first, so an expiry is reported once and never after the work finished.
  private func end(expired: Bool, report: ((Expiry) -> Void)?) {
    lock.lock()
    guard !ended else {
      lock.unlock()
      return
    }
    ended = true
    let id = self.id
    self.id = .invalid
    let remainingStartMs = self.remainingStartMs
    lock.unlock()
    let heldMs = max(0, BackgroundWakeLedger.wallMs() - beganAt)
    BackgroundWakeLedger.closePublish(heldMs: heldMs, expired: expired)
    if expired, let report {
      report(Expiry(lane: lane, heldMs: heldMs, remainingStartMs: remainingStartMs))
    }
    if id != .invalid { UIApplication.shared.endBackgroundTask(id) }
  }

  /// `backgroundTimeRemaining` as milliseconds, or `nil` for the "no limit" it reports while the
  /// app is active (`.greatestFiniteMagnitude`).
  static func finiteMs(_ seconds: TimeInterval) -> UInt64? {
    guard seconds.isFinite, seconds < 24 * 3600 else { return nil }
    return UInt64(max(0, seconds) * 1000)
  }
}
