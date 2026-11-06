import CoreBluetooth
import Foundation
import Network

/// The two iOS permissions with no request API of their own, asked on purpose from onboarding's
/// permission steps instead of whenever the node first touches the radio or the LAN.
///
/// Neither alert can be raised by asking for it: Bluetooth's appears when a `CBManager` is created,
/// local network's when the process first does something on the LAN. So each is triggered by the
/// smallest thing that does exactly that, and the answer is read back from what follows.

private func authorizationName(_ value: CBManagerAuthorization) -> String {
  switch value {
  case .allowedAlways: return "granted"
  case .notDetermined: return "undetermined"
  default: return "denied"  // .denied, .restricted
  }
}

enum BluetoothAccess {
  /// Read without prompting: the class property needs no manager.
  static func current() -> String { authorizationName(CBManager.authorization) }

  private static let queue = DispatchQueue(label: "com.unrealjune.irohlocation.bluetooth-access")
  /// Kept alive until the alert is answered; a released manager can take its alert with it.
  nonisolated(unsafe) private static var manager: CBCentralManager?

  /// Show the alert if it is still owed, and resolve when it has been answered. Bounded, because
  /// someone can leave an alert up indefinitely and onboarding must not hang behind it; the bound
  /// answers `undetermined` and the step moves on.
  static func request(timeout: TimeInterval = 120) async -> String {
    if CBManager.authorization != .notDetermined { return current() }
    queue.sync {
      if manager == nil {
        manager = CBCentralManager(
          delegate: nil, queue: queue, options: [CBCentralManagerOptionShowPowerAlertKey: false])
      }
    }
    let deadline = Date().addingTimeInterval(timeout)
    while CBManager.authorization == .notDetermined && Date() < deadline {
      try? await Task.sleep(nanoseconds: 100_000_000)
    }
    queue.sync { manager = nil }
    return current()
  }
}

/// Raises the local-network alert by advertising and browsing for a Bonjour service of our own, and
/// reads the answer from the browse: finding our own advertisement means access was granted, and a
/// browse stuck in `waiting` with `PolicyDenied` means it was refused. The pattern Apple's DTS
/// recommends (TN3179), since there is no API to read the state.
///
/// The service type is not iroh's (`_irohv1._udp`): iroh's discovery parses whatever it browses, and
/// an advertisement with no endpoint in it is noise there. Both types must stay in
/// `NSBonjourServices`, or the browse fails without ever showing the alert.
final class LocalNetworkProbe {
  static let serviceType = "_streetcryptid._tcp"
  /// `kDNSServiceErr_PolicyDenied`, spelled out to avoid importing dnssd for one constant.
  private static let policyDenied: Int32 = -65570

  private let queue = DispatchQueue(label: "com.unrealjune.irohlocation.local-network")
  private var browser: NWBrowser?
  private var listener: NWListener?
  private var continuation: CheckedContinuation<String, Never>?

  static func request(timeout: TimeInterval = 120) async -> String {
    let probe = LocalNetworkProbe()
    return await withCheckedContinuation { continuation in
      probe.queue.async { probe.start(continuation, timeout: timeout) }
    }
  }

  /// The handlers capture `self` strongly on purpose: nothing else holds the probe, and `finish`
  /// breaks the cycle by dropping the browser and listener.
  private func start(_ continuation: CheckedContinuation<String, Never>, timeout: TimeInterval) {
    self.continuation = continuation
    let parameters = NWParameters.tcp
    parameters.includePeerToPeer = true

    do {
      let listener = try NWListener(using: parameters)
      listener.service = NWListener.Service(
        name: "sc-probe-\(UUID().uuidString.prefix(8))", type: Self.serviceType)
      // Nothing is served; the advertisement is the point.
      listener.newConnectionHandler = { $0.cancel() }
      listener.stateUpdateHandler = { state in
        if case .failed = state { self.finish("unknown") }
      }
      self.listener = listener
      listener.start(queue: queue)
    } catch {
      finish("unknown")
      return
    }

    let browser = NWBrowser(
      for: .bonjour(type: Self.serviceType, domain: nil), using: parameters)
    browser.stateUpdateHandler = { state in
      switch state {
      case .waiting(let error), .failed(let error):
        if case .dns(let code) = error, code == Self.policyDenied { self.finish("denied") }
      default:
        break
      }
    }
    browser.browseResultsChangedHandler = { results, _ in
      if !results.isEmpty { self.finish("granted") }
    }
    self.browser = browser
    browser.start(queue: queue)

    queue.asyncAfter(deadline: .now() + timeout) { self.finish("unknown") }
  }

  /// Always on `queue`. The first verdict wins; tearing both down stops the advertisement at once.
  private func finish(_ verdict: String) {
    guard let continuation else { return }
    self.continuation = nil
    browser?.cancel()
    listener?.cancel()
    browser = nil
    listener = nil
    continuation.resume(returning: verdict)
  }
}
