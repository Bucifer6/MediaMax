# Security policy

Kinora is a self-hosted media server, so a security bug can expose someone's home network, accounts or media.
Thank you for reporting responsibly.

## Reporting a vulnerability

**Please don't open a public issue.** Report it privately through GitHub:
**Security → Report a vulnerability** on this repository (private vulnerability reporting).

Include what you can: the affected version or commit, how to reproduce it, what an attacker could do, and any
proof of concept. You'll get an acknowledgement within a few days, and a fix or a plan once it's confirmed. Please
give us a reasonable time to release a fix before disclosing it publicly; you'll be credited unless you'd rather not be.

## Supported versions

Security fixes go into the latest release and `main`. Older releases are not patched; please update.

## Scope

In scope: the server (`server/`), the web app (`web/`), the phone and TV apps (`apps/`, `tv/`), the installers and
deployment files (`deploy/`, `packaging/`, `docker/`, `nas/`) and the release workflow.

Out of scope: problems that need the attacker to already be an administrator of the server, denial of service by
flooding, issues in third-party services (Trakt, OpenSubtitles, Subs.ro, Plex, IPTV providers), and missing hardening
on a server that its owner exposed to the internet without the recommended reverse proxy (see `docs/DEPLOY.md`).
