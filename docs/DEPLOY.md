# Deploying Kinora securely

`deploy/install.sh` sets up Kinora on a Linux server with Docker in one go: HTTPS with a free certificate,
a hardened reverse proxy, CrowdSec and/or fail2ban against password guessing, your media folders mounted
read-only, hardware transcoding, and upgrades. This page explains what it does, how to run each piece by hand,
and how to fix things when they go wrong. For other platforms (NAS units, Windows, Linux without Docker), see
[INSTALL.md](INSTALL.md).

Contents: [Quick start](#quick-start) · [What gets installed](#what-gets-installed) ·
[The installer](#the-installer) · [Caddy](#caddy) · [Nginx](#nginx) ·
[Existing reverse proxy](#existing-reverse-proxy) · [Cloudflare Tunnel](#cloudflare-tunnel) ·
[Tailscale](#tailscale) · [CrowdSec](#crowdsec) · [fail2ban](#fail2ban) · [Unbanning an address](#unbanning-an-address) ·
[Hardening defaults](#hardening-defaults) · [Upgrades and backups](#upgrades-and-backups) ·
[Troubleshooting](#troubleshooting) · [Network & HTTPS in the admin](#network--https-admin--network)

> **No reverse proxy by default.** Out of the box Kinora answers plain HTTP on port 8484 and runs no proxy of
> its own, so it drops straight in behind an Nginx, Traefik, NPM, SWAG or Caddy you already run. Turn on HTTPS
> where it suits you: the installer's `--proxy caddy|nginx`, your own proxy, or **Admin → Network & HTTPS →
> Built-in HTTPS** (see [below](#network--https-admin--network)).

---

## Quick start

You need a Linux server (x86-64 or arm64) with Docker, and for HTTPS a domain name whose DNS A/AAAA record points
at the server, with ports 80 and 443 reachable from the internet.

```bash
curl -fsSL https://raw.githubusercontent.com/Bucifer6/MediaMax/main/deploy/install.sh | sudo bash
```

Prefer to read a script before running it as root? Download, read, then run:

```bash
curl -fsSLO https://raw.githubusercontent.com/Bucifer6/MediaMax/main/deploy/install.sh
less install.sh
sudo bash install.sh
```

The installer asks a few questions (each has a sensible default), shows a summary, and then starts everything
and waits until Kinora answers. Open the address it prints and **create the administrator account straight
away**: until then, anyone who reaches the page can claim the server.

Unattended, with flags (or the environment variables listed in `install.sh --help`):

```bash
sudo bash install.sh --yes --domain media.example.com --email you@example.com \
  --proxy caddy --security crowdsec --media /srv/movies --media /srv/tv --media /srv/photos:rw
```

Afterwards the installer lives in the install folder:

```bash
sudo /opt/kinora/install.sh            # reconfigure (current answers are the defaults)
sudo /opt/kinora/install.sh --upgrade  # new images and deploy files, restart
sudo /opt/kinora/install.sh --status   # containers, health, bans, recent sign-in failures
sudo /opt/kinora/install.sh --uninstall [--purge]
```

## What gets installed

| Component | Why | When |
|---|---|---|
| **Kinora** (`ghcr.io/bucifer6/kinora`) | the server | always |
| **Caddy** | HTTPS with automatic certificates, HTTP→HTTPS, HTTP/3, compression, security headers, access log | proxy `caddy` (the default is `none`) |
| **Nginx + Certbot** | the same with Nginx; Certbot gets and renews the certificate | proxy `nginx` |
| **CrowdSec** | reads the Kinora security log and the proxy log, bans brute force, scanners and known-bad addresses (community blocklist) | security `crowdsec` (default) or `both` |
| **CrowdSec bouncer in Caddy** | blocks the addresses CrowdSec decides on, with a 403 | Caddy + CrowdSec |
| **CrowdSec firewall bouncer** (on the host) | blocks those addresses in iptables | Nginx/none/existing + CrowdSec, if you agree |
| **fail2ban** | bans addresses with repeated failed sign-ins in the host firewall | security `fail2ban` or `both` |
| **cloudflared** | Cloudflare Tunnel instead of open ports | proxy `tunnel` |

Everything runs as one Docker Compose project called `mediamax`, with the optional services switched on by
**compose profiles** (`COMPOSE_PROFILES` in `.env`: `caddy`, `nginx`, `crowdsec`, `fail2ban`, `tunnel`).

The install folder (default `/opt/kinora`):

```
/opt/kinora
├── .env                     your answers (mode 600; holds the CrowdSec bouncer key and tunnel token)
├── docker-compose.yml       generated from .env; regenerated on every run (previous copy: .bak)
├── docker-compose.override.yml   optional, yours: merged automatically, never touched by the installer
├── mediamax.env             extra Kinora settings (TMDB_API_KEY=..., MEDIAMAX_EXTRA_GIDS=...), kept
├── install.sh               the installer, for --upgrade/--status/--uninstall
├── config/                  Kinora data (/config): database, artwork, logs/security.log, backups/
├── recordings/              DVR recordings
├── logs/caddy, logs/nginx   proxy access logs (read by CrowdSec/fail2ban)
├── caddy/                   Caddyfile, conf.d/ (generated snippets), Dockerfile (Caddy + bouncer)
├── nginx/                   templates/ (site config), snippets/, maintenance script
├── letsencrypt/, certbot-www/   Nginx certificates
├── crowdsec/                acquis.yaml, Kinora parser and scenarios
├── fail2ban/                jail.d/, filter.d/, ban database
└── snippets/nginx/          reference configs for an existing Nginx
```

Files that come from `deploy/` (Caddyfile, Nginx configs, CrowdSec and fail2ban files) are replaced when you
re-run or upgrade; the previous version is kept next to it as `*.bak`. Put your own changes where they survive:
`caddy/conf.d/*.global` and `*.site` (any name not written by the installer), `fail2ban/jail.d/zz-custom.local`,
`docker-compose.override.yml`, `mediamax.env`, and extra keys in `.env` (kept under "Your own additions").

### The installer

What it asks, and what it does with the answers:

1. **Docker check.** Docker and the Compose plugin (2.20+) must be there. If not, it shows the official install
   command (`curl -fsSL https://get.docker.com | sh`, or the `docker-compose-plugin` package) and runs it only if
   you say yes.
2. **Domain** (optional). With one you get `https://<domain>`; without one, `http://<server-ip>:8484`
   (`--port` changes 8484).
3. **E-mail** for Let's Encrypt expiry notices (optional).
4. **Reverse proxy**: Caddy (default), Nginx, none, "I already have one", or Cloudflare Tunnel.
5. **Security**: CrowdSec (default), fail2ban, both, or none. With CrowdSec but without Caddy it offers the
   CrowdSec firewall bouncer on the host (packages from CrowdSec's repository).
6. **Media folders**, mounted read-only at `/media/<folder name>`; add `:rw` for read-write.
7. **PUID/PGID** (detected from the user who ran `sudo`), **time zone** (from the host), **hardware
   transcoding** (detects `/dev/dri` and NVIDIA with the container toolkit).
8. **Weekly auto-upgrade** (optional cron job).

Then it writes `.env` and `docker-compose.yml`, checks them with `docker compose config`, pulls images (and
builds Caddy with the CrowdSec module when needed), starts everything, waits for Kinora's `/health`,
requests the Nginx certificate, registers the CrowdSec bouncer and prints the address and next steps.

Running it again is safe: your answers are the defaults, data in `config/` and `recordings/` is never touched,
and only services whose configuration changed are restarted.

Environment variables for unattended runs (each also accepted under its original `MEDIAMAX_*` name; the `.env` file the
installer writes keeps the `MEDIAMAX_*` keys, which the compose file and proxy templates read): `KINORA_INSTALL_DIR`, `KINORA_DOMAIN`, `ACME_EMAIL`,
`KINORA_PROXY`, `KINORA_SECURITY`, `KINORA_MEDIA` (comma separated), `KINORA_PUID`, `KINORA_PGID`,
`MEDIAMAX_TZ`, `MEDIAMAX_HWACCEL`, `MEDIAMAX_HTTP_PORT`, `CLOUDFLARE_TUNNEL_TOKEN`, `MEDIAMAX_IMAGE`, `MEDIAMAX_REF`.

---

## Caddy

[`deploy/caddy/Caddyfile`](../deploy/caddy/Caddyfile) serves both setups, chosen by `MEDIAMAX_SITE_ADDRESS`:
a domain name (automatic HTTPS, HTTP→HTTPS redirect, HTTP/3) or `:8484` (plain HTTP, no domain). It:

- adds `Strict-Transport-Security` on HTTPS, and fills in `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: same-origin`, `X-Frame-Options: SAMEORIGIN` and `Content-Security-Policy: frame-ancestors 'self'`
  **only when Kinora didn't send them**. Kinora sends its own strict CSP (with `sandbox`) on the plugin UI pages
  and uploaded images; the proxy never adds a second one there, so the plugin sandbox keeps working;
- compresses text responses (zstd/gzip) by content type only: video, audio, HLS playlists and segments, live TV
  MPEG-TS and range responses pass through untouched;
- streams with `flush_interval -1`, keeps WebSockets (`/api/v1/ws`) open across reloads, and waits up to 30 s for
  Kinora during a restart;
- allows 64 MB request bodies (uploads are 50 MB in Kinora), and 4 GB for backup restores;
- writes a JSON access log to `logs/caddy/access.log` (rotated at 50 MB) with tokens, API keys and Subsonic
  passwords in query strings replaced by `REDACTED`.

By hand, without the installer:

```yaml
# docker-compose.yml (next to the Kinora service from INSTALL.md, both on one network)
services:
  caddy:
    image: caddy:2
    restart: unless-stopped
    ports: ["80:80", "443:443", "443:443/udp"]
    environment:
      MEDIAMAX_SITE_ADDRESS: media.example.com
      MEDIAMAX_UPSTREAM: mediamax:8484
    volumes:
      - ./caddy:/etc/caddy:ro          # deploy/caddy/Caddyfile (+ an empty conf.d/)
      - ./logs/caddy:/var/log/caddy
      - caddy-data:/data
volumes:
  caddy-data:
```

Remove the `ports:` of the Kinora service (or bind it to `127.0.0.1`) so the only way in is through Caddy, and
set `KINORA_TRUSTED_PROXIES` on Kinora to the Docker network (see [Hardening defaults](#hardening-defaults)).
For the e-mail address, put `email you@example.com` in `caddy/conf.d/acme.global`.

**Behind Cloudflare (orange cloud)?** Uncomment the `servers { trusted_proxies ... }` block in the global options
so Caddy (and Kinora, CrowdSec, the logs) see the visitor's address from `CF-Connecting-IP` rather than
Cloudflare's. Firewall bans don't help in this setup (the packets come from Cloudflare); the CrowdSec bouncer
inside Caddy does, because it checks the client address.

## Nginx

[`deploy/nginx/`](../deploy/nginx) holds:

| File | Goes in |
|---|---|
| `mediamax-common.conf` | the `http {}` context, before the site (`conf.d/00-mediamax-common.conf`): upstream, rate-limit zones, header maps, log format, gzip |
| `mediamax.conf` | the site: port 80 (ACME challenge + redirect) and 443 with `http2`, HSTS, TLS 1.2/1.3; unknown host names are refused |
| `mediamax-http.conf` | instead of `mediamax.conf` when there is no domain: plain HTTP on 8484 |
| `snippets/mediamax-locations.conf` | included in the server block: proxy settings and locations |
| `40-mediamax-maintenance.sh` | in the container's `/docker-entrypoint.d/`: rotates logs past 50 MB and reloads every 6 h (renewed certificates) |

What they do: `proxy_buffering off` and `proxy_request_buffering off`, 1-hour idle timeouts for streams and a
day for the WebSocket, WebSocket upgrade, `client_max_body_size 64m` (4 GB for the backup restore upload),
rate limits on sign-in (`/api/v1/auth/login`, `profile-login`, `link/approve`, `me/2fa/*`: 10 per minute per
address with bursts of 10; the rest of `/api/v1/auth/`: 5 per second, bursts of 40), answer 429 when exceeded,
the same "fill in, never override" security headers as Caddy, `X-Forwarded-For` set to the client address (not
appended, so it can't be spoofed), and an access log in the combined format with secrets redacted.

The installer runs them in the official `nginx:stable-alpine` image (which fills in `${MEDIAMAX_DOMAIN}` and
`${MEDIAMAX_UPSTREAM}` from the environment) with a `certbot` container on the same `letsencrypt/` folder:

- first start: a temporary self-signed certificate lets Nginx start, then
  `certbot certonly --webroot -w /var/www/certbot -d <domain>` replaces it and Nginx reloads;
- renewal: the `certbot` container runs `certbot renew` every 12 hours (it renews 30 days before expiry), and Nginx
  reloads every 6 hours to pick up the new certificate.

Without Docker, on a host Nginx 1.25+: copy `mediamax-common.conf` to `/etc/nginx/conf.d/00-mediamax-common.conf`
(write `127.0.0.1:8484` for `${MEDIAMAX_UPSTREAM}` and remove `resolver`, `zone` and `resolve`), the snippet to
`/etc/nginx/mediamax/`, and `mediamax.conf` as your site (replace `${MEDIAMAX_DOMAIN}`). Get the certificate with
`certbot certonly --webroot -w /var/www/certbot -d media.example.com`; the certbot package renews it.

**Behind Cloudflare?** Uncomment the `set_real_ip_from` lines and `real_ip_header CF-Connecting-IP` in
`mediamax-common.conf`.

## Existing reverse proxy

Choose "I already have one" (`--proxy existing`). Kinora then listens on `127.0.0.1:8484` only, and the
installer prints the settings. Whatever the proxy, it must:

- pass WebSockets (`/api/v1/ws`);
- not buffer responses (streams), with long idle timeouts (an hour);
- accept 64 MB request bodies;
- send `X-Forwarded-For`, `X-Forwarded-Proto` and `Host`;
- connect from an address Kinora trusts. Kinora only believes `X-Forwarded-For` from the addresses in
  `MEDIAMAX_TRUSTED_PROXIES` (in `.env`; the installer sets loopback and the `mediamax` Docker network). If every
  user shows up with the proxy's address, Kinora's per-address protections and your bans hit everyone at once.

**A proxy in Docker** (Nginx Proxy Manager, Traefik, Caddy...) should join the `mediamax` network and use
`http://mediamax:8484`. Its address is then trusted automatically:

```yaml
# in the proxy's own docker-compose.yml
services:
  npm:                       # or traefik, caddy, ...
    networks: [default, mediamax]
networks:
  mediamax:
    external: true
```

**A proxy on another machine**: run the installer with `--proxy existing --proxy-ip <its address>`; Kinora
then listens on all interfaces at 8484 and trusts that address.

### Nginx (already installed)

Use the files in `/opt/kinora/snippets/nginx/` as described in [Nginx](#nginx), with the upstream set to
`127.0.0.1:8484`. The minimum, if you'd rather write your own server block:

```nginx
location / {
    proxy_pass http://127.0.0.1:8484;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $http_connection;
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_read_timeout 1h;
    proxy_send_timeout 1h;
    client_max_body_size 64m;
}
```

### Nginx Proxy Manager

Add a Proxy Host: forward to `mediamax` port `8484` (with NPM on the `mediamax` network, see above), tick
**Websockets Support** and **Block Common Exploits**, request an SSL certificate with **Force SSL** and
**HTTP/2**, and paste this into the **Advanced** tab (custom Nginx configuration):

```nginx
proxy_buffering off;
proxy_request_buffering off;
proxy_read_timeout 1h;
proxy_send_timeout 1h;
client_max_body_size 64m;
```

To rate-limit sign-in as well, add a **Custom location** `/api/v1/auth/login` forwarding to the same host and
port, with `limit_req zone=...;` only if you have defined a zone in NPM's `http` context
(`/data/nginx/custom/http_top.conf`), e.g. `limit_req_zone $binary_remote_addr zone=mediamax_login:10m rate=10r/m;`
there and `limit_req zone=mediamax_login burst=10 nodelay;` in the location.

### Traefik

With Traefik on the `mediamax` network, add labels to Kinora in `/opt/kinora/docker-compose.override.yml`
(kept by the installer, merged automatically):

```yaml
services:
  mediamax:
    labels:
      - traefik.enable=true
      - traefik.docker.network=mediamax
      - traefik.http.routers.mediamax.rule=Host(`media.example.com`)
      - traefik.http.routers.mediamax.entrypoints=websecure
      - traefik.http.routers.mediamax.tls.certresolver=letsencrypt
      - traefik.http.routers.mediamax.middlewares=mediamax-headers
      - traefik.http.services.mediamax.loadbalancer.server.port=8484
      - traefik.http.services.mediamax.loadbalancer.responseforwarding.flushinterval=-1
      - traefik.http.middlewares.mediamax-headers.headers.stsSeconds=31536000
```

Traefik v3 limits the time to read a request to 60 s by default, which cuts off large uploads on slow links:
raise it on the entry point (`--entrypoints.websecure.transport.respondingTimeouts.readTimeout=600s`).
WebSockets and request bodies need nothing else in Traefik.

### Caddy (already installed)

```caddyfile
media.example.com {
	reverse_proxy 127.0.0.1:8484 {
		flush_interval -1
	}
	request_body {
		max_size 64MB
	}
}
```

Or import the full [`deploy/caddy/Caddyfile`](../deploy/caddy/Caddyfile) site block.

---

## Cloudflare Tunnel

No open ports at all: `cloudflared` makes an outbound connection to Cloudflare, which serves your hostname.

1. In Cloudflare Zero Trust: **Networks → Tunnels → Create a tunnel** (Cloudflared). Copy the token from the
   `docker run` command it shows.
2. Add a **public hostname** (e.g. `media.example.com`) with service **HTTP** → `mediamax:8484`.
3. Run `sudo bash install.sh --proxy tunnel --tunnel-token <token>` (or choose it in the menu).

This adds the `cloudflared` service (profile `tunnel`); Kinora listens on `127.0.0.1:8484` only. Notes:

- Firewall bans (fail2ban, CrowdSec firewall bouncer) can't work behind a tunnel: every connection comes from
  `cloudflared`. Use Cloudflare's WAF and rate limiting rules (e.g. on `/api/v1/auth/login`), and Kinora's own
  account lockout (5 failures, 15 minutes).
- Cloudflare limits request bodies to 100 MB on the free plan (Kinora needs 50 MB), and its terms restrict
  serving large amounts of video through its network; read them before streaming through a tunnel.

## Tailscale

For private access from your own devices only, without exposing anything to the internet:

```bash
sudo bash install.sh --proxy existing          # Kinora on 127.0.0.1:8484 only
curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up
sudo tailscale serve --bg --https=443 http://127.0.0.1:8484
```

Kinora is then at `https://<machine>.<tailnet>.ts.net` for devices on your tailnet, with a valid certificate.
`tailscale funnel` instead of `serve` would publish it to the internet. The apps work over Tailscale too; enter
the `ts.net` address as the server.

---

## CrowdSec

[`deploy/crowdsec/`](../deploy/crowdsec):

- `acquis.yaml` reads `/var/log/mediamax/security.log` (the Kinora log, `type: mediamax`), the Caddy access log
  (`type: caddy`) and the Nginx access log (`type: nginx`), all mounted read-only;
- `parsers/s01-parse/mediamax-logs.yaml` turns each line of the security log into an event with
  `evt.Meta.source_ip`, `log_type` (`mediamax_failed_auth` for `AUTH_FAIL`/`AUTH_LOCKED`, `mediamax_auth_ok`),
  `user`, `reason` (`password`, `pin`, `totp`, `api_key`, `subsonic`, `locked`) and the event time;
- `scenarios/mediamax-bf.yaml` has two leaky buckets per source address: **mediamax-bf** (capacity 5, leak 1 per
  minute, so the 6th failure in quick succession triggers; blackhole 5 min) and **mediamax-bf_user-enum** (more than
  5 different user names from one address).

The hub collections `crowdsecurity/caddy` or `crowdsecurity/nginx`, plus `crowdsecurity/http-cve`,
`crowdsecurity/base-http-scenarios` and `crowdsecurity/linux`, are installed at every start through the
`COLLECTIONS` variable; add more with `CROWDSEC_COLLECTIONS` in `.env`. Private addresses (LAN, Docker) are never
banned (`crowdsecurity/whitelists`). A ban lasts 4 hours (CrowdSec's default profile).

**Bouncers** (what actually blocks):

- **Caddy**: Caddy is built from [`deploy/caddy/Dockerfile`](../deploy/caddy/Dockerfile) with
  [`caddy-crowdsec-bouncer`](https://github.com/hslatman/caddy-crowdsec-bouncer). The installer creates the key
  after CrowdSec starts (`cscli bouncers add mediamax-caddy -o raw`), stores it as `CROWDSEC_BOUNCER_KEY` in
  `.env`, enables `caddy/conf.d/crowdsec.global` and `crowdsec.site`, and recreates Caddy. Banned addresses get 403.
- **Nginx, no proxy, or an existing proxy**: the
  [CrowdSec firewall bouncer](https://docs.crowdsec.net/u/bouncers/firewall) on the host. The installer offers to
  install it (`curl -fsSL https://install.crowdsec.net | sh`, then `crowdsec-firewall-bouncer-iptables`), publishes
  the CrowdSec API on `127.0.0.1:8090` and writes
  `/etc/crowdsec/bouncers/crowdsec-firewall-bouncer.yaml.local`:

  ```yaml
  api_url: http://127.0.0.1:8090/
  api_key: <cscli bouncers add mediamax-firewall -o raw>
  iptables_chains:
    - INPUT
    - DOCKER-USER     # Docker-published ports never pass INPUT
  ```

  The Lua-based `cs-nginx-bouncer` needs OpenResty or Nginx built with Lua, which the official image isn't;
  the firewall bouncer works with any proxy.

Useful commands (`cd /opt/kinora` first):

```bash
docker compose exec crowdsec cscli metrics                 # what is read, parsed, which scenarios fire
docker compose exec crowdsec cscli decisions list          # current bans
docker compose exec crowdsec cscli alerts list
docker compose exec crowdsec cscli explain --file /var/log/mediamax/security.log --type mediamax
docker compose exec crowdsec cscli bouncers list
docker compose exec crowdsec cscli console enroll <key>    # optional: the CrowdSec web console
```

## fail2ban

[`deploy/fail2ban/`](../deploy/fail2ban):

- `filter.d/mediamax.conf` matches `AUTH_FAIL` and `AUTH_LOCKED` lines on the `ip=` field (IPv4, IPv6, and
  `::ffff:`-mapped IPv4), reads the ISO-8601 UTC timestamp, and ignores `ip=unknown`;
- `jail.d/mediamax.local`: jail **mediamax**, 5 failures in 10 minutes → banned for 1 hour, doubling for repeat
  offenders up to a week (`bantime.increment`). Bans go into **both** the `DOCKER-USER` chain and `INPUT`:
  Docker-published ports are DNAT-ed and pass through `FORWARD`, never `INPUT`, so a ban in `INPUT` alone would
  not stop anyone reaching a container. `DOCKER-USER` is evaluated first and still sees the real source address.
  The ban covers all ports;
- `filter.d/mediamax-caddy.conf`, `filter.d/mediamax-nginx.conf` and the jails **mediamax-caddy** /
  **mediamax-nginx** (off by default): floods of 401/403/404 (and 429 on Nginx) at the proxy, 40 within 2 minutes;
  missing artwork is ignored.

The installer runs [`crazymax/fail2ban`](https://github.com/crazy-max/docker-fail2ban) with `network_mode: host`
and `NET_ADMIN`/`NET_RAW` so it can change the host's iptables, with the Kinora and proxy logs mounted
read-only, and adds `jail.d/mediamax.network.local` so the Docker network itself is never banned. Turn on a proxy
jail with a file of your own:

```ini
# /opt/kinora/fail2ban/jail.d/zz-custom.local
[mediamax-caddy]
enabled = true
```

then `docker compose restart fail2ban`.

**On the host instead** (Debian/Ubuntu `apt install fail2ban`):

```bash
sudo cp deploy/fail2ban/filter.d/mediamax*.conf /etc/fail2ban/filter.d/
sudo cp deploy/fail2ban/jail.d/mediamax.local /etc/fail2ban/jail.d/
# point logpath at the host file:
sudo sed -i 's|/var/log/mediamax/security.log|/opt/kinora/config/logs/security.log|' /etc/fail2ban/jail.d/mediamax.local
sudo fail2ban-regex /opt/kinora/config/logs/security.log /etc/fail2ban/filter.d/mediamax.conf
sudo systemctl restart fail2ban && sudo fail2ban-client status mediamax
```

Start fail2ban after Docker (the `DOCKER-USER` chain must exist): `systemctl edit fail2ban` and add
`After=docker.service`. With the Windows or Linux builds of Kinora (no Docker), remove the `DOCKER-USER`
action line and use `/var/lib/mediamax/logs/security.log` (or wherever your data folder is).

## Unbanning an address

| Tool | Command |
|---|---|
| Kinora account lockout | lifts by itself after 15 minutes (or restart Kinora: `docker compose restart mediamax`) |
| CrowdSec | `docker compose exec crowdsec cscli decisions delete --ip 203.0.113.9` |
| CrowdSec, never ban again | add the address to a whitelist parser: see [CrowdSec whitelists](https://docs.crowdsec.net/u/getting_started/post_installation/whitelists) |
| fail2ban (container) | `docker compose exec fail2ban fail2ban-client set mediamax unbanip 203.0.113.9` |
| fail2ban (host) | `sudo fail2ban-client set mediamax unbanip 203.0.113.9` |
| fail2ban, everything | `docker compose exec fail2ban fail2ban-client unban --all` |
| Nginx rate limit | nothing to undo: it only slows requests down while they come too fast |

Run these from `/opt/kinora`. `install.sh --status` lists current bans.

---

## Hardening defaults

The generated `docker-compose.yml`:

- **Kinora is not reachable from outside when a proxy is used**: it publishes no port, or only
  `127.0.0.1:8484`. Without a proxy it listens on `0.0.0.0:8484`.
- **`KINORA_TRUSTED_PROXIES`** is set to `loopback` plus the fixed `mediamax` network (`172.30.84.0/24`, change
  `MEDIAMAX_SUBNET` in `.env` if it clashes with your LAN), so only the proxy can tell Kinora a client address.
  Without a proxy it is `loopback` only: nobody can fake an address with `X-Forwarded-For`.
- Media folders are mounted **read-only** unless you asked for `:rw`.
- `no-new-privileges` on every container. Kinora's entrypoint starts as root only to fix the owner of `/config`
  and then drops to PUID/PGID with `setpriv`, which `no-new-privileges` allows; GPU access works through group
  membership. A few capabilities Kinora never needs are dropped (`NET_RAW`, `MKNOD`, `AUDIT_WRITE`,
  `SYS_CHROOT`, `SETFCAP`).
- `restart: unless-stopped`, health checks on Kinora, Caddy, Nginx and CrowdSec, and container logs rotated at
  10 MB × 3 (`logging: max-size`).
- `/transcode` is a RAM disk (`MEDIAMAX_TRANSCODE_SIZE`, default 4g, only used as needed).
- Secrets (`.env`, `mediamax.env`) are readable by root only.

Version pinning: add `MEDIAMAX_IMAGE=ghcr.io/bucifer6/kinora:0.3.0` (and if you like `CADDY_IMAGE`,
`NGINX_IMAGE`, `CERTBOT_IMAGE`, `CROWDSEC_IMAGE`, `FAIL2BAN_IMAGE`, `CLOUDFLARED_IMAGE`) to `.env`, then
`docker compose up -d`.

## Upgrades and backups

```bash
sudo /opt/kinora/install.sh --upgrade
```

pulls new images, refreshes the deploy files from the same branch or tag (`MEDIAMAX_REF`), rebuilds Caddy with the
CrowdSec module, restarts what changed and waits for `/health`. To do this weekly, answer yes to the auto-upgrade
question (or pass `--auto-upgrade`); it writes `/etc/cron.d/mediamax-upgrade`:

```cron
17 4 * * 0 root /opt/kinora/install.sh --dir /opt/kinora --upgrade --yes >>/opt/kinora/logs/upgrade.log 2>&1
```

**Backups.** Kinora backs itself up (Admin → Backups: on demand or on a schedule), into `config/backups/`.
Copy that folder somewhere else regularly (another disk, a NAS, cloud storage). To move to a new server: install
there, stop Kinora, copy `config/` (and `recordings/`), start it again.

---

## Troubleshooting

**The certificate isn't issued.** The domain's A/AAAA record must point at this server, and ports 80 and 443 must
be reachable from the internet (router port forwarding, cloud firewall/security group). Check with
`docker compose logs caddy` or, for Nginx, the installer's certbot output. Behind CGNAT (common on 4G/5G and some
fibre ISPs) incoming connections can't work: use [Cloudflare Tunnel](#cloudflare-tunnel) or
[Tailscale](#tailscale). Let's Encrypt allows 5 failed validations per hour; test with `--staging` first.

**"port is already in use".** Something else listens on 80/443 (an Apache or Nginx from the distribution:
`sudo ss -ltnp 'sport = :80'`). Stop it, or use `--proxy existing` with that server.

**502 / "bad gateway".** Kinora isn't healthy yet or has crashed: `docker compose ps`, `docker compose logs mediamax`.

**Every user shows the same address** in Admin → Devices or Activity & logs, or one user's mistakes lock everyone out. The proxy
connects from an address Kinora doesn't trust. Check `MEDIAMAX_TRUSTED_PROXIES` in `.env`; for a proxy in Docker,
join the `mediamax` network. If the address is the Docker gateway (`172.30.84.1`), the request came through
Docker's userland proxy, typically an **IPv6** client reaching an IPv4-only container: enable IPv6 on the Docker
network or put the proxy on the host network. (fail2ban never bans the Docker network; CrowdSec never bans private
addresses.)

**Streams stall or stop after a minute** behind your own proxy: response buffering is on or a timeout is short;
see [Existing reverse proxy](#existing-reverse-proxy).

**Uploads fail with 413**: raise the proxy's body limit to 64 MB (`client_max_body_size`, `request_body max_size`).

**CrowdSec doesn't ban.** `docker compose exec crowdsec cscli metrics` shows whether `security.log` is read and
parsed. Private/LAN addresses are whitelisted on purpose. With Nginx or no proxy, nothing blocks unless the firewall
bouncer is installed (`systemctl status crowdsec-firewall-bouncer`). With Caddy, `cscli bouncers list` should show
`mediamax-caddy` with a recent "last API pull"; if not, re-run the installer.

**fail2ban doesn't ban.** `docker compose exec fail2ban fail2ban-client status mediamax` and
`fail2ban-regex /opt/kinora/config/logs/security.log /opt/kinora/fail2ban/filter.d/mediamax.conf`. Docker's
optional nftables firewall backend has no `DOCKER-USER` chain; keep the iptables backend (the default) or use
CrowdSec.

**I locked myself out.** See [Unbanning an address](#unbanning-an-address), from the server's console or SSH.

**Permission denied on media or config.** PUID/PGID must be able to read the media folders (`id <user>`,
`ls -ln /srv/movies`); add groups with `MEDIAMAX_EXTRA_GIDS` in `mediamax.env`. On SELinux systems (Fedora, RHEL)
bind mounts need a label: add `:z` to the volume in `docker-compose.override.yml`, or
`chcon -Rt container_file_t /srv/media`.

**Hardware transcoding doesn't work.** Intel/AMD: `ls -l /dev/dri` on the host must show `renderD128`. NVIDIA:
install the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html)
and run the installer again. Then check Admin → Server settings → Transcoding.

**DLNA.** Smart TVs find DLNA servers by multicast on UDP 1900, which doesn't cross Docker's bridge network. DLNA
needs `network_mode: host` on Kinora, which this installer doesn't set up (the proxy reaches Kinora over the
Docker network). Use the plain Docker setup in [INSTALL.md](INSTALL.md) if you need DLNA.

**Start over** (keeps your data): `sudo /opt/kinora/install.sh --uninstall`, then run the installer again.

## Security dashboard (Admin → Security)

When Kinora is installed with `deploy/install.sh`, the admin area gets a **Security** page that shows everything in one place:

- **Sign-in attempts:** failed sign-ins per hour, broken down by password, PIN, 2FA code, API key and music-app login. It also lists the top offending addresses (with a **Ban** button), the accounts being targeted, and lockouts.
- **Reverse proxy:** Caddy or Nginx traffic for the last 24 hours, including requests per hour, status classes, the busiest addresses with their error counts, and the most common errors. This is where scanners probing `/wp-login.php` or `/.env` show up.
- **HTTPS certificate:** days until expiry, the issuer, and whether the certificate is trusted.
- **CrowdSec:** active decisions with their scenario and expiry (**Unban** works per address) and recent alerts.
- **fail2ban:** each jail's failures and banned addresses, with **Unban**.
- **Ban an address:** through CrowdSec (1 hour to 1 year) or a fail2ban jail. Kinora refuses to ban the address you're using. Bans and unbans are written to Activity & logs.

**How it connects.** The installer wires everything up for you:

- **CrowdSec:** Kinora signs in to CrowdSec's Local API as the machine `mediamax-dashboard`. The password is generated into `.env` (`CROWDSEC_DASHBOARD_PASSWORD`) and registered with `cscli machines add`.
- **fail2ban:** fail2ban's control socket is root-only, so a small relay, the `fail2ban-bridge` service running `deploy/fail2ban/bridge.py`, exposes a socket that only Kinora's group can open. It allows exactly four commands: ping, status, ban and unban. Requests are decoded with an unpickler that refuses every class, and Kinora's own decoder refuses anything but plain data.
- **Proxy logs:** mounted into Kinora read-only at `/var/log/proxy`.
- **Settings:** come from `KINORA_PROXY_KIND`, `KINORA_PROXY_LOG`, `KINORA_PUBLIC_HOST`, `KINORA_CROWDSEC_URL`, `KINORA_CROWDSEC_MACHINE_ID`, `KINORA_CROWDSEC_PASSWORD` and `KINORA_FAIL2BAN_SOCKET`.

Set up by hand? Enter the same values under **Admin → Security → Connections**. For CrowdSec, register the machine with:

```bash
docker exec crowdsec cscli machines add mediamax-dashboard --password '<choose one>' -f /dev/null
```

## Network & HTTPS (Admin → Network)

Admin → **Network & HTTPS** decides how people reach the server. Changes apply at once, without a restart.

| Mode | When | What Kinora does |
|---|---|---|
| **Direct** (default) | LAN, VPN, Tailscale, a port forward to 8484 | plain HTTP on 8484; `X-Forwarded-For` is believed from loopback only, so nobody can fake their address |
| **Behind my reverse proxy** | you run Nginx, Traefik, Caddy, NPM, SWAG, HAProxy, Apache or Cloudflare Tunnel | believes `X-Forwarded-For`/`-Proto` from the **trusted proxies** you list (default: loopback and private networks, Docker networks included); shows copy-ready configs for each proxy |
| **Built-in HTTPS** | no proxy, but you want a certificate | runs a bundled [Caddy](https://caddyserver.com) as a child process: Let's Encrypt certificate, HTTP→HTTPS, HTTP/2 and 3, HSTS, compression of text only, unbuffered streaming. Off until you choose it |

The page's **Connection check** shows how your own request arrived (socket address, `X-Forwarded-For`, protocol),
so you can see straight away whether the proxy is trusted. `KINORA_TRUSTED_PROXIES` in the environment still
overrides the list (the installer sets it for its own Caddy/Nginx; it is left empty with `--proxy none`).

**Built-in HTTPS needs:** a domain whose DNS points at the server, ports 80 and 443 reachable from the internet,
and nothing else listening on them. Caddy is bundled in the Docker image and the release downloads; elsewhere
install it or set `KINORA_CADDY=/path/to/caddy`. Its certificates live in `<data>/caddy`, its access log is
`<logs>/caddy-access.log` (tokens redacted), and its messages show on the page. Use *Test mode* (Let's Encrypt
staging) while you get DNS and ports right, to stay clear of rate limits.

In Docker, publish the ports and let the unprivileged process bind them:

```yaml
services:
  mediamax:
    ports: ["8484:8484", "80:80", "443:443"]
    sysctls:
      net.ipv4.ip_unprivileged_port_start: "0"
```

The installer does this with `--proxy none --builtin-https`. Outside Docker, either run with the right to bind
low ports (`setcap cap_net_bind_service=+ep $(which caddy)`) or choose ports above 1024 and forward 80/443 to them
on your router.
