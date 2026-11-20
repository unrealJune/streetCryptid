import AppKit
import XCTest

@testable import RepeaterCore

final class MothmanArtworkTests: XCTestCase {
  @MainActor
  func testTemplateContainsOnlyTheSigilNotTheOpaqueAppIconTile() throws {
    let source = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
      .appendingPathComponent("../../../../assets/images/mothman-logo.svg").standardizedFileURL
    let svg = try Data(contentsOf: source)
    for size in [64, 256] {
      let bitmap = try MothmanArtwork.bitmap(svg: svg, pixels: size, template: true)
      var filled = 0
      for y in 0..<size {
        for x in 0..<size {
          if bitmap.colorAt(x: x, y: y)!.alphaComponent > 0.5 { filled += 1 }
        }
      }
      let fraction = Double(filled) / Double(size * size)
      XCTAssertGreaterThan(fraction, 0.05, "The sigil must actually render")
      XCTAssertLessThan(fraction, 0.4, "A background tile must not become a solid template square")
      XCTAssertEqual(bitmap.colorAt(x: 0, y: 0)!.alphaComponent, 0)
      XCTAssertEqual(bitmap.colorAt(x: size / 2, y: 0)!.alphaComponent, 0)
    }
  }
}
