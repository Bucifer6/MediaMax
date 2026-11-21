sub init()
    m.top.functionName = "runRequest"
end sub

sub runRequest()
    req = m.top.request
    res = performRequest(req)
    ' Optional second request sent only after the first finished (e.g. final progress report, then stop the session).
    if req.followUp <> invalid then performRequest(req.followUp)
    m.top.response = res
end sub

' Device headers the server records for the session list (X-MediaMax-*) plus the bearer token.
sub addMediaMaxHeaders(xfer as object, token as dynamic)
    g = m.global
    xfer.AddHeader("Accept", "application/json")
    xfer.AddHeader("X-MediaMax-Device-Id", g.deviceId)
    xfer.AddHeader("X-MediaMax-Device-Name", g.deviceName)
    xfer.AddHeader("X-MediaMax-Platform", "roku")
    xfer.AddHeader("X-MediaMax-Version", g.appVersion)
    if not isNonEmptyString(token) then token = g.token
    if isNonEmptyString(token) then xfer.AddHeader("Authorization", "Bearer " + token)
end sub

function performRequest(req as object) as object
    res = { id: req.id, ok: false, status: 0, data: invalid, error: "", errorCode: "", context: req.context }
    path = req.path
    url = ""
    if Left(LCase(path), 4) = "http"
        url = path
    else
        base = req.baseUrl
        if not isNonEmptyString(base) then base = m.global.serverUrl
        if not isNonEmptyString(base)
            res.error = "No server configured"
            res.errorCode = "no_server"
            return res
        end if
        url = base + "/api/v1" + path
    end if

    port = CreateObject("roMessagePort")
    xfer = CreateObject("roUrlTransfer")
    xfer.SetMessagePort(port)
    xfer.SetUrl(url)
    xfer.RetainBodyOnError(true)
    xfer.EnableEncodings(true)
    if Left(LCase(url), 6) = "https:"
        xfer.SetCertificatesFile("common:/certs/ca-bundle.crt")
        xfer.InitClientCertificates()
    end if
    ' An explicit token (background requests) wins over the current one, which may already be cleared.
    addMediaMaxHeaders(xfer, req.token)

    method = UCase(req.method)
    started = false
    if method = "GET"
        started = xfer.AsyncGetToString()
    else
        ' Fastify rejects an empty JSON body, so POST / PATCH / DELETE always send one.
        body = req.body
        if body = invalid then body = {}
        xfer.AddHeader("Content-Type", "application/json")
        xfer.SetRequest(method)
        started = xfer.AsyncPostFromString(FormatJson(body))
    end if
    if not started
        res.error = "Could not start the request"
        res.errorCode = "network"
        return res
    end if

    timeoutMs = 20000
    if req.timeoutMs <> invalid then timeoutMs = req.timeoutMs
    msg = wait(timeoutMs, port)
    if type(msg) <> "roUrlEvent"
        xfer.AsyncCancel()
        res.status = -28
        res.error = "The server did not answer in time."
        res.errorCode = "timeout"
        return res
    end if

    code = msg.GetResponseCode()
    text = msg.GetString()
    res.status = code
    data = invalid
    if text <> invalid and text <> "" then data = ParseJson(text)
    res.data = data
    if code >= 200 and code < 300
        res.ok = true
    else if code < 0
        ' Negative codes are cURL errors: DNS, refused connection, TLS …
        res.error = "Can't reach the server (" + msg.GetFailureReason() + ")"
        res.errorCode = "network"
    else
        res.error = "Request failed (" + code.ToStr() + ")"
        res.errorCode = "http"
        if data <> invalid and GetInterface(data, "ifAssociativeArray") <> invalid
            if isNonEmptyString(data.message) then res.error = data.message
            if isNonEmptyString(data.error) then res.errorCode = data.error
        end if
    end if
    return res
end function
