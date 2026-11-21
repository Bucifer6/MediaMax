sub init()
    m.screens = m.top.findNode("screens")
    m.stack = []
    m.toastGroup = m.top.findNode("toastGroup")
    m.toastLabel = m.top.findNode("toastLabel")
    m.toastTimer = m.top.findNode("toastTimer")
    m.toastTimer.observeField("fire", "onToastTimer")
    m.spinner = m.top.findNode("spinner")
    m.spinner.poster.uri = "pkg:/images/spinner.png"
    m.spinner.poster.width = 96
    m.spinner.poster.height = 96
    m.pendingDeepLink = invalid

    initGlobals()
    startup()
end sub

' Global node fields read by every component and task thread.
sub initGlobals()
    di = CreateObject("roDeviceInfo")
    app = CreateObject("roAppInfo")
    name = di.GetFriendlyName()
    if not isNonEmptyString(name) then name = "Roku " + di.GetModelDisplayName()
    settings = loadSettings()
    m.global.addFields({
        serverUrl: regRead("serverUrl"),
        serverName: regRead("serverName", "Kinora"),
        token: regRead("token"),
        user: {},
        features: {},
        deviceId: di.GetChannelClientId(),
        deviceName: name,
        appVersion: app.GetVersion(),
        settings: settings,
        deviceProfile: buildDeviceProfile(settings)
    })
end sub

function loadSettings() as object
    return {
        maxBitrate: toInt(regRead("maxBitrate", "0")),
        subtitleMode: regRead("subtitleMode", "auto"),
        autoplayNext: regRead("autoplayNext", "true") = "true"
    }
end function

' Launch: no server → address screen; a saved token → check it (GET /auth/me) and continue; otherwise sign in.
sub startup()
    if not isNonEmptyString(m.global.serverUrl)
        showScreen("ServerScreen", {}, true)
        return
    end if
    m.top.loading = true
    apiCall("GET", "/system/info", invalid, "onStartupInfo")
end sub

sub onStartupInfo(event as object)
    res = apiResult(event)
    if not res.ok
        m.top.loading = false
        showScreen("ServerScreen", { error: "Couldn't reach " + m.global.serverUrl + ". " + res.error }, true)
        return
    end if
    m.global.features = getOr(res.data, "features", {})
    m.global.serverName = getOr(res.data, "name", "Kinora")
    regWrite("serverName", m.global.serverName)
    if not isNonEmptyString(m.global.token)
        m.top.loading = false
        showScreen("SignInScreen", {}, true)
        return
    end if
    apiCall("GET", "/auth/me", invalid, "onStartupMe")
end sub

sub onStartupMe(event as object)
    res = apiResult(event)
    m.top.loading = false
    if res.ok
        m.global.user = res.data
        afterSignIn(true)
    else if res.status = 401 or res.status = 403
        clearToken()
        showScreen("SignInScreen", { error: "Your session has ended. Please sign in again." }, true)
    else
        showScreen("ServerScreen", { error: res.error }, true)
    end if
end sub

' Account with profiles → "Who's watching?" (at launch and after sign-in), otherwise Home.
sub afterSignIn(atLaunch as boolean)
    user = m.global.user
    hasProfiles = toInt(getOr(user, "profileCount", 0)) > 0 or isNonEmptyString(getOr(user, "parentUserId", invalid))
    if hasProfiles
        showScreen("ProfileScreen", { atLaunch: atLaunch }, true)
    else
        showScreen("HomeScreen", {}, true)
    end if
end sub

sub onSignedIn()
    data = m.top.signedIn
    if data = invalid or not isNonEmptyString(data.token) then return
    m.global.token = data.token
    regWrite("token", data.token)
    if data.user <> invalid then m.global.user = data.user
    if getOr(data, "profileChosen", false) = true
        showScreen("HomeScreen", {}, true)
    else
        afterSignIn(false)
    end if
end sub

sub clearToken()
    m.global.token = ""
    m.global.user = {}
    regDelete("token")
end sub

sub onSignedOut()
    clearToken()
    showScreen("SignInScreen", {}, true)
end sub

' ------------------------------------------------------------------ navigation

sub onNavigate()
    nav = m.top.navigate
    if nav = invalid or not isNonEmptyString(nav.screen) then return
    params = nav.params
    if params = invalid then params = {}
    showScreen(nav.screen, params, false)
end sub

sub onResetTo()
    nav = m.top.resetTo
    if nav = invalid or not isNonEmptyString(nav.screen) then return
    params = nav.params
    if params = invalid then params = {}
    showScreen(nav.screen, params, true)
end sub

sub showScreen(name as string, params as object, reset as boolean)
    if reset
        ' e.g. linked from a phone while the password keyboard is still open
        if m.top.dialog <> invalid then m.top.dialog.close = true
        while m.stack.Count() > 0
            closeTop()
        end while
    else if m.stack.Count() > 0
        top = m.stack.Peek()
        top.visible = false
    end if
    screen = CreateObject("roSGNode", name)
    if screen = invalid
        print "Kinora: unknown screen "; name
        return
    end if
    m.screens.appendChild(screen)
    m.stack.Push(screen)
    screen.params = params
    screen.setFocus(true)
    if name = "HomeScreen" and m.pendingDeepLink <> invalid then handleDeepLink()
end sub

sub closeTop()
    screen = m.stack.Pop()
    if screen = invalid then return
    screen.closing = true
    m.screens.removeChild(screen)
end sub

sub onGoBack()
    goBackOne()
end sub

function goBackOne() as boolean
    if m.stack.Count() <= 1 then return false
    closeTop()
    top = m.stack.Peek()
    top.visible = true
    top.setFocus(true)
    top.resumed = true
    return true
end function

function onKeyEvent(key as string, press as boolean) as boolean
    if not press then return false
    if key = "back"
        if goBackOne() then return true
        ' Root screen: let the OS close the channel.
        m.top.exitChannel = true
        return true
    end if
    return false
end function

sub onBackgroundRequest()
    r = m.top.backgroundRequest
    if r = invalid or not isNonEmptyString(r.path) then return
    task = CreateObject("roSGNode", "ApiTask")
    if m.bgSeq = invalid then m.bgSeq = 0
    if m.bgTasks = invalid then m.bgTasks = {}
    m.bgSeq = m.bgSeq + 1
    id = "bg" + m.bgSeq.ToStr()
    followUp = r.followUp
    if followUp <> invalid then followUp["token"] = m.global.token
    task.request = { id: id, method: r.method, path: r.path, body: r.body, followUp: followUp, token: m.global.token }
    task.observeField("response", "onBackgroundDone")
    m.bgTasks[id] = task
    task.control = "RUN"
end sub

sub onBackgroundDone(event as object)
    res = event.getData()
    if res <> invalid and res.id <> invalid and m.bgTasks <> invalid then m.bgTasks.Delete(res.id)
end sub

' ------------------------------------------------------------------ app-wide UI

sub onToast()
    if not isNonEmptyString(m.top.toast) then return
    m.toastLabel.text = m.top.toast
    m.toastGroup.visible = true
    m.toastTimer.control = "stop"
    m.toastTimer.control = "start"
end sub

sub onToastTimer()
    m.toastGroup.visible = false
end sub

sub onLoading()
    m.spinner.visible = m.top.loading
    if m.top.loading then m.spinner.control = "start" else m.spinner.control = "stop"
end sub

' ------------------------------------------------------------------ deep links

sub onDeepLink()
    m.pendingDeepLink = m.top.deepLink
    ' Signed in already (Home is on the stack): open it now; otherwise after Home is shown.
    if m.stack.Count() > 0 and m.stack[0].subtype() = "HomeScreen" then handleDeepLink()
end sub

sub handleDeepLink()
    link = m.pendingDeepLink
    m.pendingDeepLink = invalid
    if link = invalid or not isNonEmptyString(link.contentId) then return
    mediaType = LCase(getOr(link, "mediaType", ""))
    if mediaType = "live"
        showScreen("PlayerScreen", { channelId: link.contentId }, false)
    else if mediaType = "movie" or mediaType = "episode" or mediaType = "shortformvideo"
        showScreen("PlayerScreen", { itemId: link.contentId }, false)
    else
        showScreen("DetailScreen", { itemId: link.contentId }, false)
    end if
end sub
