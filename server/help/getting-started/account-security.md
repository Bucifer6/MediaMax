---
title: Your account, password and two-factor sign-in
summary: Change your password, turn on two-factor sign-in, and sign out devices you no longer use.
section: getting-started
audience: everyone
keywords: password, 2fa, two-factor, totp, authenticator, recovery codes, security, devices, sign out, api key, subsonic
related: profiles, login-problems, apps-and-devices
order: 4
---

All of this is in **Settings**. Profile sessions don't have these options: switch to the account owner's profile first.

## Changing your password

Open **Settings → Security**, enter your current password and the new one twice, then choose **Change password**. Other devices stay signed in; sign them out under **Settings → Devices** if you think someone else knows the old password.

## Two-factor sign-in

Two-factor sign-in asks for a 6-digit code from an authenticator app (such as Google Authenticator, Microsoft Authenticator, 1Password or Aegis) as well as your password.

1. Go to **Settings → Security → Two-factor authentication** and turn it on.
2. Scan the QR code with your authenticator app and type the code it shows.
3. **Save the recovery codes** somewhere safe. Each one works once if you lose your phone.

When you sign in you'll be asked for the code. If your phone's clock is wrong, codes are rejected: set the time to automatic. If you lose both your phone and the recovery codes, ask your server admin to reset two-factor sign-in for your account.

## Signed-in devices

**Settings → Devices** lists every browser and app signed in to your account, with when it was last used. Choose a device to sign it out; it will need to sign in again.

## Music apps and API keys

**Settings → Security** also has **API keys** (for tools and scripts) and the details for Subsonic music apps such as Symfonium or Feishin. With two-factor sign-in on, sign in to music apps with an API key instead of your password.

## Too many wrong passwords

After 5 wrong passwords in a row the account is locked for 15 minutes, whichever device the attempts came from. See [Can't sign in or locked out](help:login-problems).
