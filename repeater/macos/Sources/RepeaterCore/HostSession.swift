import Combine
import Darwin
import Foundation

@MainActor
public final class HostSession: ObservableObject {
  @Published public private(set) var snapshot: Snapshot?
  @Published public private(set) var problem: String?
  @Published public private(set) var arrival: UInt64 = 0
  @Published public private(set) var running = false
  private let executable: URL
  private let stateDirectory: URL
  private var process: Process?
  private var terminatingProcess: Process?
  private var input: FileHandle?
  private var monitor: Task<Void, Never>?
  private var retry: Task<Void, Never>?
  private var budget = RetryBudget()
  private var stopping = false
  private var lastSnapshot = ProcessInfo.processInfo.systemUptime
  private var runID: String?
  private var pending: [String: CheckedContinuation<Void, Error>] = [:]

  public init(executable: URL, stateDirectory: URL) {
    self.executable = executable
    self.stateDirectory = stateDirectory
  }

  public func start() {
    guard process == nil, !stopping else { return }
    retry?.cancel()
    problem = nil
    snapshot = nil
    runID = nil
    let child = Process()
    let stdin = Pipe()
    let stdout = Pipe()
    do {
      try FileManager.default.createDirectory(
        at: stateDirectory, withIntermediateDirectories: true,
        attributes: [.posixPermissions: 0o700]
      )
      try FileManager.default.setAttributes(
        [.posixPermissions: 0o700], ofItemAtPath: stateDirectory.path
      )
      child.executableURL = executable
      child.arguments = ["--state-dir", stateDirectory.path, "--mode", "user"]
      child.standardInput = stdin
      child.standardOutput = stdout
      // stdout contains claim capabilities; neither stream belongs in the system log.
      child.standardError = FileHandle.nullDevice
      child.terminationHandler = { [weak self] child in
        Task { @MainActor in self?.exited(child) }
      }
      try child.run()
      process = child
      input = stdin.fileHandleForWriting
      try? stdin.fileHandleForReading.close()
      try? stdout.fileHandleForWriting.close()
      lastSnapshot = ProcessInfo.processInfo.systemUptime
      let reader = stdout.fileHandleForReading
      // Blocking reads provide backpressure and never queue an unbounded number of UI tasks.
      Task.detached { [weak self] in
        var decoder = LineDecoder()
        var buffer = [UInt8](repeating: 0, count: 16_384)
        defer { try? reader.close() }
        do {
          while true {
            // FileHandle.read(upToCount:) may wait to fill its buffer on a pipe.
            let count = Darwin.read(reader.fileDescriptor, &buffer, buffer.count)
            if count == 0 { break }
            if count < 0 {
              if errno == EINTR { continue }
              throw HostError.disconnected
            }
            for line in try decoder.append(Data(buffer.prefix(count))) {
              let message = try HostMessage.decode(line)
              await self?.receive(message, from: child)
            }
          }
        } catch {
          await self?.fail(error, from: child)
          return
        }
        await self?.fail(HostError.disconnected, from: child)
      }
      monitor = Task { [weak self] in
        while !Task.isCancelled {
          try? await Task.sleep(nanoseconds: 2_000_000_000)
          guard !Task.isCancelled, let self, self.process === child else { return }
          let deadline: TimeInterval = self.running ? 20 : 45
          if ProcessInfo.processInfo.systemUptime - self.lastSnapshot > deadline {
            self.fail(HostError.timeout, from: child)
            return
          }
        }
      }
    } catch {
      problem = "Could not start the bundled repeater. Check the installation and state directory."
    }
  }

  public func retryNow() {
    guard process == nil, !stopping else { return }
    budget = RetryBudget()
    start()
  }

  public func resumed() {
    // Sleep is not an IPC stall; give the existing process time to resume before judging it.
    lastSnapshot = ProcessInfo.processInfo.systemUptime
  }

  public func send(_ command: HostCommand) async throws {
    guard running, let child = process, let input, !stopping else {
      throw HostError.disconnected
    }
    guard pending.isEmpty else { throw HostError.refused }
    let data = try command.line()
    try await withCheckedThrowingContinuation { continuation in
      pending[command.requestId] = continuation
      // One <=4 KiB command at a time; never block the main thread on a wedged host.
      Task.detached { [weak self] in
        do { try input.write(contentsOf: data) } catch {
          await self?.fail(HostError.disconnected, from: child)
        }
      }
      Task { [weak self] in
        try? await Task.sleep(nanoseconds: 10_000_000_000)
        guard let self, self.pending[command.requestId] != nil else { return }
        self.fail(HostError.timeout, from: child)
      }
    }
  }

  private func receive(_ message: HostMessage, from child: Process) {
    guard process === child, terminatingProcess !== child, !stopping else { return }
    if let runID, runID != message.runId {
      fail(HostError.protocolMismatch, from: child)
      return
    }
    runID = message.runId
    switch message.kind {
    case "snapshot":
      snapshot = message.snapshot
      running = true
      problem = nil
      lastSnapshot = ProcessInfo.processInfo.systemUptime
      budget.receivedSnapshot(now: lastSnapshot)
    case "arrival": arrival &+= 1
    case "result":
      if let id = message.requestId, let continuation = pending.removeValue(forKey: id) {
        if message.ok == true {
          continuation.resume()
        } else {
          continuation.resume(throwing: HostError.refused)
        }
      }
    default: break
    }
  }

  private func rejectPending(_ error: Error = HostError.disconnected) {
    let waiting = pending
    pending.removeAll()
    for continuation in waiting.values {
      continuation.resume(throwing: error)
    }
  }

  private func fail(_ error: Error, from child: Process) {
    guard process === child, terminatingProcess !== child, !stopping else { return }
    problem = (error as? HostError)?.errorDescription ?? HostError.protocolMismatch.errorDescription
    running = false
    snapshot = nil
    rejectPending(error)
    monitor?.cancel()
    terminate(child)
  }

  private func terminate(_ child: Process) {
    guard terminatingProcess !== child else { return }
    terminatingProcess = child
    try? input?.close()
    input = nil
    Task {
      try? await Task.sleep(nanoseconds: 5_000_000_000)
      guard process === child, child.isRunning else { return }
      child.terminate()
      try? await Task.sleep(nanoseconds: 2_000_000_000)
      if process === child, child.isRunning { kill(child.processIdentifier, SIGKILL) }
    }
  }

  private func exited(_ child: Process) {
    guard process === child else { return }
    process = nil
    terminatingProcess = nil
    try? input?.close()
    input = nil
    monitor?.cancel()
    running = false
    snapshot = nil
    rejectPending()
    guard !stopping else { return }
    problem = problem ?? HostError.disconnected.errorDescription
    guard let delay = budget.nextDelay() else { return }
    retry = Task { [weak self] in
      try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
      guard !Task.isCancelled else { return }
      self?.start()
    }
  }

  public func stop() async {
    stopping = true
    retry?.cancel()
    monitor?.cancel()
    rejectPending()
    if let child = process {
      terminate(child)
      // Bounded even if a Foundation termination callback never arrives.
      for _ in 0..<80 {
        if !child.isRunning { break }
        try? await Task.sleep(nanoseconds: 100_000_000)
      }
    }
    running = false
    snapshot = nil
  }
}
