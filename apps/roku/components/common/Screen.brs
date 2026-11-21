' Helpers for screens (components extending BaseScreen). Call screenInit(defaultFocusNode) from init().

sub screenInit(defaultFocus as dynamic)
    m.scene = m.top.getScene()
    m.defaultFocus = defaultFocus
    m.lastFocus = invalid
    m.top.observeField("focusedChild", "onScreenFocusChanged")
end sub

' MainScene focuses the screen node itself; hand focus on to the last focused (or default) child.
sub onScreenFocusChanged()
    if not m.top.hasFocus() then return
    target = m.lastFocus
    if target = invalid then target = m.defaultFocus
    if target <> invalid then target.setFocus(true)
end sub

sub focusNode(node as object)
    m.lastFocus = node
    node.setFocus(true)
end sub

sub navigate(screen as string, params = {} as object)
    m.scene.navigate = { screen: screen, params: params }
end sub

sub goBack()
    m.scene.goBack = true
end sub

sub showToast(message as string)
    m.scene.toast = message
end sub

sub setLoading(on as boolean)
    m.scene.loading = on
end sub

' Message dialog with an OK button.
sub showMessage(title as string, message as string)
    dlg = CreateObject("roSGNode", "StandardMessageDialog")
    dlg.title = title
    dlg.message = [message]
    dlg.buttons = ["OK"]
    dlg.observeField("buttonSelected", "onMessageDialogDone")
    dlg.observeField("wasClosed", "onMessageDialogDone")
    m.scene.dialog = dlg
end sub

' Closes the dialog that fired (a later dialog may already be showing) and gives focus back to the screen.
sub onMessageDialogDone(event as object)
    dlg = event.getRoSGNode()
    dlg.unobserveField("wasClosed")
    dlg.unobserveField("buttonSelected")
    current = m.scene.dialog
    if current <> invalid and current.isSameNode(dlg)
        dlg.close = true
        restoreFocus()
    end if
end sub

sub restoreFocus()
    target = m.lastFocus
    if target = invalid then target = m.defaultFocus
    if target <> invalid and m.top.visible then target.setFocus(true)
end sub

' Option picker: a dialog with one button per choice. `callback` receives the node event of `buttonSelected`.
function showChoiceDialog(title as string, choices as object, callback as string) as object
    dlg = CreateObject("roSGNode", "StandardMessageDialog")
    dlg.title = title
    dlg.buttons = choices
    dlg.observeField("buttonSelected", callback)
    dlg.observeField("wasClosed", "onMessageDialogDone")
    m.scene.dialog = dlg
    return dlg
end function

sub closeDialog()
    dlg = m.scene.dialog
    if dlg <> invalid
        dlg.unobserveField("wasClosed")
        dlg.unobserveField("buttonSelected")
        dlg.close = true
    end if
    restoreFocus()
end sub

' On-screen keyboard. `callback` gets the node event of `buttonSelected`; read the text from m.keyboardDialog.text.
function showKeyboard(title as string, text as string, secure as boolean, callback as string, hint = "" as string) as object
    dlg = CreateObject("roSGNode", "StandardKeyboardDialog")
    dlg.title = title
    dlg.text = text
    if hint <> "" then dlg.message = [hint]
    dlg.buttons = ["OK", "Cancel"]
    if secure then dlg.keyboardDomain = "password"
    dlg.observeField("buttonSelected", callback)
    dlg.observeField("wasClosed", "onMessageDialogDone")
    m.keyboardDialog = dlg
    m.scene.dialog = dlg
    return dlg
end function

' Numeric PIN pad. `callback` gets the node event of `buttonSelected`; the PIN is m.pinDialog.pin.
function showPinPad(title as string, pinLength as integer, callback as string) as object
    dlg = CreateObject("roSGNode", "StandardPinPadDialog")
    dlg.title = title
    if pinLength > 0 then dlg.pinPad.pinLength = pinLength
    dlg.buttons = ["OK", "Cancel"]
    dlg.observeField("buttonSelected", callback)
    dlg.observeField("wasClosed", "onMessageDialogDone")
    m.pinDialog = dlg
    m.scene.dialog = dlg
    return dlg
end function
