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
  s.source_files = 'IrohLocationModule.swift', 'generated/**/*.swift', 'generated/**/*.h'

  # The Rust static library, packaged as an XCFramework (device + simulator slices) by
  # `just bindgen-ios`. Drop the built artifact next to this podspec.
  s.vendored_frameworks = 'IrohLocationFFI.xcframework'

  # Propagate the Rust static library's Apple framework dependencies to the app target.
  s.frameworks = 'Network', 'CoreBluetooth', 'SystemConfiguration'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }
end
