import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { CHANNELS, PROGRAMMES } from './catalog.mjs';

/**
 * A small fake IPTV provider speaking the Xtream Codes API (player_api.php, xmltv.php, /live/… streams), plus static
 * assets (cast headshots, channel logos) for the demo. Everything is fictional and local.
 */
export const XTREAM_USER = 'demo';
export const XTREAM_PASS = 'demo-pass';

const pad = (n) => String(n).padStart(2, '0');
const xmltvTime = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00 +0000`;
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Programmes from 12 h ago to 36 h ahead, aligned to the half hour, cycling through each channel's line-up. */
export function schedule(now = Date.now()) {
  const start = Math.floor(now / 1800000) * 1800000 - 12 * 3600000;
  const end = start + 48 * 3600000;
  const out = [];
  for (const ch of CHANNELS) {
    const list = PROGRAMMES[ch.kind];
    let t = start;
    let i = ch.id % list.length;
    let ep = 1;
    while (t < end) {
      const [title, mins, desc, cat] = list[i % list.length];
      out.push({ channel: ch, title, desc, cat, start: t, stop: t + mins * 60000, ep: ep++, isNew: (i + ch.id) % 4 === 0 });
      t += mins * 60000;
      i++;
    }
  }
  return out;
}

function xmltv(base) {
  let x = '<?xml version="1.0" encoding="UTF-8"?>\n<tv generator-info-name="mediamax-demo">\n';
  for (const ch of CHANNELS) x += `<channel id="ch${ch.id}.demo"><display-name>${xml(ch.name)}</display-name><icon src="${base}/logos/${ch.id}.png"/></channel>\n`;
  for (const p of schedule()) {
    x += `<programme start="${xmltvTime(new Date(p.start))}" stop="${xmltvTime(new Date(p.stop))}" channel="ch${p.channel.id}.demo"><title lang="en">${xml(p.title)}</title><desc lang="en">${xml(p.desc)}</desc><category lang="en">${xml(p.cat)}</category>${p.isNew ? '<new/>' : ''}${p.cat === 'Movie' || p.cat === 'News' ? '' : `<episode-num system="onscreen">E${p.ep}</episode-num>`}</programme>\n`;
  }
  return x + '</tv>\n';
}

export function startMock(assetsDir, port = 0) {
  const now = Date.now();
  const cats = [...new Set(CHANNELS.map((c) => c.cat))];
  let base = '';
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const json = (o) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(o));
    };
    if (u.pathname === '/player_api.php') {
      if (u.searchParams.get('username') !== XTREAM_USER || u.searchParams.get('password') !== XTREAM_PASS) return json({ user_info: { auth: 0 } });
      switch (u.searchParams.get('action')) {
        case null:
          return json({ user_info: { username: XTREAM_USER, auth: 1, status: 'Active', exp_date: String(Math.floor(now / 1000) + 86400 * 300), active_cons: '0', max_connections: '6', is_trial: '0', allowed_output_formats: ['ts', 'm3u8'] }, server_info: { timezone: 'UTC', url: '127.0.0.1', port: String(server.address().port) } });
        case 'get_live_categories':
          return json(cats.map((c, i) => ({ category_id: String(i + 1), category_name: c, parent_id: 0 })));
        case 'get_live_streams':
          return json(CHANNELS.map((c, i) => ({ num: i + 1, name: c.name, stream_type: 'live', stream_id: c.id, stream_icon: `${base}/logos/${c.id}.png`, epg_channel_id: `ch${c.id}.demo`, category_id: String(cats.indexOf(c.cat) + 1), tv_archive: c.kind === 'news' || c.kind === 'sports' ? 1 : 0, tv_archive_duration: 3 })));
        default:
          return json([]);
      }
    }
    if (u.pathname === '/xmltv.php') {
      res.setHeader('content-type', 'application/xml');
      return res.end(xmltv(base));
    }
    const live = u.pathname.match(/^\/(?:live|timeshift)\/.*?(\d+)\.(ts|m3u8)$/);
    if (live) {
      const file = path.join(assetsDir, 'streams', `${live[1]}.ts`);
      if (!fs.existsSync(file)) return res.writeHead(404).end();
      const st = fs.statSync(file);
      res.writeHead(200, { 'content-type': 'video/mp2t', 'content-length': st.size });
      return fs.createReadStream(file).pipe(res);
    }
    const file = path.join(assetsDir, path.normalize(decodeURIComponent(u.pathname)).replace(/^([/\\])+/, ''));
    if (file.startsWith(assetsDir) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { 'content-type': file.endsWith('.png') ? 'image/png' : 'image/jpeg', 'cache-control': 'max-age=3600', 'access-control-allow-origin': '*' });
      return fs.createReadStream(file).pipe(res);
    }
    res.writeHead(404).end('not found');
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve({ server, base, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) });
    });
  });
}
