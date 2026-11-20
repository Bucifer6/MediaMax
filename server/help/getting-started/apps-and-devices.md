---
title: Installing the apps and signing in on a TV
summary: Use {{product}} in a browser, on phones, Samsung and LG TVs, Android TV, Fire TV and Apple TV, and sign in with a code.
section: getting-started
audience: everyone
keywords: app, install, iphone, ipad, android, samsung, tizen, lg, webos, android tv, fire tv, apple tv, link code, sign in with code, server address, carplay, android auto
related: tv-navigation, remote-buttons, account-security
order: 5
---

## In a browser

Open the server's address in any modern browser (Chrome, Edge, Firefox, Safari). It works on computers, tablets and phones. Ask your admin for the address if you don't have it.

## Phones and tablets (iOS, Android)

Install the app your admin points you to, open it, type the server address (for example `https://media.example.com`), then sign in. The app also has offline **Downloads**, Chromecast and AirPlay, and CarPlay and Android Auto for music.

## TVs

| TV or box | How |
|---|---|
| **Samsung (Tizen)**, **LG (webOS)** | Install the TV app your admin provides, type the server address once, then sign in. |
| **Android TV, Google TV, Fire TV** | Install the TV app (or open the server address in the TV's browser). |
| **Apple TV** | Install the Apple TV app, if your admin publishes one. |
| **Any TV browser or set-top box** | Open the server address with `?tv=1` at the end, for example `http://192.168.1.10:8484/?tv=1`. TV mode is remembered. |

## Signing in with a code

Typing a password with a remote is slow, so TVs can sign in with a short code:

1. On the TV, choose **Use your phone** (or **Link with code**). It shows a code of 4 or more letters and numbers.
2. On a phone or computer that is already signed in, go to **Settings → Link device** (in the account menu: **Link a device**), or open the address shown on the TV, ending in `/link`. In the phone app it's **Settings → Link a TV**.
3. Type the code and choose **Link device**. The TV signs in by itself within a few seconds.

If the code has expired, choose **New code** on the TV. Profiles can't link devices: switch to the account owner first.

## Signing out a device

Lost a phone or sold a TV? Sign it out from **Settings → Devices** on any other device.
