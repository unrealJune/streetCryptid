// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "StreetCryptidRepeater",
  platforms: [.macOS(.v13)],
  products: [
    .executable(name: "StreetCryptidRepeater", targets: ["RepeaterApp"]),
    .executable(name: "RepeaterIconTool", targets: ["RepeaterIconTool"]),
  ],
  dependencies: [
    .package(url: "https://github.com/sparkle-project/Sparkle", exact: "2.10.1")
  ],
  targets: [
    .target(name: "RepeaterCore"),
    .executableTarget(name: "RepeaterIconTool", dependencies: ["RepeaterCore"]),
    .executableTarget(
      name: "RepeaterApp",
      dependencies: ["RepeaterCore", .product(name: "Sparkle", package: "Sparkle")]
    ),
    .testTarget(name: "RepeaterCoreTests", dependencies: ["RepeaterCore"]),
  ]
)
