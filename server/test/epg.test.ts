/**
 * TV guide providers: XMLTV (URL, gzip, xz, local file, time-zone override), Schedules Direct and HDHomeRun
 * against mock servers that follow the documented APIs, priority merging, broken-guide safety, matching,
 * time shift and the admin API. Plus the fuzzy matcher on realistic IPTV channel names.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { GUIDE, LIVE } from './fixtures/epg-match-set.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-epg-'));
process.env.MEDIAMAX_DATA = path.join(tmp, 'data');

/* ------------------------------ mock servers ------------------------------ */

type Handler = (req: http.IncomingMessage, body: string, url: URL) => { status?: number; type?: string; body: string | Buffer } | Promise<{ status?: number; type?: string; body: string | Buffer }>;
const servers: http.Server[] = [];
async function serve(h: Handler): Promise<string> {
  const s = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const url = new URL(req.url ?? '/', 'http://x');
    try {
      const r = await h(req, body, url);
      res.writeHead(r.status ?? 200, { 'Content-Type': r.type ?? 'application/json' });
      res.end(r.body);
    } catch (e) {
      res.writeHead(500);
      res.end(String(e));
    }
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  servers.push(s);
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}
after(() => {
  for (const s of servers) s.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const H = 3600000;
const hourStart = Math.floor(Date.now() / H) * H;
const xt = (ms: number, tz = '+0000') => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}00 ${tz}`;
};
function xmltv(channels: { id: string; name: string }[], titlePrefix: string, hours = 30): string {
  let x = '<?xml version="1.0" encoding="UTF-8"?>\n<tv>\n';
  for (const c of channels) x += `<channel id="${c.id}"><display-name>${c.name}</display-name></channel>\n`;
  for (const c of channels) {
    for (let i = -2; i < hours; i++) {
      x += `<programme start="${xt(hourStart + i * H)}" stop="${xt(hourStart + (i + 1) * H)}" channel="${c.id}"><title>${titlePrefix} ${c.name} ${i}</title></programme>\n`;
    }
  }
  return x + '</tv>\n';
}

const GUIDE1 = [
  { id: 'BBCOne.uk', name: 'BBC One' }, { id: 'ITV1.uk', name: 'ITV1' }, { id: 'E4.uk', name: 'E4' },
  { id: 'SkySportsMainEvent.uk', name: 'Sky Sports Main Event' }, { id: 'SkySportsPremierLeague.uk', name: 'Sky Sports Premier League' },
];
let guide1Broken = false;
const PROVIDER = [{ id: 'BBCOne.uk', name: 'BBC One' }, { id: 'Mystery.uk', name: 'Mystery Channel' }];
const GUIDE2 = [{ id: 'bbc1', name: 'BBC 1' }];

const hasXz = (() => {
  try {
    execFileSync('xz', ['--version']);
    return true;
  } catch {
    return false;
  }
})();

let iptvBase = '';
const iptv = await serve((_req, _b, url) => {
  if (url.pathname === '/playlist.m3u') {
    return {
      type: 'audio/x-mpegurl',
      body: `#EXTM3U url-tvg="${iptvBase}/provider.xml.gz"
#EXTINF:-1 tvg-id="bbc1.fake" group-title="UK",UK: BBC One HD
${iptvBase}/s/1.ts
#EXTINF:-1 tvg-id="ITV1.uk" group-title="UK",ITV1 HD
${iptvBase}/s/2.ts
#EXTINF:-1 group-title="UK",E4 +1
${iptvBase}/s/3.ts
#EXTINF:-1 group-title="UK",Mystery Channel
${iptvBase}/s/4.ts
#EXTINF:-1 group-title="UK",Sky Sports
${iptvBase}/s/5.ts
#EXTINF:-1 group-title="US",WABC-DT
${iptvBase}/s/6.ts
#EXTINF:-1 group-title="Misc",Nothing Here 24/7
${iptvBase}/s/7.ts
`,
    };
  }
  if (url.pathname === '/guide1.xml') return guide1Broken ? { status: 500, body: 'boom' } : { type: 'text/xml', body: xmltv(GUIDE1, 'G1') };
  if (url.pathname === '/provider.xml.gz') return { type: 'application/gzip', body: zlib.gzipSync(xmltv(PROVIDER, 'PROV')) };
  if (url.pathname === '/guide2.xml.xz') return { type: 'application/x-xz', body: execFileSync('xz', ['-c'], { input: xmltv(GUIDE2, 'G2') }) };
  if (url.pathname === '/guide2.xml') return { type: 'text/xml', body: xmltv(GUIDE2, 'G2') };
  return { status: 404, body: 'nope' };
});
iptvBase = iptv;

/* Schedules Direct mock, following https://github.com/SchedulesDirect/JSON-Service/wiki/API-20141201 */
const SD_PASSWORD = 'correct horse';
const sd = {
  tokens: 0,
  calls: [] as string[],
  validTokens: new Set<string>(),
  expireNext: false,
  lineups: [] as string[],
  maxBatch: 0,
  schedVersion: new Map<string, number>(), // station|date → version (changes md5)
  progVersion: new Map<string, number>(),
};
const SD_STATIONS = [
  { stationID: '10001', name: 'WABC', callsign: 'WABC', affiliate: 'ABC', atscMajor: 7, atscMinor: 1 },
  { stationID: '10002', name: 'WCBS', callsign: 'WCBS', affiliate: 'CBS', atscMajor: 2, atscMinor: 1 },
  { stationID: '10003', name: 'WNBC', callsign: 'WNBC', affiliate: 'NBC', atscMajor: 4, atscMinor: 1 },
];
const md5 = (s: string) => crypto.createHash('md5').update(s).digest('base64').slice(0, 22);
const sdSched = (station: string, date: string) => {
  const v = sd.schedVersion.get(`${station}|${date}`) ?? 0;
  const base = Date.parse(`${date}T00:00:00Z`);
  const programs = Array.from({ length: 24 }, (_, h) => {
    const pid = `EP${station}${String(h % 6).padStart(4, '0')}`;
    return { programID: pid, airDateTime: new Date(base + h * H).toISOString().replace('.000', ''), duration: 3600, md5: md5(pid + (sd.progVersion.get(pid) ?? 0)), ...(h === 20 ? { new: true } : {}) };
  });
  if (v) programs[0].duration = 1800 + v; // a real change
  // Like SD, the schedule md5 covers its airings (whose md5s change when a programme changes).
  return { stationID: station, programs, metadata: { modified: new Date().toISOString(), md5: md5(`${station}${date}${JSON.stringify(programs)}`), startDate: date } };
};
const sdUrl = await serve((req, body, url) => {
  const p = url.pathname.replace(/^\/20141201/, '');
  sd.calls.push(`${req.method} ${p}`);
  const json = (o: unknown, status = 200) => ({ status, body: JSON.stringify(o) });
  if (!String(req.headers['user-agent'] ?? '').startsWith('Kinora/')) return json({ code: 1004, message: 'Missing user agent' }, 400);
  if (p === '/token' && req.method === 'POST') {
    const b = JSON.parse(body);
    if (b.username !== 'sduser' || b.password !== crypto.createHash('sha1').update(SD_PASSWORD).digest('hex')) return json({ code: 4003, message: 'Invalid username or token has expired.' }, 400);
    const token = `tok-${++sd.tokens}`;
    sd.validTokens.add(token);
    return json({ code: 0, message: 'OK', serverID: 'mock', datetime: new Date().toISOString(), token });
  }
  const tok = String(req.headers.token ?? '');
  if (sd.expireNext) {
    sd.expireNext = false;
    sd.validTokens.delete(tok);
  }
  if (!sd.validTokens.has(tok)) return json({ code: 4006, message: 'Token has expired. Request new token.' }, 403);
  const batch = (n: number) => {
    sd.maxBatch = Math.max(sd.maxBatch, n);
    return n > 5000;
  };
  if (p === '/status') {
    return json({
      account: { expires: new Date(Date.now() + 200 * 86400000).toISOString(), messages: [], maxLineups: 4 },
      lineups: sd.lineups.map((l) => ({ lineup: l, modified: '2026-11-01T00:00:00Z', uri: `/20141201/lineups/${l}` })),
      lastDataUpdate: new Date().toISOString(), notifications: [], systemStatus: [{ date: new Date().toISOString(), status: 'Online', message: 'No known issues.' }], serverID: 'mock', code: 0,
    });
  }
  if (p === '/headends') {
    if (url.searchParams.get('country') !== 'USA' || url.searchParams.get('postalcode') !== '10001') return json([]);
    return json([
      { headend: 'NY67791', transport: 'Cable', location: 'New York', lineups: [{ name: 'Mock Cable - Digital', lineup: 'USA-NY67791-X', uri: '/20141201/lineups/USA-NY67791-X' }] },
      { headend: '10001', transport: 'Antenna', location: '10001', lineups: [{ name: 'Antenna', lineup: 'USA-OTA-10001', uri: '/20141201/lineups/USA-OTA-10001' }] },
    ]);
  }
  const lm = p.match(/^\/lineups\/(.+)$/);
  if (lm && req.method === 'PUT') {
    if (!sd.lineups.includes(lm[1])) sd.lineups.push(lm[1]);
    return json({ response: 'OK', code: 0, serverID: 'mock', message: 'Added lineup.', changesRemaining: 5, datetime: new Date().toISOString() });
  }
  if (lm && req.method === 'DELETE') {
    sd.lineups = sd.lineups.filter((l) => l !== lm[1]);
    return json({ response: 'OK', code: 0, serverID: 'mock', message: 'Deleted lineup.', changesRemaining: 4, datetime: new Date().toISOString() });
  }
  if (p === '/lineups') {
    if (!sd.lineups.length) return json({ response: 'NO_LINEUPS', code: 4102, message: 'No lineups have been added to this account.' }, 400);
    return json({ serverID: 'mock', datetime: new Date().toISOString(), lineups: sd.lineups.map((l) => ({ lineup: l, name: 'Antenna', transport: 'Antenna', location: '10001', uri: `/20141201/lineups/${l}` })) });
  }
  if (lm && req.method === 'GET') {
    return json({
      map: SD_STATIONS.map((s) => ({ stationID: s.stationID, uhfVhf: s.atscMajor, atscMajor: s.atscMajor, atscMinor: s.atscMinor })),
      stations: SD_STATIONS.map((s) => ({ stationID: s.stationID, name: s.name, callsign: s.callsign, affiliate: s.affiliate, broadcastLanguage: ['en'], logo: { URL: `https://logos.example/${s.stationID}.png`, height: 270, width: 360, md5: 'x' } })),
      metadata: { lineup: lm[1], modified: '2026-11-01T00:00:00Z', transport: 'Antenna' },
    });
  }
  if (p === '/schedules/md5' && req.method === 'POST') {
    const b = JSON.parse(body) as { stationID: string; date: string[] }[];
    if (batch(b.length)) return json({ code: 2001, message: 'Too many stations' }, 400);
    const out: Record<string, Record<string, unknown>> = {};
    for (const s of b) {
      out[s.stationID] = {};
      for (const d of s.date) out[s.stationID][d] = { code: 0, message: 'OK', lastModified: new Date().toISOString(), md5: sdSched(s.stationID, d).metadata.md5 };
    }
    return json(out);
  }
  if (p === '/schedules' && req.method === 'POST') {
    const b = JSON.parse(body) as { stationID: string; date: string[] }[];
    if (batch(b.length)) return json({ code: 2001, message: 'Too many stations' }, 400);
    return json(b.flatMap((s) => s.date.map((d) => sdSched(s.stationID, d))));
  }
  if (p === '/programs' && req.method === 'POST') {
    const ids = JSON.parse(body) as string[];
    if (batch(ids.length)) return json({ code: 2001, message: 'Too many programs' }, 400);
    return json(ids.map((pid) => ({
      programID: pid, titles: [{ title120: `Show ${pid.slice(-4)}` }], episodeTitle150: `Episode v${sd.progVersion.get(pid) ?? 0}`,
      descriptions: { description1000: [{ descriptionLanguage: 'en', description: `About ${pid}` }] }, genres: ['News'], originalAirDate: '2020-01-01',
      metadata: [{ Gracenote: { season: 2, episode: 5 } }], md5: md5(pid + (sd.progVersion.get(pid) ?? 0)), hasImageArtwork: true,
    })));
  }
  if (p === '/metadata/programs/' && req.method === 'POST') {
    const roots = JSON.parse(body) as string[];
    if (roots.length > 500) return json({ code: 2001, message: 'Too many' }, 400);
    return json(roots.map((r) => ({ programID: r, data: [{ uri: `https://img.example/${r}.jpg`, width: '1280', height: '720', category: 'Iconic', aspect: '16x9' }] })));
  }
  return json({ code: 2000, message: `unknown ${p}` }, 404);
});
process.env.MEDIAMAX_SD_URL = `${sdUrl}/20141201`;

/* HDHomeRun device + guide API mock */
const hdhr = { guideCalls: 0 };
const hdDevice = await serve((_req, _b, url) => {
  if (url.pathname === '/discover.json') return { body: JSON.stringify({ FriendlyName: 'HDHomeRun FLEX 4K', DeviceID: '1234ABCD', DeviceAuth: 'auth-xyz', BaseURL: 'http://x', LineupURL: 'http://x/lineup.json', TunerCount: 4 }) };
  if (url.pathname === '/lineup.json') {
    return { body: JSON.stringify([{ GuideNumber: '2.1', GuideName: 'WCBS-DT', URL: 'http://127.0.0.1/auto/v2.1', HD: 1 }, { GuideNumber: '4.1', GuideName: 'WNBC-HD', URL: 'http://127.0.0.1/auto/v4.1', HD: 1 }]) };
  }
  return { status: 404, body: '' };
});
const hdGuide = await serve((_req, _b, url) => {
  if (url.searchParams.get('DeviceAuth') !== 'auth-xyz') return { status: 403, body: 'null' };
  hdhr.guideCalls++;
  const start = Number(url.searchParams.get('Start') ?? Math.floor(hourStart / 1000));
  const mk = (num: string, name: string, aff: string) => ({
    GuideNumber: num, GuideName: name, Affiliate: aff, ImageURL: `https://img.hdhomerun.example/${num}.png`,
    Guide: Array.from({ length: 4 }, (_, i) => ({ StartTime: start + i * 3600, EndTime: start + (i + 1) * 3600, Title: `${aff} Show ${start + i * 3600}`, EpisodeNumber: 'S01E02', Synopsis: 'Synopsis', Filter: ['News'], First: i === 0 ? 1 : 0 })),
  });
  return { body: JSON.stringify([mk('2.1', 'WCBS-DT', 'CBS'), mk('4.1', 'WNBC-DT', 'NBC')]) };
});
process.env.MEDIAMAX_HDHR_GUIDE_URL = `${hdGuide}/api/guide.php`;

/* ------------------------------ imports (after env) ------------------------------ */

const { db } = await import('../src/db.ts');
const live = await import('../src/services/livetv/livetv.ts');
const epg = await import('../src/services/livetv/epg/epg.ts');
const { GuideIndex, normalizeName, jaroWinkler, AUTO_THRESHOLD, SUGGEST_THRESHOLD } = await import('../src/services/livetv/epg/matcher.ts');
const { parseXmltvTime, zonedToUtc } = await import('../src/services/livetv/xmltv.ts');
const { SdClient } = await import('../src/services/livetv/epg/schedulesdirect.ts');
const { createUser, issueToken } = await import('../src/services/auth.ts');
const { buildApp } = await import('../src/app.ts');

const admin = createUser({ username: 'epgadmin', password: 'pw-123456', isAdmin: true });
const viewer = createUser({ username: 'epgviewer', password: 'pw-123456' });
const ch = (sourceId: string, name: string) => db.get('SELECT * FROM channels WHERE source_id = ? AND name = ?', sourceId, name)!;
const progTitles = (channelId: string) => live.channelPrograms(admin, channelId).map((p) => p.title);

/* ------------------------------ matcher ------------------------------ */

test('normalisation strips prefixes, quality tags, +1 and punctuation', () => {
  const n = (s: string) => normalizeName(s).compact;
  assert.equal(n('UK: BBC One HD'), 'bbc1');
  assert.equal(n('bbc.one.uk'), 'bbc1');
  assert.equal(n('BBCOne.uk@HD'), 'bbc1');
  assert.equal(n('|US| ESPN FHD'), 'espn');
  assert.equal(n('[DE] Das Erste ᴴᴰ'), 'daserste');
  assert.equal(normalizeName('ITV +1').plus, 1);
  assert.equal(normalizeName('UK: BBC One HD').country, 'gb');
  assert.equal(n('5USA'), '5usa');
  assert.ok(Math.abs(jaroWinkler('MARTHA', 'MARHTA') - 0.961) < 0.001);
});

test('fuzzy matcher accuracy on realistic IPTV names', () => {
  const idx = new GuideIndex(GUIDE.map(([id, name]) => ({ id, names: [name] })));
  let autoRight = 0, reviewRight = 0, wrongAuto = 0, missed = 0, noneRight = 0;
  for (const l of LIVE) {
    const b = idx.best({ id: l.name, name: l.name, tvgId: l.tvgId ?? null });
    const auto = !!b && b.confidence >= AUTO_THRESHOLD;
    if (l.expect === null) {
      if (auto) wrongAuto++;
      else noneRight++;
    } else if (auto && b!.guideId === l.expect) {
      autoRight++;
      if (l.offset) assert.equal(b!.offsetMinutes, l.offset, l.name);
    } else if (auto) wrongAuto++;
    else if (b && b.guideId === l.expect && b.confidence >= SUGGEST_THRESHOLD) reviewRight++;
    else missed++;
  }
  const expected = LIVE.filter((l) => l.expect).length;
  console.log(`matcher: ${autoRight}/${expected} auto-matched correctly, ${reviewRight} correct suggestions queued for review, ${missed} missed, ${wrongAuto} wrong auto-matches, ${noneRight}/${LIVE.length - expected} correctly left unmatched`);
  assert.equal(wrongAuto, 0, 'no wrong automatic matches');
  assert.ok(autoRight >= expected - 3, `auto-matched ${autoRight}/${expected}`);
});

test('callsigns and tuner guide numbers', () => {
  const idx = new GuideIndex([{ id: '10001', names: ['WABC'], callsign: 'WABC', number: '7.1' }, { id: '10002', names: ['WCBS'], callsign: 'WCBS', number: '2.1' }]);
  assert.deepEqual(idx.best({ id: 'a', name: 'WABC-DT' }), { guideId: '10001', confidence: 0.96, method: 'callsign', offsetMinutes: 0 });
  assert.equal(idx.best({ id: 'b', name: 'Channel two', number: '2.1' }, { byNumber: true })?.method, 'number');
  assert.equal(idx.best({ id: 'b', name: 'Channel two', number: '2.1' })?.guideId ?? null, null);
});

test('XMLTV time-zone override', () => {
  assert.equal(parseXmltvTime('20260115120000 +0000', '+02:00'), '2026-01-15T10:00:00.000Z');
  assert.equal(parseXmltvTime('20260115120000 +0500', 'Europe/London'), '2026-01-15T12:00:00.000Z');
  assert.equal(parseXmltvTime('20260715120000', 'Europe/London'), '2026-07-15T11:00:00.000Z');
  assert.equal(new Date(zonedToUtc(2026, 3, 8, 12, 0, 0, 'America/New_York')).toISOString(), '2026-03-08T16:00:00.000Z');
});

/* ------------------------------ XMLTV, priorities, legacy epgUrl ------------------------------ */

let iptvId = '';
test('live source epgUrl and provider guide become guide sources; channels are matched', async () => {
  const src = live.createSource({ name: 'Mock IPTV', type: 'm3u', url: `${iptv}/playlist.m3u`, epgUrl: `${iptv}/guide1.xml` });
  iptvId = src.id;
  await live.refreshSource(src.id);
  const s = live.listSources().find((x) => x.id === src.id)!;
  assert.equal(s.lastError, null);
  const guides = epg.listEpgSources().filter((g) => g.ownerSourceId === src.id);
  assert.deepEqual(guides.map((g) => [g.managedBy, g.priority]), [['epgUrl', 100], ['provider', 0]]);
  assert.equal(guides[0].report.channels, 5);
  assert.ok(guides[0].report.daysAhead > 1);
  assert.ok(!JSON.stringify(guides).includes('password'));

  const bbc = ch(src.id, 'UK: BBC One HD');
  assert.equal(bbc.guide_status, 'auto');
  assert.equal(bbc.guide_source_id, guides[0].id, 'higher-priority guide wins');
  assert.ok(progTitles(bbc.id).every((t) => t.startsWith('G1 ')));
  assert.equal(ch(src.id, 'ITV1 HD').guide_method, 'id');
  // Mystery Channel is only in the provider guide: lower priority fills the gap.
  const mystery = ch(src.id, 'Mystery Channel');
  assert.equal(mystery.guide_source_id, guides[1].id);
  assert.ok(progTitles(mystery.id)[0].startsWith('PROV '));
  // "+1" channel: matched to E4 with a one-hour shift.
  const e4 = ch(src.id, 'E4 +1');
  assert.equal(e4.guide_offset, 60);
  const e4p = live.channelPrograms(admin, e4.id);
  const base = db.get('SELECT start FROM programs WHERE epg_channel_id = ? ORDER BY start LIMIT 1', epg.guideKey(guides[0].id, 'E4.uk'))!.start;
  assert.ok(e4p.some((p) => p.start === new Date(Date.parse(base) + H).toISOString()));
  // Ambiguous name → suggestion for review, not applied.
  const sky = ch(src.id, 'Sky Sports');
  assert.equal(sky.guide_status, 'review');
  assert.equal(sky.guide_key, null);
  assert.equal(ch(src.id, 'Nothing Here 24/7').guide_status, 'none');
  // Guide and now/next work through the normal endpoints.
  const g = live.guide(admin, {});
  assert.ok(g.programs.some((p) => p.channelId === bbc.id));
  assert.ok(live.getChannel(admin, bbc.id).nowPlaying?.title.startsWith('G1 '));
});

test('a broken guide never empties the EPG', async () => {
  const g1 = epg.listEpgSources().find((g) => g.managedBy === 'epgUrl')!;
  const before = g1.report.programmes;
  guide1Broken = true;
  await live.refreshSource(iptvId, { epgOnly: true });
  guide1Broken = false;
  const after1 = epg.getEpgSource(g1.id);
  assert.match(after1.lastError ?? '', /HTTP 500/);
  assert.equal(after1.report.programmes, before);
  const bbc = ch(iptvId, 'UK: BBC One HD');
  assert.ok(progTitles(bbc.id).length > 10 && progTitles(bbc.id).every((t) => t.startsWith('G1 ')));
  assert.equal(live.listSources().find((s) => s.id === iptvId)!.lastError, null, 'source is fine while another guide loads');
});

let g2Id = '';
test('global xz guide, priority changes, local file with time-zone override', { skip: !hasXz && 'xz not installed' }, async () => {
  const g2 = await epg.createEpgSource({ name: 'Community', kind: 'xmltv', config: { url: `${iptv}/guide2.xml.xz` }, priority: 50 });
  g2Id = g2.id;
  await epg.refreshEpgSource(g2.id);
  assert.equal(epg.getEpgSource(g2.id).lastError, null);
  assert.equal(epg.getEpgSource(g2.id).report.channels, 1);
  const bbc = () => ch(iptvId, 'UK: BBC One HD');
  assert.notEqual(bbc().guide_source_id, g2.id, 'priority 50 loses to the source epgUrl (100)');
  epg.updateEpgSource(g2.id, { priority: 150 });
  assert.equal(bbc().guide_source_id, g2.id);
  assert.ok(progTitles(bbc().id).every((t) => t.startsWith('G2 ')));
  epg.updateEpgSource(g2.id, { priority: 50 });
  assert.notEqual(bbc().guide_source_id, g2.id);

  const file = path.join(tmp, 'guide3.xml');
  fs.writeFileSync(file, xmltv([{ id: 'local.one', name: 'Nothing Here' }], 'LOCAL'));
  const g3 = await epg.createEpgSource({ name: 'Local file', kind: 'xmltv', config: { path: file, timezone: '+02:00' }, liveSourceIds: [iptvId] });
  await epg.refreshEpgSource(g3.id);
  const row = db.get('SELECT start FROM programs WHERE epg_channel_id = ? ORDER BY start LIMIT 1', epg.guideKey(g3.id, 'local.one'))!;
  assert.equal(row.start, new Date(hourStart - 2 * H - 2 * H).toISOString(), 'wall clock read as +02:00');
  await assert.rejects(epg.createEpgSource({ name: 'bad tz', kind: 'xmltv', config: { path: file, timezone: 'Mars/Olympus' } }), /time zone/);
  await assert.rejects(epg.createEpgSource({ name: 'rel', kind: 'xmltv', config: { path: 'relative.xml' } }), /absolute/);
});

test('manual match, time shift and accept-all survive a refresh', async () => {
  const sky = ch(iptvId, 'Sky Sports');
  const g1 = epg.listEpgSources().find((g) => g.managedBy === 'epgUrl')!;
  const m = epg.setChannelMatch(sky.id, { epgSourceId: g1.id, epgChannelId: 'SkySportsPremierLeague.uk', offsetHours: -1 });
  assert.equal(m.status, 'manual');
  assert.equal(m.offsetHours, -1);
  const shifted = live.channelPrograms(admin, sky.id);
  const orig = db.get('SELECT start FROM programs WHERE epg_channel_id = ? ORDER BY start LIMIT 1', epg.guideKey(g1.id, 'SkySportsPremierLeague.uk'))!.start;
  assert.ok(shifted.some((p) => p.start === new Date(Date.parse(orig) - H).toISOString()));
  // DVR can schedule a shifted programme (the copy is a real programme row).
  assert.ok(db.get('SELECT 1 FROM programs WHERE id = ?', shifted[0].id));
  await live.refreshSource(iptvId);
  const again = ch(iptvId, 'Sky Sports');
  assert.equal(again.guide_status, 'manual');
  assert.equal(again.guide_channel_id, 'SkySportsPremierLeague.uk');
  assert.equal(again.guide_offset, -60);
  // Explicit "no guide", then back to automatic.
  assert.equal(epg.setChannelMatch(sky.id, { none: true }).status, 'none');
  assert.equal(epg.setChannelMatch(sky.id, { epgChannelId: null, offsetHours: null }).status, 'review');
  assert.ok(epg.acceptAllSuggestions().accepted >= 1);
  assert.equal(ch(iptvId, 'Sky Sports').guide_status, 'manual');
  // The old PATCH epgChannelId still works and resolves against the guides.
  live.updateChannel(ch(iptvId, 'Nothing Here 24/7').id, { epgChannelId: 'Mystery.uk' });
  const nh = ch(iptvId, 'Nothing Here 24/7');
  assert.equal(nh.guide_status, 'manual');
  assert.ok(nh.guide_source_id);
});

/* ------------------------------ Schedules Direct ------------------------------ */

let sdId = '';
test('Schedules Direct: login, headends, lineups, md5-cached schedules and programmes', async () => {
  await assert.rejects(epg.createEpgSource({ name: 'SD', kind: 'schedulesdirect', config: { username: 'sduser', password: 'wrong' } }), /login failed|Invalid/i);
  assert.equal(sd.tokens, 0);
  const s = await epg.createEpgSource({ name: 'Schedules Direct', kind: 'schedulesdirect', config: { username: 'sduser', password: SD_PASSWORD, days: 3 } });
  sdId = s.id;
  await epg.refreshEpgSource(s.id); // no lineups yet → error, nothing stored
  assert.match(epg.getEpgSource(s.id).lastError ?? '', /No lineups/);
  assert.equal(s.config.hasPassword, true);
  assert.ok(!('password' in s.config));
  assert.equal(epg.getEpgSourceRow(s.id).secret, crypto.createHash('sha1').update(SD_PASSWORD).digest('hex'), 'only the SHA1 is stored');

  const heads = await epg.sdHeadends(s.id, 'USA', '10001');
  assert.equal(heads.length, 2);
  const r = await epg.sdChangeLineup(s.id, 'USA-OTA-10001', true);
  assert.equal(r.changesRemaining, 5);
  assert.deepEqual(r.status.lineups.map((l) => l.lineup), ['USA-OTA-10001']);
  await epg.refreshEpgSource(s.id);
  const src = epg.getEpgSource(s.id);
  assert.equal(src.lastError, null);
  assert.equal(src.report.channels, 3);
  assert.equal(src.report.programmes, 3 * 3 * 24);
  assert.equal(sd.tokens, 1, 'one token, reused');
  const chans = epg.searchGuideChannels({ q: 'WABC' });
  assert.equal(chans[0].id, '10001');
  assert.equal(chans[0].number, '7.1');
  // The IPTV "WABC-DT" channel matched the station by callsign.
  const wabc = ch(iptvId, 'WABC-DT');
  assert.equal(wabc.guide_source_id, s.id);
  assert.equal(wabc.guide_method, 'callsign');
  const p = live.channelPrograms(admin, wabc.id, new Date(Date.now() - 86400000).toISOString(), new Date(Date.now() + 2 * 86400000).toISOString());
  assert.ok(p.length > 20);
  assert.match(p[0].title, /^Show /);
  assert.equal(p[0].episodeNum, 'S02E05');

  // Second refresh: md5s unchanged → no schedule or programme downloads, no new token.
  sd.calls.length = 0;
  await epg.refreshEpgSource(s.id);
  assert.ok(!sd.calls.includes('POST /schedules') && !sd.calls.includes('POST /programs') && !sd.calls.some((c) => c.startsWith('GET /lineups/')), sd.calls.join(', '));
  assert.ok(!sd.calls.includes('POST /token'));

  // One station/date changes, one programme changes → only those are fetched.
  const today = new Date().toISOString().slice(0, 10);
  sd.schedVersion.set(`10002|${today}`, 1);
  sd.progVersion.set('EP100010003', 1);
  let schedBody = '';
  let progBody = '';
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const u = String(input);
    if (u.endsWith('/schedules')) schedBody = init.body;
    if (u.endsWith('/programs')) progBody = init.body;
    return origFetch(input, init);
  }) as typeof fetch;
  sd.calls.length = 0;
  try {
    await epg.refreshEpgSource(s.id);
  } finally {
    globalThis.fetch = origFetch;
  }
  const sched = JSON.parse(schedBody) as { stationID: string; date: string[] }[];
  assert.deepEqual(sched.find((x) => x.stationID === '10002')?.date, [today], 'only the changed day of 10002');
  assert.equal(sched.find((x) => x.stationID === '10001')?.date.length, 3, '10001 airs the changed programme every day');
  assert.ok(!sched.some((x) => x.stationID === '10003'));
  assert.deepEqual(JSON.parse(progBody), ['EP100010003']);
  assert.ok(db.get("SELECT 1 FROM programs WHERE source_id = ? AND subtitle = 'Episode v1'", s.id));

  // Expired token (4006) → renewed once and retried.
  sd.expireNext = true;
  await epg.refreshEpgSource(s.id);
  assert.equal(epg.getEpgSource(s.id).lastError, null);
  assert.equal(sd.tokens, 2);
  // Manual refreshes are rate-limited.
  assert.throws(() => epg.manualRefresh(s.id), /hammer/);
});

test('Schedules Direct client batches 5000 stations / programme ids per request', async () => {
  const c = new SdClient({ username: 'sduser', passwordHash: crypto.createHash('sha1').update(SD_PASSWORD).digest('hex'), getToken: () => ({}), saveToken: () => undefined });
  sd.maxBatch = 0;
  const ids = Array.from({ length: 5003 }, (_, i) => String(20000 + i));
  sd.calls.length = 0;
  const m = await c.scheduleMd5(ids, ['2026-11-20']);
  assert.equal(Object.keys(m).length, 5003);
  await c.programs(ids.map((i) => `EP${i}0001`));
  assert.equal(sd.maxBatch, 5000);
  assert.equal(sd.calls.filter((x) => x === 'POST /schedules/md5').length, 2);
  assert.equal(sd.calls.filter((x) => x === 'POST /programs').length, 2);
});

/* ------------------------------ HDHomeRun ------------------------------ */

test('HDHomeRun guide: DeviceAuth from discover.json, channels matched by guide number', async () => {
  const tuner = live.createSource({ name: 'Tuner', type: 'hdhomerun', url: hdDevice });
  await live.refreshSource(tuner.id);
  const g = await epg.createEpgSource({ name: 'HDHomeRun guide', kind: 'hdhomerun', config: { liveSourceId: tuner.id, days: 1 } });
  assert.deepEqual(g.liveSourceIds, [tuner.id]);
  await epg.refreshEpgSource(g.id);
  const s = epg.getEpgSource(g.id);
  assert.equal(s.lastError, null);
  assert.equal(s.report.channels, 2);
  assert.ok(hdhr.guideCalls >= 2, 'pages forward with Start=');
  const wnbc = ch(tuner.id, 'WNBC-HD');
  assert.equal(wnbc.guide_source_id, g.id);
  assert.ok(['id', 'number'].includes(wnbc.guide_method));
  assert.ok(live.getChannel(admin, wnbc.id).nowPlaying?.title.startsWith('NBC Show'));
});

/* ------------------------------ admin API ------------------------------ */

test('admin API: guide sources, matching, search, preview; credentials write-only', async () => {
  const app = await buildApp();
  const tok = issueToken(admin.id, { deviceId: 'epg-test', deviceName: 'test', platform: 'web' }).token;
  const vtok = issueToken(viewer.id, { deviceId: 'epg-test-v', deviceName: 'test', platform: 'web' }).token;
  const req = async (method: string, url: string, body?: unknown, t = tok) => {
    const r = await app.inject({ method: method as any, url: `/api/v1${url}`, headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, payload: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.statusCode, json: r.body ? JSON.parse(r.body) : null };
  };
  assert.equal((await req('GET', '/livetv/epg-sources', undefined, vtok)).status, 403);
  assert.equal((await req('GET', '/livetv/matching', undefined, vtok)).status, 403);
  const list = await req('GET', '/livetv/epg-sources');
  assert.equal(list.status, 200);
  assert.ok(list.json.length >= 4);
  const raw = JSON.stringify(list.json);
  assert.ok(!raw.includes(SD_PASSWORD) && !raw.includes(crypto.createHash('sha1').update(SD_PASSWORD).digest('hex')));
  const presets = await req('GET', '/livetv/epg-presets');
  assert.ok(presets.json.some((p: any) => p.provider === 'epg.pw' && p.country === 'GB'));
  assert.ok(presets.json.some((p: any) => p.provider === 'iptv-org'));

  const created = await req('POST', '/livetv/epg-sources', { name: 'epg.pw UK', kind: 'xmltv', config: { preset: 'epgpw-gb' }, enabled: false });
  assert.equal(created.status, 200);
  assert.equal(created.json.config.url, 'https://epg.pw/xmltv/epg_GB.xml');
  assert.equal((await req('PATCH', `/livetv/epg-sources/${created.json.id}`, { refreshIntervalHours: 6 })).json.refreshIntervalHours, 6);
  assert.equal((await req('DELETE', `/livetv/epg-sources/${created.json.id}`)).status, 200);
  const managed = list.json.find((g: any) => g.managedBy === 'provider');
  assert.equal((await req('DELETE', `/livetv/epg-sources/${managed.id}`)).status, 400);
  assert.equal((await req('PATCH', `/livetv/epg-sources/${sdId}`, { config: { username: 'sduser', password: 'new-secret' } })).json.config.hasPassword, true);
  assert.equal(epg.getEpgSourceRow(sdId).secret, crypto.createHash('sha1').update('new-secret').digest('hex'));

  const m = await req('GET', '/livetv/matching?filter=all');
  assert.equal(m.status, 200);
  assert.ok(m.json.counts.all >= 9);
  assert.equal(m.json.thresholds.auto, AUTO_THRESHOLD);
  const unmatched = await req('GET', '/livetv/matching?filter=unmatched');
  assert.ok(unmatched.json.items.every((i: any) => i.status === 'none' || (i.status === 'manual' && !i.hasGuide)));
  const missing = await req('GET', '/livetv/matching?filter=missing');
  assert.ok(missing.json.items.every((i: any) => !i.hasGuide));

  const search = await req('GET', '/livetv/epg-channels?q=UK:%20BBC%20One%20HD');
  assert.equal(search.status, 200);
  assert.equal(search.json[0].name, 'BBC One');
  const bbc = ch(iptvId, 'UK: BBC One HD');
  const g1 = list.json.find((g: any) => g.managedBy === 'epgUrl');
  const put = await req('PUT', `/livetv/channels/${bbc.id}/match`, { epgSourceId: g1.id, epgChannelId: 'BBCOne.uk', offsetHours: 1 });
  assert.equal(put.status, 200);
  assert.equal(put.json.status, 'manual');
  assert.equal(put.json.offsetHours, 1);
  assert.equal(put.json.hasGuide, true);
  assert.equal((await req('PUT', `/livetv/channels/${bbc.id}/match`, { epgSourceId: g1.id, epgChannelId: 'NotThere' })).status, 400);
  const prev = await req('GET', `/livetv/epg-preview?epgSourceId=${g1.id}&epgChannelId=BBCOne.uk&offsetHours=1`);
  assert.ok(prev.json.now && prev.json.next);
  assert.match(prev.json.now.title, /^G1 BBC One /);
  // Channels list: "missing guide" flag for admins.
  const chl = await req('GET', `/livetv/channels?sourceId=${iptvId}&withEpg=false&guideStatus=true`);
  assert.equal(chl.json.items.find((c: any) => c.id === bbc.id).hasGuide, true);
  assert.equal(chl.json.items.find((c: any) => c.name === 'UK: BBC One HD').epgOffsetHours, 1);
  const sdStatus = await req('GET', `/livetv/epg-sources/${sdId}/sd/status`);
  assert.equal(sdStatus.status, 400, 'password changed to a wrong one → login error surfaces as 400');
  await app.close();
});
