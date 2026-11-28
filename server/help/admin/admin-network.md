---
title: Network & HTTPS
summary: Choose how people reach the server — direct, behind your own reverse proxy, or with built-in HTTPS — and set up remote access.
section: admin
audience: admin
keywords: network, https, ssl, certificate, lets encrypt, reverse proxy, nginx, traefik, caddy, cloudflare tunnel, tailscale, trusted proxies, x-forwarded-for, port forward, upnp, remote access, public url
related: remote-connection, admin-security, admin-adaptive-streaming
order: 4
---

**Admin → Network & HTTPS** decides how people reach the server. Changes apply at once, without a restart.

## Connection mode

| Mode | Use it when |
|---|---|
| **Direct** (default) | People connect straight to port 8484: at home, over a VPN or Tailscale, or through a port forward. |
| **Behind my reverse proxy** | You already run Nginx, Traefik, Caddy, Nginx Proxy Manager, SWAG or Cloudflare Tunnel. The page shows ready-to-copy configuration for each. |
| **Built-in HTTPS** | No proxy, but you want a certificate. {{product}} runs Caddy itself and gets a free Let's Encrypt certificate. |

### Connection check

This box shows how your own request arrived. If it says your request came through a proxy that isn't trusted, add that proxy's address under **Trusted proxies**; otherwise every visitor looks like the proxy, and one person's wrong passwords can lock everyone out.

### Proxy configuration examples

Set **Vibe address seen by your proxy** to the address your proxy can actually reach. The standard Docker Compose
file uses `vibe:8484`; the deploy kit retains `mediamax:8484`. A proxy running directly on the same machine can use
`127.0.0.1:8484`. This field changes the copy-ready examples; it does not rename containers or change server settings.

### Built-in HTTPS needs

- a domain whose DNS points at the server;
- ports 80 and 443 reachable from the internet (forwarded on your router) and not used by anything else;
- in Docker, ports 80 and 443 published as well as 8484.

Use **Test mode** (Let's Encrypt staging) while you get DNS and ports right, to avoid rate limits.

## Remote access

**Admin → Remote access** shows the server's external address and can **Forward a port automatically (UPnP)** on routers that allow it. A port forward without HTTPS sends passwords unencrypted: prefer built-in HTTPS, your own proxy, a Cloudflare Tunnel or Tailscale.

## Public URL

Set **Admin → Server settings → General → Public URL** (for example `https://media.example.com`). It is used in links, invites, the TV sign-in code screen and webhooks.

## Can't connect from outside?

See [Can't connect from outside home](help:remote-connection). Behind CGNAT (common on mobile broadband) incoming connections can't work at all; use Cloudflare Tunnel or Tailscale.
