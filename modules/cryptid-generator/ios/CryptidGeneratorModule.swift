import ExpoModulesCore

/// One unit of work handed down from JS.
///
/// Prompting lives in `src/features/account/core/cryptid-prompt.ts` so prompt strategy can change
/// without an iOS rebuild (which needs a Mac); this module only executes what it is given and
/// bounds the output.
struct GenerationRequest: Record {
  @Field var instructions: String = ""
  @Field var prompt: String = ""
  @Field var seed: Int = 1
  @Field var candidateCount: Int = 1
  @Field var maxOutputTokens: Int = 200
  @Field var temperature: Double = 0.8
  @Field var maxLines: Int = 8
  @Field var maxColumns: Int = 32
  @Field var attempt: Int = 1
}

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

  #if canImport(FoundationModels)
  /// Draws `candidateCount` independent sketches.
  ///
  /// The system model has no candidate parameter, so each sketch is its own short session with its
  /// own sampling seed. Several small answers cost about the same as one long one and give the JS
  /// scorer something to choose between, and the per-answer token cap is what keeps every attempt
  /// inside the context window.
  @available(iOS 26.0, *)
  private func draw(_ request: GenerationRequest) async throws -> [[String: String]] {
    self.emit("checkingModel", attempt: request.attempt)
    guard SystemLanguageModel.default.isAvailable else {
      throw Exception(
        name: "GeneratorUnavailable",
        description: "The on-device model is unavailable on this phone.")
    }

    let rounds = min(max(request.candidateCount, 1), 4)
    let baseSeed = UInt64(max(1, request.seed))
    var drawings: [[String: String]] = []
    var lastFailure: GenerationFailure?

    self.emit("preparingModel", attempt: request.attempt)
    let session = LanguageModelSession(instructions: request.instructions)
    session.prewarm()

    self.emit("generating", attempt: request.attempt)
    for index in 0..<rounds {
      let options = GenerationOptions(
        sampling: .random(top: 20, seed: baseSeed &+ UInt64(index)),
        temperature: request.temperature,
        maximumResponseTokens: request.maxOutputTokens)
      do {
        // A fresh session per sketch: the transcript is not wanted here, and carrying it would
        // grow every later attempt towards the context window for no benefit. Repair feedback
        // arrives in the prompt instead, built by the JS scorer.
        let attemptSession = index == 0
          ? session
          : LanguageModelSession(instructions: request.instructions)
        let response = try await attemptSession.respond(
          to: request.prompt,
          generating: GeneratedCryptid.self,
          options: options)
        let sigil =
          response.content.sigilLines
          .prefix(max(1, request.maxLines))
          .map { $0.replacingOccurrences(of: "\t", with: "  ") }
          .joined(separator: "\n")
        if !sigil.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
          drawings.append(["name": response.content.name, "sigil": sigil])
        }
      } catch let error as LanguageModelSession.GenerationError {
        lastFailure = describe(error)
      } catch is CancellationError {
        throw Exception(name: "GenerationCancelled", description: "Icon generation was cancelled.")
      } catch {
        lastFailure = GenerationFailure(
          name: "GenerationFailed", message: error.localizedDescription)
      }
    }

    // One bad draw must not sink the round; only a completely empty round is an error.
    if drawings.isEmpty {
      let failure =
        lastFailure
        ?? GenerationFailure(
          name: "GenerationFailed", message: "The on-device model did not return an icon.")
      throw Exception(name: failure.name, description: failure.message)
    }

    self.emit("formatting", attempt: request.attempt)
    return drawings
  }
  #endif

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

    AsyncFunction("generateCandidates") {
      (request: GenerationRequest) async throws -> [[String: String]] in
      #if canImport(FoundationModels)
      if #available(iOS 26.0, *) {
        return try await self.draw(request)
      }
      #endif
      throw Exception(
        name: "GeneratorUnavailable",
        description: "The on-device model is unavailable on this phone.")
    }

    // Legacy single-shot entry point, kept so JS that predates the best-of-N bridge still works.
    AsyncFunction("generate") {
      (description: String, seed: Double) async throws -> [String: String] in
      #if canImport(FoundationModels)
      if #available(iOS 26.0, *) {
        var request = GenerationRequest()
        request.instructions = """
          Create compact, original ASCII cryptid profile icons. Use only printable 7-bit ASCII and
          spaces. Never use markdown and never add commentary. Keep names between 1 and 24
          characters, use 4 to 8 lines of art, and keep every line under 28 columns.
          """
        request.prompt = "Create one cryptid inspired by \"\(description)\"."
        request.seed = Int(seed.magnitude.truncatingRemainder(dividingBy: 2_147_483_647)) + 1
        request.candidateCount = 1
        request.temperature = 0.7
        guard let first = try await self.draw(request).first else {
          throw Exception(
            name: "GenerationFailed",
            description: "The on-device model did not return an icon.")
        }
        return first
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
