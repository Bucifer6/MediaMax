import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDolbyVisionOverride, dolbyVisionProfiles } from '../src/player/capabilities.ts';
import { rangeDeliveryText } from '../src/components/HdrBadge.tsx';

const probe = (yes: string[]) => async (codec: string) => yes.includes(codec);

test('Dolby Vision profiles from MSE codec strings', async () => {
  // Chrome without Dolby Vision: nothing.
  assert.deepEqual(await dolbyVisionProfiles(probe([])), []);
  // LG webOS (single-layer profiles reported through MSE).
  assert.deepEqual(await dolbyVisionProfiles(probe(['dvh1.05.06', 'dvh1.08.06'])), ['5', '8.1', '8.4']);
  // Newer LG / Android TV browsers: dual layer as dvhe, AV1 profile 10.
  assert.deepEqual(await dolbyVisionProfiles(probe(['dvh1.08.06', 'dvhe.07.06', 'dav1.10.06'])), ['8.1', '8.4', '7', '10']);
  assert.deepEqual(await dolbyVisionProfiles(probe(['dvh1.07.06'])), ['7']);
});

test('user override: auto keeps detection, yes adds 5/8.1/8.4, no removes all', () => {
  assert.deepEqual(applyDolbyVisionOverride(['8.1', '8.4'], 'auto'), ['8.1', '8.4']);
  assert.deepEqual(applyDolbyVisionOverride([], 'yes'), ['5', '8.1', '8.4']);
  assert.deepEqual(applyDolbyVisionOverride(['10'], 'yes'), ['5', '8.1', '8.4', '10']);
  assert.deepEqual(applyDolbyVisionOverride(['5', '8.1'], 'no'), []);
});

test('stats overlay: native Dolby Vision vs base layer', () => {
  const v = { source: 'dolbyvision' as const, label: 'Dolby Vision 8.1', delivery: 'passthrough' as const, output: 'dolbyvision' as const };
  assert.equal(rangeDeliveryText(v, { profile: '8.1', level: 6, mode: 'native', baseLayer: 'hdr10', codec: 'dvh1.08.06' }), 'Dolby Vision 8.1 (native)');
  assert.equal(rangeDeliveryText({ ...v, delivery: 'base-layer', output: 'hdr10' }, { profile: '8.1', level: 6, mode: 'base-layer', baseLayer: 'hdr10', codec: null }), 'Dolby Vision 8.1 → HDR10 base layer');
  assert.equal(rangeDeliveryText({ ...v, label: 'Dolby Vision 8.4', delivery: 'base-layer', output: 'hlg' }), 'Dolby Vision 8.4 → HLG base layer');
  assert.equal(rangeDeliveryText({ ...v, delivery: 'strip-dovi' }, { profile: '7', level: 6, mode: 'stripped', baseLayer: 'hdr10', codec: null }), 'Dolby Vision 7 → HDR10 base layer (Dolby Vision layers removed)');
  assert.equal(rangeDeliveryText({ source: 'hdr10plus', label: 'HDR10+', delivery: 'base-layer' }), 'HDR10+ → played as its HDR base layer');
});
