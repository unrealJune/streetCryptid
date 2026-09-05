require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'IrohLocation'
  s.version        = package['version']
  s.summary        = package['description']
  s.license        = 'MIT'
  s.author         = 'streetCryptid'
  s.homepage       = 'https://github.com/unrealJune/streetCryptid'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { :git => '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # Swift module sources + the UniFFI-generated Swift bindings (emitted by
  # `cargo run --bin uniffi-bindgen -- generate --language swift`).
  #
  # A glob, not a list of filenames. This named `IrohLocationModule.swift` alone until the
  # background runtime and the device-secret store were added beside it, and a source file that is
  # simply not compiled fails as unresolved references FROM the file that is — pointing at the
  # caller rather than at the omission. Gradle compiles the whole source set on the other side;
  # this keeps the two from disagreeing about what "the module" means.
  s.source_files = '*.swift', 'generated/**/*.swift', 'generated/**/*.h'

  # The Rust static library, packaged as an XCFramework (device + simulator slices) by
  # `just bindgen-ios`. Drop the built artifact next to this podspec.
  s.vendored_frameworks = 'IrohLocationFFI.xcframework'

  # Propagate the Rust static library's Apple framework dependencies to the app target, plus the
  # two the Swift sources need directly: CoreLocation for the background runtime's
  # `CLLocationManager`, and Security for the Keychain the device-secret store reads.
  s.frameworks = 'Network', 'CoreBluetooth', 'SystemConfiguration', 'CoreLocation', 'Security'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }
end
