' Builds the MediaMax DeviceProfile (shared/src/types.ts) from what this Roku can actually decode, at runtime.
' Codec names follow ffprobe / the server's decide() (h264, hevc, vp9, av1, aac, ac3, eac3 …).

function canDecodeVideo(di as object, query as object) as boolean
    r = di.CanDecodeVideo(query)
    return r <> invalid and r.result = true
end function

function canDecodeAudio(di as object, query as object) as boolean
    r = di.CanDecodeAudio(query)
    return r <> invalid and r.result = true
end function

function buildDeviceProfile(settings as object) as object
    di = CreateObject("roDeviceInfo")

    ' ---- video
    video = ["h264"]
    tenBit = []
    if canDecodeVideo(di, { Codec: "hevc" })
        video.Push("hevc")
        if canDecodeVideo(di, { Codec: "hevc", Profile: "main 10" }) then tenBit.Push("hevc")
    end if
    if canDecodeVideo(di, { Codec: "vp9" })
        video.Push("vp9")
        if canDecodeVideo(di, { Codec: "vp9", Profile: "profile 2" }) then tenBit.Push("vp9")
    end if
    if canDecodeVideo(di, { Codec: "av1" })
        video.Push("av1")
        tenBit.Push("av1")
    end if
    if canDecodeVideo(di, { Codec: "mpeg2" }) then video.Push("mpeg2video")

    ' ---- display: output mode decides the largest useful frame; HDR formats from the connected TV.
    mode = di.GetVideoMode()
    maxHeight = 1080
    maxWidth = 1920
    if Instr(1, mode, "2160") > 0
        maxHeight = 2160
        maxWidth = 3840
    else if Instr(1, mode, "720") > 0
        maxHeight = 720
        maxWidth = 1280
    else if Instr(1, mode, "480") > 0 or Instr(1, mode, "576") > 0
        maxHeight = 576
        maxWidth = 1024
    end if
    dp = di.GetDisplayProperties()
    hdr10 = getOr(dp, "Hdr10", false) = true
    hdr10Plus = getOr(dp, "Hdr10Plus", false) = true
    hlg = getOr(dp, "HLG", false) = true
    dv = getOr(dp, "DolbyVision", false) = true
    ' HDR needs a 10-bit HEVC (or VP9 / AV1) decoder as well as an HDR display.
    hdrDecoder = tenBit.Count() > 0
    videoRange = {
        hdr10: hdr10 and hdrDecoder,
        hdr10Plus: hdr10Plus and hdrDecoder,
        hlg: hlg and hdrDecoder,
        dolbyVision: dv and hdrDecoder,
        hdrDisplay: hdr10 or hdr10Plus or hlg or dv
    }
    ' Roku plays single-layer Dolby Vision (profiles 5 and 8); dual-layer profile 7 is stripped to HDR10 by the server.
    if dv and hdrDecoder then videoRange["dolbyVisionProfiles"] = ["5", "8.1", "8.4"]

    ' ---- audio: decoded on the Roku, or bitstreamed to the TV / receiver over HDMI.
    audio = ["aac", "mp3"]
    decodable = [
        ["ac3", ["ac3"]],
        ["eac3", ["eac3"]],
        ["flac", ["flac"]],
        ["alac", ["alac"]],
        ["opus", ["opus"]],
        ["vorbis", ["vorbis"]],
        ["mp2", ["mp2"]],
        ["lpcm", ["pcm_s16le", "pcm_s24le"]]
    ]
    for each entry in decodable
        if canDecodeAudio(di, { Codec: entry[0] })
            for each name in entry[1]
                audio.Push(name)
            end for
        end if
    end for
    passthrough = []
    for each codec in ["ac3", "eac3", "dts"]
        if canDecodeAudio(di, { Codec: codec, PassThru: 1 }) then passthrough.Push(codec)
    end for

    channelsOut = LCase(di.GetAudioOutputChannel())
    maxChannels = 2
    if Instr(1, channelsOut, "7.1") > 0
        maxChannels = 8
    else if Instr(1, channelsOut, "5.1") > 0 or Instr(1, channelsOut, "surround") > 0
        maxChannels = 6
    end if
    multichannel = []
    for each codec in passthrough
        multichannel.Push(codec)
    end for
    if maxChannels > 2 and canDecodeAudio(di, { Codec: "aac", ChCnt: 6 }) then multichannel.Push("aac")

    maxBitrate = invalid
    if settings <> invalid and toInt(getOr(settings, "maxBitrate", 0)) > 0 then maxBitrate = settings.maxBitrate

    return {
        maxBitrate: maxBitrate,
        maxWidth: maxWidth,
        maxHeight: maxHeight,
        videoCodecs: video,
        tenBitCodecs: tenBit,
        audioCodecs: audio,
        audioPassthrough: passthrough,
        maxAudioChannels: maxChannels,
        multichannelAudioCodecs: multichannel,
        ' Progressive MP4 / MOV and (limited) MKV; anything else is remuxed to HLS by the server.
        containers: ["mp4", "m4v", "mov", "mkv", "mp3", "m4a", "aac", "flac"],
        supportsHls: true,
        ' The Video node can't reliably switch embedded audio tracks: a non-default track is remuxed server-side.
        canSelectAudioTrack: false,
        videoRange: videoRange,
        player: "roku"
    }
end function
