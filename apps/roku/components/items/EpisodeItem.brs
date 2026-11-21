sub init()
    m.bg = m.top.findNode("bg")
    m.thumb = m.top.findNode("thumb")
    m.title = m.top.findNode("title")
    m.meta = m.top.findNode("meta")
    m.overview = m.top.findNode("overview")
    m.progressBg = m.top.findNode("progressBg")
    m.progressBar = m.top.findNode("progressBar")
end sub

sub onSize()
    m.bg.width = m.top.width
    m.bg.height = m.top.height
    textW = m.top.width - 276 - 20
    m.title.width = textW
    m.meta.width = textW
    m.overview.width = textW
end sub

sub onContent()
    c = m.top.itemContent
    if c = invalid then return
    m.title.text = c.title
    m.meta.text = c.meta
    m.overview.text = c.description
    m.thumb.uri = c.HDPosterUrl
    p = c.progress
    if p = invalid then p = 0
    show = p > 0.01 and p < 0.98
    m.progressBg.visible = show
    m.progressBar.visible = show
    m.progressBar.width = 240 * p
end sub

sub onFocus()
    if m.top.itemHasFocus and m.top.listHasFocus then m.bg.color = "0x2E3780FF" else m.bg.color = "0x1E2452FF"
end sub
