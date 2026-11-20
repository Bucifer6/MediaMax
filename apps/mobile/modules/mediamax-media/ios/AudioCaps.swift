import AVFoundation

/// Audio side of the device profile on iPhone / iPad / Apple TV (merged into getCapabilities).
///
/// AVPlayer decodes AAC, AC-3 and E-AC-3 — including Dolby Atmos carried as E-AC-3 JOC in HLS fMP4, which it outputs
/// as Atmos over HDMI (Apple TV → receiver, Dolby MAT), AirPlay or as spatial audio on AirPods / spatial-audio
/// speakers. It never bitstreams and has no TrueHD or DTS decoder, so `audioPassthrough` stays empty and the server
/// converts TrueHD / DTS to E-AC-3 5.1 (see docs/AUDIO.md).
enum AudioCaps {
  static func capabilities() -> [String: Any] {
    let session = AVAudioSession.sharedInstance()
    let outputs = session.currentRoute.outputs
    var maxChannels = max(2, session.maximumOutputNumberOfChannels)
    var multichannelRoute = maxChannels > 2
    if #available(iOS 15.0, tvOS 15.0, *) {
      // Routes that take multichannel content (HDMI receivers, AirPlay 2 / HomePod surround, spatial headphones).
      if session.supportsMultichannelContent { multichannelRoute = true }
    }
    var spatial = false
    #if os(iOS)
    if #available(iOS 15.0, *) {
      spatial = outputs.contains { $0.isSpatialAudioEnabled }
    }
    #endif
    let hdmi = outputs.contains { $0.portType == .HDMI }
    #if os(tvOS)
    // Apple TV: HDMI to the TV / receiver; a 5.1 / 7.1 receiver reports its channels once the session is active.
    if hdmi && maxChannels < 6 && multichannelRoute { maxChannels = 6 }
    #endif
    let multi = multichannelRoute || spatial || hdmi && maxChannels > 2
    var codecs = ["aac", "mp3", "alac", "flac", "ac3", "eac3"]
    // Atmos objects survive only on a route that renders them (multichannel / Atmos receiver, spatial audio).
    if multi { codecs.append("eac3-joc") }
    return [
      "audioCodecs": codecs,
      "audioPassthrough": [String](),
      "maxAudioChannels": min(maxChannels, 8),
      "multichannelAudioCodecs": multi ? ["aac", "ac3", "eac3"] : [String](),
      "spatialAudio": spatial,
    ]
  }
}
