// Scanner follow-ups: unreadable folders keep their items, scans requested mid-scan run again, extras attach by
// exact folder prefix, and watcher-driven scans only walk the changed folders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { db } = await import('../src/db.ts');
const { scanLibrary } = await import('../src/services/scanner.ts');

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

function mkRoot(tag: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `mm-sf-${tag}-`));
}
/** Not real media: probes fail (logged), the files still import. */
function touch(p: string) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, 'x');
}
function addLib(id: string, type: string, roots: string[]) {
  db.run('INSERT INTO libraries (id, name, type, paths, fetch_metadata, created_at) VALUES (?, ?, ?, ?, 0, ?)', id, id, type, JSON.stringify(roots), '2026-01-01');
}
const mediaPaths = (lib: string) =>
  db.all<{ path: string }>('SELECT m.path FROM media m JOIN items i ON i.id = m.item_id WHERE i.library_id = ? ORDER BY m.path', lib).map((r) => r.path);

/** Make fs.promises.readdir fail (EIO) for one folder; returns the restore function. */
function failReaddir(dir: string, code = 'EIO') {
  const orig = fs.promises.readdir;
  (fs.promises as any).readdir = function (p: any, ...rest: any[]) {
    if (String(p) === dir) return Promise.reject(Object.assign(new Error(`${code}: i/o error, scandir '${dir}'`), { code }));
    return (orig as any).call(this, p, ...rest);
  };
  return () => {
    (fs.promises as any).readdir = orig;
  };
}

test('an unreadable sub-folder (I/O error) keeps its items and watch history', async () => {
  const root = mkRoot('eio');
  touch(path.join(root, 'Show A', 'Season 1', 'Show A S01E01.mkv'));
  touch(path.join(root, 'Show B', 'Season 1', 'Show B S01E01.mkv'));
  touch(path.join(root, 'Show B', 'Season 1', 'Show B S01E02.mkv'));
  addLib('sf-eio', 'shows', [root]);
  await scanLibrary('sf-eio');
  assert.equal(mediaPaths('sf-eio').length, 3);
  const ep = db.get<{ id: string }>("SELECT id FROM items WHERE library_id = 'sf-eio' AND type = 'episode' AND path LIKE '%Show B S01E02.mkv'")!;
  db.run("INSERT INTO users (id, username, display_name, created_at) VALUES ('sf-u', 'sf-u', 'sf-u', '2026-01-01')");
  db.run("INSERT INTO user_data (user_id, item_id, played, play_count) VALUES ('sf-u', ?, 1, 1)", ep.id);

  // A transient error on "Show B/Season 1" (network share hiccup).
  const restore = failReaddir(path.join(root, 'Show B', 'Season 1'));
  try {
    await scanLibrary('sf-eio');
  } finally {
    restore();
  }
  assert.equal(mediaPaths('sf-eio').length, 3, 'nothing under the unreadable folder was removed');
  assert.ok(db.get("SELECT 1 FROM user_data WHERE user_id = 'sf-u' AND item_id = ?", ep.id), 'watch history kept');

  // A sibling folder whose name merely starts with the failed folder's name is not protected.
  touch(path.join(root, 'Show B2', 'x S01E01.mkv'));
  await scanLibrary('sf-eio');
  fs.rmSync(path.join(root, 'Show B2'), { recursive: true });
  const restore2 = failReaddir(path.join(root, 'Show B'));
  try {
    await scanLibrary('sf-eio');
  } finally {
    restore2();
  }
  assert.ok(!mediaPaths('sf-eio').some((p) => p.includes('Show B2')), '"Show B2" is not under "Show B"');
  assert.equal(mediaPaths('sf-eio').length, 3);

  // Once readable again, really deleted files go.
  fs.rmSync(path.join(root, 'Show B', 'Season 1', 'Show B S01E02.mkv'));
  await scanLibrary('sf-eio');
  assert.equal(mediaPaths('sf-eio').length, 2);
});

test('an unreadable sub-folder (EACCES via chmod 000) keeps its items', { skip: isRoot ? 'root ignores folder permissions' : false }, async () => {
  const root = mkRoot('acc');
  touch(path.join(root, 'A', 'a.mkv'));
  touch(path.join(root, 'B', 'b.mkv'));
  addLib('sf-acc', 'videos', [root]);
  await scanLibrary('sf-acc');
  assert.equal(mediaPaths('sf-acc').length, 2);
  fs.chmodSync(path.join(root, 'B'), 0o000);
  try {
    await scanLibrary('sf-acc');
  } finally {
    fs.chmodSync(path.join(root, 'B'), 0o755);
  }
  assert.equal(mediaPaths('sf-acc').length, 2);
});

test('a scan requested while one runs triggers one more scan afterwards (requests coalesce)', async () => {
  const root = mkRoot('co');
  touch(path.join(root, 'one.mkv'));
  addLib('sf-co', 'videos', [root]);
  const orig = fs.promises.readdir;
  let rootReads = 0;
  const late: Promise<void>[] = [];
  (fs.promises as any).readdir = async function (p: any, ...rest: any[]) {
    const r = await (orig as any).call(this, p, ...rest);
    // Count the walk's listings only (with file types), not the async root checks.
    if (String(p) === root && rest[0]?.withFileTypes && ++rootReads === 1) {
      // The walk has listed the folder; a file lands and the watcher asks for scans (three times).
      touch(path.join(root, 'two.mkv'));
      late.push(scanLibrary('sf-co'), scanLibrary('sf-co'), scanLibrary('sf-co'));
    }
    return r;
  };
  try {
    const first = scanLibrary('sf-co');
    await first;
    assert.equal(late.length, 3);
    assert.ok(late.every((p) => p === late[0]), 'requests during a scan share one follow-up scan');
    assert.notEqual(late[0], first);
    await late[0];
  } finally {
    (fs.promises as any).readdir = orig;
  }
  assert.deepEqual(mediaPaths('sf-co').map((p) => path.basename(p)), ['one.mkv', 'two.mkv']);
  assert.equal(rootReads, 2, 'exactly one follow-up scan');
});

test('extras attach to their own folder, not to a folder whose name matches it as a LIKE pattern', async () => {
  const root = mkRoot('like');
  // "MovieX1" is a shared folder with two movies (neither is keyed by the folder).
  touch(path.join(root, 'MovieX1', 'Foo (2001).mkv'));
  touch(path.join(root, 'MovieX1', 'Bar (2002).mkv'));
  // "Movie_1" has only a Trailers folder; with LIKE, '_' matches 'X' and the trailer attached to Foo or Bar.
  touch(path.join(root, 'Movie_1', 'Trailers', 'orphan.mkv'));
  // "MOVIEY" (upper case) vs "moviey": LIKE is case-insensitive.
  touch(path.join(root, 'moviey', 'Baz (2003).mkv'));
  touch(path.join(root, 'MOVIEY', 'Trailers', 'orphan2.mkv'));
  // A real match through the folder prefix still works.
  touch(path.join(root, 'MovieX1', 'Trailers', 'shared.mkv'));
  addLib('sf-like', 'movies', [root]);
  await scanLibrary('sf-like');
  const extras = db.all<{ path: string }>("SELECT path FROM items WHERE library_id = 'sf-like' AND type = 'video'").map((r) => path.basename(r.path));
  assert.deepEqual(extras, ['shared.mkv']);
});

/* ------------------------ incremental (watcher) scans ------------------------ */

const { changed, changedUnits, watchTiming } = await import('../src/services/watcher.ts');
const { isScanning } = await import('../src/services/scanner.ts');

function snapshot(lib: string) {
  const items = db.all("SELECT id, type, title, parent_id, grandparent_id, path, idx, parent_idx, poster, extra FROM items WHERE library_id = ? ORDER BY id", lib);
  const media = db.all('SELECT m.id, m.item_id, m.path, m.edition FROM media m JOIN items i ON i.id = m.item_id WHERE i.library_id = ? ORDER BY m.id', lib);
  return { items, media };
}
async function settle(lib: string) {
  for (let i = 0; i < 400 && (isScanning(lib) || !db.get('SELECT last_scan_at FROM libraries WHERE id = ?', lib)?.last_scan_at); i++) await new Promise((r) => setTimeout(r, 25));
}

test('a partial scan of the changed folders gives the same rows as a full scan (shows, movies, audiobooks)', async () => {
  const shows = mkRoot('inc-shows');
  touch(path.join(shows, 'Show A (2001)', 'Season 1', 'Show A S01E01.mkv'));
  touch(path.join(shows, 'Show A (2001)', 'Season 1', 'Show A S01E02.mkv'));
  touch(path.join(shows, 'Show A (2001)', 'poster.jpg'));
  touch(path.join(shows, 'Show A (2001)', 'Featurettes', 'making of.mkv'));
  touch(path.join(shows, 'Show B', 'Show B S01E01.mkv'));
  touch(path.join(shows, 'Loose S01E01.mkv'));
  const movies = mkRoot('inc-movies');
  touch(path.join(movies, 'Avatar (2009)', 'Avatar (2009).mkv'));
  touch(path.join(movies, 'Marvel', 'Iron Man (2008).mkv'));
  touch(path.join(movies, 'Heat (1995).mkv'));
  touch(path.join(movies, 'Heat (1995) - Director\'s Cut.mkv'));
  const books = mkRoot('inc-books');
  touch(path.join(books, 'Author', 'Book One', '01.mp3'));
  touch(path.join(books, 'Loose part 1.mp3'));
  touch(path.join(books, 'Loose part 2.mp3'));
  addLib('sf-inc-s', 'shows', [shows]);
  addLib('sf-inc-m', 'movies', [movies]);
  addLib('sf-inc-b', 'audiobooks', [books]);
  for (const l of ['sf-inc-s', 'sf-inc-m', 'sf-inc-b']) await scanLibrary(l);

  // Shows: an episode added, one removed, a new season, a new show, a root-level file removed, an extra added.
  touch(path.join(shows, 'Show A (2001)', 'Season 1', 'Show A S01E03.mkv'));
  fs.rmSync(path.join(shows, 'Show A (2001)', 'Season 1', 'Show A S01E01.mkv'));
  touch(path.join(shows, 'Show A (2001)', 'Season 2', 'Show A S02E01.mkv'));
  touch(path.join(shows, 'Show C', 'Season 1', 'Show C S01E01.mkv'));
  touch(path.join(shows, 'Show A (2001)', 'Trailers', 'teaser.mkv'));
  fs.rmSync(path.join(shows, 'Loose S01E01.mkv'));
  await scanLibrary('sf-inc-s', { paths: [
    path.join(shows, 'Show A (2001)', 'Season 1', 'Show A S01E03.mkv'), path.join(shows, 'Show A (2001)', 'Season 1', 'Show A S01E01.mkv'),
    path.join(shows, 'Show A (2001)', 'Season 2'), path.join(shows, 'Show C'), path.join(shows, 'Show A (2001)', 'Trailers', 'teaser.mkv'),
    path.join(shows, 'Loose S01E01.mkv'),
  ] });
  // Movies: a version added to a root-level movie, a folder movie removed, a movie added to a shared folder, an extra.
  touch(path.join(movies, 'Heat (1995) - Extended.mkv'));
  fs.rmSync(path.join(movies, 'Avatar (2009)'), { recursive: true });
  touch(path.join(movies, 'Marvel', 'Thor (2011).mkv'));
  touch(path.join(movies, 'Marvel', 'Trailers', 'thor.mkv'));
  await scanLibrary('sf-inc-m', { paths: [path.join(movies, 'Heat (1995) - Extended.mkv'), path.join(movies, 'Avatar (2009)'), path.join(movies, 'Marvel', 'Thor (2011).mkv'), path.join(movies, 'Marvel', 'Trailers')] });
  // Audiobooks: loose files in the root form one book; a part added there, a part added to a folder book.
  touch(path.join(books, 'Loose part 3.mp3'));
  touch(path.join(books, 'Author', 'Book One', '02.mp3'));
  await scanLibrary('sf-inc-b', { paths: [path.join(books, 'Loose part 3.mp3'), path.join(books, 'Author', 'Book One', '02.mp3')] });

  const s = snapshot('sf-inc-s');
  const names = (rows: any[]) => rows.map((r) => path.basename(r.path)).sort();
  assert.deepEqual(names(s.media), ['Show A S01E02.mkv', 'Show A S01E03.mkv', 'Show A S02E01.mkv', 'Show B S01E01.mkv', 'Show C S01E01.mkv', 'making of.mkv', 'teaser.mkv']);
  assert.deepEqual(names(snapshot('sf-inc-m').media), ['Heat (1995) - Director\'s Cut.mkv', 'Heat (1995) - Extended.mkv', 'Heat (1995).mkv', 'Iron Man (2008).mkv', 'Thor (2011).mkv', 'thor.mkv']);
  assert.equal(snapshot('sf-inc-b').media.length, 5);

  const partial = ['sf-inc-s', 'sf-inc-m', 'sf-inc-b'].map(snapshot);
  for (const l of ['sf-inc-s', 'sf-inc-m', 'sf-inc-b']) await scanLibrary(l);
  const full = ['sf-inc-s', 'sf-inc-m', 'sf-inc-b'].map(snapshot);
  assert.deepEqual(partial, full, 'a full scan afterwards changes nothing');
});

test('a partial scan walks and prunes only the changed folders; too many or outside paths scan everything', async () => {
  const root = mkRoot('scope');
  touch(path.join(root, 'Show A', 'Show A S01E01.mkv'));
  touch(path.join(root, 'Show B', 'Show B S01E01.mkv'));
  addLib('sf-scope', 'shows', [root]);
  await scanLibrary('sf-scope');
  // Changes nobody reported (outside the scope) are left for the next full scan.
  touch(path.join(root, 'Show B', 'Show B S01E02.mkv'));
  fs.rmSync(path.join(root, 'Show B', 'Show B S01E01.mkv'));
  touch(path.join(root, 'Show A', 'Show A S01E02.mkv'));
  const orig = fs.promises.readdir;
  const read: string[] = [];
  (fs.promises as any).readdir = function (p: any, ...rest: any[]) {
    // The walk lists folders with file types; root checks and artwork listings are plain readdirs.
    if (rest[0]?.withFileTypes) read.push(String(p));
    return (orig as any).call(this, p, ...rest);
  };
  try {
    await scanLibrary('sf-scope', { paths: [path.join(root, 'Show A', 'Show A S01E02.mkv')] });
  } finally {
    (fs.promises as any).readdir = orig;
  }
  assert.deepEqual(read, [path.join(root, 'Show A')], 'only the changed show folder was walked');
  assert.deepEqual(mediaPaths('sf-scope').map((p) => path.basename(p)), ['Show A S01E01.mkv', 'Show A S01E02.mkv', 'Show B S01E01.mkv']);
  // A path outside the library: full scan.
  await scanLibrary('sf-scope', { paths: [os.tmpdir()] });
  assert.deepEqual(mediaPaths('sf-scope').map((p) => path.basename(p)), ['Show A S01E01.mkv', 'Show A S01E02.mkv', 'Show B S01E02.mkv']);
});

test('watcher events are debounced into one scan of the changed top-level folders', async () => {
  const root = mkRoot('watch');
  touch(path.join(root, 'Show A', 'Show A S01E01.mkv'));
  touch(path.join(root, 'Show B', 'Show B S01E01.mkv'));
  addLib('sf-watch', 'shows', [root]);
  await scanLibrary('sf-watch');
  assert.deepEqual(changedUnits(root, path.join('Show A', 'Season 1', 'x.mkv')), [path.join(root, 'Show A')]);
  assert.deepEqual(changedUnits(root, 'Show A'), [path.join(root, 'Show A')]);
  assert.deepEqual(changedUnits(root, 'gone.mkv'), [path.join(root, 'gone.mkv'), root], 'a root-level file: the root\'s own files too');
  assert.equal(changedUnits(root, ''), null, 'an event on the root itself: full scan');

  const saved = watchTiming.settleMs;
  watchTiming.settleMs = 20;
  try {
    touch(path.join(root, 'Show A', 'Show A S01E02.mkv'));
    touch(path.join(root, 'Show A', 'Show A S01E03.mkv'));
    touch(path.join(root, 'Show B', 'Show B S01E02.mkv')); // not reported: stays out of a partial scan
    db.run("UPDATE libraries SET last_scan_at = NULL WHERE id = 'sf-watch'");
    changed('sf-watch', 'sf-watch', root, path.join('Show A', 'Show A S01E02.mkv'));
    changed('sf-watch', 'sf-watch', root, path.join('Show A', 'Show A S01E03.mkv'));
    await settle('sf-watch');
    assert.deepEqual(mediaPaths('sf-watch').map((p) => path.basename(p)), ['Show A S01E01.mkv', 'Show A S01E02.mkv', 'Show A S01E03.mkv', 'Show B S01E01.mkv']);
    // An event on the root folder itself (no name): everything is scanned.
    db.run("UPDATE libraries SET last_scan_at = NULL WHERE id = 'sf-watch'");
    changed('sf-watch', 'sf-watch', root, path.join('Show A', 'x.mkv'));
    changed('sf-watch', 'sf-watch', root, '');
    await settle('sf-watch');
    assert.equal(mediaPaths('sf-watch').length, 5);
  } finally {
    watchTiming.settleMs = saved;
  }
});

test('a scan makes no blocking filesystem calls on the library folders (a slow NAS must not freeze the server)', async () => {
  const root = mkRoot('nosync');
  touch(path.join(root, 'Show A', 'Season 1', 'Show A S01E01.mkv'));
  fs.writeFileSync(path.join(root, 'Show A', 'tvshow.nfo'), '<tvshow><title>Show A From NFO</title></tvshow>');
  fs.writeFileSync(path.join(root, 'Show A', 'poster.jpg'), 'img');
  fs.writeFileSync(path.join(root, 'Show A', 'Season 1', 'Show A S01E01.nfo'), '<episodedetails><title>Pilot From NFO</title></episodedetails>');
  addLib('sf-nosync', 'shows', [root]);
  const names = ['existsSync', 'statSync', 'lstatSync', 'readdirSync', 'readFileSync', 'realpathSync', 'accessSync', 'openSync'] as const;
  const orig = new Map(names.map((n) => [n, (fs as any)[n]]));
  const blocked: string[] = [];
  for (const n of names) {
    (fs as any)[n] = function (p: any, ...rest: any[]) {
      if (String(p).startsWith(root)) blocked.push(`${n} ${p}`);
      return orig.get(n).call(this, p, ...rest);
    };
  }
  try {
    await scanLibrary('sf-nosync');
  } finally {
    for (const n of names) (fs as any)[n] = orig.get(n);
  }
  assert.deepEqual(blocked, []);
  assert.equal(db.get<{ title: string }>("SELECT title FROM items WHERE library_id = 'sf-nosync' AND type = 'show'")?.title, 'Show A From NFO');
  assert.equal(db.get<{ title: string }>("SELECT title FROM items WHERE library_id = 'sf-nosync' AND type = 'episode'")?.title, 'Pilot From NFO');
  assert.ok(db.get("SELECT poster FROM items WHERE library_id = 'sf-nosync' AND type = 'show'")?.poster, 'show poster found');
});
