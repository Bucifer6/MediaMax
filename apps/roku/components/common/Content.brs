' API objects (Item, Channel, AccountProfile) → ContentNodes for RowList / MarkupGrid / MarkupList.
' Custom fields: itemId, itemType, channelId, progress (0..1), played, landscape, badge, line2.

function itemToContent(item as object, landscape as boolean) as object
    node = CreateObject("roSGNode", "ContentNode")
    itemType = getOr(item, "type", "")
    title = getOr(item, "title", "")
    line2 = ""
    if itemType = "episode"
        show = getOr(item, "grandparentTitle", "")
        label = episodeLabel(item)
        if landscape
            line2 = joinNonEmpty([label, title], " · ")
            if show <> "" then title = show
        else
            line2 = label
        end if
    else
        year = getOr(item, "year", invalid)
        if year <> invalid then line2 = toInt(year).ToStr()
    end if

    image = ""
    if landscape
        image = imageUrl(getOr(item, "thumbUrl", invalid), 560)
        if image = "" then image = imageUrl(getOr(item, "backdropUrl", invalid), 560)
        if image = "" then image = imageUrl(getOr(item, "posterUrl", invalid), 300)
    else
        image = imageUrl(getOr(item, "posterUrl", invalid), 300)
        if image = "" then image = imageUrl(getOr(item, "thumbUrl", invalid), 300)
    end if

    ud = getOr(item, "userData", {})
    progress = 0.0
    duration = toInt(getOr(item, "durationMs", 0))
    resumeMs = toInt(getOr(ud, "positionMs", 0))
    if duration > 0 and resumeMs > 0 then progress = resumeMs / duration
    if progress > 1 then progress = 1.0

    badge = ""
    unplayed = toInt(getOr(ud, "unplayedCount", 0))
    if (itemType = "show" or itemType = "season") and unplayed > 0 then badge = unplayed.ToStr()

    meta = []
    if itemType = "episode" then meta.Push(joinNonEmpty([getOr(item, "grandparentTitle", ""), episodeLabel(item)], " · "))
    year = getOr(item, "year", invalid)
    if year <> invalid then meta.Push(toInt(year).ToStr())
    meta.Push(getOr(item, "contentRating", ""))
    meta.Push(msToRuntime(duration))
    rating = getOr(item, "communityRating", invalid)
    if isNumber(rating) and rating > 0 then meta.Push(Str(Int(rating * 10) / 10).Trim() + "/10")
    genres = getOr(item, "genres", [])
    if type(genres) = "roArray" and genres.Count() > 0 then meta.Push(genres[0])

    node.title = title
    node.HDPosterUrl = image
    node.FHDPosterUrl = image
    node.description = getOr(item, "overview", "")
    node.addFields({
        fullTitle: getOr(item, "title", ""),
        meta: joinNonEmpty(meta, "  ·  "),
        backdrop: imageUrl(getOr(item, "backdropUrl", invalid), 1280),
        itemType: itemType,
        channelId: "",
        line2: line2,
        progress: progress,
        played: getOr(ud, "played", false) = true,
        landscape: landscape,
        badge: badge
    })
    return node
end function

function channelToContent(ch as object) as object
    node = CreateObject("roSGNode", "ContentNode")
    num = getOr(ch, "number", invalid)
    name = getOr(ch, "name", "")
    label = name
    if num <> invalid then label = toInt(num).ToStr() + "  " + name
    now = getOr(ch, "nowPlaying", invalid)
    nxt = getOr(ch, "next", invalid)
    nowText = ""
    progress = 0.0
    if now <> invalid
        nowText = getOr(now, "title", "")
        st = isoToSeconds(getOr(now, "start", ""))
        en = isoToSeconds(getOr(now, "end", ""))
        if en > st then progress = (nowSeconds() - st) / (en - st)
        if progress < 0 then progress = 0.0
        if progress > 1 then progress = 1.0
    end if
    nextText = ""
    if nxt <> invalid then nextText = isoToLocalTime(getOr(nxt, "start", "")) + "  " + getOr(nxt, "title", "")
    logo = imageUrl(getOr(ch, "logoUrl", invalid), 240)
    node.title = label
    node.HDPosterUrl = logo
    node.FHDPosterUrl = logo
    node.description = nowText
    node.addFields({
        fullTitle: name,
        meta: nextText,
        backdrop: "",
        itemId: "",
        itemType: "channel",
        channelId: getOr(ch, "id", ""),
        line2: nowText,
        nextLine: nextText,
        progress: progress,
        played: false,
        landscape: true,
        badge: "",
        favorite: getOr(ch, "favorite", false) = true
    })
    return node
end function

' Append items to a parent ContentNode.
sub appendItems(parent as object, items as dynamic, landscape as boolean)
    if items = invalid then return
    for each it in items
        parent.appendChild(itemToContent(it, landscape))
    end for
end sub
