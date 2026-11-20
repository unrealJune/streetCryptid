import AppKit
import CoreImage.CIFilterBuiltins
import RepeaterCore
import ServiceManagement
import SwiftUI

enum RepeaterStyle {
  static let signal = Color.accentColor
  static let mark = Bundle.main.url(forResource: "MothmanMark", withExtension: "png")
    .flatMap(NSImage.init(contentsOf:))
}

struct RepeaterView: View {
  @ObservedObject var model: AppModel
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var confirmRelease = false

  var body: some View {
    VStack(spacing: 0) {
      if !model.configured || model.settingsOpen {
        settings
      } else {
        ScrollView {
          VStack(spacing: 28) {
            brand
            if let snapshot = model.host.snapshot {
              if snapshot.claimed {
                running(snapshot)
              } else if let link = snapshot.claimUrl {
                claim(link)
              }
            } else {
              ProgressView().controlSize(.small).frame(height: 260)
            }
          }
          .padding(.horizontal, 36)
          .padding(.vertical, 28)
          .frame(maxWidth: 560)
          .frame(maxWidth: .infinity)
        }
      }
      if model.updateReady {
        HStack {
          Label("Update ready", systemImage: "arrow.down.circle")
          Spacer()
          Button("Install Update") { model.installDownloadedUpdate() }
            .disabled(model.saving)
        }.padding(16)
      }
      if let problem = model.problem ?? model.host.problem {
        HStack(alignment: .top, spacing: 10) {
          Image(systemName: "exclamationmark.circle").foregroundStyle(.red)
          Text(problem).font(.callout).textSelection(.enabled).frame(
            maxWidth: .infinity, alignment: .leading)
          if model.host.problem != nil {
            Button("Retry") { model.host.retryNow() }
          } else {
            Button("Retry") {
              if model.configured {
                model.preferencesChanged()
              } else {
                Task { await model.finishSetup() }
              }
            }
          }
        }
        .padding(16)
        .background(.background)
        .accessibilityElement(children: .combine)
      }
    }
    .background(Color(nsColor: .windowBackgroundColor))
    .animation(reduceMotion ? nil : .easeInOut(duration: 0.18), value: model.settingsOpen)
    .alert("Release this repeater?", isPresented: $confirmRelease) {
      Button("Cancel", role: .cancel) {}
      Button("Release", role: .destructive) { Task { await model.release() } }
    } message: {
      Text("Stops carrying everyone and creates a new claim code.")
    }
  }

  private var brand: some View {
    HStack(spacing: 14) {
      if let mark = RepeaterStyle.mark {
        Image(nsImage: mark).renderingMode(.template).resizable().scaledToFit()
          .foregroundStyle(.primary)
          .frame(width: 54, height: 54)
          .accessibilityHidden(true)
      }
      VStack(alignment: .leading, spacing: 0) {
        (Text("street") + Text("Cryptid").foregroundColor(RepeaterStyle.signal))
          .font(.custom("Rajdhani-SemiBold", size: 32))
        Text("Repeater").font(.system(size: 13, weight: .medium)).foregroundStyle(.secondary)
      }
      Spacer()
    }
  }

  private func claim(_ link: String) -> some View {
    VStack(spacing: 20) {
      Text("Claim this repeater").font(.system(size: 24, weight: .semibold))
      ClaimQR(link: link)
      Button {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(link, forType: .string)
      } label: {
        Label("Copy claim link", systemImage: "doc.on.doc")
      }
      .controlSize(.large)
      .padding(.bottom, 12)
    }
    .frame(maxWidth: .infinity)
  }

  private var settings: some View {
    VStack(spacing: 0) {
      Form {
        Section {
          HStack {
            Text("Name")
            Spacer()
            TextField("My Mac", text: preference(\.name))
              .multilineTextAlignment(.trailing)
              .textFieldStyle(.plain)
              .frame(maxWidth: 240)
              .onSubmit { model.preferencesChanged() }
              .help("Up to 40 characters")
          }
        }
        Section("This Mac") {
          Toggle("Start at login", isOn: preference(\.login))
            .help("Keep running in the menu bar while you're signed in.")
          if model.loginNeedsApproval {
            HStack {
              Text("Approval needed").foregroundStyle(.secondary)
              Spacer()
              Button("Login Items...") { SMAppService.openSystemSettingsLoginItems() }
            }
          }
          Toggle("Keep awake on power", isOn: preference(\.keepAwake))
            .help(
              "Prevent idle sleep on mains power. Does not keep the display awake or override a closed lid."
            )
        }
        Section("Updates & diagnostics") {
          Toggle(isOn: preference(\.automaticUpdates)) {
            settingLabel("Automatic updates", available: model.updateAvailable)
          }
          .disabled(!model.updateAvailable)
          .help("Signed updates are available in distribution builds.")
          Toggle(isOn: preference(\.telemetry)) {
            settingLabel(
              "Send diagnostics", available: model.host.snapshot?.telemetryAvailable == true)
          }
          .help("Optional health and traffic counters. Never locations.")
        }
        if model.configured, model.host.snapshot?.network != nil {
          Section("Network & collector") {
            Text(
              "No custom relays uses the public defaults. Keys stay on this machine; a blank key keeps the saved one for that URL."
            )
            .font(.caption).foregroundStyle(.secondary)
            ForEach($model.relays) { $relay in
              VStack(alignment: .leading) {
                TextField("Relay URL (https://...)", text: $relay.url)
                SecureField(
                  relay.hasKey ? "Key saved; leave blank to keep" : "Optional relay key",
                  text: $relay.key)
                HStack {
                  Toggle("Clear saved key", isOn: $relay.clearKey)
                  Spacer()
                  Button("Remove") { model.relays.removeAll { $0.id == relay.id } }
                }
              }
            }
            Button("Add relay") { model.relays.append(AppModel.RelayDraft()) }
              .disabled(model.relays.count >= 8)
            TextField("OTLP HTTP base URL (blank: build default)", text: $model.telemetryEndpoint)
            Text(
              "Only use a collector you trust with diagnostic metadata. Send diagnostics remains a separate opt-in."
            )
            .font(.caption).foregroundStyle(.secondary)
            Button("Save network settings") { Task { await model.saveNetwork() } }
              .disabled(model.networkSaving)
            Text(
              model.host.snapshot?.network?.restartRequired == true
                ? "Restart required: Quit Repeater, then reopen it. Identity and grants are kept."
                : "Connection changes apply after quitting and reopening Repeater."
            )
            .font(.caption).foregroundStyle(.secondary)
          }
        }
        if model.configured {
          Section {
            HStack {
              Text("Version \(model.version)").foregroundStyle(.secondary)
              Spacer()
              Button("Check for Updates...") { model.checkUpdates() }
                .disabled(!model.canUpdate && !model.updateReady)
            }
          }
          if model.host.snapshot?.claimed == true {
            Section {
              Button("Release Repeater...", role: .destructive) { confirmRelease = true }
                .disabled(model.saving)
            }
          }
        }
      }
      .formStyle(.grouped)
      .toggleStyle(.switch)
      .controlSize(.small)
      if !model.configured {
        HStack {
          Spacer()
          Button("Continue") { Task { await model.finishSetup() } }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .keyboardShortcut(.defaultAction)
            .disabled(!model.host.running || model.saving || model.name.count > 40)
        }
        .padding(.horizontal, 24)
        .padding(.bottom, 24)
      }
    }
  }

  private func preference<Value>(_ keyPath: ReferenceWritableKeyPath<AppModel, Value>) -> Binding<
    Value
  > {
    Binding(
      get: { model[keyPath: keyPath] },
      set: {
        model[keyPath: keyPath] = $0
        model.preferencesChanged()
      }
    )
  }

  private func settingLabel(_ title: String, available: Bool) -> some View {
    HStack {
      Text(title)
      if !available {
        Spacer()
        Text("Unavailable").font(.caption).foregroundStyle(.tertiary)
      }
    }
  }

  private func running(_ snapshot: Snapshot) -> some View {
    VStack(alignment: .leading, spacing: 24) {
      VStack(alignment: .leading, spacing: 6) {
        Text(snapshot.name ?? "Your repeater").font(.system(size: 26, weight: .semibold))
        Text(
          "Carrying \(snapshot.members.count) \(snapshot.members.count == 1 ? "person" : "people")"
        )
        .font(.callout).foregroundStyle(.secondary)
      }
      HStack(spacing: 0) {
        metric("\(snapshot.tracked)", label: "Ready to forward")
        Spacer()
        metric("\(snapshot.received)", label: "Fixes received")
        Spacer()
        metric("\(snapshot.connections)", label: "Connections")
      }
      Divider()
      HStack(spacing: 0) {
        traffic(snapshot.bytesReceived, label: "Received", symbol: "arrow.down")
        Spacer()
        traffic(snapshot.bytesSent, label: "Sent", symbol: "arrow.up")
        Spacer()
      }
      if snapshot.missing > 0 {
        Label("\(snapshot.missing) waiting for data", systemImage: "clock")
          .font(.callout).foregroundStyle(.secondary)
      }
      if snapshot.settings.keepAwake {
        Label(
          snapshot.keepAwakeHeld ? "Keeping awake" : "Normal sleep",
          systemImage: snapshot.keepAwakeHeld ? "powerplug" : "moon"
        ).font(.callout).foregroundStyle(.secondary)
      }
      if !snapshot.members.isEmpty {
        Divider()
        VStack(alignment: .leading, spacing: 14) {
          HStack {
            Text("People").font(.headline)
            Spacer()
            Text(snapshot.policy ?? "").font(.caption).foregroundStyle(.secondary)
          }
          ForEach(snapshot.members, id: \.self) { member in
            HStack(spacing: 10) {
              Image(systemName: "person.crop.circle").foregroundStyle(.secondary)
              Text(String(member.prefix(12))).font(.system(.body, design: .monospaced))
                .textSelection(.enabled)
              Spacer()
              if member == snapshot.owner {
                Text("Owner").font(.caption).foregroundStyle(.secondary)
              }
            }.help(member)
          }
        }
      }
    }.frame(maxWidth: .infinity, alignment: .leading)
  }

  private func metric(_ value: String, label: String) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(value).font(.system(size: 28, weight: .medium, design: .rounded)).monospacedDigit()
      Text(label).font(.caption).foregroundStyle(.secondary)
    }
  }

  private func traffic(_ value: UInt64, label: String, symbol: String) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Label(label, systemImage: symbol).font(.caption).foregroundStyle(.secondary)
      Text(ByteCountFormatter.string(fromByteCount: Int64(clamping: value), countStyle: .binary))
        .font(.system(size: 20, weight: .medium, design: .rounded)).monospacedDigit()
    }
  }
}

private struct ClaimQR: View {
  let link: String
  @State private var image: NSImage?

  var body: some View {
    Group {
      if let image {
        Image(nsImage: image).interpolation(.none).resizable().scaledToFit()
          .padding(20)
          .background(.white, in: RoundedRectangle(cornerRadius: 16))
          .overlay(RoundedRectangle(cornerRadius: 16).stroke(.black.opacity(0.06)))
          .accessibilityLabel("One-time repeater claim code")
      } else {
        ProgressView()
      }
    }
    .frame(width: 288, height: 288)
    .task(id: link) {
      let filter = CIFilter.qrCodeGenerator()
      filter.message = Data(link.utf8)
      filter.correctionLevel = "M"
      if let output = filter.outputImage,
        let cg = CIContext().createCGImage(output, from: output.extent)
      {
        image = NSImage(cgImage: cg, size: NSSize(width: cg.width, height: cg.height))
      }
    }
  }
}
