import AppKit
import Foundation

public enum MothmanArtwork {
  public enum Failure: Error { case invalidImage }

  @MainActor
  public static func bitmap(svg: Data, pixels: Int, template: Bool) throws -> NSBitmapImageRep {
    let document = try XMLDocument(data: svg)
    guard let root = document.rootElement() else { throw Failure.invalidImage }
    if template {
      // Template tinting uses alpha, not colour. The app icon's tile must never enter the mask.
      for rect in root.elements(forName: "rect") { rect.detach() }
      root.attribute(forName: "viewBox")?.stringValue = "232 232 560 560"
      for node in try root.nodes(forXPath: ".//*[@stroke]") {
        (node as? XMLElement)?.attribute(forName: "stroke")?.stringValue = "#000000"
      }
      for circle in try root.nodes(forXPath: ".//circle") {
        (circle as? XMLElement)?.attribute(forName: "fill")?.stringValue = "#000000"
      }
      if pixels <= 64 {
        for node in try root.nodes(forXPath: ".//*[@stroke-width]") {
          (node as? XMLElement)?.attribute(forName: "stroke-width")?.stringValue = "40"
        }
      }
    }
    guard let image = NSImage(data: document.xmlData),
      let bitmap = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
      ), let context = NSGraphicsContext(bitmapImageRep: bitmap)
    else { throw Failure.invalidImage }
    NSGraphicsContext.saveGraphicsState()
    defer { NSGraphicsContext.restoreGraphicsState() }
    NSGraphicsContext.current = context
    context.imageInterpolation = .high
    image.draw(in: NSRect(x: 0, y: 0, width: pixels, height: pixels))
    return bitmap
  }
}
