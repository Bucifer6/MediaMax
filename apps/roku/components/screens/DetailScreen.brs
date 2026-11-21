sub init()
    m.backdrop = m.top.findNode("backdrop")
    m.leafLayout = m.top.findNode("leafLayout")
    m.showLayout = m.top.findNode("showLayout")
    m.buttons = m.top.findNode("buttons")
    m.showButtons = m.top.findNode("showButtons")
    m.seasons = m.top.findNode("seasons")
    m.episodes = m.top.findNode("episodes")
    m.error = m.top.findNode("error")
    m.item = invalid
    m.actions = []
    m.showActions = []
    m.seasonItems = []
    m.episodeItems = []
    m.nextUp = invalid
    m.audioIndex = invalid
    m.subtitleIndex = -1
    m.preselectSeasonId = ""
    m.seasonGeneration = 0
    m.currentSeason = -1

    screenInit(m.buttons)
    m.buttons.observeField("buttonSelected", "onButton")
    m.showButtons.observeField("buttonSelected", "onShowButton")
    m.seasons.observeField("itemFocused", "onSeasonFocused")
    m.seasons.observeField("itemSelected", "onSeasonSelected")
    m.episodes.observeField("itemSelected", "onEpisodeSelected")
    m.top.observeField("params", "onParams")
    m.top.observeField("resumed", "onResumed")
end sub

sub onParams()
    loadItem(m.top.params.itemId)
end sub

' Back from the player (or an episode): refresh resume points and watched state.
sub onResumed()
    if m.item <> invalid then loadItem(m.item.id)
end sub

sub loadItem(id as string)
    if m.item = invalid then setLoading(true)
    apiCall("GET", "/items/" + urlEncode(id), invalid, "onItem")
end sub

sub onItem(event as object)
    res = apiResult(event)
    setLoading(false)
    if not res.ok
        m.error.text = "Couldn't load this title: " + res.error
        return
    end if
    item = res.data
    ' A season opens its show with that season selected.
    if item.type = "season" and isNonEmptyString(item.parentId)
        m.preselectSeasonId = item.id
        loadItem(item.parentId)
        return
    end if
    firstLoad = m.item = invalid or m.item.id <> item.id
    m.item = item
    bd = imageUrl(getOr(item, "backdropUrl", invalid), 1280)
    if bd <> "" then m.backdrop.uri = bd
    if item.type = "show"
        renderShow(firstLoad)
    else
        if firstLoad then chooseDefaultTracks()
        renderLeaf()
    end if
end sub

' ------------------------------------------------------------------ movie / episode / video

function primaryMedia() as dynamic
    media = getOr(m.item, "media", [])
    if type(media) = "roArray" and media.Count() > 0 then return media[0]
    return invalid
end function

' Defaults: the server's audio language preference / default track; subtitles from the channel setting.
sub chooseDefaultTracks()
    m.audioIndex = invalid
    m.subtitleIndex = -1
    media = primaryMedia()
    if media = invalid then return
    prefs = getOr(m.global.user, "preferences", {})
    audioLang = getOr(prefs, "audioLanguage", "")
    for each a in getOr(media, "audioStreams", [])
        if m.audioIndex = invalid and getOr(a, "default", false) = true then m.audioIndex = a.index
    end for
    if isNonEmptyString(audioLang)
        for each a in getOr(media, "audioStreams", [])
            if getOr(a, "language", "") = audioLang
                m.audioIndex = a.index
                exit for
            end if
        end for
    end if
    mode = m.global.settings.subtitleMode
    subLang = getOr(prefs, "subtitleLanguage", "")
    subs = getOr(media, "subtitleStreams", [])
    if mode = "off" or subs.Count() = 0 then return
    if mode = "always"
        for each s in subs
            if isNonEmptyString(subLang) and getOr(s, "language", "") = subLang
                m.subtitleIndex = s.index
                return
            end if
        end for
        m.subtitleIndex = subs[0].index
    else
        ' auto: forced tracks only (signs / foreign dialogue).
        for each s in subs
            if getOr(s, "forced", false) = true
                m.subtitleIndex = s.index
                return
            end if
        end for
    end if
end sub

function findStream(list as dynamic, index as dynamic) as dynamic
    if list = invalid or index = invalid then return invalid
    for each s in list
        if s.index = index then return s
    end for
    return invalid
end function

sub renderLeaf()
    item = m.item
    m.showLayout.visible = false
    m.leafLayout.visible = true
    poster = imageUrl(getOr(item, "posterUrl", invalid), 400)
    if item.type = "episode"
        thumb = imageUrl(getOr(item, "thumbUrl", invalid), 400)
        if thumb <> "" then poster = thumb
    end if
    m.top.findNode("poster").uri = poster
    m.top.findNode("title").text = item.title
    sub2 = ""
    if item.type = "episode" then sub2 = joinNonEmpty([getOr(item, "grandparentTitle", ""), episodeLabel(item)], "  ·  ")
    if sub2 = "" then sub2 = getOr(item, "tagline", "")
    m.top.findNode("subtitle").text = sub2
    content = itemToContent(item, false)
    m.top.findNode("meta").text = content.meta
    m.top.findNode("overview").text = getOr(item, "overview", "")

    media = primaryMedia()
    tech = []
    if media <> invalid
        tech.Push(getOr(media, "resolutionLabel", ""))
        if getOr(media, "hdr", false) = true then tech.Push("HDR")
        tech.Push(UCase(getOr(media, "videoCodec", "")))
        a = findStream(getOr(media, "audioStreams", []), m.audioIndex)
        if a <> invalid then tech.Push(streamLabel(a, true))
        tech.Push(getOr(media, "edition", ""))
    end if
    m.top.findNode("tech").text = joinNonEmpty(tech, "  ·  ")

    people = []
    for each p in getOr(item, "people", [])
        if people.Count() < 6 and p.kind = "actor" then people.Push(p.name)
    end for
    if people.Count() > 0 then m.top.findNode("people").text = "Starring " + people.Join(", ") else m.top.findNode("people").text = ""

    ud = getOr(item, "userData", {})
    resumeMs = toInt(getOr(ud, "positionMs", 0))
    labels = []
    m.actions = []
    if media = invalid
        m.error.text = "This title has no playable media."
    else
        if resumeMs > 30000
            labels.Push("Resume from " + msToClock(resumeMs))
            m.actions.Push("resume")
            labels.Push("Play from start")
            m.actions.Push("start")
        else
            labels.Push("Play")
            m.actions.Push("start")
        end if
        audios = getOr(media, "audioStreams", [])
        if audios.Count() > 1
            a = findStream(audios, m.audioIndex)
            label = "Default"
            if a <> invalid then label = streamLabel(a, true)
            labels.Push("Audio: " + label)
            m.actions.Push("audio")
        end if
        subs = getOr(media, "subtitleStreams", [])
        if subs.Count() > 0
            s = findStream(subs, m.subtitleIndex)
            label = "Off"
            if s <> invalid then label = streamLabel(s, false)
            labels.Push("Subtitles: " + label)
            m.actions.Push("subtitles")
        end if
    end if
    if getOr(ud, "played", false) = true then labels.Push("Mark as unwatched") else labels.Push("Mark as watched")
    m.actions.Push("played")
    if item.type <> "episode"
        if getOr(ud, "inWatchlist", false) = true then labels.Push("Remove from My List") else labels.Push("Add to My List")
        m.actions.Push("watchlist")
    end if
    if item.type = "episode" and isNonEmptyString(getOr(item, "grandparentId", invalid))
        labels.Push("Go to show")
        m.actions.Push("show")
    end if
    previous = m.buttons.buttonFocused
    m.buttons.buttons = labels
    if previous > 0 and previous < labels.Count() then m.buttons.focusButton = previous
    m.defaultFocus = m.buttons
    if m.lastFocus = invalid or not m.lastFocus.isSameNode(m.buttons) then focusNode(m.buttons)
end sub

sub onButton()
    action = m.actions[m.buttons.buttonSelected]
    ud = getOr(m.item, "userData", {})
    if action = "resume"
        play(toInt(getOr(ud, "positionMs", 0)))
    else if action = "start"
        play(0)
    else if action = "audio"
        chooseAudio()
    else if action = "subtitles"
        chooseSubtitles()
    else if action = "played"
        toggle("played", getOr(ud, "played", false) = true)
    else if action = "watchlist"
        toggle("watchlist", getOr(ud, "inWatchlist", false) = true)
    else if action = "show"
        navigate("DetailScreen", { itemId: m.item.grandparentId })
    end if
end sub

sub play(startMs as integer)
    media = primaryMedia()
    params = { itemId: m.item.id, startMs: startMs, mediaId: getOr(media, "id", "") }
    if m.audioIndex <> invalid then params["audioIndex"] = m.audioIndex
    params["subtitleIndex"] = m.subtitleIndex
    s = findStream(getOr(media, "subtitleStreams", []), m.subtitleIndex)
    params["burnSubtitles"] = s <> invalid and isImageSubtitle(s)
    navigate("PlayerScreen", params)
end sub

function isImageSubtitle(s as object) as boolean
    codec = LCase(getOr(s, "codec", ""))
    return codec = "hdmv_pgs_subtitle" or codec = "pgssub" or codec = "dvd_subtitle" or codec = "dvb_subtitle" or codec = "dvb_teletext" or codec = "xsub"
end function

sub chooseAudio()
    media = primaryMedia()
    m.choiceStreams = getOr(media, "audioStreams", [])
    labels = []
    for each a in m.choiceStreams
        labels.Push(streamLabel(a, true))
    end for
    showChoiceDialog("Audio", labels, "onAudioChosen")
end sub

sub onAudioChosen(event as object)
    i = event.getData()
    closeDialog()
    if i >= 0 and i < m.choiceStreams.Count() then m.audioIndex = m.choiceStreams[i].index
    renderLeaf()
end sub

sub chooseSubtitles()
    media = primaryMedia()
    m.choiceStreams = getOr(media, "subtitleStreams", [])
    labels = ["Off"]
    for each s in m.choiceStreams
        labels.Push(streamLabel(s, false))
    end for
    showChoiceDialog("Subtitles", labels, "onSubtitleChosen")
end sub

sub onSubtitleChosen(event as object)
    i = event.getData()
    closeDialog()
    if i = 0
        m.subtitleIndex = -1
    else if i > 0 and i <= m.choiceStreams.Count()
        m.subtitleIndex = m.choiceStreams[i - 1].index
    end if
    renderLeaf()
end sub

' POST / DELETE /items/:id/{played|watchlist}
sub toggle(what as string, isOn as boolean)
    method = "POST"
    if isOn then method = "DELETE"
    apiCall(method, "/items/" + urlEncode(m.item.id) + "/" + what, invalid, "onToggled", { what: what })
end sub

sub onToggled(event as object)
    res = apiResult(event)
    if not res.ok
        showToast(res.error)
        return
    end if
    if res.data <> invalid then m.item.userData = res.data
    if m.item.type = "show" then loadItem(m.item.id) else renderLeaf()
end sub

' ------------------------------------------------------------------ show

sub renderShow(firstLoad as boolean)
    item = m.item
    m.leafLayout.visible = false
    m.showLayout.visible = true
    m.defaultFocus = m.showButtons
    m.top.findNode("showTitle").text = item.title
    m.top.findNode("showMeta").text = itemToContent(item, false).meta
    m.top.findNode("showOverview").text = getOr(item, "overview", "")
    m.showActions = []
    m.nextUp = invalid
    updateShowButtons()
    apiCall("GET", "/items/" + urlEncode(item.id) + "/next", invalid, "onNextUp")
    apiCall("GET", "/items/" + urlEncode(item.id) + "/children" + apiQuery([["sort", "index"], ["limit", 200]]), invalid, "onSeasons", { first: firstLoad })
end sub

sub updateShowButtons()
    labels = []
    m.showActions = []
    if m.nextUp <> invalid
        ud = getOr(m.nextUp, "userData", {})
        verb = "Play"
        if toInt(getOr(ud, "positionMs", 0)) > 30000 then verb = "Resume"
        labels.Push(verb + " " + joinNonEmpty([episodeLabel(m.nextUp), m.nextUp.title], " · "))
        m.showActions.Push("next")
    end if
    ud = getOr(m.item, "userData", {})
    if getOr(ud, "played", false) = true then labels.Push("Mark show as unwatched") else labels.Push("Mark show as watched")
    m.showActions.Push("played")
    if getOr(ud, "inWatchlist", false) = true then labels.Push("Remove from My List") else labels.Push("Add to My List")
    m.showActions.Push("watchlist")
    m.showButtons.buttons = labels
end sub

sub onNextUp(event as object)
    res = apiResult(event)
    if res.ok and res.data <> invalid and GetInterface(res.data, "ifAssociativeArray") <> invalid and isNonEmptyString(res.data.id)
        m.nextUp = res.data
    end if
    updateShowButtons()
    if m.lastFocus = invalid then focusNode(m.showButtons)
end sub

sub onShowButton()
    action = m.showActions[m.showButtons.buttonSelected]
    ud = getOr(m.item, "userData", {})
    if action = "next"
        nud = getOr(m.nextUp, "userData", {})
        navigate("PlayerScreen", { itemId: m.nextUp.id, startMs: toInt(getOr(nud, "positionMs", 0)) })
    else if action = "played"
        toggle("played", getOr(ud, "played", false) = true)
    else if action = "watchlist"
        toggle("watchlist", getOr(ud, "inWatchlist", false) = true)
    end if
end sub

sub onSeasons(event as object)
    res = apiResult(event)
    if not res.ok then return
    m.seasonItems = getOr(res.data, "items", [])
    root = CreateObject("roSGNode", "ContentNode")
    selectIndex = 0
    ' Default to the season of the next-up episode, else a preselected season, else the first.
    for i = 0 to m.seasonItems.Count() - 1
        s = m.seasonItems[i]
        n = root.createChild("ContentNode")
        label = s.title
        unplayed = toInt(getOr(getOr(s, "userData", {}), "unplayedCount", 0))
        if unplayed > 0 then label = label + "  (" + unplayed.ToStr() + ")"
        n.title = label
        if s.id = m.preselectSeasonId then selectIndex = i
        if m.preselectSeasonId = "" and m.nextUp <> invalid and getOr(m.nextUp, "parentId", "") = s.id then selectIndex = i
    end for
    previous = m.seasons.itemFocused
    m.seasons.content = root
    if res.context <> invalid and res.context.first = false and previous >= 0 and previous < m.seasonItems.Count() then selectIndex = previous
    m.preselectSeasonId = ""
    if m.seasonItems.Count() > 0
        m.seasons.jumpToItem = selectIndex
        loadEpisodes(selectIndex)
    end if
    if m.lastFocus = invalid then focusNode(m.showButtons)
end sub

sub onSeasonFocused()
    i = m.seasons.itemFocused
    if i >= 0 and i < m.seasonItems.Count() and i <> m.currentSeason then loadEpisodes(i)
end sub

sub onSeasonSelected()
    if m.episodeItems.Count() > 0 then focusNode(m.episodes)
end sub

sub loadEpisodes(index as integer)
    m.currentSeason = index
    season = m.seasonItems[index]
    m.top.findNode("episodesTitle").text = season.title
    m.seasonGeneration = m.seasonGeneration + 1
    apiCall("GET", "/items/" + urlEncode(season.id) + "/children" + apiQuery([["sort", "index"], ["limit", 500]]), invalid, "onEpisodes", { generation: m.seasonGeneration })
end sub

sub onEpisodes(event as object)
    res = apiResult(event)
    if not res.ok or res.context = invalid or res.context.generation <> m.seasonGeneration then return
    m.episodeItems = getOr(res.data, "items", [])
    root = CreateObject("roSGNode", "ContentNode")
    focusIndex = 0
    for i = 0 to m.episodeItems.Count() - 1
        e = m.episodeItems[i]
        node = itemToContent(e, true)
        idx = getOr(e, "index", invalid)
        if idx <> invalid then node.title = toInt(idx).ToStr() + ". " + e.title else node.title = e.title
        meta = [msToRuntime(getOr(e, "durationMs", 0))]
        if node.played then meta.Push("Watched")
        node.meta = joinNonEmpty(meta, "  ·  ")
        root.appendChild(node)
        if m.nextUp <> invalid and m.nextUp.id = e.id then focusIndex = i
    end for
    previous = m.episodes.itemFocused
    m.episodes.content = root
    if m.episodes.hasFocus() and previous >= 0 and previous < m.episodeItems.Count() then focusIndex = previous
    if m.episodeItems.Count() > 0 then m.episodes.jumpToItem = focusIndex
end sub

sub onEpisodeSelected()
    e = m.episodeItems[m.episodes.itemSelected]
    navigate("DetailScreen", { itemId: e.id })
end sub

function onKeyEvent(key as string, press as boolean) as boolean
    if not press or m.item = invalid then return false
    if m.item.type <> "show" then return false
    if key = "down" and m.showButtons.hasFocus()
        if m.seasonItems.Count() > 0 then focusNode(m.seasons)
        return true
    else if key = "up" and (m.seasons.hasFocus() or m.episodes.hasFocus())
        focusNode(m.showButtons)
        return true
    else if key = "right" and m.seasons.hasFocus() and m.episodeItems.Count() > 0
        focusNode(m.episodes)
        return true
    else if key = "left" and m.episodes.hasFocus()
        focusNode(m.seasons)
        return true
    end if
    return false
end function
