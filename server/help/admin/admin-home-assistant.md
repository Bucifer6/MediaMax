---
title: Home Assistant and smart home
summary: Show what's playing in Home Assistant over MQTT, a webhook or REST, and trigger automations such as dimming the lights.
section: admin
audience: admin
keywords: home assistant, smart home, mqtt, discovery, webhook, rest, sensor, automation, lights, now playing, broker
related: admin-plugins, admin-storage
order: 12
---

Settings are in **Admin → Smart home**. Pick one of three ways:

## MQTT (recommended)

Turn on **Publish to Home Assistant over MQTT** and enter the **Broker URL**, **Username** and **Password** (use **Use TLS** for an encrypted broker), then **Test connection** and save. With MQTT discovery, Home Assistant creates the entities by itself: *Now playing*, *Active streams*, *Transcodes*, *Streaming bandwidth*, *Someone is watching*, *Recently added*, a *Scan libraries* button and a playback event. **One "Now playing" sensor per device** adds a sensor for each TV or phone, so automations can react to a single room.

**Discovery prefix** (normally `homeassistant`) and **Base topic** only need changing if you changed them in Home Assistant.

## Webhook (no MQTT needed)

In Home Assistant, create an automation with a **Webhook** trigger and copy its ID. Then enter your **Home Assistant URL** and the **Webhook ID** here and add the webhook. {{product}} sends a test call, and from then on an event when playback starts, pauses, resumes or stops and when new media arrives. The webhook appears under **Server settings → Webhooks**, where you can change its events.

## REST sensor

Home Assistant can poll the now-playing endpoint with an API key (**Settings → Security → API keys**). The page shows ready-to-paste YAML.

## Example: dim the lights

Trigger on the living-room TV's "Now playing" sensor changing to *playing*, and turn the lights down; raise them again on *paused* or *idle*. Full examples are in the server's documentation (`docs/HOME_ASSISTANT.md`).
