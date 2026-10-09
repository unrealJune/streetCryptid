import Darwin
import Foundation
import UIKit

/// How much of an iOS background wake this app actually spends, recorded durably.
///
/// ## Why this exists
///
/// Every claim in this repo about the background execution budget is inferred from silence after
/// the fact: `last_refresh_age_ms` climbing, a gap between `device.health` records, a MetricKit CPU
/// exception arriving on the launch AFTER the one that offended. `SHIP_MAX_BATCHES = 3` and
/// `HEADLESS_TEARDOWN_TIMEOUT_MS` are asserted as the right discipline with no measured
/// denominator behind either. On 2026-09-18, with 41 CPU exceptions in 7 days already on record,
/// nothing on the device could say how much CPU a wake had used or how long its window had been.
///
/// This is that denominator. It is deliberately the crudest possible instrument — counters, not a
/// log — because the thing being measured is the cost of doing work during a wake, and an
/// instrument that writes rows is part of the problem it is reporting.
///
/// ## Why UserDefaults and not the telemetry journal
///
/// Same argument as `init-watermark.ts` and `teardown-watermark.ts`: a wake that ends before it can
/// ship cannot describe itself. The journal is JS-side and the whole point of the work this
/// measures is that JS may not be running at all. UserDefaults is synchronous, survives the process
/// ending mid-wake, and is readable from Swift on a launch that never boots React.
///
/// The next foreground `device.health` reports whatever accumulated, under `wake.*`.
///
/// ## What the numbers mean
///
/// `CLOCK_PROCESS_CPUTIME_ID` is CPU consumed by this process across all its threads. iOS's
/// `MXCPUExceptionDiagnostic` fires at roughly 48 s of CPU inside a 60 s window, so `cpu_ms_max`
/// approaching 48 000 is not "high", it is the threshold — the same constant every one of those 41
/// diagnostics reported.
///
/// Wall time is `CLOCK_MONOTONIC`, which on Darwin does NOT advance while the device is asleep.
/// That is the correct clock here: it measures the window we were given, not the hours we spent
/// suspended inside it. Note this is exactly the distinction the observability write-up flagged as
/// unverified for Hermes' `performance.now()` — in Swift it is unambiguous, which is part of why
/// the measurement belongs on this side.
enum BackgroundWakeLedger {
  // MARK: - Keys

  private static let wakes = "sc.bg.wakes"
  private static let bgLaunches = "sc.bg.bg_launches"
  private static let jsBoots = "sc.bg.js_boots"
  private static let cpuTotal = "sc.bg.cpu_ms_total"
  private static let cpuMax = "sc.bg.cpu_ms_max"
  private static let wallTotal = "sc.bg.wall_ms_total"
  private static let lastWake = "sc.bg.last_wake_ms"
  private static let syncs = "sc.bg.syncs"
  private static let dropped = "sc.bg.dropped_captures"
  /// Wall time of the window that set `cpuMax`, so the worst window reads as a RATE. 88 s of CPU is
  /// an exception inside a minute and background noise across twenty; without this, a record from
  /// 2026-09-29 could not say which it was.
  private static let wallAtCpuMax = "sc.bg.wall_ms_at_cpu_max"

  /// Receive-side pulls (`BackgroundLocationRuntime.pullFriendFixes`): what they cost and how they
  /// ended. `syncs` above still counts every pull that ran; these say whether running them is
  /// safe inside the window iOS gives us — see `friend_pull.rs` for the span with the detail.
  private static let pullMsTotal = "sc.bg.pull_ms_total"
  private static let pullMsMax = "sc.bg.pull_ms_max"
  private static let pullCpuMsTotal = "sc.bg.pull_cpu_ms_total"
  /// Pulls that brought at least one entry. Against `syncs`, the share that was worth it.
  private static let pullDelivered = "sc.bg.pull_delivered"
  private static let pullFailed = "sc.bg.pull_failed"
  /// Pulls the budget cut short (at least one namespace ended on the deadline).
  private static let pullDeadlineHits = "sc.bg.pull_deadline_hits"
  /// Pulls that came back well past their budget: the process was frozen inside one.
  private static let pullOverruns = "sc.bg.pull_overruns"
  /// iOS's background-task expiration handler ran while a pull was in flight.
  private static let pullExpired = "sc.bg.pull_expired"
  /// A pull's in-flight mark found by a later one: frozen or killed before it finished.
  private static let pullStranded = "sc.bg.pull_stranded"
  /// Pulls not started because iOS had too little background time left to give one a budget.
  private static let pullNoTime = "sc.bg.pull_no_time"
  /// The in-flight mark. Set before a pull starts, cleared when it returns — so one found by the
  /// NEXT pull is a pull that never returned. Not reset with the counters: it is state, not a count.
  private static let pullOpenAt = "sc.bg.pull_open_at_ms"
  private static let pullOpenTrigger = "sc.bg.pull_open_trigger"
  private static let pullOpenBudget = "sc.bg.pull_open_budget_ms"

  /// Marks of an open window. Absent means nothing is being timed, which is the ordinary state of a
  /// foregrounded app.
  private static let openCpu = "sc.bg.open_cpu_ms"
  private static let openWall = "sc.bg.open_wall_ms"

  /// Per-thread-group CPU, so a figure says WHERE the time went. Keyed `<prefix><group>`.
  private static let groupTotalPrefix = "sc.bg.cpu_ms."
  private static let groupOpenPrefix = "sc.bg.open_cpu_ms."

  private static var defaults: UserDefaults { .standard }

  // MARK: - Clocks

  /// CPU milliseconds this process has consumed, across every thread.
  static func cpuMs() -> Double {
    var ts = timespec()
    guard clock_gettime(CLOCK_PROCESS_CPUTIME_ID, &ts) == 0 else { return 0 }
    return Double(ts.tv_sec) * 1000 + Double(ts.tv_nsec) / 1_000_000
  }

  /// Monotonic milliseconds. Does not advance while the device is asleep, which is what makes it
  /// the right measure of a wake WINDOW rather than of elapsed wall time.
  static func wallMs() -> Double {
    var ts = timespec()
    guard clock_gettime(CLOCK_MONOTONIC, &ts) == 0 else { return 0 }
    return Double(ts.tv_sec) * 1000 + Double(ts.tv_nsec) / 1_000_000
  }

  // MARK: - Where the CPU went

  /// The thread groups a window's CPU is split into.
  ///
  /// `cpu_ms_total` said HOW MUCH, and on 2026-09-29 that was 108 s across a backgrounded iPhone's
  /// twenty minutes with nothing able to say whose. The process runs a small, fixed set of
  /// long-lived threads, and their names identify them:
  ///
  /// - `js`   — React Native's JavaScript thread (Hermes runs on it).
  /// - `rust` — every async task in the Rust core, iroh's endpoint included: UniFFI's
  ///            `async_runtime = "tokio"` runs them all on async-compat's single current-thread
  ///            runtime, `async-compat/tokio-1`, plus tokio's blocking pool.
  /// - `otel` — the OpenTelemetry batch processors, i.e. what exporting telemetry itself costs.
  /// - `main` — UIKit, Core Location's delegate callbacks, and the Expo event emitter.
  ///
  /// Everything else, including every thread that exited during the window, is the process total
  /// minus these, reported as `other` — so the groups always sum to `cpu_ms_total`.
  enum ThreadGroup: String, CaseIterable {
    case js, rust, otel, main
  }

  /// The main thread, captured on it. `pthread_main_np` only answers for the calling thread.
  private static var mainThread: pthread_t?

  /// CPU milliseconds each group's LIVE threads have consumed so far.
  static func groupCpuMs() -> [ThreadGroup: Double] {
    var out: [ThreadGroup: Double] = [:]
    var threads: thread_act_array_t?
    var count: mach_msg_type_number_t = 0
    guard task_threads(mach_task_self_, &threads, &count) == KERN_SUCCESS, let threads else {
      return out
    }
    defer {
      for i in 0..<Int(count) { mach_port_deallocate(mach_task_self_, threads[i]) }
      vm_deallocate(
        mach_task_self_, vm_address_t(UInt(bitPattern: threads)),
        vm_size_t(Int(count) * MemoryLayout<thread_t>.stride))
    }
    for i in 0..<Int(count) {
      var info = thread_basic_info()
      var size = mach_msg_type_number_t(
        MemoryLayout<thread_basic_info_data_t>.size / MemoryLayout<integer_t>.size)
      let result = withUnsafeMutablePointer(to: &info) {
        $0.withMemoryRebound(to: integer_t.self, capacity: Int(size)) {
          thread_info(threads[i], thread_flavor_t(THREAD_BASIC_INFO), $0, &size)
        }
      }
      guard result == KERN_SUCCESS, let group = group(of: threads[i]) else { continue }
      let ms =
        Double(info.user_time.seconds + info.system_time.seconds) * 1000
        + Double(info.user_time.microseconds + info.system_time.microseconds) / 1000
      out[group, default: 0] += ms
    }
    return out
  }

  private static func group(of thread: thread_act_t) -> ThreadGroup? {
    guard let pthread = pthread_from_mach_thread_np(thread) else { return nil }
    if let mainThread, pthread_equal(pthread, mainThread) != 0 { return .main }
    var buffer = [CChar](repeating: 0, count: 128)
    guard pthread_getname_np(pthread, &buffer, buffer.count) == 0 else { return nil }
    let name = String(cString: buffer)
    if name.contains("JavaScript") { return .js }
    if name.hasPrefix("async-compat") || name.hasPrefix("tokio") { return .rust }
    if name.hasPrefix("OpenTelemetry") { return .otel }
    return nil
  }

  // MARK: - Recording

  /// Record that the process launched, and whether it launched into the background.
  ///
  /// Called from the app-delegate subscriber, before anything else runs. `jsBoots` is bumped
  /// separately by whoever actually starts React, so `bg_launches` climbing while `js_boots`
  /// tracks it is the signal that a background launch is still paying for the whole bundle.
  static func noteLaunch(background: Bool) {
    // The app-delegate subscriber calls this on the main thread, before anything else runs.
    mainThread = pthread_self()
    backgrounded = background
    if background {
      defaults.set(defaults.integer(forKey: bgLaunches) + 1, forKey: bgLaunches)
      openWindow()
    }
  }

  /// Whether the app is off screen, and therefore whether a window may be open at all.
  ///
  /// This is the difference between an instrument and a number. Core Location delivers while the
  /// app is MOUNTED too — the native runtime runs either way — so `noteWake` opening a window
  /// unconditionally meant a delivery during foreground use started a "background wake" that then
  /// stayed open across map renders and bundle loads until the next ingest closed it. Measured on
  /// the simulator that produced a `cpu_ms_max` of 69 s over a 75 s window: 91% CPU, attributed to
  /// a wake, and almost all of it foreground work.
  ///
  /// `wake.cpu_ms_max` is read against iOS's 48 s exception threshold. A figure contaminated by
  /// foreground CPU does not just overstate — it makes the one comparison the metric exists for
  /// into a lie. Set from the app-delegate subscriber's own lifecycle callbacks rather than read
  /// from `UIApplication.shared`, which may not be touched off the main thread.
  private(set) static var backgrounded = false

  /// The app went off screen. Everything from here until the next foreground is fair to measure.
  static func enterBackground() {
    backgrounded = true
    openWindow()
  }

  /// The app came back. Close the window and stop measuring.
  static func enterForeground() {
    closeWindow()
    backgrounded = false
  }

  /// Record that React Native was started. Deliberately separate from `noteLaunch`: the gap
  /// between the two counts is the entire measurement.
  static func noteJsBoot() {
    defaults.set(defaults.integer(forKey: jsBoots) + 1, forKey: jsBoots)
  }

  /// Record a Core Location wake — a delivery, a fence crossing, a relaunch.
  static func noteWake() {
    defaults.set(defaults.integer(forKey: wakes) + 1, forKey: wakes)
    defaults.set(Date().timeIntervalSince1970 * 1000, forKey: lastWake)
    // Only while off screen. A delivery to a mounted app is not a background wake, and measuring
    // one as though it were is how foreground CPU ends up in `cpu_ms_max` — see `backgrounded`.
    guard backgrounded else { return }
    if defaults.object(forKey: openCpu) == nil { openWindow() }
  }

  /// Record a capture that reached neither a node nor a JS sink, and was therefore thrown away.
  ///
  /// Should always be zero. It exists because the alternative — the `sink?.sendEvent(...)` this
  /// replaced — made exactly that failure invisible, and a phone that was moving published nothing
  /// for an hour with no log line, no span and no counter to say why.
  static func noteDroppedCapture() {
    defaults.set(defaults.integer(forKey: dropped) + 1, forKey: dropped)
  }

  /// Record that a receive-side sync ran during a wake, so its cost is attributable.
  static func noteSync() {
    defaults.set(defaults.integer(forKey: syncs) + 1, forKey: syncs)
  }

  // MARK: - Pulls

  /// A pull's in-flight mark, as `openPull` left it.
  struct OpenPull {
    let startedAtMs: Double
    let trigger: String
    let budgetMs: UInt64
  }

  /// Set the in-flight mark. Synchronous, so it is on disk before the pull can be frozen. Returns
  /// the mark's identity for `closePull`.
  static func openPull(trigger: String, budgetMs: UInt64) -> Double {
    let at = Date().timeIntervalSince1970 * 1000
    defaults.set(at, forKey: pullOpenAt)
    defaults.set(trigger, forKey: pullOpenTrigger)
    defaults.set(Int(budgetMs), forKey: pullOpenBudget)
    return at
  }

  /// Clear the in-flight mark at the end of the pull that set it — and only that one. A pull that
  /// hung, was reported stranded, and finally returned must not clear its successor's mark.
  static func closePull(_ mark: Double) {
    guard defaults.double(forKey: pullOpenAt) == mark else { return }
    for key in [pullOpenAt, pullOpenTrigger, pullOpenBudget] { defaults.removeObject(forKey: key) }
  }

  /// Clear the in-flight mark, returning what it held. Called before a pull starts, so a mark
  /// found here belongs to a pull that never returned — the caller reports it and counts it with
  /// `notePullStranded`.
  static func takeOpenPull() -> OpenPull? {
    guard let at = defaults.object(forKey: pullOpenAt) as? Double else { return nil }
    let open = OpenPull(
      startedAtMs: at,
      trigger: defaults.string(forKey: pullOpenTrigger) ?? "unknown",
      budgetMs: UInt64(max(0, defaults.integer(forKey: pullOpenBudget))))
    for key in [pullOpenAt, pullOpenTrigger, pullOpenBudget] { defaults.removeObject(forKey: key) }
    return open
  }

  /// Fold one finished pull into the counters.
  static func notePull(
    elapsedMs: Double, cpuMs: Double?, delivered: Bool, failed: Bool, deadlineHit: Bool,
    overran: Bool
  ) {
    defaults.set(defaults.double(forKey: pullMsTotal) + elapsedMs, forKey: pullMsTotal)
    if elapsedMs > defaults.double(forKey: pullMsMax) { defaults.set(elapsedMs, forKey: pullMsMax) }
    if let cpuMs {
      defaults.set(defaults.double(forKey: pullCpuMsTotal) + cpuMs, forKey: pullCpuMsTotal)
    }
    if delivered { bump(pullDelivered) }
    if failed { bump(pullFailed) }
    if deadlineHit { bump(pullDeadlineHits) }
    if overran { bump(pullOverruns) }
  }

  static func notePullExpired() { bump(pullExpired) }
  static func notePullStranded() { bump(pullStranded) }
  static func notePullNoTime() { bump(pullNoTime) }

  private static func bump(_ key: String) {
    defaults.set(defaults.integer(forKey: key) + 1, forKey: key)
  }

  /// Begin timing a window.
  static func openWindow() {
    defaults.set(cpuMs(), forKey: openCpu)
    defaults.set(wallMs(), forKey: openWall)
    let groups = groupCpuMs()
    for group in ThreadGroup.allCases {
      defaults.set(groups[group] ?? 0, forKey: groupOpenPrefix + group.rawValue)
    }
  }

  /// Close the open window and fold its cost into the totals. Idempotent: a window that was never
  /// opened contributes nothing rather than a garbage reading.
  static func closeWindow() {
    guard defaults.object(forKey: openCpu) != nil else { return }
    let cpu = max(0, cpuMs() - defaults.double(forKey: openCpu))
    let wall = max(0, wallMs() - defaults.double(forKey: openWall))
    defaults.removeObject(forKey: openCpu)
    defaults.removeObject(forKey: openWall)
    defaults.set(defaults.double(forKey: cpuTotal) + cpu, forKey: cpuTotal)
    defaults.set(defaults.double(forKey: wallTotal) + wall, forKey: wallTotal)
    if cpu > defaults.double(forKey: cpuMax) {
      defaults.set(cpu, forKey: cpuMax)
      defaults.set(wall, forKey: wallAtCpuMax)
    }
    // Clamped at zero per group: a thread that exited during the window takes its CPU out of the
    // live sum, and that time is then correctly reported under `other` rather than as a negative.
    let groups = groupCpuMs()
    for group in ThreadGroup.allCases {
      let opened = groupOpenPrefix + group.rawValue
      let delta = max(0, (groups[group] ?? 0) - defaults.double(forKey: opened))
      defaults.removeObject(forKey: opened)
      let total = groupTotalPrefix + group.rawValue
      defaults.set(defaults.double(forKey: total) + delta, forKey: total)
    }
  }

  // MARK: - Reading

  /// What accumulated since the last reset. Read-only on purpose — see `reset()`.
  static var snapshot: [String: Any] {
    var out: [String: Any] = [
      "wakes": defaults.integer(forKey: wakes),
      "bg_launches": defaults.integer(forKey: bgLaunches),
      "js_boots": defaults.integer(forKey: jsBoots),
      "syncs": defaults.integer(forKey: syncs),
      // Always expected to be 0. Anything else means captures are being discarded.
      "dropped_captures": defaults.integer(forKey: dropped),
      "cpu_ms_total": Int(defaults.double(forKey: cpuTotal)),
      "cpu_ms_max": Int(defaults.double(forKey: cpuMax)),
      "wall_ms_total": Int(defaults.double(forKey: wallTotal)),
      // A window still open right now: a wake in progress, or — the interesting case — one that
      // was never closed because the process was frozen or killed inside it.
      "window_open": defaults.object(forKey: openCpu) != nil,
    ]
    if let last = defaults.object(forKey: lastWake) as? Double {
      out["last_wake_age_ms"] = Int(Date().timeIntervalSince1970 * 1000 - last)
    }
    out["wall_ms_at_cpu_max"] = Int(defaults.double(forKey: wallAtCpuMax))
    // `cpu_ms_js` / `_rust` / `_otel` / `_main`, and `_other` as the remainder, so they sum to
    // `cpu_ms_total`. Floored at zero: the groups are sampled a moment after the process total.
    var attributed = 0.0
    for group in ThreadGroup.allCases {
      let ms = defaults.double(forKey: groupTotalPrefix + group.rawValue)
      attributed += ms
      out["cpu_ms_\(group.rawValue)"] = Int(ms)
    }
    out["cpu_ms_other"] = Int(max(0, defaults.double(forKey: cpuTotal) - attributed))
    // `pull_*`: see the keys above. `pull_open` with a large `pull_open_age_ms` is a pull that is
    // stranded right now and has not yet been found by the next one.
    out["pull_ms_total"] = Int(defaults.double(forKey: pullMsTotal))
    out["pull_ms_max"] = Int(defaults.double(forKey: pullMsMax))
    out["pull_cpu_ms_total"] = Int(defaults.double(forKey: pullCpuMsTotal))
    for (key, name) in [
      (pullDelivered, "pull_delivered"), (pullFailed, "pull_failed"),
      (pullDeadlineHits, "pull_deadline_hits"), (pullOverruns, "pull_overruns"),
      (pullExpired, "pull_expired"), (pullStranded, "pull_stranded"), (pullNoTime, "pull_no_time"),
    ] {
      out[name] = defaults.integer(forKey: key)
    }
    if let at = defaults.object(forKey: pullOpenAt) as? Double {
      out["pull_open"] = true
      out["pull_open_age_ms"] = Int(Date().timeIntervalSince1970 * 1000 - at)
    } else {
      out["pull_open"] = false
    }
    return out
  }

  /// Clear the counters.
  ///
  /// Split from `snapshot` deliberately. A combined take-and-reset looks tidier and is wrong: a
  /// `foreground` health record and a `refresh` one landing in the same minute would each take
  /// half the counts and neither would be a true reading. The caller that OWNS the reporting
  /// cadence resets; everything else reads.
  static func reset() {
    let groups = ThreadGroup.allCases.map { groupTotalPrefix + $0.rawValue }
    let pulls = [
      pullMsTotal, pullMsMax, pullCpuMsTotal, pullDelivered, pullFailed, pullDeadlineHits,
      pullOverruns, pullExpired, pullStranded, pullNoTime,
    ]
    for key in [wakes, bgLaunches, jsBoots, cpuTotal, cpuMax, wallTotal, wallAtCpuMax, syncs, dropped]
      + groups + pulls
    {
      defaults.removeObject(forKey: key)
    }
  }
}
