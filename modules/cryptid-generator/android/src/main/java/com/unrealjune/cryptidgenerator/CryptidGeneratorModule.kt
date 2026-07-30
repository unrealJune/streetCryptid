package com.unrealjune.cryptidgenerator

import com.google.mlkit.genai.common.DownloadStatus
import com.google.mlkit.genai.common.FeatureStatus
import com.google.mlkit.genai.prompt.Generation
import com.google.mlkit.genai.prompt.TextPart
import com.google.mlkit.genai.prompt.generateContentRequest
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import org.json.JSONObject

private const val LEGACY_MAX_OUTPUT_TOKENS = 220

private class GeneratorUnavailableException :
  CodedException("The on-device model is unavailable on this phone.")

private class InvalidGenerationException :
  CodedException("The on-device model did not return a usable ASCII icon. Generate another.")

/**
 * One unit of work handed down from JS.
 *
 * Prompting lives in `src/features/account/core/cryptid-prompt.ts` so prompt strategy can change
 * without an Android rebuild; this module only executes what it is given and bounds the output.
 */
class GenerationRequest : Record {
  @Field var instructions: String = ""

  @Field var prompt: String = ""

  @Field var seed: Int = 1

  @Field var candidateCount: Int = 1

  @Field var maxOutputTokens: Int = LEGACY_MAX_OUTPUT_TOKENS

  @Field var temperature: Float = 0.8f

  @Field var maxLines: Int = 8

  @Field var maxColumns: Int = 32

  @Field var attempt: Int = 1
}

/**
 * Gemini Nano loses drawings when they are asked for as one JSON string with embedded `\n`, so the
 * rows are requested as a JSON array instead. The single-string form is still parsed as a fallback
 * for the times the model ignores the schema.
 */
private fun composePrompt(request: GenerationRequest): String =
  """
  ${request.instructions}

  ${request.prompt}

  Answer with one JSON object and nothing else:
  {"name": "<1-24 characters>", "lines": ["<row>", "<row>", ...]}
  At most ${request.maxLines} rows, each under ${request.maxColumns} columns, printable ASCII only.
  """
    .trimIndent()

private fun parseGeneration(raw: String, maxLines: Int): Map<String, String>? {
  val start = raw.indexOf('{')
  val end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null

  val json =
    try {
      JSONObject(raw.substring(start, end + 1))
    } catch (_: Exception) {
      return null
    }

  val name = json.optString("name").trim()
  val array = json.optJSONArray("lines")
  val rawSigil =
    if (array != null) {
      (0 until minOf(array.length(), maxLines)).joinToString("\n") { array.optString(it) }
    } else {
      json.optString("sigil")
    }
  val sigil = rawSigil.replace("\r\n", "\n").replace('\r', '\n')

  if (name.isEmpty() || sigil.isBlank()) return null
  return mapOf("name" to name, "sigil" to sigil)
}

class CryptidGeneratorModule : Module() {
  private val generator by lazy { Generation.getClient() }

  private fun emit(
    phase: String,
    detail: String? = null,
    attempt: Int = 1,
    downloadedBytes: Long? = null,
    totalBytes: Long? = null,
  ) {
    val payload = mutableMapOf<String, Any>("phase" to phase, "attempt" to attempt)
    detail?.let { payload["detail"] = it }
    downloadedBytes?.let { payload["downloadedBytes"] = it }
    totalBytes?.let { payload["totalBytes"] = it }
    sendEvent("onGenerationProgress", payload)
  }

  private suspend fun ensureAvailable() {
    emit("checkingModel")
    when (generator.checkStatus()) {
      FeatureStatus.AVAILABLE -> Unit
      FeatureStatus.DOWNLOADABLE,
      FeatureStatus.DOWNLOADING -> {
        var completed = false
        var totalBytes: Long? = null
        emit("downloadingModel", detail = "Fetching the system model")
        generator.download().collect { status ->
          when (status) {
            is DownloadStatus.DownloadStarted -> {
              totalBytes = status.bytesToDownload
              emit("downloadingModel", downloadedBytes = 0L, totalBytes = totalBytes)
            }
            is DownloadStatus.DownloadProgress ->
              emit(
                "downloadingModel",
                downloadedBytes = status.totalBytesDownloaded,
                totalBytes = totalBytes,
              )
            is DownloadStatus.DownloadCompleted -> {
              completed = true
              emit("downloadingModel", detail = "Model downloaded", totalBytes = totalBytes)
            }
            is DownloadStatus.DownloadFailed -> throw status.e
            else -> Unit
          }
        }
        if (!completed && generator.checkStatus() != FeatureStatus.AVAILABLE) {
          throw GeneratorUnavailableException()
        }
      }
      else -> throw GeneratorUnavailableException()
    }
  }

  /**
   * Draws `candidateCount` independent sketches. Several small answers cost about the same as one
   * long one and give the JS scorer something to choose between; the per-answer token cap is what
   * stops the model from looping on ASCII art.
   */
  private suspend fun draw(request: GenerationRequest): List<Map<String, String>> {
    ensureAvailable()
    emit("preparingModel", detail = "Warming up the model", attempt = request.attempt)
    generator.warmup()

    val text = composePrompt(request)
    val rounds = request.candidateCount.coerceIn(1, 4)
    val drawings = mutableListOf<Map<String, String>>()

    emit("generating", attempt = request.attempt)
    for (index in 0 until rounds) {
      // Each sketch gets its own seed so the draws differ rather than repeating one sample.
      val candidateSeed = ((request.seed.toLong() + index) % Int.MAX_VALUE).toInt().coerceAtLeast(1)
      val content =
        generateContentRequest(TextPart(text)) {
          temperature = request.temperature
          topK = 20
          maxOutputTokens = request.maxOutputTokens
          this.seed = candidateSeed
        }
      val response =
        try {
          generator.generateContent(content)
        } catch (error: Exception) {
          // One bad draw must not sink the round; only a completely empty round is an error.
          if (drawings.isEmpty() && index == rounds - 1) throw error else continue
        }
      response.candidates.forEach { candidate ->
        parseGeneration(candidate.text, request.maxLines)?.let(drawings::add)
      }
    }

    emit("formatting", attempt = request.attempt)
    return drawings
  }

  override fun definition() = ModuleDefinition {
    Name("CryptidGenerator")
    Events("onGenerationProgress")

    AsyncFunction("availability") Coroutine
      { ->
        when (generator.checkStatus()) {
          FeatureStatus.AVAILABLE -> "available"
          FeatureStatus.DOWNLOADABLE,
          FeatureStatus.DOWNLOADING -> "downloadable"
          else -> "unavailable"
        }
      }

    AsyncFunction("availabilityDetail") Coroutine
      { ->
        when (val status = generator.checkStatus()) {
          FeatureStatus.AVAILABLE -> mapOf("status" to "available")
          FeatureStatus.DOWNLOADABLE ->
            mapOf("status" to "downloadable", "reason" to "modelNotDownloaded")
          FeatureStatus.DOWNLOADING ->
            mapOf("status" to "downloadable", "reason" to "modelDownloading")
          else -> mapOf("status" to "unavailable", "reason" to "featureStatus$status")
        }
      }

    AsyncFunction("generateCandidates") Coroutine
      { request: GenerationRequest ->
        draw(request)
      }

    // Legacy single-shot entry point, kept so JS that predates the best-of-N bridge still works.
    AsyncFunction("generate") Coroutine
      { description: String, seed: Double ->
        val request =
          GenerationRequest().apply {
            instructions =
              "Draw one original ASCII cryptid profile icon. Printable 7-bit ASCII only, " +
                "4 to 8 rows, no markdown and no commentary."
            prompt = "The cryptid is: \"$description\"."
            this.seed = seed.toLong().coerceIn(1L, Int.MAX_VALUE.toLong()).toInt()
            candidateCount = 1
            maxOutputTokens = LEGACY_MAX_OUTPUT_TOKENS
            temperature = 0.7f
          }
        draw(request).firstOrNull() ?: throw InvalidGenerationException()
      }
  }
}
