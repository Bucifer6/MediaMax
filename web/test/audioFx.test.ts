import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clientFx, comfortRequest, deviceComforts } from '../src/player/audioFx';
import { audioDecisionText, audioFormat, channelText } from '../src/components/AudioBadge';

test('comfortRequest: nothing for no comforts; forced only for what the browser cannot do', () => {
  assert.deepEqual(comfortRequest({}, true), {});
  assert.deepEqual(comfortRequest({ nightMode: true, dialogueBoost: true, delayMs: 200 }, true), { audioProcessing: { nightMode: true, dialogueBoost: true, delayMs: 200 } });
  assert.equal(comfortRequest({ normalize: true }, true).forceAudioProcessing, true);
  assert.equal(comfortRequest({ delayMs: -120 }, true).forceAudioProcessing, true, 'sound earlier needs the server');
  assert.equal(comfortRequest({ nightMode: true }, false).forceAudioProcessing, true, 'TV engines: server does everything');
});

test('clientFx: never applies what the server already applied; positive delay only', () => {
  const c = { nightMode: true, dialogueBoost: true, delayMs: 150 };
  assert.deepEqual(clientFx(c, null, true), { nightMode: true, dialogueBoost: true, delayMs: 150 });
  assert.deepEqual(clientFx(c, { audio: { applied: ['nightMode', 'delayMs'] } as never }, true), { nightMode: false, dialogueBoost: true, delayMs: 0 });
  assert.deepEqual(clientFx({ delayMs: -200 }, null, true).delayMs, 0);
  assert.deepEqual(clientFx(c, null, false), { nightMode: false, dialogueBoost: false, delayMs: 0 });
});

test('deviceComforts: device overrides on top of the user defaults', () => {
  assert.deepEqual(deviceComforts({ audio: { nightMode: true, delayMs: 0 }, audioDevices: { tv: { delayMs: 120 } } }, 'tv'), { nightMode: true, delayMs: 120 });
  assert.deepEqual(deviceComforts(undefined, 'x'), {});
});

test('audio labels for badges and the stats overlay', () => {
  const thd = { index: 1, codec: 'truehd', language: 'eng', title: null, channels: 8, default: true, channelLayout: '7.1', atmos: true, formatLabel: 'TrueHD Atmos' };
  assert.equal(audioFormat(thd), 'TrueHD Atmos');
  assert.equal(channelText(thd), '7.1');
  assert.equal(audioFormat({ index: 0, codec: 'eac3', language: null, title: null, channels: 6, default: true }), 'E-AC-3', 'old scans: codec only');
  assert.equal(channelText({ channels: 6, channelLayout: null }), '5.1');
  assert.equal(audioDecisionText({ source: 'TrueHD Atmos 7.1', output: 'E-AC-3 5.1', delivery: 'transcode', codec: 'eac3', channels: 6, bitrateKbps: 640, reason: "TrueHD Atmos → E-AC-3 5.1: device can't play TrueHD", objects: 'lost', applied: [] }),
    "TrueHD Atmos 7.1 → E-AC-3 5.1 (device can't play TrueHD)");
  assert.equal(audioDecisionText({ source: 'E-AC-3 Atmos 5.1', output: 'E-AC-3 Atmos 5.1', delivery: 'copy', codec: 'copy', channels: null, bitrateKbps: 768, reason: null, objects: 'kept', applied: [] }),
    'E-AC-3 Atmos 5.1 (passed through, objects kept)');
});
