import ExpoModulesCore

#if canImport(FoundationModels)
import FoundationModels

/// Structured output for the on-device model.
///
/// The sigil is generated as *lines* rather than one free-form string on purpose: an unbounded
/// string lets the model loop on ASCII art until the response fills the 4k context window, which
/// surfaces as `GenerationError.exceededContextWindowSize`. A bounded array plus a response-token
/// cap keeps every attempt inside the window.
@available(iOS 26.0, *)
@Generable(description: "A compact ASCII cryptid profile icon")
private struct GeneratedCryptid {
  @Guide(description: "A distinctive cryptid name between 1 and 24 characters")
  var name: String

  @Guide(
    description: "Lines of printable 7-bit ASCII art, each at most 28 columns wide",
    .maximumCount(8))
  var sigilLines: [String]
}

@available(iOS 26.0, *)
private func generationInstructions(tight: Bool) -> String {
  if tight {
    return """
      Draw tiny ASCII cryptid icons. Printable 7-bit ASCII only, no markdown, no commentary.
      Answer with at most 5 short lines and stop immediately after the last line.
      """
  }
  return """
    Create compact, original ASCII cryptid profile icons. Keep every silhouette legible in a
    small monospaced tile. Use only printable 7-bit ASCII and spaces. Never use markdown and never
    add commentary. Keep names between 1 and 24 characters, use 4 to 8 lines of art, keep every
    line under 28 columns, and stop as soon as the drawing is complete.
    """
}

@available(iOS 26.0, *)
private func generationPrompt(description: String, seed: Int, tight: Bool) -> String {
  if tight {
    return "One tiny cryptid for \"\(description)\". At most 5 lines. Seed \(seed)."
  }
  return """
    Create one cryptid inspired by "\(description)".
    Use variation seed \(seed) to make this attempt distinct.
    """
}

@available(iOS 26.0, *)
private func generationOptions(seed: Int, tight: Bool) -> GenerationOptions {
  GenerationOptions(
    sampling: .random(top: 20, seed: UInt64(max(1, seed))),
    temperature: tight ? 0.5 : 0.7,
    maximumResponseTokens: tight ? 180 : 320)
}
#endif

private struct GenerationFailure: Error {
  let name: String
  let message: String
}

public final class CryptidGeneratorModule: Module {
  private func emit(
    _ phase: String,
    detail: String? = nil,
    attempt: Int = 1
  ) {
    var payload: [String: Any?] = ["phase": phase, "attempt": attempt]
    if let detail { payload["detail"] = detail }
    sendEvent("onGenerationProgress", payload)
  }

  public func definition() -> ModuleDefinition {
    Name("CryptidGenerator")
    Events("onGenerationProgress")

    AsyncFunction("availability") { () -> String in
      #if canImport(FoundationModels)
      if #available(iOS 26.0, *) {
        switch SystemLanguageModel.default.availability {
        case .available:
          return "available"
        case .unavailable(.modelNotReady):
          return "downloadable"
        default:
          return "unavailable"
        }
      }
      #endif
      return "unavailable"
    }

    AsyncFunction("availabilityDetail") { () -> [String: String] in
      #if canImport(FoundationModels)
      if #available(iOS 26.0, *) {
        switch SystemLanguageModel.default.availability {
        case .available:
          return ["status": "available"]
        case .unavailable(.modelNotReady):
          return ["status": "downloadable", "reason": "modelNotReady"]
        case .unavailable(.appleIntelligenceNotEnabled):
          return ["status": "unavailable", "reason": "appleIntelligenceNotEnabled"]
        case .unavailable(.deviceNotEligible):
          return ["status": "unavailable", "reason": "deviceNotEligible"]
        default:
          return ["status": "unavailable", "reason": "unknown"]
        }
      }
      #endif
      return ["status": "unavailable", "reason": "osTooOld"]
    }

    AsyncFunction("generate") {
      (description: String, seed: Double) async throws -> [String: String] in
      #if canImport(FoundationModels)
      if #available(iOS 26.0, *) {
        self.emit("checkingModel")
        guard SystemLanguageModel.default.isAvailable else {
          throw Exception(
            name: "GeneratorUnavailable",
            description: "The on-device model is unavailable on this phone.")
        }

        let normalizedSeed = Int(seed.magnitude.truncatingRemainder(dividingBy: 2_147_483_647)) + 1
        var lastFailure: GenerationFailure?

        // Attempt 1 is the roomy prompt; attempt 2 is a tighter prompt with a smaller token
        // budget, which is the recovery path when the model runs away and fills the window.
        for attempt in 1...2 {
          let tight = attempt > 1
          self.emit(
            "preparingModel",
            detail: tight ? "Reloading the model for a tighter retry" : nil,
            attempt: attempt)
          let session = LanguageModelSession(instructions: generationInstructions(tight: tight))
          session.prewarm()

          self.emit(
            "generating",
            detail: lastFailure.map { "Retrying after: \($0.message)" },
            attempt: attempt)
          do {
            let response = try await session.respond(
              to: generationPrompt(
                description: description, seed: normalizedSeed + attempt, tight: tight),
              generating: GeneratedCryptid.self,
              options: generationOptions(seed: normalizedSeed + attempt, tight: tight))

            self.emit("formatting", attempt: attempt)
            let sigil =
              response.content.sigilLines
              .prefix(8)
              .map { $0.replacingOccurrences(of: "\t", with: "  ") }
              .joined(separator: "\n")
            return ["name": response.content.name, "sigil": sigil]
          } catch let error as LanguageModelSession.GenerationError {
            lastFailure = describe(error)
          } catch is CancellationError {
            throw Exception(
              name: "GenerationCancelled", description: "Icon generation was cancelled.")
          } catch {
            lastFailure = GenerationFailure(
              name: "GenerationFailed", message: error.localizedDescription)
          }
        }

        let failure =
          lastFailure
          ?? GenerationFailure(
            name: "GenerationFailed", message: "The on-device model did not return an icon.")
        throw Exception(name: failure.name, description: failure.message)
      }
      #endif

      throw Exception(
        name: "GeneratorUnavailable",
        description: "The on-device model is unavailable on this phone.")
    }
  }
}

#if canImport(FoundationModels)
@available(iOS 26.0, *)
private func describe(_ error: LanguageModelSession.GenerationError) -> GenerationFailure {
  switch error {
  case .exceededContextWindowSize:
    return GenerationFailure(
      name: "ContextWindowExceeded",
      message:
        "The system model wrote past its context window before finishing the icon. Try a shorter description."
    )
  case .guardrailViolation:
    return GenerationFailure(
      name: "GuardrailViolation",
      message: "The system model refused that description. Try describing the cryptid differently.")
  case .assetsUnavailable:
    return GenerationFailure(
      name: "AssetsUnavailable",
      message: "The system model files are not ready yet. Try again once Apple Intelligence finishes setting up.")
  case .rateLimited:
    return GenerationFailure(
      name: "RateLimited",
      message: "The system model is busy right now. Wait a moment and generate again.")
  case .decodingFailure:
    return GenerationFailure(
      name: "DecodingFailure",
      message: "The system model returned an icon that could not be read. Generate another.")
  default:
    return GenerationFailure(
      name: "GenerationFailed", message: error.localizedDescription)
  }
}
#endif
