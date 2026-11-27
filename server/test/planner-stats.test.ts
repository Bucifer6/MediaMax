import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, refreshPlannerStats } from '../src/db.js';
import { analysisStatus } from '../src/services/dj/analysis.js';

// The query behind the DJ analysis count, which blocked startup for minutes on a large music library.
const TRACK_COUNT_SQL =
  "SELECT COUNT(*) n FROM items i WHERE i.type = 'track' AND EXISTS (SELECT 1 FROM media m WHERE m.item_id = i.id AND m.path IS NOT NULL)";
const plan = () => db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${TRACK_COUNT_SQL}`).map((r) => r.detail).join(' | ');

test('statistics recorded on an empty new install are refreshed once the library has grown', () => {
  // A new install: the migrations analysed the tables while they were empty.
  const recorded = db.get<{ stat: string }>("SELECT stat FROM sqlite_stat1 WHERE idx = 'media_path'");
  assert.ok(recorded, 'the migrations analysed media while it was empty');
  assert.match(recorded.stat, /^0\b/);

  const now = new Date().toISOString();
  db.tx(() => {
    for (let n = 0; n < 3000; n++) {
      db.run('INSERT INTO items (id, type, title, sort_title, added_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', `t${n}`, 'track', `Track ${n}`, `track ${n}`, now, now);
      db.run('INSERT INTO media (id, item_id, path) VALUES (?, ?, ?)', `m${n}`, `t${n}`, `/music/${n}.flac`);
    }
  });
  // The stale "empty" figures make the planner scan every media path for each track.
  assert.match(plan(), /USING INDEX media_path/);

  refreshPlannerStats();

  assert.match(plan(), /USING INDEX media_item \(item_id=\?\)/);
  assert.match(db.get<{ stat: string }>("SELECT stat FROM sqlite_stat1 WHERE idx = 'media_path'")!.stat, /^3000\b/);
  assert.equal(analysisStatus().total, 3000);
});
