sub init()
    m.ring = m.top.findNode("ring")
    m.tile = m.top.findNode("tile")
    m.initial = m.top.findNode("initial")
    m.avatar = m.top.findNode("avatar")
    m.name = m.top.findNode("name")
    m.lock = m.top.findNode("lock")
end sub

sub onContent()
    c = m.top.itemContent
    if c = invalid then return
    m.name.text = c.title
    m.initial.text = UCase(Left(c.title, 1))
    m.avatar.uri = c.HDPosterUrl
    if c.color <> invalid and c.color <> "" then m.tile.color = c.color
    lockText = ""
    if c.isKids = true then lockText = "Kids"
    if c.hasPin = true
        if lockText <> "" then lockText = lockText + " · "
        lockText = lockText + "PIN"
    end if
    m.lock.text = lockText
end sub

sub onFocus()
    m.ring.opacity = m.top.focusPercent
end sub
