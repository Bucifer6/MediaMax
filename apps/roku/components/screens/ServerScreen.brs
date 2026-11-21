sub init()
    m.list = m.top.findNode("list")
    m.status = m.top.findNode("status")
    m.error = m.top.findNode("error")
    m.servers = []
    screenInit(m.list)
    m.list.observeField("itemSelected", "onItemSelected")
    m.top.observeField("params", "onParams")
    buildList()
    startDiscovery()
end sub

sub onParams()
    p = m.top.params
    if p <> invalid and isNonEmptyString(p.error) then m.error.text = p.error
end sub

sub startDiscovery()
    m.status.text = "Searching your network..."
    m.discovery = CreateObject("roSGNode", "DiscoveryTask")
    m.discovery.observeField("done", "onDiscoveryDone")
    m.discovery.control = "RUN"
end sub

sub onDiscoveryDone()
    m.servers = m.discovery.servers
    if m.servers = invalid then m.servers = []
    if m.servers.Count() = 0
        m.status.text = "No servers found automatically. (Discovery needs DLNA turned on in the server's settings.)"
    else
        m.status.text = "Servers on your network"
    end if
    buildList()
end sub

sub buildList()
    root = CreateObject("roSGNode", "ContentNode")
    for each s in m.servers
        row = root.createChild("ContentNode")
        label = s.name + "   " + s.url
        if isNonEmptyString(s.version) then label = label + "   (v" + s.version + ")"
        row.title = label
    end for
    manual = root.createChild("ContentNode")
    manual.title = "Enter server address..."
    again = root.createChild("ContentNode")
    again.title = "Search the network again"
    m.list.content = root
end sub

sub onItemSelected()
    i = m.list.itemSelected
    n = m.servers.Count()
    if i < n
        verifyServer(m.servers[i].url)
    else if i = n
        last = m.global.serverUrl
        if last = invalid then last = ""
        showKeyboard("Server address", last, false, "onAddressEntered", "Host or IP with port, e.g. 192.168.1.20:8484")
    else
        startDiscovery()
    end if
end sub

sub onAddressEntered(event as object)
    button = event.getData()
    text = m.keyboardDialog.text
    closeDialog()
    if button <> 0 then return
    url = normalizeServerUrl(text)
    if url = "" then return
    verifyServer(url)
end sub

' GET /system/info on the candidate before saving it.
sub verifyServer(url as string)
    m.candidate = url
    m.error.text = ""
    setLoading(true)
    task = CreateObject("roSGNode", "ApiTask")
    task.request = { id: "verify", method: "GET", path: "/system/info", baseUrl: url, timeoutMs: 8000 }
    task.observeField("response", "onVerified")
    m.verifyTask = task
    task.control = "RUN"
end sub

sub onVerified(event as object)
    res = event.getData()
    setLoading(false)
    if not res.ok
        m.error.text = "Couldn't connect to " + m.candidate + ": " + res.error
        return
    end if
    info = res.data
    if info = invalid or info.version = invalid
        m.error.text = m.candidate + " doesn't look like a Kinora server."
        return
    end if
    if info.setupRequired = true
        m.error.text = "This server isn't set up yet. Finish the setup wizard in a web browser first."
        return
    end if
    ' A different server invalidates the saved token.
    if m.global.serverUrl <> m.candidate
        m.global.token = ""
        regDelete("token")
    end if
    m.global.serverUrl = m.candidate
    m.global.serverName = getOr(info, "name", "Kinora")
    m.global.features = getOr(info, "features", {})
    regWrite("serverUrl", m.candidate)
    regWrite("serverName", m.global.serverName)
    m.scene.resetTo = { screen: "SignInScreen", params: {} }
end sub
