require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'CryptidGenerator'
  s.version        = package['version']
  s.summary        = package['description']
  s.license        = 'MIT'
  s.author         = 'streetCryptid'
  s.homepage       = 'https://github.com/unrealJune/streetCryptid'
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { :git => '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.source_files = 'CryptidGeneratorModule.swift'
  s.weak_frameworks = 'FoundationModels'
end
