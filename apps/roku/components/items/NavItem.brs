sub init()
    m.bg = m.top.findNode("bg")
    m.label = m.top.findNode("label")
end sub

sub onSize()
    m.bg.width = m.top.width
    m.bg.height = m.top.height
    m.label.width = m.top.width
    m.label.height = m.top.height
end sub

sub onContent()
    if m.top.itemContent <> invalid then m.label.text = m.top.itemContent.title
end sub

sub onFocus()
    p = m.top.focusPercent
    if not m.top.gridHasFocus then p = 0
    m.bg.opacity = p
    if p > 0.5 then m.label.color = "0x0B0E26FF" else m.label.color = "0xFFFFFFFF"
end sub
