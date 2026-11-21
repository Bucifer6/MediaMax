' Render-thread side of the API client. roUrlTransfer can't run on the render thread, so every request runs in its
' own ApiTask; the task's `response` field fires `callback` (a sub in the calling component taking the node event).
'
'   apiCall("GET", "/home", invalid, "onHome")
'   sub onHome(event as object)
'       res = apiResult(event)    ' { ok, status, data, error, errorCode, context }
'   end sub

function apiCall(method as string, path as string, body as dynamic, callback as string, context = invalid as dynamic) as object
    if m.apiSeq = invalid then m.apiSeq = 0
    if m.apiTasks = invalid then m.apiTasks = {}
    m.apiSeq = m.apiSeq + 1
    id = "req" + m.apiSeq.ToStr()
    task = CreateObject("roSGNode", "ApiTask")
    task.request = { id: id, method: method, path: path, body: body, context: context }
    task.observeField("response", callback)
    ' Keep a reference so the task node isn't released before it answers.
    m.apiTasks[id] = task
    task.control = "RUN"
    return task
end function

function apiResult(event as object) as object
    res = event.getData()
    if res = invalid then res = { ok: false, status: -1, data: invalid, error: "No response", errorCode: "network" }
    if m.apiTasks <> invalid and res.id <> invalid then m.apiTasks.Delete(res.id)
    return res
end function

' Cancel bookkeeping for every in-flight request of this component (their callbacks no longer fire).
sub apiCancelAll()
    if m.apiTasks = invalid then return
    for each id in m.apiTasks
        task = m.apiTasks[id]
        task.unobserveField("response")
        task.control = "STOP"
    end for
    m.apiTasks = {}
end sub

' Query string from [key, value] pairs (pairs, not an AA, so key case is never in doubt). Invalid / empty values are skipped.
'   apiQuery([["libraryId", id], ["limit", 60]]) → "?libraryId=…&limit=60"
function apiQuery(pairs as object) as string
    parts = []
    for each pair in pairs
        k = pair[0]
        v = pair[1]
        if v <> invalid
            s = ""
            if GetInterface(v, "ifString") <> invalid
                s = v
            else if type(v) = "Boolean" or type(v) = "roBoolean"
                if v then s = "true" else s = "false"
            else
                s = v.ToStr()
            end if
            if s <> "" then parts.Push(k + "=" + urlEncode(s))
        end if
    end for
    if parts.Count() = 0 then return ""
    return "?" + parts.Join("&")
end function
