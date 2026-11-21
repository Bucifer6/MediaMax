sub init()
    m.categories = m.top.findNode("categories")
    m.channels = m.top.findNode("channels")
    m.empty = m.top.findNode("empty")
    m.refresh = m.top.findNode("refresh")
    m.categoryList = []
    m.currentCategory = -1
    m.pageSize = 100
    m.generation = 0
    resetChannels()

    screenInit(m.categories)
    m.categories.observeField("itemFocused", "onCategoryFocused")
    m.categories.observeField("itemSelected", "onCategorySelected")
    m.channels.observeField("itemFocused", "onChannelFocused")
    m.channels.observeField("itemSelected", "onChannelSelected")
    m.refresh.observeField("fire", "onRefresh")
    m.top.observeField("params", "onParams")
    m.top.observeField("closing", "onClosing")
    m.top.observeField("visible", "onVisible")
end sub

sub resetChannels()
    m.total = -1
    m.loaded = 0
    m.loading = false
    m.channelData = []
    m.channelContent = CreateObject("roSGNode", "ContentNode")
    m.channels.content = m.channelContent
end sub

sub onParams()
    setLoading(true)
    apiCall("GET", "/livetv/categories", invalid, "onCategories")
    m.refresh.control = "start"
end sub

sub onClosing()
    m.refresh.control = "stop"
end sub

' Back from the player: refresh now / next.
sub onVisible()
    if m.top.visible and m.currentCategory >= 0
        m.refresh.control = "start"
        onRefresh()
    else if not m.top.visible
        m.refresh.control = "stop"
    end if
end sub

sub onCategories(event as object)
    res = apiResult(event)
    m.categoryList = [{ id: "", name: "All channels", favorite: false }, { id: "", name: "Favourites", favorite: true }]
    if res.ok and type(res.data) = "roArray"
        for each c in res.data
            if getOr(c, "hidden", false) <> true then m.categoryList.Push({ id: c.id, name: c.name, favorite: false })
        end for
    end if
    root = CreateObject("roSGNode", "ContentNode")
    for each c in m.categoryList
        n = root.createChild("ContentNode")
        n.title = c.name
    end for
    m.categories.content = root
    openCategory(0)
end sub

sub onCategoryFocused()
    i = m.categories.itemFocused
    if i >= 0 and i <> m.currentCategory then openCategory(i)
end sub

sub onCategorySelected()
    if m.channelContent.getChildCount() > 0 then focusNode(m.channels)
end sub

sub openCategory(index as integer)
    m.currentCategory = index
    m.generation = m.generation + 1
    resetChannels()
    m.empty.visible = false
    loadPage()
end sub

sub loadPage()
    if m.loading or m.currentCategory < 0 then return
    if m.total >= 0 and m.loaded >= m.total then return
    m.loading = true
    c = m.categoryList[m.currentCategory]
    pairs = [["limit", m.pageSize], ["offset", m.loaded], ["withEpg", true]]
    if c.id <> "" then pairs.Push(["categoryId", c.id])
    if c.favorite then pairs.Push(["favorite", true])
    apiCall("GET", "/livetv/channels" + apiQuery(pairs), invalid, "onChannels", { generation: m.generation, replace: false })
end sub

' Re-fetch the loaded channels so the now / next lines stay current.
sub onRefresh()
    if m.loading or m.currentCategory < 0 or m.loaded = 0 then return
    m.loading = true
    c = m.categoryList[m.currentCategory]
    pairs = [["limit", m.loaded], ["offset", 0], ["withEpg", true]]
    if c.id <> "" then pairs.Push(["categoryId", c.id])
    if c.favorite then pairs.Push(["favorite", true])
    apiCall("GET", "/livetv/channels" + apiQuery(pairs), invalid, "onChannels", { generation: m.generation, replace: true })
end sub

sub onChannels(event as object)
    res = apiResult(event)
    setLoading(false)
    m.loading = false
    if res.context = invalid or res.context.generation <> m.generation then return
    if not res.ok
        if res.status = 403
            m.empty.text = "Live TV isn't available for this profile."
        else
            m.empty.text = "Couldn't load channels: " + res.error
        end if
        m.empty.visible = true
        return
    end if
    items = getOr(res.data, "items", [])
    m.total = toInt(getOr(res.data, "total", 0))
    if res.context.replace = true
        focused = m.channels.itemFocused
        m.channelData = []
        m.channelContent = CreateObject("roSGNode", "ContentNode")
        for each ch in items
            m.channelData.Push(ch)
            m.channelContent.appendChild(channelToContent(ch))
        end for
        m.channels.content = m.channelContent
        if focused >= 0 and focused < m.channelData.Count() then m.channels.jumpToItem = focused
        m.loaded = m.channelData.Count()
    else
        for each ch in items
            m.channelData.Push(ch)
            m.channelContent.appendChild(channelToContent(ch))
        end for
        m.loaded = m.loaded + items.Count()
    end if
    if m.loaded = 0
        if m.categoryList[m.currentCategory].favorite
            m.empty.text = "No favourite channels yet. Press * on a channel to add it."
        else
            m.empty.text = "No channels here."
        end if
        m.empty.visible = true
    else
        m.empty.visible = false
    end if
end sub

sub onChannelFocused()
    if m.channels.itemFocused >= m.loaded - 10 then loadPage()
end sub

sub onChannelSelected()
    ch = m.channelData[m.channels.itemSelected]
    if ch <> invalid then navigate("PlayerScreen", { channelId: ch.id })
end sub

sub toggleFavorite()
    i = m.channels.itemFocused
    if i < 0 or i >= m.channelData.Count() then return
    ch = m.channelData[i]
    method = "POST"
    if getOr(ch, "favorite", false) = true then method = "DELETE"
    apiCall(method, "/livetv/channels/" + urlEncode(ch.id) + "/favorite", invalid, "onFavorite", { index: i })
end sub

sub onFavorite(event as object)
    res = apiResult(event)
    if not res.ok
        showToast(res.error)
        return
    end if
    i = res.context.index
    if i >= m.channelData.Count() then return
    fav = getOr(res.data, "favorite", false) = true
    m.channelData[i].favorite = fav
    node = m.channelContent.getChild(i)
    if node <> invalid then node.favorite = fav
    ' Refresh the row (MarkupList redraws when its item content changes).
    m.channelContent.replaceChild(channelToContent(m.channelData[i]), i)
    if fav then showToast("Added to favourites") else showToast("Removed from favourites")
end sub

function onKeyEvent(key as string, press as boolean) as boolean
    if not press then return false
    if key = "left" and m.channels.hasFocus()
        focusNode(m.categories)
        return true
    else if key = "right" and m.categories.hasFocus() and m.channelContent.getChildCount() > 0
        focusNode(m.channels)
        return true
    else if key = "options" and m.channels.hasFocus()
        toggleFavorite()
        return true
    end if
    return false
end function
