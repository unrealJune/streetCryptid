import ServiceManagement

public enum LoginRegistration {
  @MainActor
  public static func apply(
    enabled: Bool,
    status: SMAppService.Status,
    register: () throws -> Void,
    unregister: () async throws -> Void
  ) async throws {
    let registered = status == .enabled || status == .requiresApproval
    if enabled && !registered {
      try register()
    } else if !enabled && registered {
      try await unregister()
    }
  }
}
