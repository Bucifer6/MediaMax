sub init()
    m.rows = m.top.findNode("rows")
    m.nav = m.top.findNode("nav")
    m.backdrop = m.top.findNode("backdrop")
    m.infoTitle = m.top.findNode("infoTitle")
    m.infoMeta = m.top.findNode("infoMeta")
    m.infoText = m.top.findNode("infoText")
    m.empty = m.top.findNode("empty")
    m.top.findNode("serverName").text = m.global.serverName
    m.top.findNode("userName").text = getOr(m.global.user, "displayName", "")
    m.homeRows = []
    m.restoreFocus = invalid

    screenInit(m.rows)
    buildNav()
    m.rows.observeField("rowItemSelected", "onRowItemSelected")
    m.rows.observeField("rowItemFocused", "onRowItemFocused")
    m.nav.observeField("itemSelected", "onNavSelected")
    m.top.observeField("params", "onParams")
    m.top.observeField("resumed", "onResumed")
end sub

sub onParams()
    loadHome()
end sub

' Back from a detail / player screen: progress, "Continue watching" and "Next up" may have changed.
sub onResumed()
    m.restoreFocus = m.rows.rowItemFocused
    loadHome()
end sub

sub buildNav()
    m.navActions = ["search", "libraries"]
    labels = ["Search", "Libraries"]
    if getOr(m.global.features, "liveTv", false) = true
        m.navActions.Push("livetv")
        labels.Push("Live TV")
    end if
    user = m.global.user
    if toInt(getOr(user, "profileCount", 0)) > 0 or isNonEmptyString(getOr(user, "parentUserId", invalid))
        m.navActions.Push("profiles")
        labels.Push("Profiles")
    end if
    m.navActions.Push("settings")
    labels.Push("Settings")
    root = CreateObject("roSGNode", "ContentNode")
    for each l in labels
        n = root.createChild("ContentNode")
        n.title = l
    end for
    m.nav.numColumns = labels.Count()
    m.nav.translation = [1824 - labels.Count() * 236 + 16, 40]
    m.nav.content = root
end sub

sub loadHome()
    if m.homeRows.Count() = 0 then setLoading(true)
    apiCall("GET", "/home", invalid, "onHome")
end sub

sub onHome(event as object)
    res = apiResult(event)
    setLoading(false)
    if not res.ok
        if res.status = 401
            m.scene.signedOut = true
            return
        end if
        showEmpty("Couldn't load Home: " + res.error)
        return
    end if
    rows = getOr(res.data, "rows", [])
    buildRows(rows)
end sub

sub showEmpty(text as string)
    m.empty.text = text
    m.empty.visible = true
    m.rows.visible = false
    focusNode(m.nav)
end sub

sub buildRows(rows as object)
    root = CreateObject("roSGNode", "ContentNode")
    sizes = []
    heights = []
    m.homeRows = []
    for each row in rows
        rowType = getOr(row, "type", "")
        isChannels = rowType = "live-now" or rowType = "favorite-channels"
        landscape = rowType = "continue" or rowType = "nextup" or rowType = "recordings" or rowType = "hero" or isChannels
        rowNode = CreateObject("roSGNode", "ContentNode")
        rowNode.title = getOr(row, "title", "")
        if isChannels
            for each ch in getOr(row, "channels", [])
                rowNode.appendChild(channelToContent(ch))
            end for
        else
            items = getOr(row, "items", [])
            if rowType = "top10" and items.Count() > 10
                trimmed = []
                for i = 0 to 9
                    trimmed.Push(items[i])
                end for
                items = trimmed
            end if
            appendItems(rowNode, items, landscape)
        end if
        if rowNode.getChildCount() > 0
            root.appendChild(rowNode)
            m.homeRows.Push(row)
            if landscape
                sizes.Push([400, 301])
                heights.Push(380)
            else
                sizes.Push([200, 376])
                heights.Push(456)
            end if
        end if
    end for
    if root.getChildCount() = 0
        showEmpty("Nothing here yet. Add a library on the server, or check that your account can see one.")
        return
    end if
    m.empty.visible = false
    m.rows.visible = true
    m.rows.rowItemSize = sizes
    m.rows.rowHeights = heights
    m.rows.content = root
    rf = m.restoreFocus
    m.restoreFocus = invalid
    if rf <> invalid and rf.Count() = 2 and rf[0] < root.getChildCount()
        r = rf[0]
        c = rf[1]
        if c >= root.getChild(r).getChildCount() then c = root.getChild(r).getChildCount() - 1
        m.rows.jumpToRowItem = [r, c]
    end if
    if not m.nav.hasFocus() then focusNode(m.rows)
end sub

function focusedContent() as dynamic
    sel = m.rows.rowItemFocused
    if sel = invalid or sel.Count() < 2 or m.rows.content = invalid then return invalid
    row = m.rows.content.getChild(sel[0])
    if row = invalid then return invalid
    return row.getChild(sel[1])
end function

sub onRowItemFocused()
    c = focusedContent()
    if c = invalid then return
    m.infoTitle.text = c.fullTitle
    m.infoMeta.text = c.meta
    m.infoText.text = c.description
    if c.backdrop <> invalid and c.backdrop <> "" then m.backdrop.uri = c.backdrop
end sub

sub onRowItemSelected()
    sel = m.rows.rowItemSelected
    row = m.rows.content.getChild(sel[0])
    c = row.getChild(sel[1])
    openContent(c)
end sub

sub openContent(c as object)
    if c.itemType = "channel"
        navigate("PlayerScreen", { channelId: c.channelId, title: c.fullTitle })
    else
        navigate("DetailScreen", { itemId: c.itemId })
    end if
end sub

sub onNavSelected()
    action = m.navActions[m.nav.itemSelected]
    if action = "search"
        navigate("SearchScreen")
    else if action = "libraries"
        navigate("LibraryScreen")
    else if action = "livetv"
        navigate("LiveTvScreen")
    else if action = "profiles"
        navigate("ProfileScreen")
    else if action = "settings"
        navigate("SettingsScreen")
    end if
end sub

function onKeyEvent(key as string, press as boolean) as boolean
    if not press then return false
    if key = "up" and m.rows.hasFocus()
        focusNode(m.nav)
        return true
    else if key = "down" and m.nav.hasFocus() and m.rows.visible
        focusNode(m.rows)
        return true
    else if key = "options"
        navigate("SearchScreen")
        return true
    end if
    return false
end function
