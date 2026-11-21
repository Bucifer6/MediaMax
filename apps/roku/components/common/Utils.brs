' Shared helpers for SceneGraph components and tasks (included with <script uri="pkg:/components/common/Utils.brs"/>).
'
' Note on JSON: dot-assignment (aa.fooBar = 1) lowercases keys in BrightScript. Request bodies are therefore always
' built with literals ({ fooBar: 1 }) or bracket access (aa["fooBar"]) so FormatJson keeps the server's camelCase.


function regRead(key as string, fallback = "" as string) as string
    sec = CreateObject("roRegistrySection", "Kinora")
    if sec.Exists(key) then return sec.Read(key)
    return fallback
end function

sub regWrite(key as string, value as string)
    sec = CreateObject("roRegistrySection", "Kinora")
    sec.Write(key, value)
    sec.Flush()
end sub

sub regDelete(key as string)
    sec = CreateObject("roRegistrySection", "Kinora")
    sec.Delete(key)
    sec.Flush()
end sub

' Safe field read for parsed JSON (returns fallback for missing / invalid values).
function getOr(aa as dynamic, key as string, fallback as dynamic) as dynamic
    if aa = invalid or GetInterface(aa, "ifAssociativeArray") = invalid then return fallback
    v = aa.Lookup(key)
    if v = invalid then return fallback
    return v
end function

function isNonEmptyString(v as dynamic) as boolean
    return v <> invalid and GetInterface(v, "ifString") <> invalid and v <> ""
end function

function isNumber(v as dynamic) as boolean
    if v = invalid then return false
    t = type(v)
    return t = "Integer" or t = "roInteger" or t = "LongInteger" or t = "Float" or t = "roFloat" or t = "Double" or t = "roDouble"
end function

function toInt(v as dynamic, fallback = 0 as integer) as integer
    if isNumber(v) then return Int(v)
    if isNonEmptyString(v) then return v.ToInt()
    return fallback
end function

' Server-relative path → absolute URL on the configured server. Absolute URLs pass through.
function absUrl(pathOrUrl as dynamic) as string
    if not isNonEmptyString(pathOrUrl) then return ""
    lower = LCase(pathOrUrl)
    if Left(lower, 7) = "http://" or Left(lower, 8) = "https://" then return pathOrUrl
    base = m.global.serverUrl
    if base = invalid then base = ""
    if Left(pathOrUrl, 1) <> "/" then return base + "/" + pathOrUrl
    return base + pathOrUrl
end function

' Image URL with the server's resize hint (`?w=`). /images is public, so no token is needed.
function imageUrl(path as dynamic, width as integer) as string
    url = absUrl(path)
    if url = "" then return ""
    base = m.global.serverUrl
    if base <> invalid and base <> "" and Left(url, Len(base)) = base
        if Instr(1, url, "?") > 0 then return url + "&w=" + width.ToStr()
        return url + "?w=" + width.ToStr()
    end if
    return url
end function

function urlEncode(s as string) as string
    return CreateObject("roUrlTransfer").Escape(s)
end function

' Normalise a typed server address: add http://, the default port and strip trailing slashes / "/web" paths.
function normalizeServerUrl(input as string) as string
    s = input.Trim()
    if s = "" then return ""
    lower = LCase(s)
    if Left(lower, 7) <> "http://" and Left(lower, 8) <> "https://" then s = "http://" + s
    while Right(s, 1) = "/"
        s = Left(s, Len(s) - 1)
    end while
    ' Add :8484 when no port was typed (host only).
    schemeEnd = Instr(1, s, "://") + 3
    rest = Mid(s, schemeEnd)
    slash = Instr(1, rest, "/")
    hostPart = rest
    pathPart = ""
    if slash > 0
        hostPart = Left(rest, slash - 1)
        pathPart = Mid(rest, slash)
    end if
    if Instr(1, hostPart, ":") = 0 and Left(LCase(s), 5) = "http:" then hostPart = hostPart + ":8484"
    return Left(s, schemeEnd - 1) + hostPart + pathPart
end function

function msToClock(ms as dynamic) as string
    total = Int(toInt(ms) / 1000)
    if total < 0 then total = 0
    h = Int(total / 3600)
    mins = Int((total mod 3600) / 60)
    secs = total mod 60
    mm = mins.ToStr()
    if h > 0 and mins < 10 then mm = "0" + mm
    ss = secs.ToStr()
    if secs < 10 then ss = "0" + ss
    if h > 0 then return h.ToStr() + ":" + mm + ":" + ss
    return mm + ":" + ss
end function

function msToRuntime(ms as dynamic) as string
    mins = Int(toInt(ms) / 60000)
    if mins <= 0 then return ""
    if mins < 60 then return mins.ToStr() + "m"
    h = Int(mins / 60)
    restMins = mins mod 60
    if restMins = 0 then return h.ToStr() + "h"
    return h.ToStr() + "h " + restMins.ToStr() + "m"
end function

' ISO-8601 (UTC, as the server sends it) → seconds since epoch.
function isoToSeconds(iso as dynamic) as integer
    if not isNonEmptyString(iso) then return 0
    dt = CreateObject("roDateTime")
    dt.FromISO8601String(iso)
    return dt.AsSeconds()
end function

function nowSeconds() as integer
    dt = CreateObject("roDateTime")
    return dt.AsSeconds()
end function

' "20:15" in the device's local time zone.
function isoToLocalTime(iso as dynamic) as string
    if not isNonEmptyString(iso) then return ""
    dt = CreateObject("roDateTime")
    dt.FromISO8601String(iso)
    dt.ToLocalTime()
    h = dt.GetHours()
    mi = dt.GetMinutes()
    mm = mi.ToStr()
    if mi < 10 then mm = "0" + mm
    return h.ToStr() + ":" + mm
end function

' ISO-8601 string for "now + offsetSeconds" (UTC).
function isoFromNow(offsetSeconds as integer) as string
    dt = CreateObject("roDateTime")
    dt.FromSeconds(dt.AsSeconds() + offsetSeconds)
    return dt.ToISOString()
end function

' "S1 · E4" / "S1E4" style labels.
function episodeLabel(item as dynamic) as string
    s = getOr(item, "parentIndex", invalid)
    e = getOr(item, "index", invalid)
    if s = invalid and e = invalid then return ""
    out = ""
    if s <> invalid then out = "S" + toInt(s).ToStr()
    if e <> invalid then out = out + "E" + toInt(e).ToStr()
    return out
end function

' Human label for an audio or subtitle stream.
function streamLabel(s as dynamic, isAudio as boolean) as string
    parts = []
    title = getOr(s, "title", invalid)
    lang = getOr(s, "language", invalid)
    if isNonEmptyString(title) then parts.Push(title)
    if isNonEmptyString(lang) and not (isNonEmptyString(title) and Instr(1, LCase(title), LCase(lang)) > 0) then parts.Push(UCase(lang))
    if isAudio
        fmt = getOr(s, "formatLabel", invalid)
        if not isNonEmptyString(fmt) then fmt = UCase(getOr(s, "codec", ""))
        if fmt <> "" then parts.Push(fmt)
        ch = toInt(getOr(s, "channels", 0))
        if ch = 6
            parts.Push("5.1")
        else if ch = 8
            parts.Push("7.1")
        else if ch = 2
            parts.Push("Stereo")
        else if ch = 1
            parts.Push("Mono")
        end if
    else
        if getOr(s, "forced", false) = true then parts.Push("Forced")
        codec = LCase(getOr(s, "codec", ""))
        if codec = "hdmv_pgs_subtitle" or codec = "dvd_subtitle" or codec = "dvb_subtitle" then parts.Push("(burned in)")
    end if
    if parts.Count() = 0 then return "Track " + toInt(getOr(s, "index", 0)).ToStr()
    return parts.Join(" · ")
end function

function joinNonEmpty(parts as object, sep as string) as string
    out = []
    for each p in parts
        if isNonEmptyString(p)
            out.Push(p)
        else if isNumber(p)
            out.Push(p.ToStr())
        end if
    end for
    return out.Join(sep)
end function

' Playable leaf item types (the rest open a detail / child list).
function isPlayableType(t as dynamic) as boolean
    return t = "movie" or t = "episode" or t = "video"
end function
