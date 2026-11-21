sub init()
    m.grid = m.top.findNode("grid")
    m.error = m.top.findNode("error")
    m.profiles = []
    screenInit(m.grid)
    m.grid.observeField("itemSelected", "onSelected")
    m.top.observeField("params", "onParams")
end sub

sub onParams()
    setLoading(true)
    apiCall("GET", "/auth/account/profiles", invalid, "onProfiles")
end sub

sub onProfiles(event as object)
    res = apiResult(event)
    setLoading(false)
    if not res.ok or res.data = invalid or type(res.data) <> "roArray" or res.data.Count() = 0
        ' Profiles turned off (or none): straight to Home.
        m.scene.resetTo = { screen: "HomeScreen", params: {} }
        return
    end if
    m.profiles = res.data
    root = CreateObject("roSGNode", "ContentNode")
    focusIndex = 0
    for i = 0 to m.profiles.Count() - 1
        p = m.profiles[i]
        node = root.createChild("ContentNode")
        node.title = getOr(p, "displayName", "")
        avatar = imageUrl(getOr(p, "avatarUrl", invalid), 240)
        node.HDPosterUrl = avatar
        color = getOr(p, "color", "")
        if isNonEmptyString(color) and Left(color, 1) = "#" then color = "0x" + Mid(color, 2) + "FF" else color = ""
        node.addFields({ color: color, isKids: getOr(p, "isKids", false) = true, hasPin: getOr(p, "hasPin", false) = true })
        if getOr(p, "current", false) = true then focusIndex = i
    end for
    m.grid.content = root
    ' Center a short row.
    n = m.profiles.Count()
    if n < 5 then m.grid.translation = [(1920 - (n * 240 + (n - 1) * 60)) / 2, 360]
    m.grid.jumpToItem = focusIndex
    focusNode(m.grid)
end sub

sub onSelected()
    p = m.profiles[m.grid.itemSelected]
    m.selected = p
    m.error.text = ""
    if p.current = true
        m.scene.resetTo = { screen: "HomeScreen", params: {} }
    else if p.hasPin = true
        showPinPad("PIN for " + p.displayName, toInt(getOr(p, "pinLength", 4), 4), "onPin")
    else
        switchTo("")
    end if
end sub

sub onPin(event as object)
    button = event.getData()
    pin = m.pinDialog.pin
    closeDialog()
    if button <> 0 then return
    switchTo(pin)
end sub

sub switchTo(pin as string)
    body = {}
    if pin <> "" then body["pin"] = pin
    setLoading(true)
    apiCall("POST", "/auth/profiles/" + urlEncode(m.selected.id) + "/switch", body, "onSwitched")
end sub

sub onSwitched(event as object)
    res = apiResult(event)
    setLoading(false)
    if res.ok
        m.scene.signedIn = { token: res.data.token, user: res.data.user, profileChosen: true }
    else if res.errorCode = "pin_invalid"
        m.error.text = "Wrong PIN. Try again."
    else if res.errorCode = "pin_locked"
        m.error.text = "Too many wrong PINs. Try again in 15 minutes."
    else
        m.error.text = res.error
    end if
end sub
