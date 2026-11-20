package tv.mediamax.media

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.media.MediaCodecList
import android.os.Build

/**
 * Audio side of the device profile (merged into getCapabilities):
 *  - maxAudioChannels: channels of the current output (HDMI / HDMI ARC / eARC sink, USB, else the built-in 2), from
 *    AudioDeviceInfo.getChannelCounts() / channel masks. The server picks AAC 7.1 / 5.1 / stereo or E-AC-3 from it.
 *  - multichannelAudioCodecs: decoders that output more than 2 channels (AAC / AC-3 / E-AC-3).
 *  - directAudioFormats: Android 13+ AudioManager.getDirectProfilesForAttributes — the encoded formats the route takes
 *    as a bitstream (more precise than probing AudioTrack.isDirectPlaybackSupported), incl. DTS-HD MA / DTS:X on 14+.
 *  - spatialAudio: Android 12L+ Spatializer available and enabled (E-AC-3 JOC renders as spatial audio).
 *
 * Passthrough itself happens in Media3: expo-video builds its ExoPlayer with DefaultRenderersFactory, whose
 * DefaultAudioSink reads AudioCapabilities from the HDMI route and sends AC-3 / E-AC-3 (JOC) / DTS / DTS-HD / TrueHD
 * bitstreams when the sink accepts them — no configuration needed (see docs/AUDIO.md).
 */
internal object AudioCaps {
  private val MEDIA_ATTRS: AudioAttributes by lazy {
    AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MOVIE).build()
  }

  fun capabilities(ctx: Context): Map<String, Any?> {
    val am = ctx.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
    return mapOf(
      "maxAudioChannels" to maxChannels(am),
      "multichannelAudioCodecs" to multichannelDecoders(),
      "directAudioFormats" to directFormats(am),
      "spatialAudio" to spatial(am),
    )
  }

  private val EXTERNAL_TYPES: Set<Int> by lazy {
    val s = mutableSetOf(AudioDeviceInfo.TYPE_HDMI, AudioDeviceInfo.TYPE_HDMI_ARC, AudioDeviceInfo.TYPE_USB_DEVICE, AudioDeviceInfo.TYPE_LINE_DIGITAL)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) s.add(AudioDeviceInfo.TYPE_USB_HEADSET)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) s.add(AudioDeviceInfo.TYPE_HDMI_EARC)
    s
  }

  /** Channels of the active output route (largest count/mask it reports), 2 for phone speakers / headphones. */
  fun maxChannels(am: AudioManager?): Int {
    if (am == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return 2
    val devices: List<AudioDeviceInfo> = try {
      if (Build.VERSION.SDK_INT >= 33) am.getAudioDevicesForAttributes(MEDIA_ATTRS)
      else am.getDevices(AudioManager.GET_DEVICES_OUTPUTS).filter { it.type in EXTERNAL_TYPES }
    } catch (_: Exception) {
      emptyList()
    }
    var best = 2
    for (d in devices) {
      val fromCounts = d.channelCounts.maxOrNull() ?: 0
      val fromMasks = d.channelMasks.maxOfOrNull { Integer.bitCount(it) } ?: 0
      // An HDMI sink that lists no counts takes whatever the TV/receiver negotiates: assume 5.1 (AC-3 class).
      val n = maxOf(fromCounts, fromMasks, if (d.type in EXTERNAL_TYPES && fromCounts == 0 && fromMasks == 0) 6 else 0)
      if (n > best) best = n
    }
    return best.coerceIn(2, 8)
  }

  private val MULTI = mapOf("audio/mp4a-latm" to "aac", "audio/ac3" to "ac3", "audio/eac3" to "eac3", "audio/opus" to "opus", "audio/flac" to "flac")

  fun multichannelDecoders(): List<String> {
    val out = linkedSetOf<String>()
    val infos = try { MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos } catch (_: Exception) { emptyArray() }
    for (info in infos) {
      if (info.isEncoder) continue
      for (type in info.supportedTypes) {
        val name = MULTI[type.lowercase()] ?: continue
        val ch = try { info.getCapabilitiesForType(type).audioCapabilities?.maxInputChannelCount ?: 0 } catch (_: Exception) { 0 }
        if (ch > 2) out.add(name)
      }
    }
    return out.toList()
  }

  /** Encoded formats the route plays directly (bitstream), Android 13+. */
  fun directFormats(am: AudioManager?): List<String> {
    if (am == null || Build.VERSION.SDK_INT < 33) return emptyList()
    val names = mutableMapOf(
      AudioFormat.ENCODING_AC3 to "ac3",
      AudioFormat.ENCODING_E_AC3 to "eac3",
      AudioFormat.ENCODING_E_AC3_JOC to "eac3-joc",
      AudioFormat.ENCODING_DTS to "dts",
      AudioFormat.ENCODING_DTS_HD to "dts-hd",
      AudioFormat.ENCODING_DOLBY_TRUEHD to "truehd",
      AudioFormat.ENCODING_DOLBY_MAT to "truehd", // MAT carries TrueHD (Atmos) to eARC receivers
    )
    if (Build.VERSION.SDK_INT >= 34) {
      names[AudioFormat.ENCODING_DTS_HD_MA] = "dts-hd"
      names[AudioFormat.ENCODING_DTS_UHD_P2] = "dts-x"
    }
    return try {
      am.getDirectProfilesForAttributes(MEDIA_ATTRS).mapNotNull { names[it.format] }.distinct()
    } catch (_: Exception) {
      emptyList()
    }
  }

  fun spatial(am: AudioManager?): Boolean {
    if (am == null || Build.VERSION.SDK_INT < 32) return false
    return try {
      val sp = am.spatializer
      val fmt = AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT).setSampleRate(48000).setChannelMask(AudioFormat.CHANNEL_OUT_5POINT1).build()
      sp.isAvailable && sp.isEnabled && sp.canBeSpatialized(MEDIA_ATTRS, fmt)
    } catch (_: Exception) {
      false
    }
  }
}
