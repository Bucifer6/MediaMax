' MediaMax for Roku - channel entry point.
' Creates the SceneGraph screen, hands launch / roInput deep links to the scene and keeps the main thread alive.

sub Main(args as dynamic)
    screen = CreateObject("roSGScreen")
    port = CreateObject("roMessagePort")
    screen.SetMessagePort(port)

    ' Global state shared by every component and task thread (see MainScene.brs initGlobals()).
    m.global = screen.getGlobalNode()

    scene = screen.CreateScene("MainScene")
    screen.Show()

    ' Deep link at launch (Roku certification: contentId + mediaType).
    if args <> invalid and args.contentId <> invalid and args.contentId <> ""
        scene.deepLink = { contentId: args.contentId, mediaType: args.mediaType }
    end if

    ' Deep links while running (ECP /input).
    input = CreateObject("roInput")
    input.SetMessagePort(port)

    scene.observeField("exitChannel", port)

    while true
        msg = wait(0, port)
        msgType = type(msg)
        if msgType = "roSGScreenEvent"
            if msg.IsScreenClosed() then return
        else if msgType = "roSGNodeEvent"
            if msg.GetField() = "exitChannel" and msg.GetData() = true
                screen.Close()
                return
            end if
        else if msgType = "roInputEvent"
            info = msg.GetInfo()
            if info <> invalid and info.contentId <> invalid
                scene.deepLink = { contentId: info.contentId, mediaType: info.mediaType }
            end if
        end if
    end while
end sub
