import Foundation

/// Waits for the mounted app to say it has finished publishing a capture handed to it.
///
/// ## Why it exists
///
/// A process with the app mounted does not publish its own captures: `BackgroundLocationRuntime`
/// hands each one to JS (`onNativeFix`), which runs it through the same node. That hand-off used
/// to return the moment the event was queued, so the `PublishAssertion` taken for the capture
/// ended before JS had even started — and the seal and the push that followed ran with no
/// background time held at all. On 2026-11-18 `cc1d2f7ebd` (app mounted, in a pocket) took a
/// visit arrival at 17:52:23, JS sealed the fix at 17:52:24, and iOS suspended the process seconds
/// later inside the push, before the `parked` claim behind it was sealed. The last envelope said
/// `live` and every friend read "out of contact" two hours later.
///
/// So the hand-off carries a token, JS answers it (`ackNativeCapture`) when its drain returns, and
/// the runtime holds the assertion until then — or until `timeoutMs`, because a JS context that
/// never answers must not hold an assertion into its expiry (which gets the process killed rather
/// than suspended).
final class HandOffAcks: @unchecked Sendable {
  static let shared = HandOffAcks()

  private let lock = NSLock()
  private var waiting: [String: CheckedContinuation<Bool, Never>] = [:]

  /// Register `token`, run `send` (which delivers it to JS), and wait for the answer. Returns
  /// `true` when JS answered, `false` when the wait timed out.
  func wait(token: String, timeoutMs: UInt64, send: () -> Void) async -> Bool {
    await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
      lock.lock()
      waiting[token] = continuation
      lock.unlock()
      send()
      DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(Int(timeoutMs))) {
        [weak self] in
        self?.resume(token, answered: false)
      }
    }
  }

  /// JS has finished with `token`. Unknown or already-timed-out tokens are ignored.
  func ack(_ token: String) {
    resume(token, answered: true)
  }

  private func resume(_ token: String, answered: Bool) {
    lock.lock()
    let continuation = waiting.removeValue(forKey: token)
    lock.unlock()
    continuation?.resume(returning: answered)
  }
}
