import http from 'node:http';
import net from 'node:net';

/**
 * Local stand-ins for things on a home network, for the smart-home and Play to screenshots. All fictional:
 *   - a tiny MQTT 3.1.1 broker (CONNECT, PUBLISH with retain, SUBSCRIBE, PINGREQ) standing in for Home Assistant's
 *     Mosquitto add-on, counting the discovery configs Kinora announces;
 *   - Kodi's JSON-RPC API (/jsonrpc) and two UPnP media renderers (a TV and a speaker) with device descriptions
 *     and enough SOAP to answer status polls.
 */

function frame(type, flags, body) {
  const len = [];
  let n = body.length;
  do {
    let b = n & 0x7f;
    n >>= 7;
    if (n) b |= 0x80;
    len.push(b);
  } while (n);
  return Buffer.concat([Buffer.from([(type << 4) | flags, ...len]), body]);
}

export function startMqttBroker() {
  const retained = new Map();
  const conns = new Set();
  const server = net.createServer((sock) => {
    conns.add(sock);
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (buf.length < 2) return;
        let len = 0;
        let mul = 1;
        let i = 1;
        while (i < buf.length) {
          len += (buf[i] & 0x7f) * mul;
          mul *= 128;
          if (!(buf[i++] & 0x80)) break;
        }
        if (buf[i - 1] & 0x80 || i + len > buf.length) return;
        const type = buf[0] >> 4;
        const flags = buf[0] & 15;
        const body = buf.subarray(i, i + len);
        buf = buf.subarray(i + len);
        if (type === 1) sock.write(frame(2, 0, Buffer.from([0, 0])));
        else if (type === 3) {
          const tl = body.readUInt16BE(0);
          const topic = body.subarray(2, 2 + tl).toString();
          let o = 2 + tl;
          if ((flags >> 1) & 3) {
            sock.write(frame(4, 0, body.subarray(o, o + 2)));
            o += 2;
          }
          if (flags & 1) retained.set(topic, Buffer.from(body.subarray(o)));
        } else if (type === 8) {
          const id = body.subarray(0, 2);
          let o = 2;
          const granted = [];
          while (o < body.length) {
            o += 2 + body.readUInt16BE(o) + 1;
            granted.push(0);
          }
          sock.write(frame(9, 0, Buffer.concat([id, Buffer.from(granted)])));
        } else if (type === 12) sock.write(frame(13, 0, Buffer.alloc(0)));
      }
    });
    sock.on('close', () => conns.delete(sock));
    sock.on('error', () => conns.delete(sock));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      url: `mqtt://127.0.0.1:${server.address().port}`, retained,
      close: () => new Promise((r) => {
        for (const s of conns) s.destroy();
        server.close(() => r());
      }),
    }));
  });
}

const RENDERERS = {
  tv: { name: 'Living Room TV', manufacturer: 'Demo Electronics', model: 'Smart TV 65', udn: 'uuid:5f1b2c3d-demo-tv-0001' },
  speaker: { name: 'Kitchen', manufacturer: 'Sonos, Inc.', model: 'Sonos One', udn: 'uuid:RINCON_000E58DEMO0001400' },
};

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function startDeviceMocks() {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      if (req.url === '/jsonrpc') {
        let body = {};
        try { body = JSON.parse(raw); } catch {}
        const results = {
          'JSONRPC.Ping': 'pong',
          'Application.GetProperties': { name: 'Kodi', version: { major: 21, minor: 1 } },
          'XBMC.GetInfoLabels': { 'System.FriendlyName': 'Den Kodi' },
          'Player.GetActivePlayers': [],
          'Application.GetVolume': { volume: 60, muted: false },
        };
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id ?? 1, result: results[body.method] ?? 'OK' }));
      }
      const m = req.url.match(/^\/(tv|speaker)\/desc\.xml$/);
      if (m) {
        const d = RENDERERS[m[1]];
        res.writeHead(200, { 'content-type': 'text/xml' });
        return res.end(`<?xml version="1.0"?><root xmlns="urn:schemas-upnp-org:device-1-0"><specVersion><major>1</major></specVersion><device>
          <deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType><friendlyName>${esc(d.name)}</friendlyName><manufacturer>${esc(d.manufacturer)}</manufacturer><modelName>${esc(d.model)}</modelName>
          <UDN>${d.udn}</UDN><serviceList>
          <service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>/${m[1]}/AVTransport</controlURL></service>
          <service><serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType><controlURL>/${m[1]}/RenderingControl</controlURL></service>
          <service><serviceType>urn:schemas-upnp-org:service:ConnectionManager:1</serviceType><controlURL>/${m[1]}/ConnectionManager</controlURL></service>
          </serviceList></device></root>`);
      }
      const action = String(req.headers.soapaction ?? '').replace(/"/g, '').split('#')[1] ?? '';
      const out = {
        GetProtocolInfo: { Source: '', Sink: 'http-get:*:video/mp4:*,http-get:*:video/mpeg:*,http-get:*:audio/mpeg:*,http-get:*:audio/flac:*' },
        GetTransportInfo: { CurrentTransportState: 'NO_MEDIA_PRESENT', CurrentTransportStatus: 'OK', CurrentSpeed: '1' },
        GetPositionInfo: { Track: '0', TrackDuration: '0:00:00', TrackURI: '', RelTime: '0:00:00', AbsTime: 'NOT_IMPLEMENTED' },
        GetVolume: { CurrentVolume: '30' },
        GetMute: { CurrentMute: '0' },
      }[action] ?? {};
      res.writeHead(200, { 'content-type': 'text/xml; charset="utf-8"' });
      res.end(`<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action}Response xmlns:u="x">${Object.entries(out).map(([k, v]) => `<${k}>${esc(v)}</${k}>`).join('')}</u:${action}Response></s:Body></s:Envelope>`);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port, base: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => {
          server.closeAllConnections?.();
          server.close(() => r());
        }),
      });
    });
  });
}
