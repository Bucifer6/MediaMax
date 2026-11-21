' Video libraries only: music, photos, audiobooks and podcasts aren't supported by this channel yet.
sub init()
    m.libs = m.top.findNode("libs")
    m.grid = m.top.findNode("grid")
    m.libTitle = m.top.findNode("libTitle")
    m.sortLabel = m.top.findNode("sortLabel")
    m.empty = m.top.findNode("empty")
    m.libraries = []
    m.pageSize = 60
    m.sorts = [
        { key: "title", order: "asc", label: "A-Z" },
        { key: "addedAt", order: "desc", label: "Recently added" },
        { key: "releaseDate", order: "desc", label: "Release date" },
        { key: "rating", order: "desc", label: "Rating" }
    ]
    m.sortIndex = 0
    m.current = invalid
    m.generation = 0
    resetPaging()

    screenInit(m.libs)
    m.libs.observeField("itemSelected", "onLibSelected")
    m.libs.observeField("itemFocused", "onLibFocused")
    m.grid.observeField("itemFocused", "onGridFocused")
    m.grid.observeField("itemSelected", "onGridSelected")
    m.top.observeField("params", "onParams")
    m.top.observeField("resumed", "onResumed")
end sub

sub resetPaging()
    m.total = -1
    m.loaded = 0
    m.loading = false
    m.gridContent = CreateObject("roSGNode", "ContentNode")
    m.grid.content = m.gridContent
end sub

sub onParams()
    setLoading(true)
    apiCall("GET", "/libraries", invalid, "onLibraries")
end sub

sub onResumed()
    ' Keep the grid; watched badges refresh the next time the library is opened.
end sub

function itemTypeFor(libType as string) as string
    if libType = "movies" or libType = "iptv-movies" then return "movie"
    if libType = "shows" or libType = "iptv-shows" then return "show"
    if libType = "videos" then return "video"
    return ""
end function

sub onLibraries(event as object)
    res = apiResult(event)
    setLoading(false)
    if not res.ok
        m.empty.text = res.error
        m.empty.visible = true
        return
    end if
    root = CreateObject("roSGNode", "ContentNode")
    m.libraries = []
    for each lib in res.data
        if itemTypeFor(getOr(lib, "type", "")) <> ""
            m.libraries.Push(lib)
            n = root.createChild("ContentNode")
            n.title = lib.name
        end if
    end for
    m.libs.content = root
    if m.libraries.Count() = 0
        m.empty.text = "No video libraries are shared with you on this server."
        m.empty.visible = true
        return
    end if
    wanted = getOr(m.top.params, "libraryId", "")
    index = 0
    for i = 0 to m.libraries.Count() - 1
        if m.libraries[i].id = wanted then index = i
    end for
    m.libs.jumpToItem = index
    openLibrary(index)
    if wanted <> "" then focusNode(m.grid) else focusNode(m.libs)
end sub

sub onLibFocused()
    ' Opening on focus keeps browsing quick; selection moves into the grid.
    i = m.libs.itemFocused
    if i >= 0 and i < m.libraries.Count() and (m.current = invalid or m.current.id <> m.libraries[i].id) then openLibrary(i)
end sub

sub onLibSelected()
    if m.gridContent.getChildCount() > 0 then focusNode(m.grid)
end sub

sub openLibrary(index as integer)
    m.current = m.libraries[index]
    m.libTitle.text = m.current.name
    updateSortLabel()
    m.generation = m.generation + 1
    resetPaging()
    m.empty.visible = false
    loadPage()
end sub

sub updateSortLabel()
    m.sortLabel.text = "Sort: " + m.sorts[m.sortIndex].label + "   (press * to change)"
end sub

sub loadPage()
    if m.loading or m.current = invalid then return
    if m.total >= 0 and m.loaded >= m.total then return
    m.loading = true
    s = m.sorts[m.sortIndex]
    q = apiQuery([
        ["libraryId", m.current.id],
        ["type", itemTypeFor(m.current.type)],
        ["sort", s.key],
        ["order", s.order],
        ["limit", m.pageSize],
        ["offset", m.loaded]
    ])
    apiCall("GET", "/items" + q, invalid, "onPage", { generation: m.generation })
end sub

sub onPage(event as object)
    res = apiResult(event)
    m.loading = false
    ' A newer library / sort was opened meanwhile.
    if res.context = invalid or res.context.generation <> m.generation then return
    if not res.ok
        showToast("Couldn't load the library: " + res.error)
        return
    end if
    items = getOr(res.data, "items", [])
    m.total = toInt(getOr(res.data, "total", 0))
    appendItems(m.gridContent, items, false)
    m.loaded = m.loaded + items.Count()
    if m.loaded = 0
        m.empty.text = "This library is empty."
        m.empty.visible = true
    end if
end sub

sub onGridFocused()
    ' Prefetch the next page two rows before the end.
    if m.grid.itemFocused >= m.loaded - 12 then loadPage()
end sub

sub onGridSelected()
    c = m.gridContent.getChild(m.grid.itemSelected)
    if c <> invalid then navigate("DetailScreen", { itemId: c.itemId })
end sub

function onKeyEvent(key as string, press as boolean) as boolean
    if not press then return false
    if key = "right" and m.libs.hasFocus() and m.gridContent.getChildCount() > 0
        focusNode(m.grid)
        return true
    else if key = "left" and m.grid.hasFocus()
        focusNode(m.libs)
        return true
    else if key = "options" and m.current <> invalid
        m.sortIndex = (m.sortIndex + 1) mod m.sorts.Count()
        openLibrary(m.libs.itemFocused)
        return true
    end if
    return false
end function
