---
title: Can't connect from outside home
summary: Why the server works at home but not on mobile data or at a friend's, and how to fix it.
section: troubleshooting
audience: everyone
keywords: remote, outside, away, mobile data, 4g, 5g, cannot connect, can't reach the server, offline, server offline, retrying, port forward, https, certificate, home only, vpn, tailscale
related: login-problems, admin-network, buffering
order: 5
---

## For everyone

- **Use the right address.** At home you may use an address like `192.168.1.10:8484`, which only works inside your home network. Away from home you need the server's public address (often `https://…`). Ask your admin.
- **"Can't reach the server"**: check your own internet connection, then try the address in a browser.
- **"Server offline — retrying…" page**: the browser couldn't reach the server when the page loaded. Leave it open: it checks again every few seconds and opens {{product}} by itself as soon as the server answers. Nothing you were watching is stored on the device.
- **Your account may be home-only.** If streaming outside the home network isn't allowed for your account, playback fails away from home. Ask your admin.
- **Certificate warnings**: don't continue past a browser security warning; tell your admin.

## For admins

1. **Set a Public URL** in **Admin → Server settings → General**, and give people that address.
2. **Make the server reachable** in one of these ways (see [Network & HTTPS](help:admin-network)):
   - built-in HTTPS with a domain and ports 80 and 443 forwarded;
   - your own reverse proxy (Nginx, Traefik, Caddy, Nginx Proxy Manager);
   - Cloudflare Tunnel or Tailscale, which also work behind CGNAT (common on mobile broadband, where port forwarding can't work);
   - a port forward to 8484 (plain HTTP: passwords are not encrypted).
3. **Check the connection** in **Admin → Network & HTTPS → Connection check**, opened through the public address.
4. **Streams stop after a minute behind your own proxy**: turn off response buffering and lengthen timeouts on the proxy.
