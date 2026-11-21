sub init()
    m.options = m.top.findNode("options")
    m.linkPanel = m.top.findNode("linkPanel")
    m.linkHint = m.top.findNode("linkHint")
    m.code = m.top.findNode("code")
    m.linkStatus = m.top.findNode("linkStatus")
    m.error = m.top.findNode("error")
    m.pollTimer = m.top.findNode("pollTimer")
    m.top.findNode("server").text = m.global.serverName + "  ·  " + m.global.serverUrl
    m.publicProfiles = []
    m.pollToken = ""
    m.polling = false
    m.username = ""
    m.password = ""
    m.pendingProfile = invalid

    screenInit(m.options)
    m.options.observeField("itemSelected", "onOptionSelected")
    m.pollTimer.observeField("fire", "onPollTimer")
    m.top.observeField("params", "onParams")
    m.top.observeField("closing", "onClosing")
    m.top.observeField("visible", "onVisible")
    buildOptions()
end sub

sub onParams()
    p = m.top.params
    if p <> invalid and isNonEmptyString(p.error) then m.error.text = p.error
    features = m.global.features
    if getOr(features, "linkCodes", true) = true
        m.linkHint.text = "On your phone or computer, sign in to MediaMax, open " + m.global.serverUrl + "/link (or choose Link a device in the menu) and enter this code:"
        requestCode()
    else
        m.linkHint.text = "Device linking is turned off on this server. Sign in with your username and password instead."
        m.code.text = ""
    end if
    if getOr(features, "profilePicker", false) = true
        apiCall("GET", "/auth/profiles", invalid, "onPublicProfiles")
    end if
end sub

sub onClosing()
    m.pollTimer.control = "stop"
    apiCancelAll()
end sub

sub onVisible()
    if m.top.visible = false then m.pollTimer.control = "stop"
end sub

function deviceBody() as object
    return { deviceId: m.global.deviceId, deviceName: m.global.deviceName, platform: "roku", appVersion: m.global.appVersion }
end function

' ------------------------------------------------------------------ link code

sub requestCode()
    m.linkStatus.text = "Getting a code..."
    apiCall("POST", "/auth/link/request", deviceBody(), "onCode")
end sub

sub onCode(event as object)
    res = apiResult(event)
    if not res.ok
        m.code.text = ""
        m.linkStatus.text = res.error
        return
    end if
    m.code.text = spacedCode(res.data.code)
    m.pollToken = res.data.pollToken
    m.linkStatus.text = "Waiting for you to enter the code..."
    m.pollTimer.control = "start"
end sub

function spacedCode(code as string) as string
    out = ""
    for i = 1 to Len(code)
        if i > 1 then out = out + " "
        out = out + Mid(code, i, 1)
    end for
    return out
end function

sub onPollTimer()
    if m.polling or m.pollToken = "" then return
    m.polling = true
    apiCall("GET", "/auth/link/poll" + apiQuery([["pollToken", m.pollToken]]), invalid, "onPoll")
end sub

sub onPoll(event as object)
    res = apiResult(event)
    m.polling = false
    if not res.ok then return
    status = getOr(res.data, "status", "pending")
    if status = "linked"
        m.pollTimer.control = "stop"
        m.linkStatus.text = "Linked!"
        m.scene.signedIn = { token: res.data.token, user: res.data.user }
    else if status = "expired"
        m.pollTimer.control = "stop"
        m.pollToken = ""
        requestCode()
    end if
end sub

' ------------------------------------------------------------------ other options

sub buildOptions()
    root = CreateObject("roSGNode", "ContentNode")
    o = root.createChild("ContentNode")
    o.title = "Username and password"
    for each p in m.publicProfiles
        row = root.createChild("ContentNode")
        row.title = "Sign in as " + p.displayName
    end for
    c = root.createChild("ContentNode")
    c.title = "Change server"
    m.options.content = root
end sub

sub onPublicProfiles(event as object)
    res = apiResult(event)
    if res.ok and res.data <> invalid and type(res.data) = "roArray"
        m.publicProfiles = res.data
        buildOptions()
    end if
end sub

sub onOptionSelected()
    i = m.options.itemSelected
    n = m.publicProfiles.Count()
    if i = 0
        m.pendingProfile = invalid
        showKeyboard("Username", m.username, false, "onUsername")
    else if i <= n
        startProfileLogin(m.publicProfiles[i - 1])
    else
        m.pollTimer.control = "stop"
        m.scene.resetTo = { screen: "ServerScreen", params: {} }
    end if
end sub

sub onUsername(event as object)
    button = event.getData()
    text = m.keyboardDialog.text
    closeDialog()
    if button <> 0 or text.Trim() = "" then return
    m.username = text.Trim()
    showKeyboard("Password for " + m.username, "", true, "onPassword")
end sub

sub onPassword(event as object)
    button = event.getData()
    text = m.keyboardDialog.text
    closeDialog()
    if button <> 0 then return
    m.password = text
    doLogin("")
end sub

sub doLogin(totp as string)
    body = deviceBody()
    body["username"] = m.username
    body["password"] = m.password
    if totp <> "" then body["totpCode"] = totp
    m.error.text = ""
    setLoading(true)
    apiCall("POST", "/auth/login", body, "onLogin")
end sub

sub onLogin(event as object)
    res = apiResult(event)
    setLoading(false)
    if res.ok
        m.password = ""
        m.pollTimer.control = "stop"
        m.scene.signedIn = { token: res.data.token, user: res.data.user }
    else if res.errorCode = "totp_required"
        showKeyboard("Two-factor code", "", false, "onTotp", "Enter the 6-digit code from your authenticator app (or a recovery code).")
    else
        m.error.text = res.error
    end if
end sub

sub onTotp(event as object)
    button = event.getData()
    text = m.keyboardDialog.text
    closeDialog()
    if button <> 0 or text.Trim() = "" then return
    if m.pendingProfile <> invalid
        doProfileLogin(m.profilePin, text.Trim())
    else
        doLogin(text.Trim())
    end if
end sub

' Public profile picker (features.profilePicker): password profiles use the normal login with the username filled in.
sub startProfileLogin(p as object)
    if p.requiresPassword = true
        m.pendingProfile = invalid
        m.username = p.username
        showKeyboard("Password for " + p.displayName, "", true, "onPassword")
        return
    end if
    m.pendingProfile = p
    m.profilePin = ""
    if p.hasPin = true
        showPinPad("PIN for " + p.displayName, toInt(getOr(p, "pinLength", 4), 4), "onProfilePin")
    else
        doProfileLogin("", "")
    end if
end sub

sub onProfilePin(event as object)
    button = event.getData()
    pin = m.pinDialog.pin
    closeDialog()
    if button <> 0 then return
    m.profilePin = pin
    doProfileLogin(pin, "")
end sub

sub doProfileLogin(pin as string, totp as string)
    body = deviceBody()
    body["userId"] = m.pendingProfile.id
    if pin <> "" then body["pin"] = pin
    if totp <> "" then body["totpCode"] = totp
    setLoading(true)
    apiCall("POST", "/auth/profile-login", body, "onLogin")
end sub
