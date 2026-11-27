package tv.mediamax.media

/**
 * Audio formats Media3's FFmpeg extension (org.jellyfin.media3:media3-ffmpeg-decoder, see android/build.gradle)
 * decodes in software. expo-video is patched to build its ExoPlayer with extension renderers ON, so these play
 * when there is no MediaCodec decoder and no HDMI passthrough for them (DTS / DTS-HD / TrueHD on a Fire TV with a
 * stereo TV, MP2 broadcast audio, …). Output is multichannel PCM (the TV / receiver downmixes if needed).
 *
 * Reflection, so the module still compiles when the AAR is left out (VIBE_FFMPEG=0): then nothing is reported.
 */
internal object SoftwareAudio {
  private val MIMES = linkedMapOf(
    "audio/vnd.dts" to "dts",
    "audio/vnd.dts.hd" to "dts-hd",
    "audio/true-hd" to "truehd",
    "audio/ac3" to "ac3",
    "audio/eac3" to "eac3",
    "audio/mp4a-latm" to "aac",
    "audio/mpeg" to "mp3",
    "audio/mpeg-L2" to "mp2",
    "audio/flac" to "flac",
    "audio/alac" to "alac",
    "audio/vorbis" to "vorbis",
    "audio/opus" to "opus",
  )

  /** Capability tokens (server names: dts, dts-hd, truehd, mp2 …), empty without the FFmpeg extension. */
  val codecs: List<String> by lazy { scan() }

  /** FFmpeg version string, or null when the extension isn't available. */
  val version: String? by lazy {
    try {
      val lib = Class.forName("androidx.media3.decoder.ffmpeg.FfmpegLibrary")
      if (lib.getMethod("isAvailable").invoke(null) != true) null else lib.getMethod("getVersion").invoke(null) as? String
    } catch (_: Throwable) {
      null
    }
  }

  private fun scan(): List<String> {
    return try {
      val lib = Class.forName("androidx.media3.decoder.ffmpeg.FfmpegLibrary")
      if (lib.getMethod("isAvailable").invoke(null) != true) return emptyList()
      val supports = lib.getMethod("supportsFormat", String::class.java)
      MIMES.filter { (mime, _) ->
        try {
          supports.invoke(null, mime) == true
        } catch (_: Throwable) {
          false
        }
      }.values.distinct()
    } catch (_: Throwable) {
      // ClassNotFound (built without the AAR) or UnsatisfiedLinkError (ABI without the .so).
      emptyList()
    }
  }
}
