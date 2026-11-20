import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { parseM3u, m3uCatchupUrl } from '../src/services/livetv/m3u.ts';
import { parseXmltvReadable, parseXmltvTime } from '../src/services/livetv/xmltv.ts';
import { normalizeBase, timeshiftStamp, liveUrl } from '../src/services/livetv/xtream.ts';
import { findSharedRegion } from '../src/services/introdetect.ts';

test('m3u parsing', () => {
  const pl = parseM3u(`#EXTM3U url-tvg="http://epg/guide.xml.gz"
#EXTINF:-1 tvg-id="bbc1.uk" tvg-name="BBC One" tvg-logo="http://l/bbc.png" group-title="UK" tvg-chno="101" catchup="default" catchup-source="http://cu/{utc}/{duration}" catchup-days="7",BBC One HD
#EXTVLCOPT:http-user-agent=CustomUA
http://stream/bbc1.ts
#EXTINF:-1,No Attrs
http://stream/2.m3u8`);
  assert.equal(pl.epgUrl, 'http://epg/guide.xml.gz');
  assert.equal(pl.entries.length, 2);
  assert.equal(pl.entries[0].name, 'BBC One HD');
  assert.equal(pl.entries[0].tvgId, 'bbc1.uk');
  assert.equal(pl.entries[0].chno, 101);
  assert.equal(pl.entries[0].userAgent, 'CustomUA');
  assert.equal(pl.entries[0].catchupDays, 7);
  const url = m3uCatchupUrl(pl.entries[0], new Date('2024-01-01T10:00:00Z'), 30);
  assert.equal(url, `http://cu/${Date.parse('2024-01-01T10:00:00Z') / 1000}/1800`);
});

test('xmltv parsing', async () => {
  assert.equal(parseXmltvTime('20240101120000 +0100'), '2024-01-01T11:00:00.000Z');
  const xml = `<?xml version="1.0"?><tv><channel id="a"><display-name>A</display-name><icon src="http://i"/></channel>
  <programme start="20240101120000 +0000" stop="20240101130000 +0000" channel="a"><title>News &amp; Weather</title><desc>Desc</desc><category>News</category><episode-num system="xmltv_ns">1.4.</episode-num><new/></programme></tv>`;
  const chans: any[] = [];
  const progs: any[] = [];
  const r = await parseXmltvReadable(Readable.from([xml]), { onChannel: (c) => chans.push(c), onProgramme: (p) => progs.push(p) });
  assert.deepEqual(r, { channels: 1, programmes: 1 });
  assert.equal(chans[0].icon, 'http://i');
  assert.equal(progs[0].title, 'News & Weather');
  assert.equal(progs[0].episodeNum, 'S02E05');
  assert.equal(progs[0].isNew, true);
});

test('xtream helpers', () => {
  assert.equal(normalizeBase('provider.tv:8080/player_api.php?username=x'), 'http://provider.tv:8080');
  assert.equal(liveUrl({ url: 'http://p:80/', username: 'u', password: 'p w' }, 5), 'http://p:80/live/u/p%20w/5.ts');
  assert.equal(timeshiftStamp(new Date('2024-06-01T12:30:00Z'), 'Europe/London'), '2024-06-01:13-30');
});

test('fingerprint shared region', () => {
  const rnd = (seed: number, n: number) => {
    let s = seed;
    return Uint32Array.from({ length: n }, () => (s = (s * 1664525 + 1013904223) >>> 0));
  };
  const intro = rnd(42, 200); // ~25s
  const a = new Uint32Array([...rnd(1, 100), ...intro, ...rnd(2, 300)]);
  const b = new Uint32Array([...rnd(3, 40), ...intro, ...rnd(4, 300)]);
  const r = findSharedRegion(a, b)!;
  assert.ok(r);
  assert.ok(Math.abs(r.aStart - 100) <= 2 && Math.abs(r.aEnd - 300) <= 2, JSON.stringify(r));
  assert.ok(Math.abs(r.bStart - 40) <= 2);
  assert.equal(findSharedRegion(rnd(7, 500), rnd(8, 500)), null);
});

test('lrc lyrics parsing', async () => {
  const { parseLrc } = await import('../src/services/lyrics.ts');
  const l = parseLrc('[ar:Someone]\n[offset:+100]\n[00:01.50]Hello\n[00:03.00][00:10.00]Chorus\n');
  assert.deepEqual(l.map((x) => x.startMs), [1400, 2900, 9900]);
  assert.equal(l[1].text, 'Chorus');
  assert.deepEqual(parseLrc('just\nplain text').map((x) => x.startMs), [null, null]);
});

test('dlna soap helpers', async () => {
  process.env.MEDIAMAX_DATA ??= (await import('node:os')).tmpdir() + '/mediamax-test-' + process.pid;
  const { soapArg, isLocalAddress } = await import('../src/services/dlna.ts');
  assert.equal(soapArg('<s:Body><u:Browse><ObjectID>lib:abc</ObjectID><BrowseFlag>BrowseMetadata</BrowseFlag></u:Browse></s:Body>', 'ObjectID'), 'lib:abc');
  assert.ok(isLocalAddress('192.168.1.20'));
  assert.ok(isLocalAddress('::ffff:10.0.0.5'));
  assert.ok(!isLocalAddress('8.8.8.8'));
});

test('podcast feed, duration and OPML parsing', async () => {
  const { parseFeed, parseDuration, parseOpml } = await import('../src/services/podcasts.ts');
  assert.equal(parseDuration('01:02:03'), 3723000);
  assert.equal(parseDuration('62:03'), 3723000);
  assert.equal(parseDuration('3723'), 3723000);
  assert.equal(parseDuration('n/a'), null);
  const f = parseFeed(`<?xml version="1.0"?><rss xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel><title>Cast</title>
    <itunes:image href="http://img/c.jpg"/><itunes:category text="News"/><description>&lt;b&gt;Hi&lt;/b&gt; there</description>
    <item><title>E1</title><guid isPermaLink="false">g1</guid><pubDate>Mon, 16 Nov 2026 10:00:00 GMT</pubDate><itunes:episode>3</itunes:episode>
      <enclosure url="http://x/e1.mp3" type="audio/mpeg" length="123"/></item>
    <item><title>No audio</title></item></channel></rss>`);
  assert.equal(f.title, 'Cast');
  assert.equal(f.image, 'http://img/c.jpg');
  assert.equal(f.description, 'Hi there');
  assert.deepEqual(f.categories, ['News']);
  assert.equal(f.episodes.length, 1);
  assert.equal(f.episodes[0].guid, 'g1');
  assert.equal(f.episodes[0].episode, 3);
  assert.equal(f.episodes[0].pubDate, '2026-11-16T10:00:00.000Z');
  assert.deepEqual(parseOpml('<opml><body><outline text="x"><outline xmlUrl="http://a/feed"/><outline xmlUrl="http://b/feed"/></outline></body></opml>'), ['http://a/feed', 'http://b/feed']);
});

test('remote URL safety', async () => {
  const { isSafeRemoteUrl } = await import('../src/util/misc.ts');
  for (const ok of ['http://a/b.ts', 'https://a/b.m3u8', 'rtmp://x/live', 'udp://239.0.0.1:1234', 'rtsp://cam/1']) assert.ok(isSafeRemoteUrl(ok), ok);
  for (const bad of ['file:///etc/passwd', 'concat:/etc/passwd|x', 'pipe:0', '/etc/passwd', 'subfile,,start,0,end,1,,:/etc/passwd', 'data:text/plain,hi', '']) assert.ok(!isSafeRemoteUrl(bad), bad);
});
