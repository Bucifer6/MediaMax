sub init()
    m.bg = m.top.findNode("bg")
    m.logo = m.top.findNode("logo")
    m.name = m.top.findNode("name")
    m.star = m.top.findNode("star")
    m.now = m.top.findNode("now")
    m.next = m.top.findNode("next")
    m.progressBg = m.top.findNode("progressBg")
    m.progressBar = m.top.findNode("progressBar")
end sub

sub onSize()
    w = m.top.width
    m.bg.width = w
    m.bg.height = m.top.height
    textW = w - 760 - 24
    if textW < 100 then textW = 100
    m.now.width = textW
    m.next.width = textW
    m.progressBg.width = textW
    updateProgress()
end sub

sub onContent()
    c = m.top.itemContent
    if c = invalid then return
    m.name.text = c.title
    m.logo.uri = c.HDPosterUrl
    if c.line2 <> "" then m.now.text = c.line2 else m.now.text = "No guide data"
    m.next.text = ""
    if c.nextLine <> invalid and c.nextLine <> "" then m.next.text = "Next: " + c.nextLine
    m.star.visible = c.favorite = true
    updateProgress()
end sub

sub updateProgress()
    c = m.top.itemContent
    if c = invalid then return
    p = c.progress
    if p = invalid then p = 0
    m.progressBg.visible = p > 0
    m.progressBar.visible = p > 0
    m.progressBar.width = m.progressBg.width * p
end sub

sub onFocus()
    if m.top.itemHasFocus then m.bg.color = "0x2E3780FF" else m.bg.color = "0x1E2452FF"
end sub
