import AVFoundation
import CoreMedia
import ExpoModulesCore
import UIKit
import VideoToolbox

/// Playback capabilities of this iPhone / iPad / Apple TV for MediaMax's device profile (HDR modes AVPlayer can
/// output, hardware decoders), plus Apple TV display matching: switch the TV to the content's dynamic range and
/// frame rate (AVDisplayCriteria) while a video plays, when the user enabled "Match Content" in tvOS settings.
public class MediaMaxMediaModule: Module {
  public func definition() -> ModuleDefinition {
    Name("MediaMaxMedia")

    // Android forwards extra remote keys; the Siri Remote has none, so this never fires on Apple platforms.
    Events("onRemoteKey")

    Function("getCapabilities") { () -> [String: Any] in
      Self.capabilities()
    }

    /// tvOS 17+: ask the display to match `frameRate` (fps, 0 = keep) and `range` ("sdr" | "hdr10" | "hlg" | "dolbyvision").
    AsyncFunction("matchDisplay") { (frameRate: Double, range: String) -> Bool in
      #if os(tvOS)
      if #available(tvOS 17.0, *) {
        return DisplayMatcher.apply(frameRate: frameRate, range: range)
      }
      #endif
      return false
    }.runOnQueue(.main)

    AsyncFunction("resetDisplay") { () in
      #if os(tvOS)
      if #available(tvOS 17.0, *) {
        DisplayMatcher.reset()
      }
      #endif
    }.runOnQueue(.main)
  }

  static func capabilities() -> [String: Any] {
    var hdr10 = false
    var hlg = false
    var dolbyVision = false
    // HDR modes the current display path supports (phone/iPad panel, or the TV behind an Apple TV).
    let modes = AVPlayer.availableHDRModes
    hdr10 = modes.contains(.hdr10)
    hlg = modes.contains(.hlg)
    dolbyVision = modes.contains(.dolbyVision)
    var eligible = hdr10 || hlg || dolbyVision
    if #available(iOS 13.4, tvOS 13.4, *) {
      eligible = AVPlayer.eligibleForHDRPlayback
      if eligible && !(hdr10 || hlg || dolbyVision) {
        // availableHDRModes can be empty on newer OS versions; eligibility implies HDR10/HLG/DV on Apple devices.
        hdr10 = true
        hlg = true
        dolbyVision = true
      }
    }

    let hevc = VTIsHardwareDecodeSupported(kCMVideoCodecType_HEVC)
    let av1Type: CMVideoCodecType = 0x6176_3031 // 'av01'
    let av1 = VTIsHardwareDecodeSupported(av1Type)
    var videoCodecs = ["h264"]
    var tenBit: [String] = []
    if hevc {
      videoCodecs.append("hevc")
      tenBit.append("hevc")
    }
    if av1 {
      videoCodecs.append("av1")
      tenBit.append("av1")
    }

    let bounds = UIScreen.main.nativeBounds
    let nativeHeight = Int(min(bounds.width, bounds.height))
    #if os(tvOS)
    let platform = "tvos"
    // Apple TV HD (no hardware HEVC) tops out at 1080p; Apple TV 4K decodes 2160p HEVC.
    let maxDecodeHeight = hevc ? 2160 : 1080
    #else
    let platform = "ios"
    let maxDecodeHeight = hevc ? 2160 : 1080
    #endif

    // AVPlayer plays Dolby Vision profiles 5 and 8.x (8.1 HDR10-compatible, 8.4 HLG-compatible); never dual-layer 7.
    let dvProfiles = dolbyVision && hevc ? ["5", "8.1", "8.4"] : []

    return [
      "platform": platform,
      "hdr10": eligible && hdr10 && hevc,
      "hdr10Plus": false,
      "hlg": eligible && hlg && hevc,
      "dolbyVision": eligible && !dvProfiles.isEmpty,
      "dolbyVisionProfiles": dvProfiles,
      "hdrDisplay": eligible,
      "videoCodecs": videoCodecs,
      "tenBitCodecs": tenBit,
      // AVPlayer decodes AC-3 / E-AC-3 (incl. Atmos JOC, sent as Atmos over HDMI/AirPlay); no DTS or TrueHD.
      "audioCodecs": ["aac", "mp3", "alac", "flac", "ac3", "eac3", "eac3-joc"],
      "audioPassthrough": [String](),
      "maxDecodeHeight": maxDecodeHeight,
      "displayHeight": nativeHeight,
    ]
  }
}

#if os(tvOS)
@available(tvOS 17.0, *)
enum DisplayMatcher {
  static func window() -> UIWindow? {
    UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap { $0.windows }
      .first { $0.isKeyWindow } ?? UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first?.windows.first
  }

  /// Build a format description carrying the colour extensions AVDisplayCriteria reads (transfer function, primaries).
  static func formatDescription(range: String) -> CMFormatDescription? {
    var ext: [CFString: Any] = [:]
    var codec: CMVideoCodecType = kCMVideoCodecType_HEVC
    switch range {
    case "hdr10":
      ext[kCMFormatDescriptionExtension_TransferFunction] = kCMFormatDescriptionTransferFunction_SMPTE_ST_2084_PQ
      ext[kCMFormatDescriptionExtension_ColorPrimaries] = kCMFormatDescriptionColorPrimaries_ITU_R_2020
      ext[kCMFormatDescriptionExtension_YCbCrMatrix] = kCMFormatDescriptionYCbCrMatrix_ITU_R_2020
    case "hlg":
      ext[kCMFormatDescriptionExtension_TransferFunction] = kCMFormatDescriptionTransferFunction_ITU_R_2100_HLG
      ext[kCMFormatDescriptionExtension_ColorPrimaries] = kCMFormatDescriptionColorPrimaries_ITU_R_2020
      ext[kCMFormatDescriptionExtension_YCbCrMatrix] = kCMFormatDescriptionYCbCrMatrix_ITU_R_2020
    case "dolbyvision":
      codec = 0x6476_6831 // 'dvh1'
      ext[kCMFormatDescriptionExtension_TransferFunction] = kCMFormatDescriptionTransferFunction_SMPTE_ST_2084_PQ
      ext[kCMFormatDescriptionExtension_ColorPrimaries] = kCMFormatDescriptionColorPrimaries_ITU_R_2020
      ext[kCMFormatDescriptionExtension_YCbCrMatrix] = kCMFormatDescriptionYCbCrMatrix_ITU_R_2020
    default:
      codec = kCMVideoCodecType_H264
      ext[kCMFormatDescriptionExtension_TransferFunction] = kCMFormatDescriptionTransferFunction_ITU_R_709_2
      ext[kCMFormatDescriptionExtension_ColorPrimaries] = kCMFormatDescriptionColorPrimaries_ITU_R_709_2
      ext[kCMFormatDescriptionExtension_YCbCrMatrix] = kCMFormatDescriptionYCbCrMatrix_ITU_R_709_2
    }
    var desc: CMFormatDescription?
    let status = CMVideoFormatDescriptionCreate(
      allocator: kCFAllocatorDefault, codecType: codec, width: 3840, height: 2160,
      extensions: ext as CFDictionary, formatDescriptionOut: &desc)
    return status == noErr ? desc : nil
  }

  static func apply(frameRate: Double, range: String) -> Bool {
    guard let manager = window()?.avDisplayManager, manager.isDisplayCriteriaMatchingEnabled,
          let desc = formatDescription(range: range) else { return false }
    manager.preferredDisplayCriteria = AVDisplayCriteria(refreshRate: Float(frameRate), formatDescription: desc)
    return true
  }

  static func reset() {
    window()?.avDisplayManager.preferredDisplayCriteria = nil
  }
}
#endif
