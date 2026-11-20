---
title: Security dashboard, CrowdSec and fail2ban
summary: Watch sign-in attempts and proxy traffic, check the certificate, and ban or unban addresses.
section: admin
audience: admin
keywords: security, dashboard, sign-in attempts, brute force, ban, unban, crowdsec, fail2ban, lockout, certificate, proxy log, scanners, api keys
related: admin-network, login-problems, admin-users
order: 5
---

**Admin → Security** brings everything in one place:

| Card | Shows |
|---|---|
| **Sign-in attempts** | Failed sign-ins per hour (password, PIN, 2FA code, API key, music app), top addresses with a **Ban** button, targeted accounts and lockouts. |
| **Reverse proxy** | Caddy or Nginx traffic for the last 24 hours: busiest addresses and most common errors. Scanners probing `/wp-login.php` show up here. |
| **HTTPS certificate** | Days until expiry, the issuer, and whether it is trusted. |
| **CrowdSec** | Active decisions (with **Unban**) and recent alerts. |
| **fail2ban** | Each jail's failures and banned addresses, with **Unban**. |

You can ban an address through CrowdSec (1 hour to 1 year) or a fail2ban jail. {{product}} refuses to ban the address you're using. Bans and unbans are written to **Activity & logs**.

## Connecting CrowdSec and fail2ban

The one-command installer (`deploy/install.sh`) connects everything for you. Set up by hand? Enter the details under **Admin → Security → Connections**. For CrowdSec, register a machine first:

```
docker exec crowdsec cscli machines add mediamax-dashboard --password '<choose one>' -f /dev/null
```

## Built-in protection

- After 5 failed sign-ins an account locks for 15 minutes, whatever address the attempts come from. It unlocks by itself (or restart the server).
- Failed sign-ins are written to `logs/security.log`, which fail2ban and CrowdSec read.
- API keys for integrations are write-only in the admin pages.

## Locked yourself out?

From the server's console:

| Tool | Command |
|---|---|
| CrowdSec | `cscli decisions delete --ip 203.0.113.9` |
| fail2ban | `fail2ban-client set mediamax unbanip 203.0.113.9` |

In the deploy kit run these with `docker compose exec crowdsec …` or `docker compose exec fail2ban …` from `/opt/mediamax`.
