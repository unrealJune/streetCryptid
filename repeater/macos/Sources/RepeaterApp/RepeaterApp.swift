import AppKit
import Combine
import CoreText
import ServiceManagement
import SwiftUI

@main
enum RepeaterApp {
  @MainActor static func main() {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    withExtendedLifetime(delegate) { app.run() }
  }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, NSToolbarDelegate {
  private var model: AppModel!
  private var window: NSWindow!
  private var statusItem: NSStatusItem!
  private var terminating = false
  private var subscriptions = Set<AnyCancellable>()
  private let navigationItem = NSToolbarItem(itemIdentifier: .init("navigation"))

  func applicationDidFinishLaunching(_ notification: Notification) {
    // No identity is minted by a second UI; never try to replace the first instance.
    if NSRunningApplication.runningApplications(
      withBundleIdentifier: Bundle.main.bundleIdentifier ?? ""
    ).contains(where: { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }) {
      NSApp.terminate(nil)
      return
    }
    for name in ["Rajdhani", "Plex"] {
      if let url = Bundle.main.url(forResource: name, withExtension: "ttf") {
        CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
      }
    }
    model = AppModel()
    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 600, height: 620),
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered, defer: false
    )
    window.title = "streetCryptid Repeater"
    window.minSize = NSSize(width: 520, height: 560)
    window.titlebarAppearsTransparent = true
    window.toolbarStyle = .unified
    let toolbar = NSToolbar(identifier: "RepeaterToolbar")
    toolbar.delegate = self
    toolbar.displayMode = .iconOnly
    toolbar.allowsUserCustomization = false
    window.toolbar = toolbar
    window.isReleasedWhenClosed = false
    window.delegate = self
    window.contentView = NSHostingView(rootView: RepeaterView(model: model))
    window.center()
    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    let image =
      NSImage(
        contentsOf: Bundle.main.url(forResource: "MothmanTemplate", withExtension: "png")!
      )
      ?? NSImage(
        systemSymbolName: "antenna.radiowaves.left.and.right", accessibilityDescription: "Repeater")
    image?.isTemplate = true
    image?.size = NSSize(width: 20, height: 20)
    statusItem.button?.image = image
    statusItem.button?.toolTip = "streetCryptid Repeater"
    let menu = NSMenu()
    menu.addItem(item("Open Repeater", #selector(showWindow)))
    menu.addItem(item("Settings...", #selector(showSettings)))
    menu.addItem(item("Check for Updates...", #selector(checkUpdates)))
    menu.addItem(.separator())
    menu.addItem(item("Quit Repeater", #selector(quit)))
    statusItem.menu = menu
    model.$settingsOpen.combineLatest(model.$configured).sink { [weak self] open, configured in
      guard let self else { return }
      self.navigationItem.image = NSImage(
        systemSymbolName: open ? "chevron.left" : "gearshape",
        accessibilityDescription: open ? "Back" : "Settings"
      )
      self.navigationItem.label = open ? "Back" : "Settings"
      self.navigationItem.toolTip = open ? "Back to repeater" : "Settings"
      self.navigationItem.isEnabled = configured
      self.window.title = open ? "Settings" : "streetCryptid Repeater"
    }.store(in: &subscriptions)
    let main = NSMenu()
    let appMenu = NSMenu()
    appMenu.addItem(item("About streetCryptid Repeater", #selector(about)))
    appMenu.addItem(item("Settings...", #selector(showSettings), key: ","))
    appMenu.addItem(item("Quit Repeater", #selector(quit), key: "q"))
    let appItem = NSMenuItem()
    appItem.submenu = appMenu
    main.addItem(appItem)
    let edit = NSMenuItem()
    edit.title = "Edit"
    edit.submenu = NSMenu(title: "Edit")
    for (title, action, key) in [
      ("Cut", "cut:", "x"), ("Copy", "copy:", "c"),
      ("Paste", "paste:", "v"), ("Select All", "selectAll:", "a"),
    ] {
      edit.submenu?.addItem(
        NSMenuItem(title: title, action: Selector(action), keyEquivalent: key)
      )
    }
    main.addItem(edit)
    NSApp.mainMenu = main
    NSWorkspace.shared.notificationCenter.addObserver(
      self, selector: #selector(woke), name: NSWorkspace.didWakeNotification, object: nil
    )
    // Login launches stay in the menu bar; a deliberate Finder/Dock open gets a window.
    let loginLaunch =
      NSAppleEventManager.shared().currentAppleEvent?
      .paramDescriptor(forKeyword: keyAEPropData)?.enumCodeValue == keyAELaunchedAsLogInItem
    let backgroundUpdate = UserDefaults.standard.bool(forKey: "relaunchInMenuBar")
    UserDefaults.standard.removeObject(forKey: "relaunchInMenuBar")
    if !model.configured || (!loginLaunch && !backgroundUpdate) { showWindow() }
    model.host.start()
  }

  private func item(_ title: String, _ action: Selector, key: String = "") -> NSMenuItem {
    let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
    item.target = self
    return item
  }
  func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
    [.flexibleSpace, .init("navigation")]
  }
  func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
    toolbarDefaultItemIdentifiers(toolbar)
  }
  func toolbar(
    _ toolbar: NSToolbar, itemForItemIdentifier identifier: NSToolbarItem.Identifier,
    willBeInsertedIntoToolbar flag: Bool
  ) -> NSToolbarItem? {
    if identifier.rawValue == "navigation" {
      navigationItem.target = self
      navigationItem.action = #selector(navigate)
      navigationItem.isBordered = true
      return navigationItem
    }
    return nil
  }
  @objc private func navigate() {
    if model.settingsOpen {
      Task { await model.leaveSettings() }
    } else {
      model.editSettings()
    }
  }
  @objc private func showWindow() {
    NSApp.setActivationPolicy(.regular)
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    model.visible = true
  }
  @objc private func showSettings() {
    model.editSettings()
    showWindow()
  }
  @objc private func checkUpdates() {
    if model.canUpdate || model.updateReady { model.checkUpdates() }
  }
  @objc private func about() { NSApp.orderFrontStandardAboutPanel(nil) }
  @objc private func quit() { NSApp.terminate(nil) }
  @objc private func woke() { model.host.resumed() }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
    if window != nil { showWindow() }
    return true
  }
  func windowWillClose(_ notification: Notification) {
    model.visible = false
    NSApp.setActivationPolicy(.accessory)
  }
  func windowDidMiniaturize(_ notification: Notification) { model.visible = false }
  func windowDidDeminiaturize(_ notification: Notification) { model.visible = true }
  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    guard let model else { return .terminateNow }
    guard !terminating else { return .terminateLater }
    terminating = true
    Task {
      await model.finishPendingSettings()
      await model.host.stop()
      sender.reply(toApplicationShouldTerminate: true)
    }
    return .terminateLater
  }
}
