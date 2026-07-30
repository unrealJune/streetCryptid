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
import org.json.JSONObject

private const val MAX_OUTPUT_TOKENS = 220

private class GeneratorUnavailableException :
  CodedException("The on-device model is unavailable on this phone.")

private class InvalidGenerationException :
  CodedException("The on-device model did not return a usable ASCII icon. Generate another.")

private fun generationPrompt(description: String, seed: Int): String =
  """
  Create one original ASCII cryptid profile icon inspired by this description:
  "$description"

  Requirements:
  - Return exactly one JSON object with string fields "name" and "sigil".
  - The name is distinctive and 1-24 characters.
  - The sigil uses only printable 7-bit ASCII, spaces, and line breaks.
  - The sigil is 4-8 lines and no line exceeds 28 columns.
  - Keep the silhouette legible in a small monospaced profile tile.
  - Encode line breaks inside the JSON string as \n.
  - Do not use markdown or add commentary.
  - Variation seed: $seed.
  """.trimIndent()

private fun parseGeneration(raw: String): Map<String, String> {
  val start = raw.indexOf('{')
  val end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) throw InvalidGenerationException()

  val json =
    try {
      JSONObject(raw.substring(start, end + 1))
    } catch (_: Exception) {
      throw InvalidGenerationException()
    }
  val name = json.optString("name").trim()
  val sigil = json.optString("sigil").replace("\r\n", "\n").replace('\r', '\n')
  if (name.isEmpty() || sigil.isBlank()) throw InvalidGenerationException()
  return mapOf("name" to name, "sigil" to sigil)
}

class CryptidGeneratorModule : Module() {
  private val generator by lazy { Generation.getClient() }

  private fun emit(
    phase: String,
    detail: String? = null,
    downloadedBytes: Long? = null,
    totalBytes: Long? = null,
  ) {
    val payload = mutableMapOf<String, Any>("phase" to phase, "attempt" to 1)
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

    AsyncFunction("generate") Coroutine
      { description: String, seed: Double ->
        ensureAvailable()
        emit("preparingModel", detail = "Warming up the model")
        generator.warmup()
        val normalizedSeed = seed.toLong().coerceIn(1L, Int.MAX_VALUE.toLong()).toInt()
        val request =
          generateContentRequest(TextPart(generationPrompt(description, normalizedSeed))) {
            temperature = 0.7f
            topK = 20
            maxOutputTokens = MAX_OUTPUT_TOKENS
            this.seed = normalizedSeed
          }
        emit("generating")
        val response = generator.generateContent(request)
        emit("formatting")
        val raw = response.candidates.firstOrNull()?.text ?: throw InvalidGenerationException()
        parseGeneration(raw)
      }
  }
}
