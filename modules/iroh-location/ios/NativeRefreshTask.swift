import BackgroundTasks
import Foundation

/// A `BGProcessingTask` that wakes this app to publish, with no JavaScript involved.
///
/// ## Why it exists
///
/// A parked iPhone has very few ways to run at all. The coarse stream of the `stopped` state keeps
/// the process alive for roughly an hour after it settles; significant-location-change wants about
/// half a kilometre of movement; the stop fence wants the owner to leave. Measured on 2026-09-04,
/// what filled the rest of a night — the backfills at +93 min and +8 h — was the JS periodic
/// refresh, i.e. `BGTaskScheduler` firing `expo-background-task`.
///
/// `8abb3b1` stopped booting React on background launches and, with it, retired that refresh on
/// iOS, because servicing it meant loading the whole bundle to run a heartbeat. The heartbeat is
/// native now, so the wake is too: this is the same OS scheduling, serviced by
/// `BackgroundLocationRuntime` directly. Without it a parked phone published nothing between the
/// coarse stream dying and its owner next moving half a kilometre.
///
/// ## Registration is load-bearing, and so is the Info.plist entry
///
/// `BGTaskScheduler` requires every handler to be registered before the app finishes launching,
/// which is why `IrohBackgroundAppDelegateSubscriber` calls `register()` from
/// `willFinishLaunching`. It also raises on an identifier missing from
/// `BGTaskSchedulerPermittedIdentifiers`, so `register()` checks the plist first and does nothing
/// rather than crash a build whose config lacks it. `app.json` declares it.
enum NativeRefreshTask {
  static let identifier = "com.unrealjune.streetcryptid.native-refresh"

  /// 15 minutes is the floor iOS honours; it runs the task later, and often much later, as it sees
  /// fit. The request is only ever "not before".
  private static let earliestInterval: TimeInterval = 15 * 60

  private static let lock = NSLock()
  private static var registered = false

  /// Register the launch handler. Idempotent; call from `willFinishLaunching` on every launch.
  static func register() {
    lock.lock()
    defer { lock.unlock() }
    guard !registered else { return }
    let permitted =
      (Bundle.main.object(forInfoDictionaryKey: "BGTaskSchedulerPermittedIdentifiers") as? [String])
      ?? []
    guard permitted.contains(identifier) else {
      NSLog("[iroh-location] refresh task not permitted by Info.plist; parked backfill is off")
      return
    }
    registered = BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: nil) {
      task in
      handle(task)
    }
  }

  /// Ask for the next wake. Cheap to repeat: a pending request for the same identifier is replaced.
  static func schedule() {
    lock.lock()
    let ok = registered
    lock.unlock()
    guard ok, BackgroundLocationRuntime.wasArmed else { return }
    let request = BGProcessingTaskRequest(identifier: identifier)
    // A heartbeat that cannot reach the network publishes into the local replica and waits for
    // the next wake to push, so a run without connectivity is mostly wasted budget.
    request.requiresNetworkConnectivity = true
    request.requiresExternalPower = false
    request.earliestBeginDate = Date(timeIntervalSinceNow: earliestInterval)
    do {
      try BGTaskScheduler.shared.submit(request)
    } catch {
      NSLog("[iroh-location] refresh task not scheduled: \(error.localizedDescription)")
    }
  }

  /// Withdraw any pending request — sharing was switched off.
  static func cancel() {
    BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: identifier)
  }

  private static func handle(_ task: BGTask) {
    // Next one first: a run that the OS expires half-way must still leave a request behind, or the
    // chain ends with it.
    schedule()
    guard BackgroundLocationRuntime.wasArmed else {
      task.setTaskCompleted(success: true)
      return
    }
    let completion = Completion(task)
    let work = Task {
      await BackgroundLocationRuntime.shared.serviceRefresh()
      completion.finish(success: true)
    }
    task.expirationHandler = {
      work.cancel()
      completion.finish(success: false)
    }
  }

  /// `setTaskCompleted` exactly once, whichever of the work and the expiry gets there first.
  private final class Completion {
    private let task: BGTask
    private let lock = NSLock()
    private var done = false

    init(_ task: BGTask) { self.task = task }

    func finish(success: Bool) {
      lock.lock()
      let first = !done
      done = true
      lock.unlock()
      if first { task.setTaskCompleted(success: success) }
    }
  }
}
