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
import kotlin.coroutines.cancellation.CancellationException

// ML Kit's prompt API rejects anything outside 1..256 with
// `IllegalArgumentException: maxOutputTokens must be between 1 and 256`, so 256 is the whole
// budget we get. ASCII art tokenizes at roughly one token per punctuation character, which is why
// the roomy prompt asks for at most six lines of 26 characters: a longer drawing would be
// truncated mid-line by the ceiling, which reads as "the model drew garbage".
private const val MODEL_MAX_OUTPUT_TOKENS = 256
private const val MAX_OUTPUT_TOKENS = MODEL_MAX_OUTPUT_TOKENS
private const val TIGHT_OUTPUT_TOKENS = 192

private const val ART_CHARSET =
  "letters, digits, spaces, and / \\ | _ - ( ) [ ] < > ^ ~ * . , ' \" : ; = + o O @ #"

private class GeneratorUnavailableException :
  CodedException("The on-device model is unavailable on this phone.")

private class InvalidGenerationException :
  CodedException("The on-device model did not return a usable ASCII icon. Generate another.")

/**
 * The model answers in a line-delimited format rather than JSON on purpose.
 *
 * ASCII cryptids are mostly backslashes, and a backslash inside a JSON string has to be escaped.
 * Small models almost never do that, and Android's `org.json` silently swallows the backslash of
 * any escape it does not recognise (`\_` becomes `_`), so a JSON round trip quietly destroys the
 * drawing. A NAME/ART/END block needs no escaping at all.
 */
private fun generationPrompt(description: String, seed: Int, tight: Boolean): String =
  if (tight) {
    """
    Draw one tiny ASCII-art cryptid for: "$description"

    Answer in exactly this format, nothing else:
    NAME: <name, 1-24 characters>
    ART:
    <at most 5 lines, each at most 24 characters>
    END

    Use only $ART_CHARSET.
    Stop right after END. Variation seed: $seed.
    """
      .trimIndent()
  } else {
    """
    Draw one original ASCII-art cryptid profile icon for: "$description"

    Answer in exactly this format, nothing else:
    NAME: <name, 1-24 characters>
    ART:
    <art line 1>
    <art line 2>
    END

    Rules:
    - Between 4 and 6 art lines. Never more than 26 characters on a line.
    - Use only $ART_CHARSET.
    - Write the art literally, one line per line. Do not escape anything.
    - Keep the silhouette legible in a small monospaced profile tile.
    - No markdown, no code fences, no explanation before or after.
    - Stop right after END. Variation seed: $seed.
    """
      .trimIndent()
  }

private val NAME_LINE = Regex("""^\s*(?:\*\*)?name(?:\*\*)?\s*[:\-]\s*""", RegexOption.IGNORE_CASE)
private val ART_LINE = Regex("""^\s*(?:\*\*)?art(?:\*\*)?\s*[:\-]?\s*$""", RegexOption.IGNORE_CASE)
private val END_LINE = Regex("""^\s*end\s*$""", RegexOption.IGNORE_CASE)
private val FENCE_LINE = Regex("""^\s*```[a-z0-9]*\s*$""", RegexOption.IGNORE_CASE)

/** Reads the NAME/ART/END block. Tolerates a missing ART marker and a truncated END. */
private fun parseDelimited(raw: String): Map<String, String>? {
  val lines = raw.replace("\r\n", "\n").replace('\r', '\n').split("\n")
  val nameIndex = lines.indexOfFirst { NAME_LINE.containsMatchIn(it) }
  if (nameIndex < 0) return null
  val name = NAME_LINE.replace(lines[nameIndex], "").trim().trim('"', '\'', '*', '`').trim()
  if (name.isEmpty()) return null

  val relativeArtStart = lines.drop(nameIndex + 1).indexOfFirst { ART_LINE.matches(it) }
  val artStart = if (relativeArtStart < 0) nameIndex + 1 else nameIndex + relativeArtStart + 2
  val body = lines.drop(artStart)
  // A fenced drawing ends at its closing fence. Filtering fences out globally instead would let a
  // model that opens a block and never writes END pull its own sign-off into the art.
  val fenced = body.firstOrNull { it.isNotBlank() }?.let { FENCE_LINE.matches(it) } == true
  val art =
    if (fenced) {
      body
        .dropWhile { !FENCE_LINE.matches(it) }
        .drop(1)
        .takeWhile { !FENCE_LINE.matches(it) && !END_LINE.matches(it) }
    } else {
      body.takeWhile { !END_LINE.matches(it) }.filterNot { FENCE_LINE.matches(it) }
    }
      .joinToString("\n")
  if (art.isBlank()) return null
  return mapOf("name" to name, "sigil" to art)
}

/**
 * Pulls a string field out of JSON-ish output without a JSON parser.
 *
 * Only the escapes a model plausibly means are decoded; a lone backslash is kept verbatim because
 * in this context it is almost always part of the drawing. A truncated (unterminated) string still
 * yields what arrived, since a cut-off drawing is repairable and an exception is not.
 */
private fun extractJsonField(raw: String, field: String): String? {
  val opening = Regex(""""$field"\s*:\s*"""").find(raw) ?: return null
  val out = StringBuilder()
  var index = opening.range.last + 1
  while (index < raw.length) {
    val current = raw[index]
    if (current == '"') return out.toString()
    if (current != '\\' || index + 1 >= raw.length) {
      out.append(current)
      index += 1
      continue
    }
    when (val escaped = raw[index + 1]) {
      'n' -> {
        out.append('\n')
        index += 2
      }
      't' -> {
        out.append("  ")
        index += 2
      }
      'r' -> index += 2
      '"' -> {
        out.append(escaped)
        index += 2
      }
      'u' -> {
        val hex = raw.drop(index + 2).take(4)
        val code = hex.toIntOrNull(16)
        if (hex.length == 4 && code != null) {
          out.append(Char(code))
          index += 6
        } else {
          out.append(current)
          index += 1
        }
      }
      // Everything else, including `\\` and `\/`, is kept verbatim. The prompt asks the model not
      // to escape anything, so in this fallback those are two drawing characters far more often
      // than one escape, and collapsing them is the silent corruption this parser exists to avoid.
      else -> {
        out.append(current)
        index += 1
      }
    }
  }
  return out.toString().ifBlank { null }
}

private fun parseJsonish(raw: String): Map<String, String>? {
  val name = extractJsonField(raw, "name")?.trim() ?: return null
  val sigil = extractJsonField(raw, "sigil") ?: extractJsonField(raw, "art") ?: return null
  if (name.isEmpty() || sigil.isBlank()) return null
  return mapOf("name" to name, "sigil" to sigil)
}

internal fun parseGeneration(raw: String): Map<String, String> =
  parseDelimited(raw) ?: parseJsonish(raw) ?: throw InvalidGenerationException()

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
   * Attempt 1 is the roomy prompt; attempt 2 tightens the format and the token budget, which is
   * the recovery path when the model rambles instead of drawing. Mirrors the iOS retry.
   */
  private suspend fun runGeneration(description: String, seed: Int): Map<String, String> {
    var lastError: Exception? = null
    for (attempt in 1..2) {
      val tight = attempt > 1
      val attemptSeed = if (seed >= Int.MAX_VALUE - 2) attempt else seed + attempt
      emit(
        "preparingModel",
        detail = if (tight) "Reloading the model for a tighter retry" else "Warming up the model",
        attempt = attempt,
      )

      emit("generating", detail = lastError?.message, attempt = attempt)
      try {
        // Built inside the try: the config builder validates eagerly and throws
        // IllegalArgumentException, which would otherwise escape past the retry loop.
        val request =
          generateContentRequest(TextPart(generationPrompt(description, attemptSeed, tight))) {
            temperature = if (tight) 0.5f else 0.75f
            topK = 20
            maxOutputTokens =
              (if (tight) TIGHT_OUTPUT_TOKENS else MAX_OUTPUT_TOKENS)
                .coerceIn(1, MODEL_MAX_OUTPUT_TOKENS)
            this.seed = attemptSeed
          }
        generator.warmup()
        val response = generator.generateContent(request)
        emit("formatting", attempt = attempt)
        val raw = response.candidates.firstOrNull()?.text ?: throw InvalidGenerationException()
        return parseGeneration(raw)
      } catch (cancellation: CancellationException) {
        throw cancellation
      } catch (error: Exception) {
        lastError = error
      }
    }
    throw lastError ?: InvalidGenerationException()
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
        runGeneration(description, seed.toLong().coerceIn(1L, Int.MAX_VALUE.toLong()).toInt())
      }
  }
}
