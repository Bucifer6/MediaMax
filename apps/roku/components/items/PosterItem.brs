' Card layout: artwork fills the top (height - 76 px), two text lines underneath.
sub init()
    m.frame = m.top.findNode("frame")
    m.placeholder = m.top.findNode("placeholder")
    m.placeholderText = m.top.findNode("placeholderText")
    m.poster = m.top.findNode("poster")
    m.progressBg = m.top.findNode("progressBg")
    m.progressBar = m.top.findNode("progressBar")
    m.badge = m.top.findNode("badge")
    m.badgeBg = m.top.findNode("badgeBg")
    m.badgeText = m.top.findNode("badgeText")
    m.title = m.top.findNode("title")
    m.line2 = m.top.findNode("line2")
    m.textHeight = 76
end sub

sub onSize()
    w = m.top.width
    h = m.top.height
    if w <= 0 or h <= 0 then return
    artH = h - m.textHeight
    if artH < 40 then artH = h
    m.frame.translation = [-4, -4]
    m.frame.width = w + 8
    m.frame.height = artH + 8
    m.placeholder.width = w
    m.placeholder.height = artH
    m.placeholderText.width = w - 20
    m.placeholderText.height = artH
    m.placeholderText.translation = [10, 0]
    m.poster.width = w
    m.poster.height = artH
    m.progressBg.width = w
    m.progressBg.height = 8
    m.progressBg.translation = [0, artH - 8]
    m.progressBar.height = 8
    m.progressBar.translation = [0, artH - 8]
    m.badge.translation = [w - m.badgeBg.width - 8, 8]
    m.title.width = w
    m.title.translation = [0, artH + 10]
    m.line2.width = w
    m.line2.translation = [0, artH + 44]
    updateProgress()
end sub

sub onContent()
    c = m.top.itemContent
    if c = invalid then return
    m.title.text = c.title
    m.line2.text = c.line2
    m.placeholderText.text = c.title
    if c.itemType = "channel" then m.poster.loadDisplayMode = "scaleToFit" else m.poster.loadDisplayMode = "scaleToZoom"
    m.poster.uri = c.HDPosterUrl
    if c.badge <> invalid and c.badge <> ""
        setBadge(c.badge, "0xA855F7FF", 48)
    else if c.played = true
        setBadge("Watched", "0x16A34AFF", 110)
    else
        m.badge.visible = false
    end if
    updateProgress()
end sub

sub setBadge(text as string, color as string, width as integer)
    m.badgeText.text = text
    m.badgeText.width = width
    m.badgeBg.width = width
    m.badgeBg.color = color
    m.badge.translation = [m.top.width - width - 8, 8]
    m.badge.visible = true
end sub

sub updateProgress()
    c = m.top.itemContent
    if c = invalid or c.progress = invalid then return
    p = c.progress
    show = p > 0.01 and p < 0.98
    m.progressBg.visible = show
    m.progressBar.visible = show
    m.progressBar.width = m.top.width * p
end sub

sub onFocus()
    ' Focus ring: fade the frame in with the RowList / grid focus animation.
    m.frame.opacity = m.top.focusPercent
    if m.top.itemHasFocus then m.frame.color = "0x22D3EEFF" else m.frame.color = "0x2A3166FF"
end sub
