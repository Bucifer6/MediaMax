sub init()
    m.keyboard = m.top.findNode("keyboard")
    m.results = m.top.findNode("results")
    m.status = m.top.findNode("status")
    m.debounce = m.top.findNode("debounce")
    m.query = ""
    m.generation = 0
    screenInit(m.keyboard)
    m.keyboard.observeField("text", "onText")
    m.debounce.observeField("fire", "runSearch")
    m.results.observeField("itemSelected", "onSelected")
end sub

sub onText()
    m.debounce.control = "stop"
    m.debounce.control = "start"
end sub

sub runSearch()
    q = m.keyboard.text.Trim()
    if q = m.query then return
    m.query = q
    if Len(q) < 2
        m.results.content = CreateObject("roSGNode", "ContentNode")
        m.status.text = "Type a title, person or channel"
        return
    end if
    m.generation = m.generation + 1
    m.status.text = "Searching..."
    apiCall("GET", "/search" + apiQuery([["q", q], ["limit", 40]]), invalid, "onResults", { generation: m.generation })
end sub

sub onResults(event as object)
    res = apiResult(event)
    if res.context = invalid or res.context.generation <> m.generation then return
    if not res.ok
        m.status.text = res.error
        return
    end if
    root = CreateObject("roSGNode", "ContentNode")
    for each it in getOr(res.data, "items", [])
        ' Episodes / seasons / movies / shows / videos; music and photos aren't playable here.
        t = getOr(it, "type", "")
        if t = "movie" or t = "show" or t = "season" or t = "episode" or t = "video"
            root.appendChild(itemToContent(it, false))
        end if
    end for
    for each ch in getOr(res.data, "channels", [])
        root.appendChild(channelToContent(ch))
    end for
    m.results.content = root
    n = root.getChildCount()
    if n = 0
        m.status.text = "No results for " + Chr(34) + m.query + Chr(34)
    else
        m.status.text = n.ToStr() + " results"
    end if
end sub

sub onSelected()
    c = m.results.content.getChild(m.results.itemSelected)
    if c = invalid then return
    if c.itemType = "channel"
        navigate("PlayerScreen", { channelId: c.channelId })
    else
        navigate("DetailScreen", { itemId: c.itemId })
    end if
end sub

function onKeyEvent(key as string, press as boolean) as boolean
    if not press then return false
    if key = "right" and m.keyboard.isInFocusChain() and m.results.content <> invalid and m.results.content.getChildCount() > 0
        focusNode(m.results)
        return true
    else if key = "left" and m.results.hasFocus()
        focusNode(m.keyboard)
        return true
    end if
    return false
end function
