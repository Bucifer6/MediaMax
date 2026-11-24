import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanRules, isEmptyRules, parseRulesPrefs, removePreset, ruleChips, rulesKey, rulesSummary, serializeRulesPrefs, setActivePreset, uniqueName,
  upsertPreset, withoutChip,
} from '../src/player/djRules';

test('cleanRules: trims, de-duplicates, clamps, orders ranges, drops empties', () => {
  const r = cleanRules({
    includeGenres: [' Jazz ', 'jazz', '', 'Soul'], excludeGenres: ['Metal'], includeArtists: [], excludeArtists: ['  Nickelback'],
    yearMin: 2010, yearMax: 1990, bpmMin: 10, bpmMax: 400, energyMin: 0, energyMax: 1, cleanOnly: false, minRating: 0, maxDurationSec: 5,
  });
  assert.deepEqual(r, { includeGenres: ['Jazz', 'Soul'], excludeGenres: ['Metal'], excludeArtists: ['Nickelback'], yearMin: 1990, yearMax: 2010, bpmMin: 40, bpmMax: 220, maxDurationSec: 30 });
  assert.deepEqual(cleanRules(null), {});
  assert.equal(isEmptyRules({ includeGenres: [' '], energyMin: 0 }), true);
  assert.equal(isEmptyRules({ cleanOnly: true }), false);
});

test('a genre both included and excluded is only excluded', () => {
  assert.deepEqual(cleanRules({ includeGenres: ['Rock', 'Pop'], excludeGenres: ['rock'] }), { includeGenres: ['Pop'], excludeGenres: ['rock'] });
});

test('string numbers from inputs are accepted; garbage is dropped', () => {
  assert.deepEqual(cleanRules({ yearMin: '1995' as unknown as number, bpmMax: 'abc' as unknown as number, energyMax: 0.456 }), { yearMin: 1995, energyMax: 0.46 });
});

test('rulesKey ignores order and noise', () => {
  assert.equal(rulesKey({ yearMin: 1990, includeGenres: ['Jazz'] }), rulesKey({ includeGenres: [' Jazz', 'jazz'], yearMin: 1990, cleanOnly: false }));
  assert.notEqual(rulesKey({ yearMin: 1990 }), rulesKey({ yearMin: 1991 }));
});

test('presets: add, edit, activate, delete the active one turns rules off', () => {
  let p = { activePresetId: null, presets: [] } as { activePresetId: string | null; presets: { id: string; name: string; rules: object }[] };
  p = upsertPreset(p, { id: 'k', name: 'Kids', rules: { cleanOnly: true, maxDurationSec: 300 } }, true) as typeof p;
  assert.equal(p.activePresetId, 'k');
  p = upsertPreset(p, { id: 'w', name: 'kids', rules: { includeGenres: ['Lo-fi'] } }) as typeof p;
  assert.equal(p.presets[1]!.name, 'kids 2', 'names stay unique (case-insensitive)');
  assert.equal(p.activePresetId, 'k');
  p = upsertPreset(p, { id: 'k', name: 'Kids', rules: { cleanOnly: true } }) as typeof p;
  assert.equal(p.presets.length, 2);
  assert.deepEqual(p.presets[0]!.rules, { cleanOnly: true });
  assert.equal(p.presets[0]!.name, 'Kids', 'renaming to its own name is fine');
  p = setActivePreset(p, 'w') as typeof p;
  assert.equal(p.activePresetId, 'w');
  assert.equal(setActivePreset(p, 'nope').activePresetId, null);
  p = removePreset(p, 'w') as typeof p;
  assert.equal(p.activePresetId, null);
  assert.deepEqual(p.presets.map((x) => x.id), ['k']);
  assert.equal(removePreset(p, 'zzz').presets.length, 1);
});

test('upsert without an id creates one', () => {
  const p = upsertPreset({ activePresetId: null, presets: [] }, { id: '', name: '', rules: {} });
  assert.ok(p.presets[0]!.id.startsWith('p-'));
  assert.equal(p.presets[0]!.name, 'My rules');
  assert.equal(uniqueName('My rules', p.presets), 'My rules 2');
});

test('serialise / parse round trip, and junk in preferences is cleaned', () => {
  const prefs = { activePresetId: 'a', presets: [{ id: 'a', name: '  Focus  ', rules: { includeGenres: ['Ambient', 'ambient'], bpmMin: 150, bpmMax: 90 } }] };
  const ser = serializeRulesPrefs(prefs);
  assert.deepEqual(ser, { activePresetId: 'a', presets: [{ id: 'a', name: 'Focus', rules: { includeGenres: ['Ambient'], bpmMin: 90, bpmMax: 150 } }] });
  assert.deepEqual(parseRulesPrefs(JSON.parse(JSON.stringify(ser))), ser);
  assert.deepEqual(parseRulesPrefs({ activePresetId: 'gone', presets: [{ id: 'x' }, null, 5, { name: 'no id' }] }), { activePresetId: null, presets: [{ id: 'x', name: 'My rules', rules: {} }] });
  assert.deepEqual(parseRulesPrefs(undefined), { activePresetId: null, presets: [] });
});

test('chips describe rules; removing a chip removes that limit', () => {
  const r = { includeGenres: ['Jazz'], excludeArtists: ['Kenny G'], yearMin: 1990, yearMax: 1999, bpmMin: 90, energyMax: 0.6, cleanOnly: true, minRating: 8, maxDurationSec: 330, sources: [{ type: 'playlist' as const, id: 'pl1' }] };
  const chips = ruleChips(r, (s) => (s.id === 'pl1' ? 'Sunday' : s.id));
  assert.deepEqual(chips.map((c) => c.label), ['Only Jazz', 'No Kenny G', 'From Sunday', '1990–1999', '90+ BPM', 'Energy 0 %–60 %', 'Clean only', 'Rated 4★ or more', 'Up to 5:30']);
  const noJazz = withoutChip(r, chips[0]!);
  assert.equal(noJazz.includeGenres, undefined);
  assert.equal(withoutChip(r, chips[3]!).yearMin, undefined);
  assert.equal(withoutChip(r, chips[3]!).yearMax, undefined);
  assert.equal(withoutChip(r, chips[2]!).sources, undefined);
  assert.equal(rulesSummary({}), 'No limits');
  assert.equal(rulesSummary(r), 'Only Jazz · No Kenny G · +7');
  assert.equal(ruleChips({ maxDurationSec: 300 })[0]!.label, 'Up to 5 min');
});
