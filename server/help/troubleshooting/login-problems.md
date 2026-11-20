---
title: Can't sign in or locked out
summary: Forgotten passwords, locked accounts, two-factor codes that don't work, and signing in on a TV.
section: troubleshooting
audience: everyone
keywords: login, sign in, password, forgot, locked, lockout, too many attempts, two-factor, 2fa, code, recovery code, pin, disabled, session expired, signed out, banned
related: account-security, apps-and-devices, admin-security
order: 6
---

## Forgot your password

There's no email reset: ask your server admin to set a new password for you in **Admin → Users**.

## "Too many attempts" or locked out

After 5 wrong passwords in a row, the account is locked for **15 minutes**, whatever device the attempts came from. Wait and try again. If it keeps happening, someone may be guessing your password: tell your admin and turn on two-factor sign-in.

If your whole network can't reach the server after many failed attempts, your address may have been banned by the server's security tools. Your admin can unban it in **Admin → Security**.

## Two-factor code rejected

- Check the time on your phone is set automatically: codes depend on the clock.
- Use a fresh code; each lasts 30 seconds.
- Lost your phone? Use one of your **recovery codes** instead.
- No recovery codes either? Ask your admin to **Reset two-factor** for your account.

## Forgot a profile PIN

The account owner can change or remove the PIN in **Settings → Profiles**.

## Signed out unexpectedly

Sessions end after a period of inactivity set by your admin, when you change your password and sign out devices, or when someone signs a device out from **Settings → Devices**. Just sign in again.

## "This account is disabled"

Your admin has turned the account off. Contact them.

## Signing in on a TV

Use **Use your phone** / **Link with code** instead of typing a password with the remote. See [Installing the apps and signing in on a TV](help:apps-and-devices).
