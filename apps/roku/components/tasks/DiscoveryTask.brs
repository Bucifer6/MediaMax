sub init()
    m.top.functionName = "runDiscovery"
end sub

sub runDiscovery()
    bases = ssdpSearch(m.top.timeoutMs)
    servers = []
    for each base in bases
        info = fetchSystemInfo(base)
        if info <> invalid
            servers.Push({ url: base, name: getOr(info, "name", "Vibe"), version: getOr(info, "version", "") })
        end if
    end for
    m.top.servers = servers
    m.top.done = true
end sub

' Multicast M-SEARCH; returns the distinct server base URLs (http://host:port) that identify as Vibe.
function ssdpSearch(timeoutMs as integer) as object
    crlf = Chr(13) + Chr(10)
    found = {}
    order = []
    port = CreateObject("roMessagePort")
    sock = CreateObject("roDatagramSocket")
    if sock = invalid then return order
    sock.setMessagePort(port)
    local = CreateObject("roSocketAddress")
    local.setPort(0)
    sock.setAddress(local)
    dest = CreateObject("roSocketAddress")
    dest.setAddress("239.255.255.250:1900")
    sock.setSendToAddress(dest)
    sock.setMulticastTTL(4)
    sock.notifyReadable(true)

    search = "M-SEARCH * HTTP/1.1" + crlf
    search = search + "HOST: 239.255.255.250:1900" + crlf
    search = search + "MAN: " + Chr(34) + "ssdp:discover" + Chr(34) + crlf
    search = search + "MX: 2" + crlf
    search = search + "ST: urn:schemas-upnp-org:device:MediaServer:1" + crlf + crlf
    ' UDP is lossy: send twice.
    sock.sendStr(search)
    sock.sendStr(search)

    timer = CreateObject("roTimespan")
    timer.Mark()
    while timer.TotalMilliseconds() < timeoutMs
        ev = wait(250, port)
        if type(ev) = "roSocketEvent" and sock.isReadable()
            reply = sock.receiveStr(8192)
            base = parseSsdpReply(reply)
            if base <> "" and not found.DoesExist(base)
                found[base] = true
                order.Push(base)
            end if
        end if
    end while
    sock.close()
    return order
end function

function parseSsdpReply(reply as dynamic) as string
    if not isNonEmptyString(reply) then return ""
    location = ""
    server = ""
    lines = reply.Split(Chr(10))
    for each raw in lines
        line = raw.Trim()
        colon = Instr(1, line, ":")
        if colon > 1
            key = LCase(Left(line, colon - 1).Trim())
            value = Mid(line, colon + 1).Trim()
            if key = "location" then location = value
            if key = "server" then server = value
        end if
    end for
    if (Instr(1, LCase(server), "kinora") = 0 and Instr(1, LCase(server), "mediamax") = 0) or location = "" then return ""
    cut = Instr(1, location, "/dlna/")
    if cut = 0 then return ""
    return Left(location, cut - 1)
end function

function fetchSystemInfo(base as string) as dynamic
    xfer = CreateObject("roUrlTransfer")
    port = CreateObject("roMessagePort")
    xfer.SetMessagePort(port)
    xfer.SetUrl(base + "/api/v1/system/info")
    xfer.AddHeader("Accept", "application/json")
    if not xfer.AsyncGetToString() then return invalid
    msg = wait(3000, port)
    if type(msg) <> "roUrlEvent"
        xfer.AsyncCancel()
        return invalid
    end if
    if msg.GetResponseCode() <> 200 then return invalid
    return ParseJson(msg.GetString())
end function
