import AppKit
import RepeaterCore

@main
struct RepeaterIconTool {
  @MainActor
  static func main() throws {
    guard CommandLine.arguments.count == 3 else {
      throw CocoaError(.fileReadInvalidFileName)
    }
    let svg = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
    let resources = URL(fileURLWithPath: CommandLine.arguments[2])
    let iconset = resources.appendingPathComponent("Repeater.iconset")
    try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)
    for size in [16, 32, 128, 256, 512] {
      for scale in [1, 2] {
        let image = try MothmanArtwork.bitmap(svg: svg, pixels: size * scale, template: false)
        let suffix = scale == 2 ? "@2x" : ""
        try image.representation(using: .png, properties: [:])!.write(
          to: iconset.appendingPathComponent("icon_\(size)x\(size)\(suffix).png")
        )
      }
    }
    for (name, size) in [("MothmanTemplate", 64), ("MothmanMark", 256)] {
      let image = try MothmanArtwork.bitmap(svg: svg, pixels: size, template: true)
      try image.representation(using: .png, properties: [:])!.write(
        to: resources.appendingPathComponent("\(name).png")
      )
    }
  }
}
