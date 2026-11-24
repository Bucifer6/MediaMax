---
title: What's new in {{product}} {{version}}
version: 0.3.0
---

- **Smoother hardware transcoding**: the Docker image now ships an FFmpeg build with full GPU support, so HDR films are converted to SDR on NVIDIA cards, Quick Sync works on recent Intel chips (N100, Arc, Core Ultra) and Rockchip boards can transcode. When the graphics card can't handle a file, {{product}} now steps down gradually instead of dropping straight to the processor, interlaced TV and DVDs are deinterlaced, and the hardware check runs again on its own after an upgrade.
- **A lighter, quicker server**: guide refreshes, music apps (Subsonic) and folder watching no longer make the server stall; when you add an episode, only that show's folder is rescanned; library pages and search send about 40% less data; and idle rescans no longer rewrite the database.
- **Safer libraries**: if a folder can't be read for a moment (a network share dropping out), its titles and watch history are kept instead of being removed.
- **Live TV**: SAT>IP recordings and live TV in the browser work again, a channel whose stream dropped restarts for the next viewer, and large playlists import much faster.
- **Security**: two-factor codes can only be used once, PIN guesses share one limit, API keys can't sign devices in or change sign-in settings and no longer appear in links, and failed music-app sign-ins are limited per address.
- **Players**: audio no longer keeps playing after you leave a film, subtitles you switch off stay off, and many smaller fixes on the web, phones and TVs.

See [What is {{product}}?](help:welcome) for a tour.
