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

  /// Marks of an open window. Absent means nothing is being timed, which is the ordinary state of a
  /// foregrounded app.
  private static let openCpu = "sc.bg.open_cpu_ms"
  private static let openWall = "sc.bg.open_wall_ms"

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

  // MARK: - Recording

  /// Record that the process launched, and whether it launched into the background.
  ///
  /// Called from the app-delegate subscriber, before anything else runs. `jsBoots` is bumped
  /// separately by whoever actually starts React, so `bg_launches` climbing while `js_boots`
  /// tracks it is the signal that a background launch is still paying for the whole bundle.
  static func noteLaunch(background: Bool) {
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

  /// Record that a receive-side sync ran during a wake, so its cost is attributable.
  static func noteSync() {
    defaults.set(defaults.integer(forKey: syncs) + 1, forKey: syncs)
  }

  /// Begin timing a window.
  static func openWindow() {
    defaults.set(cpuMs(), forKey: openCpu)
    defaults.set(wallMs(), forKey: openWall)
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
    if cpu > defaults.double(forKey: cpuMax) { defaults.set(cpu, forKey: cpuMax) }
  }

  // MARK: - Reading

  /// What accumulated since the last reset. Read-only on purpose — see `reset()`.
  static var snapshot: [String: Any] {
    var out: [String: Any] = [
      "wakes": defaults.integer(forKey: wakes),
      "bg_launches": defaults.integer(forKey: bgLaunches),
      "js_boots": defaults.integer(forKey: jsBoots),
      "syncs": defaults.integer(forKey: syncs),
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
    return out
  }

  /// Clear the counters.
  ///
  /// Split from `snapshot` deliberately. A combined take-and-reset looks tidier and is wrong: a
  /// `foreground` health record and a `refresh` one landing in the same minute would each take
  /// half the counts and neither would be a true reading. The caller that OWNS the reporting
  /// cadence resets; everything else reads.
  static func reset() {
    for key in [wakes, bgLaunches, jsBoots, cpuTotal, cpuMax, wallTotal, syncs] {
      defaults.removeObject(forKey: key)
    }
  }
}
