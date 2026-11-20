import Foundation

/// One native command at a time; edits made during a write replace the next draft, not each other.
@MainActor
public final class SettingsWriter<Value> {
  private var pending: Value?
  private var worker: Task<Void, Never>?
  private let write: (Value) async throws -> Void
  private let changed: (Bool, Error?) -> Void
  public private(set) var error: Error?

  public init(
    write: @escaping (Value) async throws -> Void,
    changed: @escaping (Bool, Error?) -> Void
  ) {
    self.write = write
    self.changed = changed
  }

  public func submit(_ value: Value) {
    pending = value
    error = nil
    guard worker == nil else { return }
    changed(true, nil)
    worker = Task {
      while pending != nil {
        try? await Task.sleep(nanoseconds: 250_000_000)
        guard let next = pending else { break }
        pending = nil
        do {
          try await write(next)
          error = nil
        } catch {
          self.error = error
        }
      }
      worker = nil
      changed(false, error)
    }
  }

  public func flush() async -> Bool {
    while let worker { await worker.value }
    return error == nil
  }
}
