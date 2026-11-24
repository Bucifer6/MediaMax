// Radio Host on the phone (src/player/radioHost.ts, a port of web/src/player/radioHost.ts): break scheduling, ducking
// maths, skip-if-late, silent failure (same expectations as the web tests), plus the phone's duck envelope and the
// "may the player ask at all" gate (offline / no server / downloads / casting: no requests). Run: npm test in apps/mobile.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  askState, DUCK_GAIN, DUCK_RAMP_MS, duckPoints, Ducker, estimateSpeechMs, GAP_FADE_MS, GAP_PAD_MS, hostMayAsk, MIN_LEAD_MS, OUTRO_PAD_MS, planBreakTimeline,
  POST_LEAD_MS, RadioHost, radioHostPrefs, readyInTime, REQUEST_LEAD_MS, talkWindowMs, wantsDeviceVoice, withHostPatch,
} from '../src/player/radioHost.ts';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);

test('duck level is −12 dB (≈ 0.25) with ~400 ms ramps', () => {
  near(DUCK_GAIN, 0.2512, 1e-3);
  near(20 * Math.log10(DUCK_GAIN), -12, 1e-9);
  assert.equal(DUCK_RAMP_MS, 400);
  assert.equal(POST_LEAD_MS, 2000);
});

test('speech estimate is ~3 words per second', () => {
  assert.equal(estimateSpeechMs(''), 0);
  assert.equal(estimateSpeechMs('one two three four five six'), 2400);
  assert.equal(estimateSpeechMs('  spaced   out  words '), 1400);
});

test('talk window: from the incoming start point to the vocals, in wall time', () => {
  assert.equal(talkWindowMs(null, 0), null);
  assert.equal(talkWindowMs(18000, 2000), 16000);
  assert.equal(talkWindowMs(18000, 2000, 1.04), Math.round(16000 / 1.04));
  assert.equal(talkWindowMs(1000, 2000), 0, 'starts after the vocals: no window');
});

test('ask ~30 s before the transition; too close = stay quiet', () => {
  assert.equal(askState(REQUEST_LEAD_MS + 1), 'wait');
  assert.equal(askState(REQUEST_LEAD_MS), 'ask');
  assert.equal(askState(MIN_LEAD_MS), 'ask');
  assert.equal(askState(MIN_LEAD_MS - 1), 'late');
  assert.equal(askState(NaN), 'wait');
});

test('over-intro: duck at the transition, talk after the attack, music full 2 s before the vocals', () => {
  const tl = planBreakTimeline({ placement: 'over-intro', transitionInMs: 20000, introMs: 12000, speechMs: 5000 });
  assert.equal(tl.placement, 'over-intro');
  assert.equal(tl.duckAtMs, 20000);
  assert.equal(tl.speakAtMs, 20000 + DUCK_RAMP_MS);
  assert.equal(tl.speechEndMs, 25400);
  assert.equal(tl.releaseAtMs, 25400);
  // The release ramp is over before (post − 2 s).
  assert.ok(tl.releaseAtMs + DUCK_RAMP_MS <= 20000 + 12000 - POST_LEAD_MS);
  near(tl.gain, DUCK_GAIN);
  const pts = duckPoints(tl, 100);
  assert.deepEqual(pts.map((p) => p.v), [1, DUCK_GAIN, DUCK_GAIN, 1]);
  near(pts[0].t, 120);
  near(pts[1].t, 120.4);
  near(pts[2].t, 125.4);
  near(pts[3].t, 125.8);
});

test('over-intro that would run into the vocals moves over the outro; nothing fits = skip', () => {
  const tl = planBreakTimeline({ placement: 'over-intro', transitionInMs: 20000, introMs: 6000, speechMs: 5000 });
  assert.equal(tl.placement, 'over-outro');
  assert.equal(tl.speechEndMs, 20000 - OUTRO_PAD_MS);
  assert.equal(tl.speakAtMs, 20000 - OUTRO_PAD_MS - 5000);
  assert.equal(tl.duckAtMs, tl.speakAtMs - DUCK_RAMP_MS);
  // Unknown intro: also the outro.
  assert.equal(planBreakTimeline({ placement: 'over-intro', transitionInMs: 20000, introMs: null, speechMs: 3000 }).placement, 'over-outro');
  // Short intro and no time left before the transition: skip.
  assert.equal(planBreakTimeline({ placement: 'over-intro', transitionInMs: 0, introMs: 4000, speechMs: 5000 }), null);
});

test('over-outro ends just before the transition; a late one moves over the intro', () => {
  const tl = planBreakTimeline({ placement: 'over-outro', transitionInMs: 25000, introMs: null, speechMs: 6000 });
  assert.equal(tl.placement, 'over-outro');
  assert.equal(tl.releaseAtMs, 25000 - OUTRO_PAD_MS);
  const late = planBreakTimeline({ placement: 'over-outro', transitionInMs: 3000, introMs: 15000, speechMs: 6000 });
  assert.equal(late.placement, 'over-intro');
  assert.equal(late.duckAtMs, 3000);
  assert.equal(planBreakTimeline({ placement: 'over-outro', transitionInMs: 3000, introMs: null, speechMs: 6000 }), null);
});

test('gap: fade, talk, pause, next track; no ducking', () => {
  const tl = planBreakTimeline({ placement: 'gap', transitionInMs: 10000, introMs: null, speechMs: 4000 });
  assert.equal(tl.gapAtMs, 10000);
  assert.equal(tl.speakAtMs, 10000 + GAP_FADE_MS);
  assert.equal(tl.resumeAtMs, 10000 + GAP_FADE_MS + 4000 + GAP_PAD_MS);
  assert.equal(tl.duckAtMs, null);
  assert.deepEqual(duckPoints(tl, 0), []);
});

test('ready in time only with a margin before the talk starts', () => {
  assert.equal(readyInTime(1000, 2000), true);
  assert.equal(readyInTime(1900, 2000), false);
  assert.equal(planBreakTimeline({ placement: 'gap', transitionInMs: -1, introMs: null, speechMs: 1000 }), null);
});

/* ---------------- controller with a fake clock ---------------- */

function harness(opts = {}) {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  const log = [];
  const ducks = [];
  const unducks = [];
  const states = [];
  const played = [];
  let endVoice = null;
  const deps = {
    now: () => now,
    setTimer: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (t) => void timers.delete(t),
    fetchBreak: (req) => (opts.fetch ? opts.fetch(req) : Promise.resolve(null)),
    prepareVoice: opts.prepare ?? (async (brk) => ({
      durationMs: opts.voiceMs === undefined ? 3000 : opts.voiceMs,
      play: () => {
        played.push(brk.text);
        if (opts.voiceFails) return Promise.reject(new Error('boom'));
        return new Promise((res) => (endVoice = res));
      },
      stop: () => endVoice?.(),
      setVolume: () => {},
    })),
    duck: (duckIn, releaseIn, gain) => {
      ducks.push({ duckIn, releaseIn, gain, at: now });
      return opts.canDuck !== false;
    },
    unduck: () => void unducks.push(now),
    volume: () => 0.8,
    onState: (s) => states.push(s),
    log: (...a) => log.push(a.join(' ')),
  };
  const host = new RadioHost(deps);
  const flush = () => new Promise((r) => setImmediate(r));
  const advance = async (ms) => {
    const end = now + ms;
    for (;;) {
      await flush();
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = end;
    await flush();
  };
  return { host, deps, ducks, unducks, states, played, log, advance, flush, endVoice: () => endVoice?.(), setNow: (t) => (now = t), get now() { return now; } };
}

const brk = (placement, extra = {}) => ({ id: 'b1', kind: 'frontsell', text: 'Up next, a little something from Nina Simone.', placement, maxMs: 10000, audioUrl: null, durationMs: null, ...extra });
const req = { mode: 'radio', nextItemId: 'b', previousItemId: 'a', tracksSinceBreak: 2, msSinceBreak: 400000 };

test('null break: the host stays quiet (no duck, no caption)', async () => {
  const h = harness();
  h.host.ask('a>b@0', req, 25000, 12000);
  await h.advance(30000);
  h.host.onTransition('a>b@0');
  await h.advance(10000);
  assert.equal(h.ducks.length, 0);
  assert.equal(h.played.length, 0);
  assert.ok(h.states.every((s) => !s.caption));
});

test('over-intro break: ducks at the transition, captions while talking, music back when it ends', async () => {
  const h = harness({ fetch: async () => brk('over-intro'), voiceMs: 3000 });
  h.host.ask('a>b@0', req, 25000, 12000);
  await h.advance(1000);
  assert.equal(h.host.current?.state, 'ready');
  assert.equal(h.ducks.length, 0, 'nothing before the transition');
  await h.advance(24000);
  h.host.onTransition('a>b@0');
  assert.equal(h.ducks.length, 1);
  assert.equal(h.ducks[0].duckIn, 0);
  assert.equal(h.ducks[0].releaseIn, DUCK_RAMP_MS + 3000);
  near(h.ducks[0].gain, DUCK_GAIN);
  await h.advance(DUCK_RAMP_MS);
  assert.deepEqual(h.played, ['Up next, a little something from Nina Simone.']);
  assert.equal(h.host.state.speaking, true);
  assert.equal(h.host.state.caption, 'Up next, a little something from Nina Simone.');
  h.endVoice();
  await h.flush();
  assert.equal(h.host.state.speaking, false);
  assert.equal(h.host.state.caption, null);
  assert.equal(h.unducks.length, 1);
  assert.deepEqual(h.host.stats().tracksSinceBreak, 0);
});

test('over-outro break: scheduled so the talk ends right before the transition', async () => {
  const h = harness({ fetch: async () => brk('over-outro'), voiceMs: 4000 });
  h.host.ask('a>b@0', req, 25000, null);
  await h.advance(1);
  const speakAt = 25000 - OUTRO_PAD_MS - 4000;
  await h.advance(speakAt - DUCK_RAMP_MS - 1 - h.now);
  assert.equal(h.ducks.length, 0);
  await h.advance(1);
  assert.equal(h.ducks.length, 1);
  assert.equal(h.ducks[0].at, speakAt - DUCK_RAMP_MS);
  assert.equal(h.ducks[0].releaseIn, 4000 + DUCK_RAMP_MS);
  await h.advance(DUCK_RAMP_MS);
  assert.equal(h.played.length, 1);
});

test('skip if late: a break that arrives after the transition point is dropped silently', async () => {
  let resolve;
  const h = harness({ fetch: () => new Promise((r) => (resolve = r)) });
  h.host.ask('a>b@0', req, 10000, 3000);
  await h.advance(10000);
  h.host.onTransition('a>b@0');
  await h.advance(5000);
  resolve(brk('over-intro'));
  await h.advance(100);
  assert.equal(h.played.length, 0);
  assert.equal(h.ducks.length, 0);
  assert.equal(h.host.current, null);
  assert.ok(h.log.some((l) => l.includes('skipped')));
});

test('silent failure: fetch error, no voice, or a voice that fails never shows anything and restores the music', async () => {
  const a = harness({ fetch: async () => { throw new Error('HTTP 500'); } });
  a.host.ask('k', req, 20000, 10000);
  await a.advance(25000);
  assert.equal(a.played.length, 0);
  assert.ok(a.states.every((s) => !s.caption));

  const b = harness({ fetch: async () => brk('over-intro'), prepare: async () => null });
  b.host.ask('k', req, 20000, 10000);
  await b.advance(21000);
  b.host.onTransition('k');
  await b.advance(5000);
  assert.equal(b.ducks.length, 0);

  const c = harness({ fetch: async () => brk('over-intro'), voiceFails: true });
  c.host.ask('k', req, 20000, 10000);
  await c.advance(20000);
  c.host.onTransition('k');
  await c.advance(DUCK_RAMP_MS + 10);
  assert.equal(c.ducks.length, 1);
  assert.equal(c.unducks.length, 1, 'music ramps back up at once');
  assert.equal(c.host.state.speaking, false);
  assert.equal(c.host.state.caption, null);
  assert.ok(c.log.some((l) => l.includes('voice failed')));
});

test('no Web Audio (iOS): the voice still plays, just without ducking', async () => {
  const h = harness({ fetch: async () => brk('over-intro'), canDuck: false });
  h.host.ask('k', req, 20000, 12000);
  await h.advance(20000);
  h.host.onTransition('k');
  await h.advance(DUCK_RAMP_MS);
  assert.equal(h.played.length, 1);
  h.endVoice();
  await h.flush();
  assert.equal(h.unducks.length, 0, 'nothing to release');
});

test('gap break: wantsGap at the end, playGap resolves when the talk ends (or is skipped)', async () => {
  const h = harness({ fetch: async () => brk('gap') });
  h.host.ask('k', req, 20000, null);
  await h.advance(1000);
  assert.equal(h.host.wantsGap('k'), true);
  assert.equal(h.host.wantsGap('other'), false);
  let done = false;
  void h.host.playGap('k').then(() => (done = true));
  await h.flush();
  assert.equal(h.host.state.speaking, true);
  h.host.skip();
  await h.flush();
  assert.equal(done, true);
  assert.equal(h.host.state.caption, null);
});

test('mute host: no breaks are asked for and a running one stops', async () => {
  let asked = 0;
  const h = harness({ fetch: async () => (asked++, brk('over-intro')) });
  h.host.ask('k', req, 20000, 12000);
  await h.advance(20000);
  h.host.onTransition('k');
  await h.advance(DUCK_RAMP_MS);
  assert.equal(h.host.state.speaking, true);
  h.host.setMuted(true);
  await h.flush();
  assert.equal(h.host.state.speaking, false);
  h.host.ask('k2', req, 40000, 12000);
  await h.advance(1000);
  assert.equal(asked, 1);
});

test('playNow: a Your DJ intro talks over the current track at once; caption-only acknowledgement', async () => {
  const h = harness();
  h.host.playNow(brk('over-intro', { id: 'i1', kind: 'segment-intro', text: 'Switching it up.' }), 9000);
  await h.advance(DUCK_RAMP_MS);
  assert.equal(h.ducks.length, 1);
  assert.deepEqual(h.played, ['Switching it up.']);
  h.endVoice();
  await h.flush();
  h.host.caption('Switching it up. Throwbacks.', 3000);
  assert.equal(h.host.state.caption, 'Switching it up. Throwbacks.');
  assert.equal(h.host.state.speaking, false);
  await h.advance(3000);
  assert.equal(h.host.state.caption, null);
});

test('a voice that never reports its end is stopped by the safety timer', async () => {
  const h = harness({ fetch: async () => brk('over-intro'), voiceMs: 2000 });
  h.host.ask('k', req, 20000, 15000);
  await h.advance(20000);
  h.host.onTransition('k');
  await h.advance(DUCK_RAMP_MS + 2000 * 1.5 + 3000 + 10);
  assert.equal(h.host.state.speaking, false);
  assert.equal(h.unducks.length, 1);
});

/* ---------------- phone: duck envelope (expo-audio has no gain automation) ---------------- */

test('duck envelope: −12 dB with 400 ms attack / release, sampled into the player volume', () => {
  const d = new Ducker();
  assert.equal(d.factor(0), 1);
  assert.equal(d.active(0), false);
  // Over-intro as the controller asks for it: attack now, release after the attack + 3 s of talk.
  d.duck(1000, 0, DUCK_RAMP_MS + 3000, DUCK_GAIN, DUCK_RAMP_MS);
  near(d.factor(1000), 1);
  near(d.factor(1200), 1 - (1 - DUCK_GAIN) / 2, 1e-9);
  near(d.factor(1400), DUCK_GAIN);
  near(d.factor(3000), DUCK_GAIN);
  near(d.factor(4400), DUCK_GAIN);
  near(d.factor(4600), (DUCK_GAIN + 1) / 2, 1e-9);
  near(d.factor(4800), 1);
  assert.equal(d.active(4000), true);
  // Once released the envelope ends by itself (the music comes back even if no timer runs).
  assert.equal(d.active(4800), false);
  assert.equal(d.factor(9000), 1);
});

test('duck envelope: an early end ramps back from wherever it is; fade-out holds silence until reset', () => {
  const d = new Ducker();
  d.duck(0, 0, 10000);
  near(d.factor(2000), DUCK_GAIN);
  d.unduck(2000, 400);
  near(d.factor(2200), (DUCK_GAIN + 1) / 2, 1e-9);
  near(d.factor(2400), 1);
  assert.equal(d.active(2400), false);
  // Gap break: the outgoing track fades over GAP_FADE_MS and stays silent until the player resets it.
  d.fadeOut(0, GAP_FADE_MS);
  near(d.factor(GAP_FADE_MS / 2), 0.5);
  assert.equal(d.factor(60000), 0);
  assert.equal(d.active(60000), true);
  d.reset();
  assert.equal(d.factor(60000), 1);
  // A delayed over-outro duck starts from full level.
  d.duck(0, 1000, 5000);
  assert.equal(d.factor(500), 1);
  near(d.factor(1400), DUCK_GAIN);
});

test('over-intro on the phone: the duck is back at full ~2 s before the vocals (post)', () => {
  const introMs = 14000;
  const speech = 6000;
  const tl = planBreakTimeline({ placement: 'over-intro', transitionInMs: 0, introMs, speechMs: speech });
  const d = new Ducker();
  d.duck(0, tl.duckAtMs, tl.releaseAtMs, tl.gain, DUCK_RAMP_MS);
  near(d.factor(tl.speakAtMs), DUCK_GAIN);
  assert.equal(d.factor(introMs - POST_LEAD_MS), 1);
  // Too long for the intro and no outro left: skipped, nothing ducks.
  assert.equal(planBreakTimeline({ placement: 'over-intro', transitionInMs: 0, introMs: 5000, speechMs: 6000 }), null);
});

/* ---------------- phone: when the player may ask at all ---------------- */

const gate = (extra = {}) => ({ mode: 'radio', aiOn: true, casting: false, muted: false, localFile: false, tracks: true, repeatOne: false, ...extra });

test('gate: only streamed music with the AI DJ reachable; offline / no server / downloads / casting = no requests', () => {
  assert.equal(hostMayAsk(gate()), true);
  assert.equal(hostMayAsk(gate({ mode: 'yourdj' })), true);
  assert.equal(hostMayAsk(gate({ mode: null })), false, 'host off');
  assert.equal(hostMayAsk(gate({ aiOn: false })), false, 'offline, server unreachable or AI DJ off');
  assert.equal(hostMayAsk(gate({ localFile: true })), false, 'downloaded / offline playback');
  assert.equal(hostMayAsk(gate({ casting: true })), false);
  assert.equal(hostMayAsk(gate({ muted: true })), false);
  assert.equal(hostMayAsk(gate({ tracks: false })), false, 'audiobooks / podcasts');
  assert.equal(hostMayAsk(gate({ repeatOne: true })), false);
});

test('offline: a player loop that respects the gate never reaches /dj/break', async () => {
  let fetches = 0;
  const h = harness({ fetch: async () => (fetches++, brk('over-intro')) });
  // The music provider asks only when hostMayAsk() is true (src/state/music.tsx hostTick).
  for (const g of [gate({ aiOn: false }), gate({ localFile: true }), gate({ casting: true })]) {
    if (hostMayAsk(g)) h.host.ask('k', req, 25000, 12000);
  }
  await h.advance(30000);
  assert.equal(fetches, 0);
  assert.equal(h.host.current, null);
});

test('late fetch and slow voice: skipped silently, the music level untouched', async () => {
  // The voice is only ready after the transition and the intro window is gone.
  const h = harness({
    fetch: async () => brk('over-intro'),
    prepare: () => new Promise((r) => setTimeout(() => r({ durationMs: 4000, play: () => Promise.resolve(), stop() {}, setVolume() {} }), 5)),
  });
  h.host.ask('k', req, 10000, 3000);
  h.host.onTransition('k');
  h.setNow(5000);
  await new Promise((r) => setTimeout(r, 20));
  await h.flush();
  assert.equal(h.ducks.length, 0);
  assert.equal(h.played.length, 0);
  assert.ok(h.log.some((l) => l.includes('skipped')));
  assert.ok(h.states.every((s) => !s.caption), 'no caption, no error');
});

test('prefs: off by default, whole object saved, device voice preference', () => {
  assert.equal(radioHostPrefs(undefined).enabled, false);
  assert.equal(radioHostPrefs({}).chattiness, 'off');
  const p = radioHostPrefs({ radioHost: { enabled: true, chattiness: 'light', categories: { jokes: false } } });
  assert.equal(p.enabled, true);
  assert.equal(p.categories.jokes, false);
  assert.equal(p.categories.weather, true, 'missing categories default on (as on the server)');
  const off = withHostPatch(p, { chattiness: 'off' });
  assert.equal(off.enabled, false);
  assert.deepEqual(Object.keys(off.categories).sort(), ['announce', 'facts', 'jokes', 'stats', 'time', 'weather']);
  assert.equal(withHostPatch(off, { chattiness: 'chatty' }).enabled, true);
  assert.equal(wantsDeviceVoice('device'), true);
  assert.equal(wantsDeviceVoice('device:com.apple.voice.Samantha'), true);
  assert.equal(wantsDeviceVoice(null), false);
});
