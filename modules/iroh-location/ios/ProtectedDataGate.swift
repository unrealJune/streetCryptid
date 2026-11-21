import Foundation
import UIKit

/// Holds back everything that reads or writes app data until the phone has been unlocked once
/// since it booted.
///
/// ## The failure this exists for
///
/// iOS can relaunch the app for a Core Location event (a fence, a visit, a significant change)
/// right after a reboot, before the owner has typed their passcode. Until that first unlock every
/// file protected `untilFirstUserAuthentication` is unreadable, and that is the default class: the
/// `UserDefaults` plist, the Rust `state_dir`, the caches the telemetry spool lives in, and the
/// `AfterFirstUnlock` keychain items. Nothing errors. `UserDefaults` just reads back empty, so
/// `wasArmed` said sharing was off and the launch armed nothing, and `restorePersistedState` rebuilt
/// a fresh state machine. A fence exit delivered then still ran `enterMoving`, whose
/// `persistState` wrote `sc.bg.armed = false` over a defaults domain it could not read.
///
/// On 2026-11-17/18 two friends' phones died within 25 minutes of each other. A Jelly Star ran
/// down to `sampling-suspended` (critical battery) and cut off at 23:50 UTC. An iPhone 14 last woke
/// at 00:15. Neither had been heard from 19 hours later. The Android half of that was an old build
/// with no boot receiver. This is the iOS half. It was found by reading the code, not in telemetry,
/// because a launch in this state cannot ship anything to describe itself.
///
/// ## What happens instead
///
/// - Work that touches app data goes through `whenAvailable`, which runs it at once if data is
///   readable and otherwise queues it in order: the runtime's `restorePersistedState`, then the
///   whole of `finishLaunch` (wake ledger, telemetry, the React decision, `start()`).
/// - Every way this process can run again calls `poll`: the unlock notification itself, each Core
///   Location callback, `NativeRefreshTask`, and a scene connecting or coming to the foreground.
///   A suspended process does not see the notification, so the first wake after the unlock
///   completes the launch, and the delivery that caused that wake is then handled by a running
///   runtime.
/// - While locked, a launch whose `ArmedMarker` says sharing was on asks for a refresh wake
///   (submitting needs no app data) and holds a background assertion for the short time iOS
///   allows, in case the owner is unlocking right now. A phone sitting still after a reboot has no
///   fence or visit to wake it, so the refresh is its way back.
/// - `persistState` writes nothing while work is deferred, so a defaults domain the process cannot
///   read is never overwritten.
///
/// ## What it reports
///
/// A locked process cannot ship telemetry: the exporter's endpoint lives in `UserDefaults` and its
/// spool in caches, both unreadable. So it keeps `LockedLaunchLog`, a counter file with no data
/// protection, and the first `start()` after the unlock reports it, with the boot it belongs to,
/// in the `detail` of `location.runtime{event=started}` (see `BootReport`):
///
///     bg=1 boot_age_s=5400 reboot=1 wait_ms=812000 via=location locked=launch:2,location:3
///
/// Reading it:
/// - `reboot=1 bg=1` is the fix working: iOS brought the app back after a reboot on its own.
///   `wait_ms`/`via` say how long the launch waited for the unlock and what finally ran it.
/// - `reboot=1 bg=0` with no `locked=` means nothing launched us between the boot and the owner
///   opening the app. `boot_age_s` is how long that took.
/// - `locked=` counts wakes that found the phone locked, including those of processes that died
///   before the unlock.
/// - `armed_mismatch=1`: `UserDefaults` said sharing was off while the marker said on, so a
///   defaults write clobbered the intent. That is the failure described above, still happening.
///
/// Main thread only, except `isDeferring`, `takeUnlockReport` and `ArmedMarker`.
enum ProtectedDataGate {
  private static var deferred: [() -> Void] = []
  private static var observer: NSObjectProtocol?
  private static var lockedSince: Date?
  private static var assertion: UIBackgroundTaskIdentifier = .invalid

  private static let flagLock = NSLock()
  private static var deferringFlag = false
  /// Guarded by `flagLock`.
  private static var unlockReport: String?

  /// Whether launch work is waiting for the first unlock. Safe from any thread.
  static var isDeferring: Bool {
    flagLock.lock()
    defer { flagLock.unlock() }
    return deferringFlag
  }

  private static func setDeferring(_ value: Bool) {
    flagLock.lock()
    deferringFlag = value
    flagLock.unlock()
  }

  /// Whether app data can be read right now.
  static var isAvailable: Bool {
    dispatchPrecondition(condition: .onQueue(.main))
    return UIApplication.shared.isProtectedDataAvailable
  }

  /// Runs `work` now if app data is readable, otherwise once it is. Work queued earlier always runs
  /// first. Returns whether `work` ran now.
  @discardableResult
  static func whenAvailable(_ work: @escaping () -> Void) -> Bool {
    dispatchPrecondition(condition: .onQueue(.main))
    if UIApplication.shared.isProtectedDataAvailable {
      if !deferred.isEmpty { drain(via: "next_call") }
      work()
      return true
    }
    deferred.append(work)
    if lockedSince == nil {
      lockedSince = Date()
      LockedLaunchLog.note("launch")
      NSLog(
        "[iroh-location] protected data unavailable (before first unlock); deferring launch, "
          + "armed_marker=\(ArmedMarker.read())")
    }
    setDeferring(true)
    observe()
    return false
  }

  /// Call from any wake that may be the first one since the phone was unlocked. Does nothing unless
  /// work is waiting and data has become readable.
  static func poll(via: String) {
    dispatchPrecondition(condition: .onQueue(.main))
    guard !deferred.isEmpty else { return }
    guard UIApplication.shared.isProtectedDataAvailable else {
      // Still locked: a wake that could not do anything. Counted so the next start can say so.
      LockedLaunchLog.note(via)
      NSLog("[iroh-location] wake via=\(via) while protected data is unavailable")
      return
    }
    drain(via: via)
  }

  /// Background time for a locked launch, in case the unlock is about to happen. iOS gives about
  /// thirty seconds and the expiry handler ends it. The deferred work does not depend on it.
  static func holdForUnlock() {
    dispatchPrecondition(condition: .onQueue(.main))
    guard assertion == .invalid, !deferred.isEmpty else { return }
    assertion = UIApplication.shared.beginBackgroundTask(withName: "sc.await-first-unlock") {
      endAssertion()
    }
  }

  /// Describes the wait once, for the `started` event that follows it. `nil` if this process never
  /// waited.
  ///
  /// Safe from any thread, because `start()` is: a foreground launch starts sharing from JS, and
  /// `startNativeBackground` is a sync Function, so it runs on React's JS thread. A main-queue
  /// precondition here trapped every such launch on 2026-11-20.
  static func takeUnlockReport() -> String? {
    flagLock.lock()
    defer { flagLock.unlock() }
    let report = unlockReport
    unlockReport = nil
    return report
  }

  private static func observe() {
    guard observer == nil else { return }
    observer = NotificationCenter.default.addObserver(
      forName: UIApplication.protectedDataDidBecomeAvailableNotification, object: nil,
      queue: .main
    ) { _ in
      poll(via: "unlock")
    }
  }

  private static func drain(via: String) {
    if let lockedSince {
      let waitedMs = Int(Date().timeIntervalSince(lockedSince) * 1000)
      flagLock.lock()
      unlockReport = "wait_ms=\(waitedMs) via=\(via)"
      flagLock.unlock()
      NSLog("[iroh-location] protected data available after \(waitedMs) ms (via=\(via))")
    }
    lockedSince = nil
    if let observer {
      NotificationCenter.default.removeObserver(observer)
      self.observer = nil
    }
    let work = deferred
    deferred = []
    // Cleared before the work runs, because `start()` persists state and must be allowed to.
    setDeferring(false)
    for item in work { item() }
    endAssertion()
  }

  private static func endAssertion() {
    guard assertion != .invalid else { return }
    UIApplication.shared.endBackgroundTask(assertion)
    assertion = .invalid
  }
}

/// Whether sharing was on, readable before the first unlock.
///
/// A one-byte file written with no data protection, which is the only kind a launch before the
/// first unlock can read. `persistState` keeps it in step with `sc.bg.armed`, which stays the
/// source of truth whenever `UserDefaults` can be read. It reveals that sharing was on and nothing
/// else: no position, no friend, no key.
enum ArmedMarker {
  private static let lock = NSLock()
  private static var written: Bool?

  private static var url: URL? {
    FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
      .appendingPathComponent("sc-bg-armed", isDirectory: false)
  }

  static func record(_ armed: Bool) {
    lock.lock()
    defer { lock.unlock() }
    guard written != armed, let url else { return }
    do {
      try FileManager.default.createDirectory(
        at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
      try Data([armed ? 1 : 0]).write(to: url, options: [.atomic, .noFileProtection])
      written = armed
    } catch {
      NSLog("[iroh-location] armed marker not written: \(error.localizedDescription)")
    }
  }

  static func read() -> Bool {
    guard let url, let data = try? Data(contentsOf: url) else { return false }
    return data.first == 1
  }
}

/// What happened while the phone was locked, kept where a locked process can write it.
///
/// Counts per wake kind (`launch`, `location`, `refresh`, `scene`, `foreground`), across
/// processes: a locked launch that iOS suspends and later kills never reaches an unlock, and its
/// successor reports it.
/// Written with no data protection, like `ArmedMarker`; it holds nothing but counts.
enum LockedLaunchLog {
  private static let lock = NSLock()

  private static var url: URL? {
    FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
      .appendingPathComponent("sc-locked-launch", isDirectory: false)
  }

  static func note(_ kind: String) {
    lock.lock()
    defer { lock.unlock() }
    guard let url else { return }
    var counts = read(url)
    counts[kind, default: 0] += 1
    let text = counts.keys.sorted().map { "\($0):\(counts[$0]!)" }.joined(separator: ",")
    do {
      try FileManager.default.createDirectory(
        at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
      try Data(text.utf8).write(to: url, options: [.atomic, .noFileProtection])
    } catch {
      NSLog("[iroh-location] locked-launch log not written: \(error.localizedDescription)")
    }
  }

  /// The counts since the last take, as `launch:2,location:3`, and clears them. `nil` if none.
  static func take() -> String? {
    lock.lock()
    defer { lock.unlock() }
    guard let url else { return nil }
    let counts = read(url)
    try? FileManager.default.removeItem(at: url)
    guard !counts.isEmpty else { return nil }
    return counts.keys.sorted().map { "\($0):\(counts[$0]!)" }.joined(separator: ",")
  }

  private static func read(_ url: URL) -> [String: Int] {
    guard let data = try? Data(contentsOf: url), let text = String(data: data, encoding: .utf8)
    else { return [:] }
    var counts: [String: Int] = [:]
    for pair in text.split(separator: ",") {
      let parts = pair.split(separator: ":")
      if parts.count == 2, let n = Int(parts[1]) { counts[String(parts[0])] = n }
    }
    return counts
  }
}

/// The `detail` of `location.runtime{event=started}`: how long the phone has been up, whether it
/// rebooted since the last start, and what the locked part of this boot looked like.
enum BootReport {
  private static let lastBootKey = "sc.bg.last_boot_s"

  /// When the kernel booted, in epoch seconds.
  static var bootTime: Int? {
    var tv = timeval()
    var size = MemoryLayout<timeval>.size
    var mib: [Int32] = [CTL_KERN, KERN_BOOTTIME]
    guard sysctl(&mib, 2, &tv, &size, nil, 0) == 0, tv.tv_sec > 0 else { return nil }
    return Int(tv.tv_sec)
  }

  /// Any thread (`start()` may run on the JS thread), data available (it reads and writes
  /// `UserDefaults`).
  static func detail(background: Bool, unlock: String?, armedMismatch: Bool) -> String {
    var parts: [String] = ["bg=\(background ? 1 : 0)"]
    if let boot = bootTime {
      parts.append("boot_age_s=\(Int(Date().timeIntervalSince1970) - boot)")
      let defaults = UserDefaults.standard
      let last = defaults.integer(forKey: lastBootKey)
      // A couple of seconds of slack: the kernel's boot time is adjusted with the clock.
      if last == 0 || abs(last - boot) > 2 {
        parts.append(last == 0 ? "reboot=unknown" : "reboot=1")
        defaults.set(boot, forKey: lastBootKey)
      }
    }
    if let unlock { parts.append(unlock) }
    if let locked = LockedLaunchLog.take() { parts.append("locked=\(locked)") }
    if armedMismatch { parts.append("armed_mismatch=1") }
    return parts.joined(separator: " ")
  }
}
