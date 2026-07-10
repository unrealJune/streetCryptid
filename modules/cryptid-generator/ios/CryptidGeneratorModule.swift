import ExpoModulesCore

#if canImport(FoundationModels)
import FoundationModels

@available(iOS 26.0, *)
@Generable(description: "A compact ASCII cryptid profile icon")
private struct GeneratedCryptid {
  @Guide(description: "A distinctive cryptid name between 1 and 24 characters")
  var name: String

  @Guide(description: "Four to eight lines of printable 7-bit ASCII art, at most 28 columns wide")
  var sigil: String
}
#endif

public final class CryptidGeneratorModule: Module {
  public func definition() -> ModuleDefinition {
    Name("CryptidGenerator")

    AsyncFunction("availability") { () -> String in
      #if canImport(FoundationModels)
      if #available(iOS 26.0, *) {
        return SystemLanguageModel.default.isAvailable ? "available" : "unavailable"
      }
      #endif
      return "unavailable"
    }

    AsyncFunction("generate") {
      (description: String, seed: Double) async throws -> [String: String] in
      #if canImport(FoundationModels)
      if #available(iOS 26.0, *) {
        guard SystemLanguageModel.default.isAvailable else {
          throw Exception(
            name: "GeneratorUnavailable",
            description: "The on-device model is unavailable on this phone.")
        }

        let instructions = """
          Create compact, original ASCII cryptid profile icons. Keep every silhouette legible in a
          small monospaced tile. Use only printable 7-bit ASCII, spaces, and line breaks. Never use
          markdown. Keep names between 1 and 24 characters and art between 4 and 8 lines, with no
          line wider than 28 columns.
          """
        let session = LanguageModelSession(instructions: instructions)
        let prompt = """
          Create one cryptid inspired by "\(description)".
          Use variation seed \(Int(seed)) to make this attempt distinct.
          """
        let response = try await session.respond(to: prompt, generating: GeneratedCryptid.self)
        return ["name": response.content.name, "sigil": response.content.sigil]
      }
      #endif

      throw Exception(
        name: "GeneratorUnavailable",
        description: "The on-device model is unavailable on this phone.")
    }
  }
}
