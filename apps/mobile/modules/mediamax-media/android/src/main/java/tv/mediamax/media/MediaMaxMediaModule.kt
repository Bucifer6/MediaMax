package tv.mediamax.media

import android.content.Context
import android.content.IntentFilter
import android.hardware.display.DisplayManager
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.media.MediaCodecInfo.CodecProfileLevel
import android.media.MediaCodecList
import android.os.Build
import android.view.Display
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Playback capabilities of this Android / Android TV / Google TV / Fire TV device for Vibe's device profile:
 * HDR types of the connected display, hardware decoders (HEVC Main10, AV1, VP9 profile 2, Dolby Vision profiles)
 * and the encoded audio formats the HDMI/eARC sink accepts for passthrough. Also forwards TV remote keys that
 * react-native-tvos doesn't (digits, colour keys, info/guide, track next/previous) as `onRemoteKey` events.
 */
class MediaMaxMediaModule : Module() {
  private val context: Context?
    get() = appContext.reactContext

  override fun definition() = ModuleDefinition {
    Name("MediaMaxMedia")

    Events("onRemoteKey")

    OnCreate {
      RemoteKeys.listener = { key -> sendEvent("onRemoteKey", mapOf("key" to key)) }
    }

    OnDestroy {
      RemoteKeys.listener = null
    }

    Function("getCapabilities") {
      val ctx = context ?: return@Function null
      capabilities(ctx)
    }

    // Frame-rate matching (DisplayMatch.kt): switch the HDMI refresh rate to the content's (or a multiple). The range is
    // Apple TV only; Android switches HDR itself from the stream. AsyncFunction like iOS (index.ts types them as Promises).
    AsyncFunction("matchDisplay") { frameRate: Double, _: String ->
      val activity = appContext.currentActivity ?: return@AsyncFunction false
      DisplayMatch.match(activity, frameRate)
    }
    AsyncFunction("resetDisplay") {
      appContext.currentActivity?.let { DisplayMatch.reset(it) }
    }

    // "Open in external player" (ExternalPlayer.kt): resolves when the player returns, with its position if it sends one.
    AsyncFunction("openExternalPlayer") { options: Map<String, Any?>, promise: Promise ->
      val activity = appContext.currentActivity
      if (activity == null) {
        promise.reject("ERR_EXTERNAL_PLAYER", "No activity", null)
        return@AsyncFunction
      }
      activity.runOnUiThread { ExternalPlayer.open(activity, options, promise) }
    }
    Function("installedPlayers") { packages: List<String> ->
      ExternalPlayer.installedOf(appContext.currentActivity, packages)
    }
    OnActivityResult { _, payload ->
      ExternalPlayer.onResult(payload.requestCode, payload.resultCode, payload.data)
    }
  }

  private fun capabilities(ctx: Context): Map<String, Any?> {
    val display = (ctx.getSystemService(Context.DISPLAY_SERVICE) as? DisplayManager)?.getDisplay(Display.DEFAULT_DISPLAY)
    val hdrTypes = mutableSetOf<Int>()
    if (display != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      if (Build.VERSION.SDK_INT >= 34) {
        display.mode.supportedHdrTypes.forEach { hdrTypes.add(it) }
      }
      @Suppress("DEPRECATION")
      display.hdrCapabilities?.supportedHdrTypes?.forEach { hdrTypes.add(it) }
    }
    val displayHdr = display != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && display.isHdr

    val codecs = DecoderScan.scan()
    // FFmpeg (software) decoders for what MediaCodec lacks; they output every channel, so they count as multichannel.
    val software = SoftwareAudio.codecs.filter { it !in codecs.audio }
    val hdr10 = hdrTypes.contains(Display.HdrCapabilities.HDR_TYPE_HDR10)
    val hlg = hdrTypes.contains(Display.HdrCapabilities.HDR_TYPE_HLG)
    val hdr10Plus = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && hdrTypes.contains(Display.HdrCapabilities.HDR_TYPE_HDR10_PLUS)
    // Dolby Vision needs both a DV decoder and a DV-capable display path.
    val dvDisplay = hdrTypes.contains(Display.HdrCapabilities.HDR_TYPE_DOLBY_VISION)
    val dvProfiles = if (dvDisplay) codecs.dolbyVisionProfiles.toList() else emptyList()

    val physicalHeight = if (display != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) display.mode.physicalHeight else 0

    return mapOf(
      "platform" to "android",
      "hdr10" to (hdr10 && codecs.tenBit.isNotEmpty()),
      "hdr10Plus" to (hdr10Plus && codecs.tenBit.isNotEmpty()),
      "hlg" to (hlg && codecs.tenBit.isNotEmpty()),
      "dolbyVision" to dvProfiles.isNotEmpty(),
      "dolbyVisionProfiles" to dvProfiles,
      "hdrDisplay" to (displayHdr || hdrTypes.isNotEmpty()),
      "videoCodecs" to codecs.video.toList(),
      "tenBitCodecs" to codecs.tenBit.toList(),
      "audioCodecs" to codecs.audio.toList(),
      "audioPassthrough" to passthrough(ctx),
      "maxDecodeHeight" to codecs.maxHeight,
      "displayHeight" to physicalHeight,
      "softwareAudioCodecs" to software,
      "ffmpegVersion" to SoftwareAudio.version,
    ) + AudioCaps.capabilities(ctx)
  }

  /** Encoded formats the current audio route (HDMI / eARC / optical) takes as a bitstream. */
  private fun passthrough(ctx: Context): List<String> {
    val names = linkedMapOf(
      AudioFormat.ENCODING_AC3 to "ac3",
      AudioFormat.ENCODING_E_AC3 to "eac3",
      AudioFormat.ENCODING_DTS to "dts",
      AudioFormat.ENCODING_DTS_HD to "dts-hd",
      AudioFormat.ENCODING_DOLBY_TRUEHD to "truehd",
    )
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) names[AudioFormat.ENCODING_E_AC3_JOC] = "eac3-joc"
    val out = linkedSetOf<String>()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      val attrs = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MOVIE).build()
      for ((enc, name) in names) {
        try {
          val fmt = AudioFormat.Builder().setEncoding(enc).setSampleRate(48000).setChannelMask(AudioFormat.CHANNEL_OUT_5POINT1).build()
          if (AudioTrack.isDirectPlaybackSupported(fmt, attrs)) out.add(name)
        } catch (_: Exception) {
          // Unsupported encoding constant on this build.
        }
      }
    } else {
      // Sticky HDMI plug broadcast lists the sink's encodings (no receiver needed to read it).
      try {
        val intent = ctx.registerReceiver(null, IntentFilter(AudioManager.ACTION_HDMI_AUDIO_PLUG))
        if (intent?.getIntExtra(AudioManager.EXTRA_AUDIO_PLUG_STATE, 0) == 1) {
          intent.getIntArrayExtra(AudioManager.EXTRA_ENCODINGS)?.forEach { enc -> names[enc]?.let { out.add(it) } }
        }
      } catch (_: Exception) {
      }
    }
    return out.toList()
  }
}

/** Hardware (where the platform says so) video/audio decoders. */
internal object DecoderScan {
  class Result {
    val video = linkedSetOf<String>()
    val tenBit = linkedSetOf<String>()
    val audio = linkedSetOf<String>()
    val dolbyVisionProfiles = linkedSetOf<String>()
    var maxHeight = 0
  }

  private val AUDIO = mapOf(
    "audio/mp4a-latm" to "aac", "audio/mpeg" to "mp3", "audio/ac3" to "ac3", "audio/eac3" to "eac3", "audio/eac3-joc" to "eac3-joc",
    "audio/vnd.dts" to "dts", "audio/vnd.dts.hd" to "dts-hd", "audio/true-hd" to "truehd", "audio/opus" to "opus",
    "audio/flac" to "flac", "audio/vorbis" to "vorbis", "audio/raw" to "pcm",
  )

  fun scan(): Result {
    val r = Result()
    val infos = try { MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos } catch (_: Exception) { emptyArray() }
    for (info in infos) {
      if (info.isEncoder) continue
      val software = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && info.isSoftwareOnly
      for (type in info.supportedTypes) {
        val mime = type.lowercase()
        AUDIO[mime]?.let { r.audio.add(it) }
        val caps = try { info.getCapabilitiesForType(type) } catch (_: Exception) { null } ?: continue
        val profiles = caps.profileLevels.map { it.profile }.toSet()
        val name = when (mime) {
          "video/avc" -> "h264"
          "video/hevc" -> "hevc"
          "video/av01" -> "av1"
          "video/x-vnd.on2.vp9" -> "vp9"
          "video/x-vnd.on2.vp8" -> "vp8"
          "video/mpeg2" -> "mpeg2video"
          "video/dolby-vision" -> "dolby-vision"
          else -> null
        } ?: continue
        if (name == "dolby-vision") {
          if (software) continue
          if (profiles.contains(CodecProfileLevel.DolbyVisionProfileDvheStn)) r.dolbyVisionProfiles.add("5")
          if (profiles.contains(CodecProfileLevel.DolbyVisionProfileDvheDtb)) r.dolbyVisionProfiles.add("7")
          if (profiles.contains(CodecProfileLevel.DolbyVisionProfileDvheSt)) r.dolbyVisionProfiles.addAll(listOf("8.1", "8.2", "8.4"))
          if (profiles.contains(CodecProfileLevel.DolbyVisionProfileDvavSe)) r.dolbyVisionProfiles.add("9")
          // AV1 Dolby Vision (profile 10, Android 11+ constant; the value is inlined at compile time).
          if (profiles.contains(CodecProfileLevel.DolbyVisionProfileDvav110)) r.dolbyVisionProfiles.add("10")
          continue
        }
        r.video.add(name)
        // 10-bit claims only from hardware decoders: a software Main10 decoder can't keep up with 4K HDR.
        if (!software) {
          val tenBit = when (name) {
            "hevc" -> profiles.contains(CodecProfileLevel.HEVCProfileMain10) || profiles.contains(CodecProfileLevel.HEVCProfileMain10HDR10)
            "av1" -> profiles.contains(CodecProfileLevel.AV1ProfileMain10) || profiles.contains(CodecProfileLevel.AV1ProfileMain10HDR10)
            "vp9" -> profiles.contains(CodecProfileLevel.VP9Profile2) || profiles.contains(CodecProfileLevel.VP9Profile2HDR)
            else -> false
          }
          if (tenBit) r.tenBit.add(name)
          val vc = caps.videoCapabilities
          if (vc != null && (name == "hevc" || name == "h264" || name == "av1")) {
            val h = when {
              vc.isSizeSupported(7680, 4320) -> 4320
              vc.isSizeSupported(3840, 2160) -> 2160
              vc.isSizeSupported(1920, 1080) -> 1080
              else -> vc.supportedHeights.upper
            }
            if (h > r.maxHeight) r.maxHeight = h
          }
        }
      }
    }
    return r
  }
}
