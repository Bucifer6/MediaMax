// QA regressions: numeric settings validation, orphaned karaoke stems cleanup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const { updateSettings, getSettings } = await import('../src/services/settings.ts');
const { pruneOrphanStems } = await import('../src/services/stems.ts');

test('cleared / invalid numeric settings are kept in range instead of breaking playback', () => {
  const s = updateSettings({
    transcoding: { ...getSettings().transcoding, segmentSeconds: 0, maxConcurrent: -3, defaultBitrate: Number(''), preset: 'bogus' as any },
    trickplay: { enabled: true, intervalSeconds: 0, width: 99999 },
    sessionTimeoutDays: 0,
    backups: { intervalDays: -1, keep: 0 },
  } as any);
  assert.equal(s.transcoding.segmentSeconds, 1);
  assert.equal(s.transcoding.maxConcurrent, 1);
  assert.equal(s.transcoding.defaultBitrate, 300);
  assert.equal(s.transcoding.preset, 'veryfast');
  assert.equal(s.trickplay.intervalSeconds, 2);
  assert.equal(s.trickplay.width, 640);
  assert.equal(s.sessionTimeoutDays, 0, '0 = sessions never expire');
  assert.equal(s.backups.intervalDays, 0);
  assert.equal(s.backups.keep, 1);
  // Strings from forms and non-numbers.
  const t = updateSettings({ transcoding: { ...getSettings().transcoding, segmentSeconds: '6' as any, threads: 'x' as any } } as any);
  assert.equal(t.transcoding.segmentSeconds, 6);
  assert.equal(t.transcoding.threads, 0);
});

test('orphaned karaoke stems are pruned; models, onnxruntime and uploads stay', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-stems-'));
  for (const d of ['models', 'ort', '.upload-x-1', 'keep1', 'gone1']) fs.mkdirSync(path.join(dir, 'stems', d), { recursive: true });
  const n = pruneOrphanStems((id) => id === 'keep1', dir);
  assert.equal(n, 1);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'stems')).sort(), ['.upload-x-1', 'keep1', 'models', 'ort']);
  assert.equal(pruneOrphanStems(() => true, path.join(dir, 'nope')), 0);
});
