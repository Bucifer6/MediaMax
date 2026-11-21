sub init()
    m.video = m.top.findNode("video")
    m.skipGroup = m.top.findNode("skipGroup")
    m.skipButton = m.top.findNode("skipButton")
    m.upNext = m.top.findNode("upNext")
    m.upNextTitle = m.top.findNode("upNextTitle")
    m.upNextCountdown = m.top.findNode("upNextCountdown")
    m.upNextButton = m.top.findNode("upNextButton")
    m.messageGroup = m.top.findNode("messageGroup")
    m.message = m.top.findNode("message")
    m.progressTimer = m.top.findNode("progressTimer")
    m.countdownTimer = m.top.findNode("countdownTimer")

    m.info = invalid
    m.sessionId = ""
    m.streamStartMs = 0
    m.durationMs = 0
    m.lastPositionMs = 0
    m.itemId = ""
    m.channelId = ""
    m.mediaId = ""
    m.audioIndex = invalid
    m.subtitleIndex = -1
    m.subtitleLang = ""
    m.burn = false
    m.retried = false
    m.stopped = false
    m.exited = false
    m.started = false
    m.lastReported = ""
    m.trackNames = {}
    m.skipMarker = invalid
    m.skipMarkerKey = ""
    m.autoSkipped = {}
    m.upNextShown = false
    m.upNextDismissed = false
    m.countdown = 0

    screenInit(m.video)
    m.video.notificationInterval = 1
    m.video.observeField("state", "onVideoState")
    m.video.observeField("position", "onPosition")
    m.skipButton.observeField("buttonSelected", "onSkipSelected")
    m.upNextButton.observeField("buttonSelected", "onUpNextSelected")
    m.progressTimer.observeField("fire", "onProgressTimer")
    m.countdownTimer.observeField("fire", "onCountdown")
    m.top.observeField("params", "onParams")
    m.top.observeField("closing", "onClosing")
end sub

sub onParams()
    p = m.top.params
    m.itemId = getOr(p, "itemId", "")
    m.channelId = getOr(p, "channelId", "")
    m.mediaId = getOr(p, "mediaId", "")
    m.audioIndex = getOr(p, "audioIndex", invalid)
    m.subtitleIndex = toInt(getOr(p, "subtitleIndex", -1), -1)
    m.burn = getOr(p, "burnSubtitles", false) = true
    requestPlayback(toInt(getOr(p, "startMs", 0)), false)
end sub

function isLive() as boolean
    return m.channelId <> ""
end function

' ------------------------------------------------------------------ start

sub requestPlayback(startMs as integer, forceTranscode as boolean)
    showStatus("Loading...")
    m.started = false
    m.lastReported = ""
    if isLive()
        body = { forceHls: true, deviceProfile: { containers: ["mp4", "m4v", "mov", "mkv"] } }
        apiCall("POST", "/livetv/channels/" + urlEncode(m.channelId) + "/play", body, "onPlaybackInfo", { startMs: 0 })
        return
    end if
    body = {
        startMs: startMs,
        deviceProfile: m.global.deviceProfile,
        subtitleFormats: ["vtt", "srt"],
        adaptive: true
    }
    if m.mediaId <> "" then body["mediaId"] = m.mediaId
    if m.audioIndex <> invalid then body["audioStreamIndex"] = m.audioIndex
    if m.burn and m.subtitleIndex >= 0
        body["subtitleStreamIndex"] = m.subtitleIndex
        body["burnSubtitles"] = true
    end if
    if forceTranscode then body["forceTranscode"] = true
    apiCall("POST", "/playback/" + urlEncode(m.itemId), body, "onPlaybackInfo", { startMs: startMs })
end sub

sub onPlaybackInfo(event as object)
    res = apiResult(event)
    if m.stopped then return
    if not res.ok
        fatal("Can't play this: " + res.error)
        return
    end if
    info = res.data
    m.info = info
    m.sessionId = getOr(info, "sessionId", "")
    m.streamStartMs = toInt(getOr(info, "streamStartMs", 0))
    m.durationMs = toInt(getOr(info, "durationMs", 0))
    m.skipMarker = invalid
    m.skipMarkerKey = ""
    m.upNextShown = false
    m.upNextDismissed = false

    content = CreateObject("roSGNode", "ContentNode")
    content.url = absUrl(info.url)
    content.streamFormat = streamFormatFor(info)
    content.title = getOr(info, "title", "")
    content.description = getOr(info, "subtitle", "")
    poster = imageUrl(getOr(info, "posterUrl", invalid), 300)
    if poster <> ""
        content.HDPosterUrl = poster
        content.FHDPosterUrl = poster
    end if
    if isLive()
        content.live = true
    else
        startMs = toInt(getOr(info, "startMs", 0))
        playStart = Int((startMs - m.streamStartMs) / 1000)
        if playStart > 0 then content.PlayStart = playStart
        m.lastPositionMs = startMs
    end if

    ' Text subtitles as side-loaded WebVTT (the server converts SRT / ASS / embedded text tracks).
    tracks = []
    m.trackNames = {}
    pickByLang = m.subtitleIndex = -2
    if pickByLang then m.subtitleIndex = -1
    for each t in getOr(info, "subtitles", [])
        if getOr(t, "isImage", false) <> true and isNonEmptyString(getOr(t, "url", ""))
            name = absUrl(t.url)
            lang = getOr(t, "language", "")
            if not isNonEmptyString(lang) then lang = "und"
            tracks.Push({ TrackName: name, Language: lang, Description: streamLabel(t, false) })
            m.trackNames[toInt(t.index).ToStr()] = name
            if pickByLang and m.subtitleIndex < 0 and lang = m.subtitleLang and getOr(t, "forced", false) <> true then m.subtitleIndex = t.index
        end if
    end for
    content.SubtitleTracks = tracks

    m.video.content = content
    applySubtitleSelection()
    m.video.control = "play"
    hideStatus()
    focusNode(m.video)
    m.progressTimer.control = "start"
end sub

function streamFormatFor(info as object) as string
    if getOr(info, "isHls", false) = true then return "hls"
    mime = LCase(getOr(info, "mimeType", ""))
    url = LCase(getOr(info, "url", ""))
    if Instr(1, mime, "mpegurl") > 0 or Instr(1, url, ".m3u8") > 0 then return "hls"
    if Instr(1, mime, "matroska") > 0 or Instr(1, mime, "webm") > 0 then return "mkv"
    if Instr(1, mime, "audio/mpeg") > 0 then return "mp3"
    if Instr(1, mime, "flac") > 0 then return "flac"
    if Instr(1, mime, "mp2t") > 0 then return "ts"
    return "mp4"
end function

sub applySubtitleSelection()
    key = ""
    if m.subtitleIndex <> invalid and m.subtitleIndex >= 0 then key = toInt(m.subtitleIndex).ToStr()
    if not m.burn and key <> "" and m.trackNames.DoesExist(key)
        m.video.subtitleTrack = m.trackNames[key]
        m.video.globalCaptionMode = "On"
        m.subtitleLang = languageOfTrack(m.subtitleIndex)
    else
        m.video.globalCaptionMode = "Off"
        if not m.burn then m.subtitleLang = ""
    end if
end sub

function languageOfTrack(index as dynamic) as string
    if m.info = invalid then return ""
    for each t in getOr(m.info, "subtitles", [])
        if t.index = index then return getOr(t, "language", "")
    end for
    return ""
end function

' ------------------------------------------------------------------ state & progress

function positionMs() as integer
    return Int(m.video.position * 1000) + m.streamStartMs
end function

sub onVideoState()
    state = m.video.state
    if state = "playing"
        if not m.started
            m.started = true
            applySubtitleSelection()
        end if
        if m.lastReported <> "playing" then report("playing")
    else if state = "paused"
        report("paused")
    else if state = "finished"
        onFinished()
    else if state = "error"
        onVideoError()
    end if
end sub

sub onPosition()
    if m.info = invalid or isLive() then return
    p = positionMs()
    if p > 0 then m.lastPositionMs = p
    updateMarkers(p)
    updateUpNext(p)
end sub

sub onProgressTimer()
    state = m.video.state
    if state = "paused"
        report("paused")
    else if state = "playing" or state = "buffering"
        report("playing")
    end if
end sub

' POST /playback/sessions/:id/progress. audioIndex / subtitleIndex are informational (the server ignores fields it doesn't know).
sub report(state as string)
    if m.sessionId = "" or m.stopped then return
    m.lastReported = state
    body = { positionMs: m.lastPositionMs, state: state, sessionId: m.sessionId, subtitleIndex: m.subtitleIndex }
    if m.durationMs > 0 then body["durationMs"] = m.durationMs
    if m.audioIndex <> invalid then body["audioIndex"] = m.audioIndex
    if isLive() then body["positionMs"] = 0
    apiCall("POST", "/playback/sessions/" + urlEncode(m.sessionId) + "/progress", body, "onProgressAck", { sessionId: m.sessionId })
end sub

' { ok: false } means the server no longer knows the session: an admin stopped it, or it was replaced / reaped.
sub onProgressAck(event as object)
    res = apiResult(event)
    if m.stopped or res.context = invalid or res.context.sessionId <> m.sessionId then return
    if res.ok and res.data <> invalid and res.data.ok = false
        m.sessionId = ""
        fatal("Playback was stopped by the server.")
    else if res.status = 401
        m.sessionId = ""
        fatal("You've been signed out.")
    end if
end sub

' Final "stopped" report, then DELETE the session (kills any transcode). Sent through the scene so it outlives this screen.
sub stopSession()
    if m.sessionId = "" then return
    id = urlEncode(m.sessionId)
    body = { positionMs: m.lastPositionMs, state: "stopped", sessionId: m.sessionId }
    if isLive() then body["positionMs"] = 0
    if m.durationMs > 0 then body["durationMs"] = m.durationMs
    m.scene.backgroundRequest = {
        method: "POST", path: "/playback/sessions/" + id + "/progress", body: body,
        followUp: { method: "DELETE", path: "/playback/sessions/" + id, body: {} }
    }
    m.sessionId = ""
end sub

sub cleanup()
    m.progressTimer.control = "stop"
    m.countdownTimer.control = "stop"
    m.video.control = "stop"
    stopSession()
    apiCancelAll()
end sub

sub stopAndExit()
    if not m.stopped
        m.stopped = true
        cleanup()
    end if
    goBack()
end sub

sub onClosing()
    if not m.stopped
        m.stopped = true
        cleanup()
    end if
end sub

sub onFinished()
    m.progressTimer.control = "stop"
    if m.durationMs > 0 then m.lastPositionMs = m.durationMs
    if not isLive() and m.info <> invalid and isNonEmptyString(getOr(m.info, "nextItemId", invalid)) and m.global.settings.autoplayNext = true and not m.upNextDismissed
        playNext()
    else
        stopAndExit()
    end if
end sub

' One retry: direct play / remux the Roku couldn't handle → force a transcode at the same position.
sub onVideoError()
    errorText = m.video.errorMsg
    if not m.retried
        m.retried = true
        resumeAt = m.lastPositionMs
        m.video.control = "stop"
        stopSession()
        showToast("Switching to a compatible stream...")
        requestPlayback(resumeAt, not isLive())
        return
    end if
    fatal("Playback failed: " + errorText)
end sub

sub fatal(text as string)
    if m.stopped then return
    m.stopped = true
    cleanup()
    hideStatus()
    dlg = CreateObject("roSGNode", "StandardMessageDialog")
    dlg.title = "Playback"
    dlg.message = [text]
    dlg.buttons = ["OK"]
    dlg.observeField("buttonSelected", "onFatalClosed")
    dlg.observeField("wasClosed", "onFatalClosed")
    m.scene.dialog = dlg
end sub

sub onFatalClosed()
    if m.scene.dialog <> invalid then m.scene.dialog.close = true
    if not m.exited
        m.exited = true
        goBack()
    end if
end sub

sub showStatus(text as string)
    m.message.text = text
    m.messageGroup.visible = true
end sub

sub hideStatus()
    m.messageGroup.visible = false
end sub

' ------------------------------------------------------------------ markers (skip intro / recap / credits)

sub updateMarkers(p as integer)
    active = invalid
    for each mk in getOr(m.info, "markers", [])
        if p >= mk.startMs and p < mk.endMs - 500
            active = mk
            exit for
        end if
    end for
    if active = invalid
        hideSkip()
        m.skipMarkerKey = ""
        return
    end if
    key = active.type + toInt(active.startMs).ToStr()
    hasNext = isNonEmptyString(getOr(m.info, "nextItemId", invalid))
    if active.type = "credits" and hasNext
        showUpNext()
        return
    end if
    prefs = getOr(m.global.user, "preferences", {})
    if active.type = "intro" and getOr(prefs, "skipIntros", false) = true and not m.autoSkipped.DoesExist(key)
        m.autoSkipped[key] = true
        seekToMs(active.endMs)
        showToast("Skipped intro")
        return
    end if
    if m.skipMarkerKey = key then return
    m.skipMarkerKey = key
    m.skipMarker = active
    label = "Skip"
    if active.type = "intro"
        label = "Skip Intro"
    else if active.type = "recap"
        label = "Skip Recap"
    else if active.type = "credits"
        label = "Skip Credits"
    else if active.type = "preview"
        label = "Skip Preview"
    else if active.type = "commercial"
        label = "Skip Ad"
    end if
    m.skipButton.text = label
    m.skipGroup.visible = true
    focusNode(m.skipButton)
end sub

sub hideSkip()
    if not m.skipGroup.visible then return
    m.skipGroup.visible = false
    if m.skipButton.hasFocus() then focusNode(m.video)
end sub

sub onSkipSelected()
    if m.skipMarker = invalid then return
    target = m.skipMarker.endMs
    hideSkip()
    seekToMs(target)
end sub

sub seekToMs(ms as integer)
    m.video.seek = (ms - m.streamStartMs) / 1000
end sub

' ------------------------------------------------------------------ up next / autoplay

sub updateUpNext(p as integer)
    if not isNonEmptyString(getOr(m.info, "nextItemId", invalid)) then return
    hasCredits = false
    for each mk in getOr(m.info, "markers", [])
        if mk.type = "credits" then hasCredits = true
    end for
    nearEnd = not hasCredits and m.durationMs > 0 and m.durationMs - p <= 25000 and p > 0
    if nearEnd
        showUpNext()
    else if m.upNextShown and not hasCredits
        hideUpNext()
    end if
end sub

sub showUpNext()
    if m.upNextShown or m.upNextDismissed then return
    m.upNextShown = true
    hideSkip()
    m.upNextTitle.text = "Next episode"
    apiCall("GET", "/items/" + urlEncode(m.info.nextItemId), invalid, "onNextItem")
    if m.global.settings.autoplayNext = true
        m.countdown = 15
        m.upNextCountdown.text = "Playing in 15 s   (Back to keep watching)"
        m.countdownTimer.control = "start"
    else
        m.upNextCountdown.text = "Back to keep watching"
    end if
    m.upNext.visible = true
    focusNode(m.upNextButton)
end sub

sub onNextItem(event as object)
    res = apiResult(event)
    if not res.ok or res.data = invalid then return
    m.upNextTitle.text = joinNonEmpty([episodeLabel(res.data), getOr(res.data, "title", "")], " · ")
end sub

sub hideUpNext()
    m.countdownTimer.control = "stop"
    m.upNext.visible = false
    m.upNextShown = false
    if m.upNextButton.hasFocus() then focusNode(m.video)
end sub

sub onCountdown()
    m.countdown = m.countdown - 1
    if m.countdown <= 0
        m.countdownTimer.control = "stop"
        playNext()
        return
    end if
    m.upNextCountdown.text = "Playing in " + m.countdown.ToStr() + " s   (Back to keep watching)"
end sub

sub onUpNextSelected()
    playNext()
end sub

sub playNext()
    if m.info = invalid then return
    nextId = getOr(m.info, "nextItemId", "")
    if nextId = "" then return
    m.countdownTimer.control = "stop"
    m.progressTimer.control = "stop"
    m.upNext.visible = false
    hideSkip()
    m.video.control = "stop"
    stopSession()
    m.itemId = nextId
    m.mediaId = ""
    m.audioIndex = invalid
    ' Keep the subtitle language, matched against the next episode's tracks.
    if m.subtitleLang <> "" and not m.burn then m.subtitleIndex = -2 else m.subtitleIndex = -1
    m.burn = false
    m.retried = false
    m.autoSkipped = {}
    requestPlayback(0, false)
end sub

' ------------------------------------------------------------------ in-player track menu (* key)

sub showTrackMenu()
    if m.info = invalid or isLive() then return
    m.menuActions = []
    labels = []
    if getOr(m.info, "subtitles", []).Count() > 0 or getOr(m.info, "burnInSubtitles", []).Count() > 0
        labels.Push("Subtitles")
        m.menuActions.Push("subtitles")
    end if
    if getOr(m.info, "audioStreams", []).Count() > 1
        labels.Push("Audio")
        m.menuActions.Push("audio")
    end if
    if labels.Count() = 0
        showToast("No other audio or subtitle tracks")
        return
    end if
    showChoiceDialog("Playback options", labels, "onTrackMenu")
end sub

sub onTrackMenu(event as object)
    i = event.getData()
    closeDialog()
    if i < 0 or i >= m.menuActions.Count() then return
    if m.menuActions[i] = "subtitles"
        m.subChoices = [invalid]
        labels = ["Off"]
        for each t in getOr(m.info, "subtitles", [])
            if getOr(t, "isImage", false) <> true
                m.subChoices.Push({ index: t.index, burn: false })
                labels.Push(streamLabel(t, false))
            end if
        end for
        for each t in getOr(m.info, "burnInSubtitles", [])
            m.subChoices.Push({ index: t.index, burn: true })
            labels.Push(streamLabel(t, false) + " (burned in)")
        end for
        showChoiceDialog("Subtitles", labels, "onSubtitleChoice")
    else
        m.audioChoices = getOr(m.info, "audioStreams", [])
        labels = []
        for each a in m.audioChoices
            labels.Push(streamLabel(a, true))
        end for
        showChoiceDialog("Audio", labels, "onAudioChoice")
    end if
end sub

sub onSubtitleChoice(event as object)
    i = event.getData()
    closeDialog()
    if i < 0 or i >= m.subChoices.Count() then return
    choice = m.subChoices[i]
    wasBurned = m.burn
    if choice = invalid
        m.subtitleIndex = -1
        m.burn = false
    else
        m.subtitleIndex = choice.index
        m.burn = choice.burn
    end if
    if m.burn or wasBurned
        ' Burned-in subtitles change the video itself: restart the stream at the current position.
        restartAtCurrentPosition()
    else
        applySubtitleSelection()
        report("playing")
    end if
end sub

sub onAudioChoice(event as object)
    i = event.getData()
    closeDialog()
    if i < 0 or i >= m.audioChoices.Count() then return
    m.audioIndex = m.audioChoices[i].index
    restartAtCurrentPosition()
end sub

sub restartAtCurrentPosition()
    resumeAt = m.lastPositionMs
    m.progressTimer.control = "stop"
    m.video.control = "stop"
    stopSession()
    m.retried = false
    requestPlayback(resumeAt, false)
end sub

' ------------------------------------------------------------------ keys

function onKeyEvent(key as string, press as boolean) as boolean
    if not press then return false
    if key = "back"
        if m.upNext.visible
            m.upNextDismissed = true
            hideUpNext()
            return true
        end if
        stopAndExit()
        return true
    else if key = "options"
        showTrackMenu()
        return true
    else if key = "play" and not m.video.hasFocus()
        if m.video.state = "playing" then m.video.control = "pause" else m.video.control = "resume"
        return true
    else if (key = "left" or key = "right" or key = "fastforward" or key = "rewind" or key = "down") and not m.video.hasFocus()
        ' Hand the remote back to the video's own trick-play UI.
        focusNode(m.video)
        return true
    else if key = "up" and m.video.hasFocus()
        if m.skipGroup.visible
            focusNode(m.skipButton)
            return true
        else if m.upNext.visible
            focusNode(m.upNextButton)
            return true
        end if
    end if
    return false
end function
