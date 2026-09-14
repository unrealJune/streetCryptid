import Foundation
import MetricKit

/// The OS's own account of how this app last died, or stalled.
///
/// ## Why this exists
/// Everything else in our telemetry is written BY the app, which means the one event it can never
/// describe is its own ending. On 2026-09-13 an iPhone's spans stopped at 21:53:43 and resumed at
/// 21:55:05 with no way to tell a crash from a watchdog kill from a memory kill from iOS simply
/// suspending it — four causes, four different fixes, one indistinguishable hole in the data.
/// `app.previous_run` narrows that to "the process went away while in state X"; only the OS knows
/// which of the ways it went.
///
/// MetricKit is that account, delivered to the app itself rather than to Apple's aggregate
/// dashboards: crash diagnostics carry the termination reason, exception type/code and signal
/// (a jetsam names itself here), and hang diagnostics carry the hang's DURATION — which needs no
/// symbolication to be worth reading, and is exactly the number missing today.
///
/// ## Durability
/// Payloads arrive on a background queue shortly after launch, including a launch into the
/// background, and MetricKit never redelivers. A JavaScript context that is not ready yet — or a
/// headless wake that ends before draining — would lose them permanently, so they are appended to
/// a file the moment they arrive and drained from there. The same argument as the telemetry
/// journal, for the same reason.
///
/// ## What is and is not forwarded
/// The structured fields, plus a BOUNDED, flattened call stack (binary name + offset per frame,
/// attributed thread first) — the form you paste into a symbolicator. Not the whole call-stack
/// tree: a crash tree runs to hundreds of kilobytes of subframes, and the frames past the first
/// few dozen have never been the ones that answer the question. Nothing here is user data; it is
/// addresses, offsets and Apple's own reason strings.
final class MetricKitDiagnostics: NSObject, MXMetricManagerSubscriber {
  static let shared = MetricKitDiagnostics()

  /// Frames kept per diagnostic. Deep enough to cross our own frames into the OS, short enough
  /// that a batch of crash reports cannot become the reason a phone's telemetry stops shipping.
  private static let maxFrames = 48
  /// Diagnostics retained on disk while waiting to be drained.
  private static let maxStored = 32

  private let queue = DispatchQueue(label: "com.unrealjune.irohlocation.metrickit")
  private var started = false

  /// Begin receiving payloads. Idempotent; safe to call from module creation.
  func start() {
    // Claim under the lock, subscribe outside it. `didReceive` takes the same lock to append, so
    // registering while holding it would deadlock outright if MetricKit ever delivered a pending
    // payload synchronously from `add`. It does not today; the version of this that depends on
    // that staying true is not worth writing.
    let shouldSubscribe: Bool = queue.sync {
      guard !started else { return false }
      started = true
      return true
    }
    guard shouldSubscribe else { return }
    MXMetricManager.shared.add(self)
  }

  // MARK: - MXMetricManagerSubscriber

  /// Required by the protocol. Daily aggregate metrics are not what this is for — the diagnostics
  /// callback below is — and collecting them would be a privacy surface for no debugging gain.
  @objc(didReceiveMetricPayloads:)
  func didReceive(_ payloads: [MXMetricPayload]) {}

  // Both protocol methods import into Swift as `didReceive(_:)`, so the Objective-C selectors
  // are pinned rather than inferred: two overloads competing for one inferred selector is a hard
  // build error, and the wrong one silently never firing would be worse.
  @objc(didReceiveDiagnosticPayloads:)
  func didReceive(_ payloads: [MXDiagnosticPayload]) {
    var rows: [[String: Any]] = []
    for payload in payloads {
      let received = Date().timeIntervalSince1970 * 1000
      let begin = payload.timeStampBegin.timeIntervalSince1970 * 1000
      let end = payload.timeStampEnd.timeIntervalSince1970 * 1000

      for diagnostic in payload.crashDiagnostics ?? [] {
        var row = Self.base(diagnostic, kind: "crash", begin: begin, end: end, received: received)
        // The four fields that name the manner of death. `terminationReason` is where a jetsam
        // (memory kill) and a watchdog kill announce themselves in words.
        if let reason = diagnostic.terminationReason { row["termination_reason"] = reason }
        if let type = diagnostic.exceptionType { row["exception_type"] = type.intValue }
        if let code = diagnostic.exceptionCode { row["exception_code"] = code.intValue }
        if let signal = diagnostic.signal { row["signal"] = signal.intValue }
        if let vm = diagnostic.virtualMemoryRegionInfo { row["vm_region"] = vm }
        row["frames"] = Self.flatten(diagnostic.callStackTree)
        rows.append(row)
      }

      for diagnostic in payload.hangDiagnostics ?? [] {
        var row = Self.base(diagnostic, kind: "hang", begin: begin, end: end, received: received)
        // The number this whole file was added for: how long the app was unresponsive.
        row["duration_ms"] = diagnostic.hangDuration.converted(to: .milliseconds).value
        row["frames"] = Self.flatten(diagnostic.callStackTree)
        rows.append(row)
      }

      for diagnostic in payload.cpuExceptionDiagnostics ?? [] {
        var row = Self.base(diagnostic, kind: "cpu", begin: begin, end: end, received: received)
        row["cpu_time_ms"] = diagnostic.totalCPUTime.converted(to: .milliseconds).value
        row["sampled_time_ms"] = diagnostic.totalSampledTime.converted(to: .milliseconds).value
        row["frames"] = Self.flatten(diagnostic.callStackTree)
        rows.append(row)
      }

      for diagnostic in payload.diskWriteExceptionDiagnostics ?? [] {
        var row = Self.base(
          diagnostic, kind: "disk_write", begin: begin, end: end, received: received)
        row["writes_bytes"] = diagnostic.totalWritesCaused.converted(to: .bytes).value
        row["frames"] = Self.flatten(diagnostic.callStackTree)
        rows.append(row)
      }

      if #available(iOS 16.0, *) {
        for diagnostic in payload.appLaunchDiagnostics ?? [] {
          var row = Self.base(diagnostic, kind: "launch", begin: begin, end: end, received: received)
          row["duration_ms"] = diagnostic.launchDuration.converted(to: .milliseconds).value
          row["frames"] = Self.flatten(diagnostic.callStackTree)
          rows.append(row)
        }
      }
    }
    guard !rows.isEmpty else { return }
    append(rows)
  }

  // MARK: - Draining

  /// Hand over everything stored and clear it. Each element is a JSON object string.
  ///
  /// Cleared on read rather than on acknowledgement: a diagnostic re-reported every launch
  /// forever is worse than one lost, and the caller writes it to a durable journal of its own
  /// before it can be dropped.
  func take() -> [String] {
    queue.sync { () -> [String] in
      guard let url = Self.storeURL() else { return [] }
      guard let data = try? Data(contentsOf: url) else { return [] }
      try? FileManager.default.removeItem(at: url)
      return String(decoding: data, as: UTF8.self)
        .split(separator: "\n")
        .map(String.init)
        .filter { !$0.isEmpty }
    }
  }

  private func append(_ rows: [[String: Any]]) {
    queue.sync {
      guard let url = Self.storeURL() else { return }
      var lines: [String] = []
      if let data = try? Data(contentsOf: url) {
        lines =
          String(decoding: data, as: UTF8.self)
          .split(separator: "\n")
          .map(String.init)
          .filter { !$0.isEmpty }
      }
      for row in rows {
        guard
          let data = try? JSONSerialization.data(withJSONObject: row, options: []),
          let line = String(data: data, encoding: .utf8)
        else { continue }
        lines.append(line)
      }
      if lines.count > Self.maxStored { lines = Array(lines.suffix(Self.maxStored)) }
      if let encoded = lines.joined(separator: "\n").data(using: .utf8) {
        try? encoded.write(to: url, options: .atomic)
      }
    }
  }

  private static func storeURL() -> URL? {
    let fm = FileManager.default
    guard let dir = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
      return nil
    }
    if !fm.fileExists(atPath: dir.path) {
      try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
    }
    return dir.appendingPathComponent("metrickit-diagnostics.jsonl")
  }

  // MARK: - Shaping

  private static func base(
    _ diagnostic: MXDiagnostic, kind: String, begin: Double, end: Double, received: Double
  ) -> [String: Any] {
    var row: [String: Any] = [
      "kind": kind,
      "window_begin_ms": begin,
      "window_end_ms": end,
      "received_ms": received,
    ]
    row["app_version"] = diagnostic.applicationVersion
    let meta = diagnostic.metaData
    row["app_build"] = meta.applicationBuildVersion
    row["os_version"] = meta.osVersion
    row["device_type"] = meta.deviceType
    return row
  }

  /// Flatten a call stack tree into `binaryName+0xoffset` frames, attributed thread first.
  ///
  /// Goes through `jsonRepresentation()` rather than the object graph because MetricKit exposes
  /// the tree only as JSON — there is no public frame type to walk.
  private static func flatten(_ tree: MXCallStackTree) -> [String] {
    guard
      let root = try? JSONSerialization.jsonObject(with: tree.jsonRepresentation())
        as? [String: Any],
      let stacks = root["callStacks"] as? [[String: Any]]
    else { return [] }

    // The attributed thread is the one that crashed or hung; anything else is context.
    let ordered = stacks.sorted { lhs, rhs in
      ((lhs["threadAttributed"] as? Bool) ?? false) && !((rhs["threadAttributed"] as? Bool) ?? false)
    }

    var frames: [String] = []
    for stack in ordered {
      guard let roots = stack["callStackRootFrames"] as? [[String: Any]] else { continue }
      var pending = roots
      while let frame = pending.first, frames.count < maxFrames {
        pending.removeFirst()
        let binary = (frame["binaryName"] as? String) ?? "?"
        let offset = (frame["offsetIntoBinaryTextSegment"] as? NSNumber)?.uint64Value ?? 0
        frames.append("\(binary)+0x\(String(offset, radix: 16))")
        // Depth-first: a MetricKit subframe is the callee, so this walks down the stack in the
        // order a symbolicated report would print it.
        if let sub = frame["subFrames"] as? [[String: Any]] {
          pending.insert(contentsOf: sub, at: 0)
        }
      }
      if frames.count >= maxFrames { break }
    }
    return frames
  }
}
