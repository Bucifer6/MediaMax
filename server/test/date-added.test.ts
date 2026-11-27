// "Date added" from file times: per-library rule, parents take their earliest child, Recalculate date added.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { db } = await import('../src/db.ts');
const { createUser, issueToken } = await import('../src/services/auth.ts');
const { scanLibrary, fileAddedMs, recalculateDateAdded } = await import('../src/services/scanner.ts');
const { buildApp } = await import('../src/app.ts');

const admin = await createUser({ username: 'daadmin', password: 'pw-123456', isAdmin: true });
const atok = issueToken(admin.id, { deviceId: 'da-a', deviceName: 'test', platform: 'web' }).token;
const app = await buildApp();
after(() => app.close());
const auth = { authorization: `Bearer ${atok}` };

const DAY = 86400000;
const touch = (file: string, ms: number) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
  fs.utimesSync(file, ms / 1000, ms / 1000);
};
const added = (where: string, ...p: string[]) => db.get<{ added_at: string }>(`SELECT added_at FROM items WHERE ${where}`, ...p)!.added_at;

test('fileAddedMs: creation time, falling back to mtime when there is none, never in the future', () => {
  const now = Date.UTC(2026, 10, 21);
  assert.equal(fileAddedMs('scan', { birthtime: 5, mtime: 6 }, now), null);
  assert.equal(fileAddedMs('created', { birthtime: now - 10 * DAY, mtime: now - DAY }, now), now - 10 * DAY);
  assert.equal(fileAddedMs('created', { birthtime: 0, mtime: now - DAY }, now), now - DAY, 'no birthtime → mtime');
  assert.equal(fileAddedMs('modified', { birthtime: now - 10 * DAY, mtime: now - DAY }, now), now - DAY);
  assert.equal(fileAddedMs('modified', { birthtime: 0, mtime: now + 30 * DAY }, now), now, 'future dates are clamped to now');
  assert.equal(fileAddedMs('created', { birthtime: 0, mtime: 0 }, now), null);
});

test('new libraries default to file creation time; the option is validated and editable', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-da-new-'));
  let r = await app.inject({ method: 'POST', url: '/api/v1/libraries', headers: auth, payload: { name: 'X', type: 'movies', paths: [root], fetchMetadata: false } });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().dateAdded, 'created');
  const id = r.json().id;
  r = await app.inject({ method: 'PATCH', url: `/api/v1/libraries/${id}`, headers: auth, payload: { dateAdded: 'bogus' } });
  assert.equal(r.statusCode, 400);
  r = await app.inject({ method: 'PATCH', url: `/api/v1/libraries/${id}`, headers: auth, payload: { dateAdded: 'modified' } });
  assert.equal(r.json().dateAdded, 'modified');
  // The server-wide default for new libraries.
  await app.inject({ method: 'PUT', url: '/api/v1/settings', headers: auth, payload: { defaultDateAdded: 'scan' } });
  r = await app.inject({ method: 'POST', url: '/api/v1/libraries', headers: auth, payload: { name: 'Y', type: 'movies', paths: [root], fetchMetadata: false } });
  assert.equal(r.json().dateAdded, 'scan');
  await app.inject({ method: 'PUT', url: '/api/v1/settings', headers: auth, payload: { defaultDateAdded: 'created' } });
});

test('scanning with "file modified time": episodes, seasons and shows get file dates; Recently Added still follows the newest episode', async () => {
  const now = Date.now();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-da-shows-'));
  touch(path.join(root, 'Old Show', 'Season 1', 'Old Show S01E01.mkv'), now - 400 * DAY);
  touch(path.join(root, 'Old Show', 'Season 1', 'Old Show S01E02.mkv'), now - 390 * DAY);
  touch(path.join(root, 'Old Show', 'Season 2', 'Old Show S02E01.mkv'), now - 30 * DAY);
  touch(path.join(root, 'Newer Show', 'Season 1', 'Newer Show S01E01.mkv'), now - 100 * DAY);
  touch(path.join(root, 'Future Show', 'Season 1', 'Future Show S01E01.mkv'), now + 50 * DAY);
  db.run("INSERT INTO libraries (id, name, type, paths, fetch_metadata, created_at, date_added) VALUES ('da-shows', 'Shows', 'shows', ?, 0, '2026-01-01', 'modified')", JSON.stringify([root]));
  await scanLibrary('da-shows');

  const day = (iso: string) => Math.round((now - Date.parse(iso)) / DAY);
  assert.equal(day(added("library_id = 'da-shows' AND type = 'episode' AND path LIKE ?", '%S01E01.mkv')), 400);
  assert.equal(day(added("library_id = 'da-shows' AND type = 'season' AND title = 'Season 1' AND parent_id = (SELECT id FROM items WHERE title = 'Old Show')")), 400, 'season = earliest episode');
  assert.equal(day(added("library_id = 'da-shows' AND type = 'season' AND title = 'Season 2'")), 30);
  assert.equal(day(added("library_id = 'da-shows' AND type = 'show' AND title = 'Old Show'")), 400, 'show = earliest season');
  assert.ok(Date.parse(added("library_id = 'da-shows' AND type = 'show' AND title = 'Future Show'")) <= Date.now(), 'never in the future');

  // Recently Added for the library orders shows by their newest episode: Future (clamped to now), Old Show (30 days), Newer (100).
  const { buildHome } = await import('../src/services/items.ts');
  const { getUser } = await import('../src/services/auth.ts');
  const { updateBranding } = await import('../src/services/branding.ts');
  updateBranding({ homeRows: [{ id: 'lr', type: 'library-recent', enabled: true, libraryId: 'da-shows' }] });
  const rows = buildHome(getUser(admin.id));
  assert.deepEqual(rows[0]!.items.map((i) => i.title), ['Future Show', 'Old Show', 'Newer Show']);

  // A rescan does not move existing dates.
  const before = added("library_id = 'da-shows' AND type = 'show' AND title = 'Old Show'");
  await scanLibrary('da-shows');
  assert.equal(added("library_id = 'da-shows' AND type = 'show' AND title = 'Old Show'"), before);
});

test('Recalculate date added re-applies the rule to items scanned with "scan time"', async () => {
  const now = Date.now();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-da-movies-'));
  touch(path.join(root, 'Classic (1960)', 'Classic (1960).mkv'), now - 1000 * DAY);
  db.run("INSERT INTO libraries (id, name, type, paths, fetch_metadata, created_at, date_added) VALUES ('da-movies', 'Movies', 'movies', ?, 0, '2026-01-01', 'scan')", JSON.stringify([root]));
  await scanLibrary('da-movies');
  const scanTime = Date.parse(added("library_id = 'da-movies' AND type = 'movie'"));
  assert.ok(now - scanTime < DAY, 'scan time used');
  assert.equal(await recalculateDateAdded('da-movies'), 0, 'scan rule: nothing to recalculate');

  let r = await app.inject({ method: 'PATCH', url: '/api/v1/libraries/da-movies', headers: auth, payload: { dateAdded: 'modified' } });
  assert.equal(r.statusCode, 200);
  r = await app.inject({ method: 'POST', url: '/api/v1/libraries/da-movies/recalculate-date-added', headers: auth });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().changed, 1);
  assert.equal(Math.round((now - Date.parse(added("library_id = 'da-movies' AND type = 'movie'"))) / DAY), 1000);
  // Admin only.
  const viewer = await createUser({ username: 'daviewer', password: 'pw-123456' });
  const vtok = issueToken(viewer.id, { deviceId: 'da-v', deviceName: 'test', platform: 'web' }).token;
  r = await app.inject({ method: 'POST', url: '/api/v1/libraries/da-movies/recalculate-date-added', headers: { authorization: `Bearer ${vtok}` } });
  assert.equal(r.statusCode, 403);
  // Also offered as a scheduled task.
  const tasks = (await app.inject({ method: 'GET', url: '/api/v1/tasks', headers: auth })).json() as { id: string }[];
  assert.ok(tasks.some((t) => t.id === 'recalculate-date-added'));
});
