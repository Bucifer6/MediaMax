# Home Assistant & smart home

Kinora talks to [Home Assistant](https://www.home-assistant.io) in three ways. Set them up in **Admin → Smart home**.

| | Needs | Best for |
|---|---|---|
| **MQTT discovery** | An MQTT broker (the Mosquitto add-on) | Sensors, a "someone is watching" switch, a Scan button and playback events that appear in HA by themselves |
| **Webhook preset** | Nothing extra | A single automation reacting to play / pause / stop |
| **REST endpoint** | An API key | HA's REST sensor, Homepage / Homarr / Glance dashboards |

## MQTT

1. Install the **Mosquitto broker** add-on (or use any MQTT broker) and the **MQTT** integration in HA.
2. In Kinora: Admin → Smart home → enable *Publish to Home Assistant over MQTT*, enter the broker URL (`mqtt://homeassistant.local:1883`, or `mqtts://…:8883` for TLS), username and password (write-only; shown as `••••` once saved), then **Test connection** and **Save**.
3. A device named after your server appears under Settings → Devices & services → MQTT.

Kinora's MQTT client is built in (MQTT 3.1.1, QoS 0/1, TLS, keep-alive, last will). It reconnects with back-off and re-announces everything when HA restarts (it listens to `homeassistant/status`).

### Entities

Entity ids come from the device and entity names. With a server called *Kinora*:

| Entity | State | Attributes |
|---|---|---|
| `sensor.mediamax_now_playing` | `playing` / `paused` / `idle` (most relevant stream) | title, series, season, episode, year, media_type, poster_url, progress (%), position, duration, client, platform, user, transcode, method, hdr, bitrate_kbps |
| `sensor.mediamax_active_streams` | number of streams | `sessions` list |
| `sensor.mediamax_transcodes` | number of transcodes | |
| `sensor.mediamax_streaming_bandwidth` | kbit/s (paused streams count as 0) | |
| `binary_sensor.mediamax_someone_is_watching` | `on` while anything plays (off when paused or idle) | |
| `sensor.mediamax_recently_added` | latest title (`Show – Episode` for episodes) | `items` (last 5 with poster URLs) |
| `button.mediamax_scan_libraries` | press to scan all libraries (runs now, even in disk-friendly mode) | |
| `event.mediamax_playback` | event types `started`, `paused`, `resumed`, `stopped`, `ended` | same fields as Now playing + session_id |
| `sensor.<device>_<user>_now_playing` | one per client device that has played something (e.g. `sensor.living_room_tv_alice_now_playing`) | as Now playing |

*Ended* = stopped at 90 % or later. Poster URLs are absolute when a Public URL is set (Admin → Remote access); images are served without login.

Everything goes *unavailable* when Kinora stops: availability topic `mediamax/<server>/availability` is `online`/`offline` (retained, `offline` is the MQTT last will). Nothing is published while the server is idle except keep-alive pings; while something plays, state is refreshed every 15 s (only when it changed).

### Topics

| Topic (base `mediamax`) | Content |
|---|---|
| `mediamax/<id>/availability` | `online` / `offline` (retained) |
| `mediamax/<id>/server` | JSON server state (retained) |
| `mediamax/<id>/player/<device>` | JSON per device (retained) |
| `mediamax/<id>/recently_added` | JSON (retained) |
| `mediamax/<id>/event` | JSON playback events (not retained) |
| `mediamax/<id>/command/scan_libraries` | publish `PRESS` to scan |
| `homeassistant/<component>/mediamax_<id>/<object>/config` | discovery (retained) |

### MQTT automation examples

```yaml
# Dim the living-room lights when a video starts on the living-room TV, raise them on pause/stop.
automation:
  - alias: "Kinora – movie lights"
    trigger:
      - platform: state
        entity_id: sensor.living_room_tv_alice_now_playing
    condition:
      - "{{ state_attr(trigger.entity_id, 'media_type') in ['movie', 'episode', 'video'] or trigger.to_state.state == 'idle' }}"
    action:
      - choose:
          - conditions: "{{ trigger.to_state.state == 'playing' }}"
            sequence:
              - service: light.turn_on
                target: { entity_id: light.living_room }
                data: { brightness_pct: 10, transition: 3 }
          - conditions: "{{ trigger.to_state.state in ['paused', 'idle'] }}"
            sequence:
              - service: light.turn_on
                target: { entity_id: light.living_room }
                data: { brightness_pct: 80, transition: 2 }

  # Using the event entity instead (any device):
  - alias: "Kinora – notify when a movie ends"
    trigger:
      - platform: state
        entity_id: event.mediamax_playback
    condition:
      - "{{ trigger.to_state.attributes.event_type == 'ended' and trigger.to_state.attributes.media_type == 'movie' }}"
    action:
      - service: notify.mobile_app_phone
        data:
          message: "{{ trigger.to_state.attributes.user }} finished {{ trigger.to_state.attributes.title }}"

  # Don't let the NAS sleep timer / heating schedule kick in while anyone watches.
  - alias: "Kinora – keep the living room warm while watching"
    trigger:
      - platform: state
        entity_id: binary_sensor.mediamax_someone_is_watching
        to: "on"
    action:
      - service: climate.set_preset_mode
        target: { entity_id: climate.living_room }
        data: { preset_mode: comfort }
```

## Webhook preset (no MQTT)

1. In HA create an automation with a **Webhook** trigger and copy its webhook ID.
2. Kinora → Admin → Smart home → *Home Assistant — webhook*: enter your HA URL (`http://homeassistant.local:8123`) and the webhook ID, click **Add Home Assistant webhook**. Kinora sends a test call and adds the webhook (events: play, pause, resume, stop, new media) under Server settings → Webhooks, where you can change events or switch any webhook's payload format between *Kinora JSON* and *Home Assistant (flat JSON)*.

### Payload

```json
{
  "event": "playback.start",
  "action": "started",
  "state": "playing",
  "server": "Kinora",
  "server_id": "iqMnBNQu2wPjR5ax",
  "at": "2026-11-20T20:15:03.120Z",
  "user": "Alice", "user_id": "u1",
  "device": "Living Room TV", "platform": "androidtv",
  "media_type": "episode", "is_video": true,
  "title": "Static", "series": "The Expanse", "season": 2, "episode": 3, "year": 2017,
  "poster_url": "https://media.example.com/api/v1/images/img_abc",
  "position_seconds": 0, "duration_seconds": 2700, "progress_percent": 0,
  "transcode": false, "hdr": true,
  "session_id": "s1", "item_id": "ep1"
}
```

`action` is one of `started`, `paused`, `resumed`, `stopped`, `ended` (stopped at ≥ 90 %), `watched` (scrobble), `library_new` (with `count`, `titles`), `login`, `recording_completed`, `recording_failed`, `request_created`, `request_available`, `test`. `state` is `playing`, `paused` or `idle`.

### Webhook automation example

```yaml
automation:
  - alias: "Kinora – movie night lights (webhook)"
    trigger:
      - platform: webhook
        webhook_id: mediamax_lights
        allowed_methods: [POST]
        local_only: true
    condition:
      - "{{ trigger.json.device == 'Living Room TV' and trigger.json.is_video }}"
    action:
      - choose:
          - conditions: "{{ trigger.json.action in ['started', 'resumed'] }}"
            sequence:
              - service: scene.turn_on
                target: { entity_id: scene.movie_time }
          - conditions: "{{ trigger.json.action in ['paused', 'stopped', 'ended'] }}"
            sequence:
              - service: light.turn_on
                target: { entity_id: light.living_room }
                data: { brightness_pct: 80, transition: 2 }
```

`local_only: true` only accepts calls from your LAN; keep it unless Kinora runs elsewhere.

## REST endpoint

`GET /api/v1/status/now-playing` with an API key (header `X-Api-Key`, or `?api_key=` for tools that can't set headers). Create keys under Settings → Security → API keys. An admin's key sees all streams; any other user's key only their own.

```yaml
sensor:
  - platform: rest
    name: Kinora streams
    resource: http://mediamax.lan:8484/api/v1/status/now-playing
    headers:
      X-Api-Key: !secret kinora_api_key
    value_template: "{{ value_json.activeStreams }}"
    json_attributes: [watching, transcodes, bandwidthKbps, sessions, recentlyAdded]
    scan_interval: 30
```

Response (`NowPlayingStatus` in `shared/src/types.ts`): `{ server, watching, activeStreams, transcodes, directStreams, bandwidthKbps, sessions: [{ state, user, device, title, series, season, episode, mediaType, posterUrl, progressPercent, transcode, hdr, bitrateKbps, … }], recentlyAdded: [...], generatedAt }`.

Homepage (`services.yaml`) example:

```yaml
- Kinora:
    href: https://media.example.com
    widget:
      type: customapi
      url: http://mediamax:8484/api/v1/status/now-playing
      headers: { X-Api-Key: "{{HOMEPAGE_VAR_MEDIAMAX_KEY}}" }
      mappings:
        - { field: activeStreams, label: Streams }
        - { field: transcodes, label: Transcodes }
        - { field: bandwidthKbps, label: kbit/s }
```
