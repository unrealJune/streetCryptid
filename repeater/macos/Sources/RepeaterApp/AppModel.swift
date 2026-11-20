import AppKit
import Combine
import RepeaterCore
import ServiceManagement
import Sparkle

@MainActor
final class AppModel: NSObject, ObservableObject, SPUUpdaterDelegate {
  let host: HostSession
  @Published var configured = UserDefaults.standard.bool(forKey: "setupComplete")
  @Published var settingsOpen = false
  @Published var saving = false {
    didSet { installIfHidden() }
  }
  @Published var problem: String?
  @Published var name = ""
  @Published var telemetry = false
  @Published var keepAwake = false
  struct RelayDraft: Identifiable {
    let id = UUID()
    var url = ""
    var key = ""
    var hasKey = false
    var clearKey = false
  }
  @Published var relays: [RelayDraft] = []
  @Published var telemetryEndpoint = ""
  @Published var networkSaving = false
  @Published var login = true
  @Published var automaticUpdates = true
  @Published var canUpdate = false
  @Published var visible = false {
    didSet { installIfHidden() }
  }
  @Published private(set) var updateReady = false
  private var installUpdate: (() -> Void)?
  private var updaterStarted = false
  private var subscriptions = Set<AnyCancellable>()
  private struct Preferences: Equatable {
    var name: String
    var host: HostSettings
    var login: Bool
    var automaticUpdates: Bool
  }
  private var appliedPreferences: Preferences?
  private var preferences: Preferences {
    Preferences(
      name: name, host: HostSettings(telemetry: telemetry, keepAwake: keepAwake),
      login: login, automaticUpdates: automaticUpdates
    )
  }
  private lazy var settingsWriter = SettingsWriter<Preferences>(
    write: { [weak self] preferences in
      guard let self else { throw HostError.disconnected }
      try await self.apply(preferences)
    },
    changed: { [weak self] saving, error in
      self?.problem = error?.localizedDescription
      self?.saving = saving
    }
  )
  private lazy var updates = SPUStandardUpdaterController(
    startingUpdater: false, updaterDelegate: self, userDriverDelegate: nil
  )

  override init() {
    let resources = Bundle.main.resourceURL!
    let state = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("streetCryptid/Repeater", isDirectory: true)
    host = HostSession(
      executable: resources.appendingPathComponent("streetcryptid-repeater-host"),
      stateDirectory: state
    )
    super.init()
    updates.updater.publisher(for: \.canCheckForUpdates).assign(to: &$canUpdate)
    host.objectWillChange.sink { [weak self] in self?.objectWillChange.send() }
      .store(in: &subscriptions)
    if configured { startUpdates() }
  }

  var version: String {
    Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "local"
  }
  var updateAvailable: Bool {
    let key = Bundle.main.object(forInfoDictionaryKey: "SUPublicEDKey") as? String ?? ""
    return !key.isEmpty
  }
  var loginNeedsApproval: Bool { SMAppService.mainApp.status == .requiresApproval }

  func editSettings() {
    guard configured, !settingsOpen else { return }
    if let snapshot = host.snapshot {
      name = snapshot.name ?? ""
      telemetry = snapshot.settings.telemetry
      keepAwake = snapshot.settings.keepAwake
      loadNetwork()
    }
    login =
      SMAppService.mainApp.status == .enabled
      || SMAppService.mainApp.status == .requiresApproval
    automaticUpdates = !configured || UserDefaults.standard.bool(forKey: "automaticUpdates")
    appliedPreferences = preferences
    settingsOpen = true
    problem = nil
  }

  func preferencesChanged() {
    guard configured else { return }
    if name.count > 40 { name = String(name.prefix(40)) }
    problem = nil
    settingsWriter.submit(preferences)
  }

  private func loadNetwork() {
    guard let network = host.snapshot?.network else { return }
    relays = network.relays.map { RelayDraft(url: $0.url, hasKey: $0.hasAuthToken) }
    telemetryEndpoint = network.telemetryEndpoint
  }

  func saveNetwork() async {
    networkSaving = true
    defer { networkSaving = false }
    do {
      let config = NetworkConfig(
        relays: relays.map {
          RelayConfig(
            url: $0.url.trimmingCharacters(in: .whitespacesAndNewlines),
            authToken: $0.clearKey ? "" : ($0.key.isEmpty ? nil : $0.key))
        },
        telemetryEndpoint: telemetryEndpoint.trimmingCharacters(in: .whitespacesAndNewlines))
      try await host.send(HostCommand(kind: "network", network: config))
      for i in relays.indices {
        relays[i].hasKey = !relays[i].clearKey && (!relays[i].key.isEmpty || relays[i].hasKey)
        relays[i].key = ""
        relays[i].clearKey = false
      }
      problem = nil
    } catch {
      problem =
        "Network settings were not saved. Use unique HTTPS relay origins and a valid collector URL (HTTP only on loopback)."
    }
  }

  func leaveSettings() async {
    if preferences != appliedPreferences || problem != nil {
      settingsWriter.submit(preferences)
    }
    if await settingsWriter.flush() { settingsOpen = false }
  }

  func finishPendingSettings() async {
    _ = await settingsWriter.flush()
  }

  func finishSetup() async {
    settingsWriter.submit(preferences)
    guard await settingsWriter.flush() else { return }
    UserDefaults.standard.set(true, forKey: "setupComplete")
    configured = true
    settingsOpen = false
    startUpdates()
  }

  private func apply(_ preferences: Preferences) async throws {
    let service = SMAppService.mainApp
    do {
      try await LoginRegistration.apply(
        enabled: preferences.login, status: service.status,
        register: { try service.register() },
        unregister: { try await service.unregister() }
      )
    } catch {
      throw NSError(
        domain: "RepeaterSettings", code: 1,
        userInfo: [
          NSLocalizedDescriptionKey:
            "Couldn't change start at login. Check Login Items in System Settings."
        ]
      )
    }
    if preferences.host != appliedPreferences?.host {
      try await host.send(
        HostCommand(kind: "settings", settings: preferences.host)
      )
    }
    if preferences.name != appliedPreferences?.name {
      try await host.send(HostCommand(kind: "name", name: preferences.name))
    }
    UserDefaults.standard.set(preferences.automaticUpdates, forKey: "automaticUpdates")
    appliedPreferences = preferences
    if configured { startUpdates() }
  }

  private func startUpdates() {
    guard updateAvailable else { return }
    let enabled = UserDefaults.standard.bool(forKey: "automaticUpdates")
    updates.updater.automaticallyChecksForUpdates = enabled
    updates.updater.automaticallyDownloadsUpdates = enabled
    if !updaterStarted {
      updaterStarted = true
      updates.startUpdater()
    }
  }

  func checkUpdates() {
    if updateReady { installDownloadedUpdate() } else { updates.checkForUpdates(nil) }
  }

  func updater(
    _ updater: SPUUpdater, willInstallUpdateOnQuit item: SUAppcastItem,
    immediateInstallationBlock immediateInstallHandler: @escaping () -> Void
  ) -> Bool {
    installUpdate = immediateInstallHandler
    updateReady = true
    // Sparkle must finish handing us control before we invoke its installation block.
    Task { @MainActor in installIfHidden() }
    return true
  }

  func updater(_ updater: SPUUpdater, didAbortWithError error: Error) {
    installUpdate = nil
    updateReady = false
    UserDefaults.standard.removeObject(forKey: "relaunchInMenuBar")
  }

  private func installIfHidden() {
    guard !visible, !saving, configured,
      UserDefaults.standard.bool(forKey: "automaticUpdates")
    else { return }
    installDownloadedUpdate()
  }

  func installDownloadedUpdate() {
    guard let install = installUpdate, !saving else { return }
    installUpdate = nil
    updateReady = false
    UserDefaults.standard.set(!visible, forKey: "relaunchInMenuBar")
    install()
  }

  func release() async {
    guard await settingsWriter.flush() else { return }
    saving = true
    defer { saving = false }
    do {
      try await host.send(HostCommand(kind: "release"))
      settingsOpen = false
    } catch { problem = error.localizedDescription }
  }
}
