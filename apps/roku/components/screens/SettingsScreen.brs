sub init()
    m.list = m.top.findNode("list")
    m.about = m.top.findNode("about")
    m.bitrates = [0, 40000, 20000, 12000, 8000, 4000, 2000]
    m.bitrateLabels = ["Original (no limit)", "40 Mbps (4K)", "20 Mbps (1080p high)", "12 Mbps (1080p)", "8 Mbps (1080p low)", "4 Mbps (720p)", "2 Mbps (480p)"]
    m.subModes = ["off", "auto", "always"]
    m.subLabels = ["Off", "Forced only", "Always"]
    screenInit(m.list)
    m.list.observeField("itemSelected", "onSelected")
    build()
    renderAbout()
end sub

function indexOf(list as object, value as dynamic) as integer
    for i = 0 to list.Count() - 1
        if list[i] = value then return i
    end for
    return 0
end function

sub build()
    s = m.global.settings
    m.actions = ["bitrate", "subtitles", "autoplay"]
    labels = [
        "Max streaming quality: " + m.bitrateLabels[indexOf(m.bitrates, s.maxBitrate)],
        "Subtitles by default: " + m.subLabels[indexOf(m.subModes, s.subtitleMode)],
        "Autoplay next episode: " + onOff(s.autoplayNext)
    ]
    user = m.global.user
    if toInt(getOr(user, "profileCount", 0)) > 0 or isNonEmptyString(getOr(user, "parentUserId", invalid))
        m.actions.Push("profile")
        labels.Push("Switch profile")
    end if
    m.actions.Push("server")
    labels.Push("Change server")
    m.actions.Push("signout")
    labels.Push("Sign out")
    root = CreateObject("roSGNode", "ContentNode")
    for each l in labels
        n = root.createChild("ContentNode")
        n.title = l
    end for
    focused = m.list.itemFocused
    m.list.content = root
    if focused > 0 then m.list.jumpToItem = focused
end sub

function onOff(v as boolean) as string
    if v then return "On"
    return "Off"
end function

sub renderAbout()
    p = m.global.deviceProfile
    di = CreateObject("roDeviceInfo")
    hdr = []
    vr = getOr(p, "videoRange", {})
    if getOr(vr, "dolbyVision", false) = true then hdr.Push("Dolby Vision")
    if getOr(vr, "hdr10Plus", false) = true then hdr.Push("HDR10+")
    if getOr(vr, "hdr10", false) = true then hdr.Push("HDR10")
    if getOr(vr, "hlg", false) = true then hdr.Push("HLG")
    if hdr.Count() = 0 then hdr.Push("SDR")
    lines = [
        "Server: " + m.global.serverName,
        m.global.serverUrl,
        "Signed in as: " + getOr(m.global.user, "displayName", ""),
        "",
        "Device: " + m.global.deviceName + " (" + di.GetModelDisplayName() + ", " + di.GetModel() + ")",
        "Kinora for Roku " + m.global.appVersion,
        "",
        "Plays: " + UCase(p.videoCodecs.Join(", ")) + " up to " + toInt(p.maxHeight).ToStr() + "p",
        "Dynamic range: " + hdr.Join(", "),
        "Audio: " + UCase(p.audioCodecs.Join(", ")),
        "Passthrough: " + passthroughText(p),
        "Speakers: " + toInt(p.maxAudioChannels).ToStr() + " channels"
    ]
    m.about.text = lines.Join(Chr(10))
end sub

function passthroughText(p as object) as string
    list = getOr(p, "audioPassthrough", [])
    if list.Count() = 0 then return "none"
    return UCase(list.Join(", "))
end function

sub onSelected()
    action = m.actions[m.list.itemSelected]
    if action = "bitrate"
        showChoiceDialog("Max streaming quality", m.bitrateLabels, "onBitrate")
    else if action = "subtitles"
        showChoiceDialog("Subtitles by default", m.subLabels, "onSubMode")
    else if action = "autoplay"
        s = m.global.settings
        s.autoplayNext = not s.autoplayNext
        saveSettings(s)
    else if action = "profile"
        navigate("ProfileScreen")
    else if action = "server"
        m.scene.resetTo = { screen: "ServerScreen", params: {} }
    else if action = "signout"
        showChoiceDialog("Sign out of " + m.global.serverName + "?", ["Sign out", "Cancel"], "onSignOutConfirm")
    end if
end sub

sub onBitrate(event as object)
    i = event.getData()
    closeDialog()
    if i < 0 or i >= m.bitrates.Count() then return
    s = m.global.settings
    s.maxBitrate = m.bitrates[i]
    saveSettings(s)
end sub

sub onSubMode(event as object)
    i = event.getData()
    closeDialog()
    if i < 0 or i >= m.subModes.Count() then return
    s = m.global.settings
    s.subtitleMode = m.subModes[i]
    saveSettings(s)
end sub

sub saveSettings(s as object)
    regWrite("maxBitrate", toInt(s.maxBitrate).ToStr())
    regWrite("subtitleMode", s.subtitleMode)
    if s.autoplayNext then regWrite("autoplayNext", "true") else regWrite("autoplayNext", "false")
    ' Node fields hold copies: write the whole AA back, and rebuild the profile for the new bitrate cap.
    m.global.settings = s
    m.global.deviceProfile = buildDeviceProfile(s)
    build()
end sub

sub onSignOutConfirm(event as object)
    i = event.getData()
    closeDialog()
    if i <> 0 then return
    ' Revoke the token on the server (best effort), then forget it locally.
    m.scene.backgroundRequest = { method: "POST", path: "/auth/logout", body: {} }
    m.scene.signedOut = true
end sub
