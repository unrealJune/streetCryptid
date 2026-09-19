import Foundation

/// The single door to the Rust OTLP layer, and the reason there is one.
///
/// ## Why this is not just a call
///
/// `configure_telemetry` is a synchronous `#[uniffi::export]`, so it runs on whatever thread calls
/// it — for the Expo `Function` below, that is the JS thread. Its first act on a RECONFIGURE is to
/// `shutdown()` the previous span and log providers, and those block until the OTLP batch
/// processor drains. The exporter uses the **blocking** reqwest client by deliberate choice (the
/// batch thread has no tokio reactor), so a collector that is slow or unreachable turns that
/// shutdown into a stall on the JS thread.
///
/// That path never ran before there were two callers. JS configured telemetry exactly once per
/// process, so `PROVIDERS` was always empty and the shutdown was a no-op. Adding a launch-time
/// call from `IrohBackgroundBootstrap` made it two: the bootstrap installed a pipeline, `init()`
/// installed it again a second later, and the second call wedged the launch inside the
/// `mirror-secrets` phase — the same shape as the outage this work exists to fix, introduced by
/// the fix, and caught on the simulator before it reached anyone. The init watermark added in that
/// same branch is what named the phase; without it this was a rendering app with a silent journal.
///
/// So: at most one configure per (endpoint, instance) per process. A genuine change — a new
/// identity, or an endpoint being switched off with `""` — still reconfigures, because that is a
/// reconfigure someone asked for rather than two callers racing to say the same thing.
enum TelemetryConfigurator {
  private static let endpointKey = "sc.otel.endpoint"
  private static let instanceKey = "sc.otel.instance_id"

  private static let lock = NSLock()
  private static var applied: (endpoint: String, instanceId: String)?
  private static var lastResult = false

  /// Point the Rust core's exporter at `endpoint`, unless that is already where it points.
  ///
  /// - Parameter remember: persist the values so a launch with no JS can re-apply them. Only the
  ///   JS call does; the bootstrap is *reading* this mirror, and writing it back would let a stale
  ///   value outlive the build that set it.
  @discardableResult
  static func apply(endpoint: String, instanceId: String, remember: Bool) -> Bool {
    lock.lock()
    defer { lock.unlock() }

    if remember {
      let defaults = UserDefaults.standard
      defaults.set(endpoint, forKey: endpointKey)
      defaults.set(instanceId, forKey: instanceKey)
    }

    if let applied, applied.endpoint == endpoint, applied.instanceId == instanceId {
      return lastResult
    }
    applied = (endpoint, instanceId)
    lastResult = configureTelemetry(endpoint: endpoint, instanceId: instanceId)
    return lastResult
  }

  /// What JS last configured, for a launch that has no JS to ask. `nil` when this install has never
  /// configured telemetry — a store build never does, so nothing is ever written there.
  static var persisted: (endpoint: String, instanceId: String)? {
    let defaults = UserDefaults.standard
    guard let endpoint = defaults.string(forKey: endpointKey), !endpoint.isEmpty else { return nil }
    return (endpoint, defaults.string(forKey: instanceKey) ?? "bg")
  }
}
