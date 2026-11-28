/** epgshare01, the default guide: channel names scored against the per-country channel lists, files picked and added once. */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { db } = await import('../src/db.ts');
const es = await import('../src/services/livetv/epg/epgshare.ts');
const { EPG_PRESETS } = await import('../src/services/livetv/epg/presets.ts');

const RO1 = `202611271736\n\n\n-- epg_ripper_RO1 --\n\nAntena.1.HD.ro\nAntena.1.ro\nAntena.Stars.HD.ro\nKanal.D.ro\nPro.TV.HD.ro\nPrima.TV.ro\nTVR.1.HD.ro\nNational.TV.ro\nHappy.Channel.ro\n`;
const RO2 = `-- epg_ripper_RO2 --\nDigi.24.ro\nRealitatea.Plus.ro\nB1.TV.ro\nPro.TV.ro\n`;
const UK1 = `-- epg_ripper_UK1 --\nBBC.One.HD.uk\nITV1.uk\nChannel.4.uk\n`;

test('names and guide ids meet in the middle (dots, case, accents, HD, country suffix)', () => {
  assert.equal(es.nameKey('Antena.1.HD.ro'), 'antena1hd');
  assert.equal(es.nameKey('Antena 1 HD'), 'antena1hd');
  assert.equal(es.nameKey('Televiziunea Română'), 'televiziunearomana');
  assert.equal(es.scoreList(['PRO TV HD', 'Antena 1 HD', 'Kanal D HD', 'Happy Channel H', 'Unknown'], RO1), 3, 'HD-less ids match HD names; a cut-off name does not');
  assert.equal(es.scoreList(['PRO TV HD', 'Antena 1 HD'], UK1), 0);
});

test('the files that carry the channels are picked, near-empty ones are not', () => {
  assert.deepEqual(es.pickFiles([{ file: 'RO1', score: 40 }, { file: 'RO2', score: 12 }, { file: 'UK1', score: 2 }], 160), ['RO1', 'RO2']);
  assert.deepEqual(es.pickFiles([{ file: 'RO1', score: 2 }], 160), [], 'too few matches: nothing');
  assert.deepEqual(es.pickFiles([{ file: 'RO1', score: 40 }, { file: 'HU1', score: 9 }], 100), ['RO1'], 'far below the best: left out');
  assert.deepEqual(es.pickFiles([{ file: 'RO1', score: 60 }], 15000), ['RO1'], 'a huge IPTV list still qualifies');
  assert.equal(es.scoreList(['RO: PRO TV HD', 'RO | Antena 1'], RO1), 2, 'provider prefixes are ignored');
  assert.ok(EPG_PRESETS.some((p) => p.id === 'epgshare01-ro1' && p.url === 'https://epgshare01.online/epgshare01/epg_ripper_RO1.xml.gz'));
});

test('setup adds the matching files once, then leaves the admin in charge', async () => {
  db.run("INSERT INTO live_sources (id, name, type, url, enabled, proxy_streams, created_at) VALUES ('es-src', 'HDHR', 'hdhomerun', 'http://127.0.0.1:9', 1, 1, ?)", new Date().toISOString());
  const names = ['PRO TV HD', 'Antena 1 HD', 'Antena Stars HD', 'Kanal D', 'Prima TV', 'TVR 1 HD', 'National TV', 'Digi 24', 'Realitatea Plus', 'B1 TV'];
  names.forEach((n, i) => db.run('INSERT INTO channels (id, source_id, remote_id, name, stream_url, number) VALUES (?, ?, ?, ?, ?, ?)', `es-${i}`, 'es-src', String(i + 1), n, 'http://x', i + 1));
  const fetcher = async (url: string) => {
    if (url.endsWith('RO1.txt')) return RO1;
    if (url.endsWith('RO2.txt')) return RO2;
    if (url.endsWith('UK1.txt')) return UK1;
    throw new Error('404');
  };
  const created: string[] = [];
  const create = async (p: { id: string; url: string }) => {
    created.push(p.id);
    db.run("INSERT INTO epg_sources (id, name, kind, config, state, priority, enabled, refresh_hours, created_at) VALUES (?, ?, 'xmltv', ?, '{}', 50, 1, 12, ?)", p.id, p.id, JSON.stringify({ preset: p.id, url: p.url }), new Date().toISOString());
  };
  const [r, twin] = await Promise.all([es.setupEpgshare(create, { auto: true, fetcher }), es.setupEpgshare(create, { auto: true, fetcher })]);
  assert.deepEqual(r.added, ['RO1', 'RO2']);
  assert.equal(twin, r, 'two sources refreshing at once share one run');
  assert.deepEqual(created, ['epgshare01-ro1', 'epgshare01-ro2']);
  // Automatic setup runs once: deleted guides are not brought back.
  db.run("DELETE FROM epg_sources WHERE id LIKE 'epgshare01-%'");
  assert.deepEqual((await es.setupEpgshare(create, { auto: true, fetcher })).added, []);
  // The admin's "Find guides automatically" looks again.
  assert.deepEqual((await es.setupEpgshare(create, { fetcher })).added, ['RO1', 'RO2']);
  assert.deepEqual((await es.setupEpgshare(create, { fetcher })).added, [], 'already there: not added twice');
});
