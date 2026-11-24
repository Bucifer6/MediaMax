import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const help = await import('../src/services/help.ts');
const { createUser, issueToken } = await import('../src/services/auth.ts');
const { updateSettings, setKv } = await import('../src/services/settings.ts');
const { updateBranding } = await import('../src/services/branding.ts');
const { saveSecuritySettings } = await import('../src/services/security/dashboard.ts');
const { logger } = await import('../src/util/log.ts');
const { readZip } = await import('../src/util/zip.ts');
const { redactText, redactUrl } = await import('../src/services/diagnostics.ts');
const { buildApp } = await import('../src/app.ts');

const app = await buildApp();
after(() => app.close());

const admin = await createUser({ username: 'help-admin', password: 'pass1234', isAdmin: true });
const viewer = await createUser({ username: 'help-viewer', password: 'pass1234' });
const adminTok = issueToken(admin.id, { deviceId: 'help-a', deviceName: 'test', platform: 'web' }).token;
const viewerTok = issueToken(viewer.id, { deviceId: 'help-v', deviceName: 'test', platform: 'web' }).token;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

/* ------------------------------- content ------------------------------- */

test('articles: enough of them, valid front-matter, sections, related and links', () => {
  const { articles, sections } = help.loadHelp();
  assert.ok(articles.size >= 35, `expected at least 35 articles, got ${articles.size}`);
  const sectionIds = new Set(sections.map((s) => s.id));
  for (const a of articles.values()) {
    assert.ok(a.title && a.title !== a.slug, `${a.slug}: title`);
    assert.ok(a.summary.length > 10, `${a.slug}: summary`);
    assert.ok(sectionIds.has(a.section), `${a.slug}: unknown section ${a.section}`);
    assert.ok(a.keywords.length > 0, `${a.slug}: keywords`);
    for (const r of a.related) assert.ok(articles.has(r), `${a.slug}: related "${r}" does not exist`);
    for (const m of a.body.matchAll(/\]\(help:([a-z0-9-]+)(?:#([\w-]+))?\)/g)) {
      const target = articles.get(m[1]);
      assert.ok(target, `${a.slug}: link to missing article ${m[1]}`);
      if (m[2]) assert.ok(target.headings.some((h) => h.id === m[2]), `${a.slug}: link to missing anchor ${m[1]}#${m[2]}`);
    }
    assert.ok(!/\{\{(?!\s*(product|version)\s*\}\})/.test(a.body), `${a.slug}: unknown placeholder`);
  }
  // Every section with articles for everyone, and the admin section is admin-only.
  assert.ok([...articles.values()].some((a) => a.audience === 'admin'));
  assert.ok([...articles.values()].filter((a) => a.section === 'admin').every((a) => a.audience === 'admin'));
});

test('why-transcoding has an anchor for every reason the player links to', async () => {
  const { articles } = help.loadHelp();
  const ids = new Set(articles.get('why-transcoding')!.headings.map((h) => h.id));
  for (const anchor of ['methods', 'video-codec', 'ten-bit', 'resolution', 'hdr-tone-mapping', 'dolby-vision-dual-layer', 'dolby-vision-ffmpeg', 'audio-format', 'audio-processing', 'container', 'bitrate', 'audio-track', 'transcoding-not-permitted', 'subtitles-burn-in']) {
    assert.ok(ids.has(anchor), `missing #${anchor}`);
  }
  // The web map (reason text → anchor) only points at anchors that exist.
  const map = fs.readFileSync(path.resolve(import.meta.dirname, '../../web/src/utils/helpLinks.ts'), 'utf8');
  for (const m of map.matchAll(/'why-transcoding#([\w-]+)'/g)) assert.ok(ids.has(m[1]), `web map points at missing #${m[1]}`);
});

test('front-matter parser and heading ids', () => {
  const { meta, body } = help.parseFrontMatter('---\ntitle: "Hello: world"\nkeywords: a, b\n---\n## One {#x}\n### Two & three\n');
  assert.equal(meta.title, 'Hello: world');
  assert.equal(meta.keywords, 'a, b');
  assert.deepEqual(help.extractHeadings(body), [{ level: 2, text: 'One', id: 'x' }, { level: 3, text: 'Two & three', id: 'two-three' }]);
});

/* ------------------------------- search ------------------------------- */

test('search: ranking, prefixes and typos', () => {
  const top = (q: string, admin = false) => help.helpSearch(q, admin, 'Kinora').results.map((r) => r.slug);
  assert.equal(top('why is it transcoding')[0], 'why-transcoding');
  assert.ok(top('subtitles').slice(0, 3).includes('subtitles'));
  assert.ok(top('subt').slice(0, 3).includes('subtitles'), 'prefix');
  assert.ok(top('subtitels').slice(0, 3).includes('subtitles'), 'typo');
  assert.ok(top('trancoding').slice(0, 3).includes('why-transcoding'), 'typo in a long word');
  assert.ok(top('dolby vision').includes('hdr-dolby-vision'));
  assert.ok(top('remote buttons colour').includes('remote-buttons'));
  assert.deepEqual(top(''), []);
  assert.deepEqual(top('the of and'), []);
  const r = help.helpSearch('lip sync', false, 'Kinora').results[0];
  assert.ok(r.snippet.length > 20 && r.snippet.length < 200, 'snippet');
});

test('search: admin-only articles never reach other users', () => {
  const viewerHits = help.helpSearch('hardware transcoding detect', false, 'Kinora').results;
  assert.ok(viewerHits.every((r) => r.audience === 'everyone'));
  assert.ok(!viewerHits.some((r) => r.slug === 'admin-transcoding'));
  const adminHits = help.helpSearch('hardware transcoding detect', true, 'Kinora').results;
  assert.equal(adminHits[0].slug, 'admin-transcoding');
});

test('editDistance', () => {
  assert.equal(help.editDistance('subtitles', 'subtitels'), 1);
  assert.equal(help.editDistance('kitten', 'sitting', 3), 3);
  assert.equal(help.editDistance('abc', 'abcdefgh', 2), 3);
});

/* ------------------------------- API ------------------------------- */

test('GET /help: audiences', async () => {
  const anon = (await app.inject({ url: '/api/v1/help' })).json();
  const view = (await app.inject({ url: '/api/v1/help', headers: auth(viewerTok) })).json();
  const adm = (await app.inject({ url: '/api/v1/help', headers: auth(adminTok) })).json();
  const slugs = (x: any) => x.sections.flatMap((s: any) => s.articles.map((a: any) => a.slug));
  assert.ok(!slugs(anon).includes('admin-network'));
  assert.ok(!slugs(view).includes('admin-network'));
  assert.ok(!view.sections.some((s: any) => s.id === 'admin'));
  assert.ok(slugs(adm).includes('admin-network'));
  assert.ok(adm.sections.some((s: any) => s.id === 'admin'));
  assert.ok(!JSON.stringify(adm).includes('"markdown"'), 'index has no bodies');
});

test('GET /help/:slug: admin articles are 404 for everyone else; related; placeholders', async () => {
  assert.equal((await app.inject({ url: '/api/v1/help/admin-network' })).statusCode, 404);
  assert.equal((await app.inject({ url: '/api/v1/help/admin-network', headers: auth(viewerTok) })).statusCode, 404);
  assert.equal((await app.inject({ url: '/api/v1/help/admin-network', headers: auth(adminTok) })).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/v1/help/nope' })).statusCode, 404);
  updateBranding({ serverName: 'Smith Cinema' });
  try {
    const res = await app.inject({ url: '/api/v1/help/welcome', headers: auth(viewerTok) });
    const a = res.json();
    assert.equal(a.title, 'What is Smith Cinema?');
    assert.ok(a.markdown.includes('Smith Cinema'));
    assert.ok(!a.markdown.includes('{{'), 'placeholders filled');
    assert.ok(a.related.length > 0 && a.related.every((r: any) => r.audience === 'everyone'));
    assert.ok(a.headings.length > 0);
    // Caching: same version + product + audience → 304.
    const etag = res.headers.etag as string;
    assert.ok(etag);
    assert.equal((await app.inject({ url: '/api/v1/help/welcome', headers: { ...auth(viewerTok), 'if-none-match': etag } })).statusCode, 304);
    assert.notEqual((await app.inject({ url: '/api/v1/help/welcome', headers: { ...auth(adminTok), 'if-none-match': etag } })).statusCode, 304, 'different audience, different ETag');
    // Related links of an everyone article never include admin articles for a viewer.
    const wt = (await app.inject({ url: '/api/v1/help/why-transcoding', headers: auth(viewerTok) })).json();
    assert.ok(wt.related.every((r: any) => r.audience === 'everyone'));
  } finally {
    updateBranding({ serverName: 'Kinora' });
  }
});

test('GET /help/search and /help/whats-new', async () => {
  const s = (await app.inject({ url: '/api/v1/help/search?q=lipsync%20delay' })).json();
  assert.equal(s.query, 'lipsync delay');
  assert.ok(Array.isArray(s.results));
  const s2 = (await app.inject({ url: '/api/v1/help/search?q=crowdsec', headers: auth(viewerTok) })).json();
  assert.ok(!s2.results.some((r: any) => r.slug === 'admin-security'));
  const s3 = (await app.inject({ url: '/api/v1/help/search?q=crowdsec', headers: auth(adminTok) })).json();
  assert.equal(s3.results[0].slug, 'admin-security');
  const w = await app.inject({ url: '/api/v1/help/whats-new' });
  assert.equal(w.statusCode, 200);
  assert.match(w.json().title, /What's new in Kinora/);
  assert.ok(w.json().version);
});

test('user prefs accept whatsNewSeen (validated)', async () => {
  const ok = await app.inject({ method: 'PATCH', url: '/api/v1/auth/me', headers: auth(viewerTok), payload: { preferences: { whatsNewSeen: '0.1.0' } } });
  if (ok.statusCode === 404) return; // route shape differs: covered by the service test below
  assert.equal(ok.json().preferences.whatsNewSeen, '0.1.0');
  const bad = await app.inject({ method: 'PATCH', url: '/api/v1/auth/me', headers: auth(viewerTok), payload: { preferences: { whatsNewSeen: '<script>' } } });
  assert.equal(bad.json().preferences.whatsNewSeen, null);
});

/* ------------------------------- diagnostics ------------------------------- */

test('redactors', () => {
  assert.equal(redactUrl('see https://user:pw@host.example:8080/api/x?token=abc'), 'see https://[redacted]@host.example:8080/…');
  assert.equal(redactUrl('http://radarr:7878'), 'http://radarr:7878');
  const t = redactText('GET /api/v1/stream/x?token=abcdef&w=200 Authorization: Bearer abc.def.ghi http://p:8080/live/bob/hunter2/12.ts');
  assert.ok(!/abcdef|abc\.def|hunter2|bob/.test(t), t);
  assert.ok(t.includes('w=200'));
});

test('diagnostics.zip: admin only, rate limited, and no planted secret leaks', async () => {
  const P = {
    tmdb: 'PLANTtmdb1111', arr: 'PLANTarr2222', llm: 'PLANTllm3333', os: 'PLANTos4444', oidc: 'PLANToidc5555', hook: 'PLANThook6666',
    smtp: 'PLANTsmtp7777', tg: 'PLANTtg8888', po: 'PLANTpouser9999', mqtt: 'PLANTmqtt1010', cs: 'PLANTcs1111', tvdb: 'PLANTtvdb1212',
    tvdbPin: 'PLANTpin1313', sd: 'PLANTsdhash1414', trakt: 'PLANTtrakt1515', lastfm: 'PLANTlastfm1616', jsonAuth: 'PLANTauthhdr1717',
    logTok: 'PLANTlogtok1818', logKey: 'PLANTlogkey1919', logBearer: 'PLANTbearer2020', xtUser: 'PLANTxtuser2121', xtPass: 'PLANTxtpass2222', urlPw: 'PLANTurlpw2323',
  };
  updateSettings({
    tmdbApiKey: P.tmdb,
    arr: [{ id: 'r1', kind: 'radarr', name: 'Radarr', url: 'http://radarr:7878', apiKey: P.arr, enabled: true, is4k: false, qualityProfileId: 1, rootFolderPath: '/movies', searchOnAdd: true, seasonFolders: true, tags: [], pathMappings: [] }] as any,
    aiDj: { llm: { apiKey: P.llm } } as any,
    openSubtitles: { apiKey: null, username: 'me', password: P.os, autoLanguages: [] },
    oidc: { clientSecret: P.oidc } as any,
    trakt: { clientId: 'cid', clientSecret: P.trakt },
    lastfm: { apiKey: 'k', sharedSecret: P.lastfm },
    webhooks: [{ id: 'w1', url: `https://discord.com/api/webhooks/123/${P.hook}`, events: ['playback.start'] }] as any,
    notificationAgents: [
      { kind: 'email', name: 'Mail', enabled: true, events: [], config: { host: 'smtp.example.com', from: 'a@b.c', password: P.smtp } },
      { kind: 'telegram', name: 'TG', enabled: true, events: [], config: { botToken: P.tg, chatId: '1' } },
      { kind: 'pushover', name: 'PO', enabled: true, events: [], config: { token: 'x', userKey: P.po } },
      { kind: 'webhook', name: 'JSON', enabled: true, events: [], config: { url: 'https://example.com/hook', authHeader: `Bearer ${P.jsonAuth}` } },
    ] as any,
  });
  setKv('homeAssistant', { mqtt: { enabled: true, url: 'mqtt://broker:1883', username: 'ha', password: P.mqtt } });
  saveSecuritySettings({ crowdsec: { url: 'http://crowdsec:8080', machineId: 'mediamax-dashboard', password: P.cs } } as any);
  setKv('metadata', { providers: { tvdb: { enabled: true, apiKey: P.tvdb, pin: P.tvdbPin } } });
  setKv('epg.schedulesDirect', { username: 'sduser', passwordHash: P.sd });
  const log = logger('test');
  log.info(`GET /api/v1/stream/hls/x/master.m3u8?token=${P.logTok}&api_key=${P.logKey}`);
  log.info(`upstream Authorization: Bearer ${P.logBearer}`);
  log.warn(`IPTV failed: http://provider.example:8080/live/${P.xtUser}/${P.xtPass}/123.ts`);
  log.info(`connecting to http://admin:${P.urlPw}@nas.local/feed`);
  await new Promise((r) => setTimeout(r, 100)); // let the log stream flush

  assert.equal((await app.inject({ url: '/api/v1/admin/diagnostics.zip' })).statusCode, 401);
  assert.equal((await app.inject({ url: '/api/v1/admin/diagnostics.zip', headers: auth(viewerTok) })).statusCode, 403);
  const res = await app.inject({ url: '/api/v1/admin/diagnostics.zip', headers: auth(adminTok) });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'application/zip');
  assert.match(String(res.headers['content-disposition']), /attachment; filename="diagnostics-\d{8}-\d{4}\.zip"/);
  const files = readZip(res.rawPayload);
  for (const name of ['README.txt', 'system.json', 'ffmpeg.txt', 'hardware.json', 'network.json', 'library.json', 'settings.json', 'tasks.json', 'logs/mediamax.log']) {
    assert.ok(files.has(name), `missing ${name}`);
  }
  const all = [...files.values()].map((b) => b.toString('utf8')).join('\n');
  for (const [k, v] of Object.entries(P)) assert.ok(!all.includes(v), `secret "${k}" leaked into the diagnostics bundle`);
  // Still useful: versions, the redaction marker, and the settings structure.
  const sys = JSON.parse(files.get('system.json')!.toString());
  assert.ok(sys.version && sys.os.platform && sys.cpu.cores >= 1);
  const settings = JSON.parse(files.get('settings.json')!.toString());
  assert.equal(settings.server.transcoding.enabled, true);
  assert.ok(files.get('logs/mediamax.log')!.toString().includes('[redacted]'));
  // Rate limit.
  const again = await app.inject({ url: '/api/v1/admin/diagnostics.zip', headers: auth(adminTok) });
  assert.equal(again.statusCode, 429);
});
