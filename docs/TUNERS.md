# TV tuners and set-top boxes

Besides IPTV (Xtream Codes, M3U) and HDHomeRun, MediaMax can use your own broadcast hardware as a Live TV source:

| Source | Hardware / software | Channels from | Guide from | Streams |
|---|---|---|---|---|
| **TVHeadend** | Any DVB-S/S2/T/T2/C card or USB stick managed by a [TVHeadend](https://tvheadend.org) server | `/api/channel/grid` (+ channel tags as categories) | TVHeadend's own EPG (`/api/epg/events/grid`), automatically | `/stream/channel/<uuid>?profile=<profile>` |
| **SAT>IP** | Digital Devices Octopus NET, Telestar Digibit, Inverto, Kathrein, minisatip, AVM FRITZ!Box Cable (6490/6590/6591/6660 Cable…) | An M3U of SAT>IP URLs, or the FRITZ!Box's own lists | Any XMLTV / iptv-org / epg.pw guide, matched by channel name | RTSP (or HTTP) remuxed by FFmpeg |
| **Enigma2** | Vu+, Dreambox, Zgemma, Octagon, GigaBlue… with OpenWebif | Bouquets you pick (`/api/getservices`) | The receiver's EPG (`/api/epgmulti`, `/api/epgservice`), automatically | `http://<box>:8001/<service ref>` (transcoding port 8002 optional) |

Add them under **Admin → Live TV sources → Add source**. Every tuner source:

- has a **Test connection** button that checks the address and login and shows the device, the number of tuners and the number of channels (Enigma2: also lists the bouquets to pick);
- is **always restreamed** through MediaMax (device logins and RTSP never reach the clients);
- limits concurrent streams to the **tuner count** the device reports (TVHeadend `/api/status/inputs`, SAT>IP `X_SATIPCAP`, Enigma2 tuner list). Set *Max simultaneous streams* to override it. Viewers of the same channel watching through HLS share one tuner; a viewer who would need one more tuner than the device has gets "All N connection(s) are in use";
- shows its last error on the source card, and refreshes channels and guide every *Refresh every* hours (or with **Refresh**).

Passwords are write-only: the API returns them masked (`••••••••`), and leaving the field blank when editing keeps the saved one.

## TVHeadend

1. URL: the web interface address, e.g. `http://192.168.1.10:9981` (with a webroot: `http://host:9981/tvheadend`).
2. Username / password of a TVHeadend user. TVHeadend uses **Digest** authentication by default; MediaMax answers Digest or plain (Basic) automatically. The user needs *Streaming* and *Web interface* rights; for the channel list and the tuner count also *Admin* or at least read access to channels. A streaming-only user still works: MediaMax falls back to `/playlist/channels.m3u` (no channel tags, tuner count unknown).
3. **Stream profile**: `pass` (default) sends the untouched MPEG-TS; `matroska`, `htsp` or your own transcoding profiles can be picked after a test.
4. Channel icons come from TVHeadend's image cache (`/imagecache/<id>`) with the same login.

**Guide.** The source gets a *provider guide* (priority 0, like the IPTV provider guides) that reads TVHeadend's EPG grid. Its channel ids are the TVHeadend channel UUIDs, the same ids the channels carry, so every channel matches automatically (method *id*). Add an XMLTV URL to the source, or any guide under **Admin → TV guide**, to override it per channel (higher priority wins).

**Recordings.** For TVHeadend sources the card menu has *Recordings on TVHeadend*: a read-only list of finished recordings (`/api/dvr/entry/grid_finished`) with a download link that goes through MediaMax. MediaMax's own DVR records from TVHeadend channels like from any other channel.

## SAT>IP

1. **Find SAT>IP servers on the network** sends an SSDP search for `urn:ses-com:device:SatIPServer:1` and lists what answers (name, address, tuners, `X_SATIPCAP` such as `DVBS2-2,DVBT-2`). Picking one fills the address and the description URL. Or type the IP address.
2. **Channel list**
   - **FRITZ!Box built-in lists**: MediaMax reads `http://<fritzbox>/dvb/m3u/tvhd.m3u`, `tvsd.m3u` and optionally `radio.m3u`. Run the cable channel scan in the FRITZ!Box first (*DVB-C → Channel list*). Discovered FRITZ!Boxes select this automatically.
   - **M3U with SAT>IP URLs**: a playlist of `rtsp://<ip>/?src=1&freq=11494&pol=h&msys=dvbs2&sr=22000&pids=0,17,18,5100,5101` or `http://<ip>/?src=…` entries — from your server's web interface, a community list for your satellite, or one you wrote. Entries using the placeholder host `sat.ip` (common in shared lists) or a bare `?src=…` query are pointed at your device. `tvg-id`, `tvg-logo` and `group-title` are used.
3. **Tuner count** comes from the device description (`<satip:X_SATIPCAP>`, tried at the discovered URL, `:49000/satipdesc.xml` (FRITZ!Box), `:8080/desc.xml` (minisatip) and `/desc.xml`). `DVBS2-2,DVBT-2` counts as four streams in total; MediaMax does not track which delivery system each channel needs, so set *Max simultaneous streams* if one system has fewer tuners than you watch at once.
4. **RTSP transport**: FFmpeg asks for RTP over **TCP** (interleaved) by default, which works through NAT and Docker bridges. The FRITZ!Box only streams over **UDP**, which is the default for FRITZ!Box sources; UDP needs MediaMax on the same network as the box (Docker: `network_mode: host`).

**Guide.** SAT>IP has no guide API (the DVB EIT in the stream is not read). Add a guide under **Admin → TV guide** — an iptv-org or epg.pw guide for your country, or Schedules Direct / any XMLTV — and the channels are matched by name (`tvg-id` in your M3U matches exactly). The matching page shows anything that needs a hand.

## Enigma2 (OpenWebif)

1. URL: the receiver's web interface, e.g. `http://192.168.1.20`. Username / password only if OpenWebif authentication is on (HTTP Basic).
2. **Test connection** lists the receiver's TV bouquets; tick the ones to import (default: the first). Markers (section labels) are skipped; a service in several bouquets is imported once; channel numbers follow the bouquet positions; categories are the bouquets.
3. Streams come from port **8001** (`http://<box>:8001/<service reference>`). Turn on **Stream authentication** when OpenWebif's *streamauth* is enabled (the same login is then sent to port 8001). **Use the receiver's transcoding port** switches to port 8002 on boxes with a hardware encoder. Both ports can be changed.
4. Picons come from `/picon/<service reference with _>.png` on the receiver.
5. The tuner count is the receiver's tuner list (`/api/deviceinfo`). A twin-tuner box can show two channels from different transponders at once; while it records, one tuner is busy on the box itself — lower *Max simultaneous streams* if that happens often.

**Guide.** Like TVHeadend, the receiver's own EPG is a provider guide keyed by service reference (exact matches). MediaMax reads `/api/epgmulti` per bouquet (7 days by default, *Guide days* 1–14) and falls back to `/api/epgservice` per channel on older OpenWebif versions.

## HDHomeRun discovery

The *HDHomeRun* source type has **Find HDHomeRun tuners on the network** too (SiliconDust's UDP discovery on port 65001). It needs the same network as the tuner (Docker: host networking).

## Docker and networking

- SSDP (SAT>IP) and HDHomeRun discovery use multicast/broadcast and only work with **host networking** (`network_mode: host`). Without it, type the device address.
- RTSP over UDP (FRITZ!Box) needs host networking too; RTSP over TCP and all HTTP streams (TVHeadend, Enigma2, SAT>IP over HTTP) work through the default bridge.

## Troubleshooting

| Message | Meaning |
|---|---|
| *Connection refused by host:port* | Wrong port, or the service is not running (TVHeadend 9981, OpenWebif 80, SAT>IP description 8080/49000). |
| *Wrong username or password* | The device rejected the login (Digest and Basic were both tried). |
| *Access denied — the user has no permission* | TVHeadend: give the user streaming / web interface rights. |
| *No channel lists on the FRITZ!Box* | Run the DVB-C channel scan in the FRITZ!Box, or the box has no cable tuner. |
| *Enter the URL of an M3U channel list* | Generic SAT>IP servers have no channel list of their own; give one. |
| *The tuner refused the stream* / *No free tuner on the device* | The device has no free tuner, the channel is encrypted, or (FRITZ!Box) UDP is blocked — check *RTSP transport* and networking. |
| *All N connection(s) to "…" are in use* | MediaMax's own stream limit (tuner count or *Max simultaneous streams*). |

## Limitations

- Tested against mock servers that follow the TVHeadend, OpenWebif and SAT>IP documentation, not against every device and firmware.
- No DVB EIT (in-stream guide) for SAT>IP; use XMLTV / community guides.
- Encrypted channels play only if the device decrypts them (CI module / softcam on the box).
- TVHeadend recordings are listed and downloadable, not imported as a library.
